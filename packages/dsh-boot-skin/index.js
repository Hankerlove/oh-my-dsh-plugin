/**
 * dsh-boot-skin — Host half.
 *
 * This file owns HTTP and disk, and nothing else:
 *
 *   $DSH_HOME/boot-skin/config.json   the single source of truth for the
 *                                    boot film + wallpaper settings
 *   $DSH_HOME/boot-skin/media/*       the uploaded bytes
 *
 * Routes (all registered as `prefix` routes under /boot-skin):
 *
 *   GET  /boot-skin/state                  { config, revision, urls }
 *   POST /boot-skin/config                 partial settings patch, JSON, <= 64KB
 *   POST /boot-skin/upload?id=<slot>       raw bytes (NOT multipart)
 *   POST /boot-skin/reset?id=<slot>        forget one uploaded file
 *   GET  /boot-skin/media/{boot,wallpaper} bytes with Range / ETag / 304
 *
 * Design rules, in order of importance:
 *
 *  1. This plugin is decoration. It must never take the GUI down. A handler
 *     never throws: every failure becomes a response, and a missing or
 *     unreadable media file costs exactly that one request. The only exception
 *     is route REGISTRATION, which is rethrown to the plugin boundary because
 *     it means the plugin cannot work at all and the host should see that once,
 *     at load time.
 *  2. The config file is the truth. It is written atomically (tmp + rename) and
 *     read fresh on every request, so a second window and this process can
 *     never disagree. A corrupt file falls back to defaults and is quarantined,
 *     never thrown.
 *  3. Plugin routes are not behind the web token, so every mutating route runs
 *     the connection service's request fence first, and falls back to an
 *     Origin/Host check when that service is absent.
 *
 * Plain ESM, Node built-ins only, no build step.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Transform, pipeline } from 'node:stream'

export const name = 'boot-skin'

/** The webserver is the only host service this plugin needs. */
export const inject = ['webServer']

/** Route table. `MEDIA_ROUTE` is the only one that serves two files. */
const BASE_ROUTE = '/boot-skin'
const STATE_ROUTE = `${BASE_ROUTE}/state`
const CONFIG_ROUTE = `${BASE_ROUTE}/config`
const UPLOAD_ROUTE = `${BASE_ROUTE}/upload`
const RESET_ROUTE = `${BASE_ROUTE}/reset`
const MEDIA_ROUTE = `${BASE_ROUTE}/media`

/**
 * First-paint cover.
 *
 * The boot film is created by the client module, which the shell delivers a batch
 * or two AFTER the page starts. Between first paint and that moment the user sees
 * the kernel boot layer ("Loading plugins…") or, worse, the app itself appearing
 * and then being covered. Both read as a glitch.
 *
 * These rows are served inline in index.html, so they apply from the FIRST paint:
 * suppress the kernel boot layer while it is still loading, hide the app root, and
 * paint the body the film's own backing colour.
 *
 * The release is owned by the client and is one-way — it REMOVES the style nodes,
 * so nothing can re-arm them later. A 10s guard timer in the injected script is
 * the escape hatch: if the client module never runs (plugin removed mid-flight,
 * module failed), the app must still become visible rather than stay black.
 *
 * Markers are unique so the guard can find exactly these style nodes.
 */
const COVER_MARK_BOOT = 'boot-skin:boot'
const COVER_MARK_ROOT = 'boot-skin:cover'
const COVER_MARK_BASE = 'boot-skin:base'
const COVER_STYLE_TEXT =
  `/* ${COVER_MARK_BOOT} */[data-dsh-boot]:has([data-dsh-boot-spinner]){display:none!important}` +
  // `opacity:0`, never `visibility:hidden`: hiding the root also removes its rects
  // from the window's `-webkit-app-region` computation, and Chromium does not
  // reliably recompute that after the rule is released — which leaves the title bar
  // undraggable long after the film is gone. Opacity paints nothing while keeping
  // every box, and every drag rect, exactly where it was.
  `/* ${COVER_MARK_ROOT} */#root{opacity:0!important}` +
  `/* ${COVER_MARK_BASE} */html,body{background-color:#070b14!important}`
const COVER_GUARD_SCRIPT = (() => {
  const marks = [COVER_MARK_BOOT, COVER_MARK_ROOT, COVER_MARK_BASE]
  return (
    '/* boot-skin:guard */try{' +
    `var marks=${JSON.stringify(marks)};` +
    'var release=function(){try{' +
    'var sheets=document.head?document.head.getElementsByTagName("style"):[];' +
    'var doomed=[];' +
    'for(var i=0;i<sheets.length;i++){var text=sheets[i].textContent||"";' +
    'for(var j=0;j<marks.length;j++){if(text.indexOf(marks[j])!==-1){doomed.push(sheets[i]);break}}}' +
    'for(var k=0;k<doomed.length;k++){doomed[k].remove()}' +
    '}catch(e){}};' +
    'var timer=setTimeout(release,10000);' +
    'globalThis.__BOOT_SKIN_GUARD__={release:release,clear:function(){clearTimeout(timer)}}' +
    '}catch(e){}'
  )
})()

const CONFIG_FILE_NAME = 'config.json'
const MEDIA_DIR_NAME = 'media'
const CONFIG_BODY_LIMIT_BYTES = 64 * 1024

/** Per-slot upload ceilings. */
const UPLOAD_LIMIT_BYTES = {
  boot: 80 * 1024 * 1024,
  wallpaper: 40 * 1024 * 1024,
}

/** Mime type -> on-disk extension. This table is also the upload whitelist. */
const MIME_EXTENSION = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/** Extension -> mime type, for reconstructing a mime type from a file name. */
const EXTENSION_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
}

const KNOWN_MIME = new Set(Object.keys(MIME_EXTENSION))

/** What each slot accepts. Anything else is rejected with 415. */
const ALLOWED_MIME = {
  boot: ['video/mp4', 'video/webm'],
  wallpaper: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'video/mp4', 'video/webm'],
}

/** On-disk file prefix per slot: `boot-<hash>.<ext>` / `wall-<hash>.<ext>`. */
const SLOT_FILE_PREFIX = { boot: 'boot', wallpaper: 'wall' }

/** Allowed `fit` values. */
const FIT_VALUES = new Set(['cover', 'contain', 'fill'])

/**
 * An uploaded media file name must be a plain name: only `[A-Za-z0-9._-]` and
 * never `..`. This is the path-traversal fence; the generated names satisfy it,
 * but `config.json` can be edited by hand.
 */
const MEDIA_FILE_PATTERN = /^[A-Za-z0-9._-]+$/
const MEDIA_FILE_NAME_LIMIT = 200
const DISPLAY_NAME_LIMIT = 200

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

// #region config shape
/** The defaults are the contract; every read is normalized through them. */
function defaultConfig() {
  return {
    version: 1,
    boot: {
      enabled: true,
      opacity: 100,
      fadeInMs: 240,
      fadeOutMs: 560,
      maxMs: 15000,
      muted: false,
      skip: true,
      once: true,
    },
    wallpaper: {
      enabled: false,
      opacity: 45,
      blurPx: 0,
      dim: 25,
      fit: 'cover',
      surfaceAlpha: 84,
      // Wallpaper video playback: `loop` keeps it running, `once` plays it to the
      // end and freezes on the last frame (replayed whenever the conversation
      // view is re-entered).
      videoMode: 'loop',
    },
    media: { boot: null, wallpaper: null },
  }
}

/** A structural clone: the file-shape objects, without aliasing the input. */
function cloneConfig(config) {
  return {
    version: 1,
    boot: { ...config.boot },
    wallpaper: { ...config.wallpaper },
    media: { boot: config.media.boot, wallpaper: config.media.wallpaper },
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Loose boolean coercion. A JSON client sends real booleans; this only has to
 * be forgiving of the usual string/number spellings, never throw.
 */
function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : fallback
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '') return fallback
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
    return true
  }
  return fallback
}

/** A number validator that clamps; a non-number is ignored (fallback kept). */
function asNumberInRange(min, max) {
  return (value, fallback) => {
    if (value === undefined || value === null) return fallback
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, number))
  }
}

const VIDEO_MODE_VALUES = new Set(['loop', 'once'])

function asVideoMode(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return VIDEO_MODE_VALUES.has(normalized) ? normalized : fallback
}

function asFit(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return FIT_VALUES.has(normalized) ? normalized : fallback
}

/** `[key, validator]` tables: iteration order also fixes the JSON key order. */
const BOOT_FIELDS = {
  enabled: asBoolean,
  opacity: asNumberInRange(0, 100),
  fadeInMs: asNumberInRange(0, 3000),
  fadeOutMs: asNumberInRange(0, 3000),
  maxMs: asNumberInRange(1000, 60000),
  muted: asBoolean,
  skip: asBoolean,
  once: asBoolean,
}

const WALLPAPER_FIELDS = {
  enabled: asBoolean,
  opacity: asNumberInRange(0, 100),
  blurPx: asNumberInRange(0, 40),
  dim: asNumberInRange(0, 100),
  fit: asFit,
  surfaceAlpha: asNumberInRange(40, 100),
  videoMode: asVideoMode,
}

function fillFields(target, source, fields) {
  for (const key of Object.keys(fields)) {
    target[key] = fields[key](source[key], target[key])
  }
}

/** One stored media reference, validated; anything unusable becomes null. */
function normalizeMediaEntry(entry) {
  if (!isRecord(entry)) return null
  const file = typeof entry.file === 'string' ? entry.file : ''
  if (!isSafeMediaFile(file)) return null
  const storedMime = typeof entry.mime === 'string' ? entry.mime.trim().toLowerCase() : ''
  const extension = extensionOf(file)
  const mime = KNOWN_MIME.has(storedMime) ? storedMime : (EXTENSION_MIME[extension] ?? 'application/octet-stream')
  const bytes =
    typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) && entry.bytes >= 0 ? Math.floor(entry.bytes) : 0
  const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
  const displayName = rawName === '' ? file : rawName.slice(0, DISPLAY_NAME_LIMIT)
  const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
  return { file, mime, bytes, name: displayName, updatedAt }
}

/** Read a *full* config: defaults, then every recognized field, clamped. */
function normalizeConfig(input) {
  const config = defaultConfig()
  if (!isRecord(input)) return config
  fillFields(config.boot, isRecord(input.boot) ? input.boot : {}, BOOT_FIELDS)
  fillFields(config.wallpaper, isRecord(input.wallpaper) ? input.wallpaper : {}, WALLPAPER_FIELDS)
  const media = isRecord(input.media) ? input.media : {}
  config.media.boot = normalizeMediaEntry(media.boot)
  config.media.wallpaper = normalizeMediaEntry(media.wallpaper)
  return config
}

/**
 * Apply a *partial* patch. Only `boot` and `wallpaper` are writable here:
 * `media` and `version` are owned by upload/reset, so a config POST can never
 * point the plugin at a file the user did not upload. Unknown keys are ignored.
 */
function applyPatch(current, patch) {
  const next = cloneConfig(current)
  if (!isRecord(patch)) return next
  if (isRecord(patch.boot)) fillFields(next.boot, patch.boot, BOOT_FIELDS)
  if (isRecord(patch.wallpaper)) fillFields(next.wallpaper, patch.wallpaper, WALLPAPER_FIELDS)
  return next
}
// #endregion

// #region store on disk
/** `$DSH_HOME` (the host's data directory) or `~/.dsh` by default. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

function storeDir() {
  return join(dshHome(), 'boot-skin')
}

function mediaDir() {
  return join(storeDir(), MEDIA_DIR_NAME)
}

function configPath() {
  return join(storeDir(), CONFIG_FILE_NAME)
}

function configBackupPath() {
  return `${configPath()}.bak`
}

function isSafeMediaFile(file) {
  if (typeof file !== 'string') return false
  if (file === '' || file.length > MEDIA_FILE_NAME_LIMIT) return false
  if (file.includes('..')) return false
  return MEDIA_FILE_PATTERN.test(file)
}

/** The absolute path of a stored media file, or null when the name is unsafe. */
function mediaFilePath(file) {
  if (!isSafeMediaFile(file)) return null
  return join(mediaDir(), file)
}

function extensionOf(file) {
  const dot = file.lastIndexOf('.')
  return dot === -1 || dot === file.length - 1 ? '' : file.slice(dot + 1).toLowerCase()
}

/** Create the store directories, and seed a default config the first time. */
function ensureStore() {
  try {
    mkdirSync(storeDir(), { recursive: true })
    mkdirSync(mediaDir(), { recursive: true })
    if (!existsSync(configPath())) writeConfig(defaultConfig())
  } catch {
    /* A read-only DSH_HOME must not stop the plugin from loading; every later
       write fails inside its own handler and becomes a 500 there. */
  }
}

/** Move a corrupt config out of the way, then fall back to a pristine default. */
function quarantineConfig() {
  try {
    copyFileSync(configPath(), configBackupPath())
  } catch {
    /* backup is best effort */
  }
  try {
    writeConfig(defaultConfig())
  } catch {
    /* keep serving defaults from memory */
  }
}

/**
 * Read + validate the config. Missing, unreadable, corrupt or non-object files
 * all resolve to defaults; the corrupt variants are quarantined as `.bak`.
 */
function readConfig() {
  let raw
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch {
    return defaultConfig()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    quarantineConfig()
    return defaultConfig()
  }
  if (!isRecord(parsed)) {
    quarantineConfig()
    return defaultConfig()
  }
  return normalizeConfig(parsed)
}

/** Atomic write: tmp file then rename, so a reader never sees half a file. */
function writeConfig(config) {
  mkdirSync(storeDir(), { recursive: true })
  mkdirSync(mediaDir(), { recursive: true })
  const target = configPath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

/**
 * The cache-busting revision for media URLs: the MEDIA identity, never the
 * config file's fingerprint.
 *
 * It used to be config size+mtime, which meant every settings write minted a new
 * URL — and a slider drag is dozens of writes. The client keys its media element
 * on the URL, so a video wallpaper restarted on every tick of the opacity slider.
 * Only an upload or a reset may change this now; style settings never do.
 */
function mediaRevision(config) {
  const identityOf = (entry) => (entry === null ? '-' : `${entry.file}|${entry.bytes}|${entry.updatedAt}`)
  const source = `${identityOf(config.media.boot)}::${identityOf(config.media.wallpaper)}`
  return createHash('sha1').update(source).digest('hex').slice(0, 12)
}

/** The revision of the config on disk, read fresh. */
function currentMediaRevision() {
  try {
    return mediaRevision(readConfig())
  } catch {
    return 'unreadable'
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path)
  } catch {
    /* already gone, or never created */
  }
}

function closeQuietly(fd) {
  if (fd === undefined || fd === null || fd < 0) return
  try {
    closeSync(fd)
  } catch {
    /* already closed */
  }
}
// #endregion

// #region wire helpers
/** The state document, exactly as the client contract spells it. */
function statePayload() {
  const config = readConfig()
  const revision = mediaRevision(config)
  return {
    config,
    revision,
    urls: {
      boot: config.media.boot === null ? null : `${MEDIA_ROUTE}/boot?v=${revision}`,
      wallpaper: config.media.wallpaper === null ? null : `${MEDIA_ROUTE}/wallpaper?v=${revision}`,
    },
  }
}

/** Send a response, tolerating a socket that already went away. */
function endResponse(res, status, headers, body) {
  try {
    if (res.headersSent !== true) res.writeHead(status, headers)
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      /* nothing left to do */
    }
  }
}

/** A response with headers and no body (304, 416, HEAD). */
function sendEmpty(res, status, headers) {
  endResponse(res, status, headers ?? {}, undefined)
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"ok":false,"error":"unserializable response"}'
  }
  endResponse(res, status, JSON_HEADERS, body)
}

function sendText(res, status, text) {
  endResponse(res, status, TEXT_HEADERS, text)
}

/** Only reply when the response is still writable. */
function replyJson(res, status, payload) {
  if (res.writableEnded === true || res.destroyed === true) return
  sendJson(res, status, payload)
}

/** The first string value of a header, or null. */
function headerValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return String(value[0])
  return null
}

function pathnameOf(req) {
  try {
    return new URL(typeof req.url === 'string' ? req.url : '/', 'http://boot-skin.invalid').pathname
  } catch {
    return ''
  }
}

function queryParam(req, key) {
  const raw = typeof req.url === 'string' ? req.url : ''
  const at = raw.indexOf('?')
  if (at === -1) return null
  try {
    return new URLSearchParams(raw.slice(at + 1)).get(key)
  } catch {
    return null
  }
}

/** `video/mp4; charset=binary` -> `video/mp4`. */
function normalizeMime(value) {
  const header = headerValue(value)
  if (header === null) return null
  const base = header.split(';')[0].trim().toLowerCase()
  return base === '' ? null : base
}

/** The header is URI-encoded; decode it, strip control characters, cap it. */
function displayNameOf(req, slot, mime) {
  const fallback = `${slot}.${MIME_EXTENSION[mime]}`
  const raw = headerValue((req.headers ?? {})['x-file-name'])
  if (raw === null) return fallback
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const cleaned = String(decoded)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, DISPLAY_NAME_LIMIT)
  return cleaned === '' ? fallback : cleaned
}

/**
 * Is this mutating request from a foreign origin?
 *
 * The connection service owns the real fence (Host/Origin + browser session),
 * so it is asked first. When it is absent, fall back to the only check that
 * still holds: a present `Origin` must name the same host as `Host`.
 */
function isForeignRequest(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    const requestRejection = connection === undefined || connection === null ? undefined : connection.requestRejection
    if (typeof requestRejection === 'function') {
      return Boolean(requestRejection.call(connection, req))
    }
  } catch {
    /* the fence itself failed; fall through to the origin check below */
  }
  const headers = req.headers ?? {}
  const origin = headerValue(headers.origin)
  if (origin === null || origin === '') return false
  const host = headerValue(headers.host)
  if (host === null || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}
// #endregion

// #region request bodies
/**
 * Read a JSON body with a hard byte ceiling.
 *
 * `done(failure, body)` is called exactly once; `failure` is `{ status,
 * message }`. Over the limit the request is destroyed immediately — the body is
 * never buffered past the ceiling.
 */
function readBody(req, limit, done) {
  const chunks = []
  let size = 0
  let finished = false
  const finish = (failure, body) => {
    if (finished) return
    finished = true
    done(failure, body)
  }
  req.on('data', (chunk) => {
    if (finished) return
    size += chunk.length
    if (size > limit) {
      finish({ status: 413, message: 'body too large' })
      try {
        req.destroy()
      } catch {
        /* already gone */
      }
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')))
  req.on('error', () => finish({ status: 400, message: 'request error' }))
  req.on('aborted', () => finish({ status: 400, message: 'request aborted' }))
}

/** A distinct error so the upload pipeline can tell "too big" from "disk broke". */
class PayloadTooLargeError extends Error {
  constructor() {
    super('upload too large')
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Stream a request body into `targetPath` while hashing it.
 *
 * Counting happens inside a Transform, so the ceiling is enforced per chunk and
 * the request is destroyed as soon as it is crossed — the oversized body is
 * never fully read, let alone buffered.
 *
 * `done(error, { bytes, digest })`.
 */
function receiveBodyToFile(req, targetPath, limit, done) {
  const hash = createHash('sha256')
  let bytes = 0
  let out
  try {
    out = createWriteStream(targetPath)
  } catch (cause) {
    done(cause)
    return
  }
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > limit) {
        callback(new PayloadTooLargeError())
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  pipeline(req, meter, out, (error) => {
    if (error !== null && error !== undefined) {
      removeQuietly(targetPath)
      done(error)
      return
    }
    if (bytes === 0) {
      removeQuietly(targetPath)
      done(new Error('empty body'))
      return
    }
    done(null, { bytes, digest: hash.digest('hex').slice(0, 16) })
  })
}

function tempFileName() {
  const salt = Math.random().toString(36).slice(2, 10)
  return `.upload-${process.pid.toString(36)}-${Date.now().toString(36)}-${salt}`
}
// #endregion

// #region media bytes
/** `?v=<current revision>` may be cached forever; anything else revalidates. */
function cacheControlFor(rawUrl, revision) {
  if (typeof rawUrl !== 'string' || revision === 'unreadable') return 'no-cache'
  const at = rawUrl.indexOf('?')
  if (at !== -1) {
    try {
      if (new URLSearchParams(rawUrl.slice(at + 1)).get('v') === revision) {
        return 'public, max-age=31536000, immutable'
      }
    } catch {
      /* malformed query string: revalidate */
    }
  }
  return 'no-cache'
}

function etagMatches(header, etag) {
  const value = headerValue(header)
  if (value === null || value === '') return false
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim()
    return trimmed === '*' || trimmed === etag || trimmed.replace(/^W\//, '') === etag
  })
}

/**
 * Parse a single `bytes=` range.
 *
 * Returns null when the header is not a single byte range (serve the whole
 * file), `{ invalid: true }` when it names bytes we cannot satisfy (416), and
 * `{ start, end }` otherwise.
 */
function rangeFor(rawRange, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange.trim())
  if (match === null) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return null
  let start = rawStart === '' ? undefined : Number(rawStart)
  let end = rawEnd === '' ? undefined : Number(rawEnd)
  if (start === undefined) {
    // Suffix form: the last N bytes.
    start = Math.max(0, size - end)
    end = size - 1
  } else if (end === undefined) {
    end = size - 1
  }
  const valid = Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size
  if (!valid) return { invalid: true }
  return { start, end: Math.min(end, size - 1) }
}

/** Pipe bytes through the already-open fd, handing fd ownership to the stream. */
function streamBytes(res, filePath, fd, start, end, status, headers) {
  let stream
  try {
    stream = start === undefined ? createReadStream(filePath, { fd }) : createReadStream(filePath, { fd, start, end })
  } catch {
    closeQuietly(fd)
    sendText(res, 500, 'boot-skin: could not read this media file')
    return
  }
  try {
    if (res.headersSent !== true) res.writeHead(status, headers)
  } catch {
    closeQuietly(fd)
    try {
      res.destroy()
    } catch {
      /* socket already gone */
    }
    return
  }
  // The callback ignores the error on purpose: the headers are already on the
  // wire, so the only possible reaction is letting pipeline tear the socket
  // down. The fd closes with the stream either way.
  pipeline(stream, res, () => {})
}

/** Serve one opened media file; owns (and always releases) `fd`. */
function serveOpenedFile(req, res, fd, filePath, stats, entry, revision) {
  const size = stats.size
  const etag = `"${size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"`
  const lastModified = new Date(stats.mtimeMs).toUTCString()
  const validators = { etag, 'last-modified': lastModified }
  const cacheControl = cacheControlFor(req.url, revision)

  if (etagMatches((req.headers ?? {})['if-none-match'], etag)) {
    closeQuietly(fd)
    sendEmpty(res, 304, { ...validators, 'cache-control': cacheControl })
    return
  }

  const rawRange = headerValue((req.headers ?? {}).range)
  const range = rawRange === null || rawRange.trim() === '' ? null : rangeFor(rawRange, size)
  if (range !== null && range.invalid === true) {
    closeQuietly(fd)
    sendEmpty(res, 416, { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' })
    return
  }

  if (range !== null) {
    const { start, end } = range
    const headers = {
      ...validators,
      'content-type': entry.mime,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
    }
    if (req.method === 'HEAD') {
      closeQuietly(fd)
      sendEmpty(res, 206, headers)
      return
    }
    streamBytes(res, filePath, fd, start, end, 206, headers)
    return
  }

  const headers = {
    ...validators,
    'content-type': entry.mime,
    'content-length': String(size),
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
  }
  if (req.method === 'HEAD') {
    closeQuietly(fd)
    sendEmpty(res, 200, headers)
    return
  }
  streamBytes(res, filePath, fd, undefined, undefined, 200, headers)
}
// #endregion

/**
 * Register the five routes. Registration failures are the one thing that is
 * allowed to leave this plugin: without routes the feature cannot exist, and
 * the host loading path should report that once instead of half-starting.
 */
export function apply(ctx) {
  // Registered FIRST and synchronously: the host collects the injected row table
  // once, at startup, and a handler registered after that collection never
  // contributes. Nothing above this line may await.
  try {
    ctx.effect(
      () => ctx.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          const config = readConfig()
          // Nothing to play means the shell's own boot screen is all the user would
          // see — leave the page completely alone.
          if (config.boot.enabled !== true || config.media.boot === null) return
          const already = table.some(
            (row) =>
              row !== null &&
              typeof row === 'object' &&
              row.kind === 'style' &&
              typeof row.text === 'string' &&
              row.text.indexOf(COVER_MARK_BASE) !== -1,
          )
          if (already) return
          table.push({ kind: 'style', text: COVER_STYLE_TEXT })
          table.push({ kind: 'script', placement: 'head', text: COVER_GUARD_SCRIPT })
        } catch {
          /* a broken config read must never break index rendering */
        }
      }),
      'boot-skin: first-paint cover',
    )
  } catch {
    /* a host without the event keeps the un-covered behaviour */
  }

  ensureStore()

  /** Logging must never be the reason a handler fails. */
  const warn = (cause) => {
    try {
      const logger = ctx.logger
      if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') {
        logger.warn(cause instanceof Error ? cause : new Error(String(cause)))
      }
    } catch {
      /* nothing sensible to do */
    }
  }

  const failJson = (res, cause) => {
    warn(cause)
    replyJson(res, 500, { ok: false, error: 'boot-skin: internal error' })
  }

  // 1. GET /boot-skin/state
  const serveState = (req, res) => {
    try {
      if (req.method !== 'GET') {
        replyJson(res, 405, { ok: false, error: 'GET required' })
        return
      }
      replyJson(res, 200, statePayload())
    } catch (cause) {
      failJson(res, cause)
    }
  }

  // 2. POST /boot-skin/config
  const serveConfig = (req, res) => {
    try {
      if (req.method !== 'POST') {
        replyJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      if (isForeignRequest(ctx, req)) {
        replyJson(res, 403, { ok: false, error: 'forbidden origin' })
        return
      }
      readBody(req, CONFIG_BODY_LIMIT_BYTES, (failure, body) => {
        try {
          if (failure !== null) {
            replyJson(res, failure.status, { ok: false, error: failure.message })
            return
          }
          let patch
          try {
            patch = JSON.parse(body)
          } catch {
            replyJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          if (!isRecord(patch)) {
            replyJson(res, 400, { ok: false, error: 'body must be a JSON object' })
            return
          }
          const current = readConfig()
          const next = applyPatch(current, patch)
          // Only touch the file when something actually changed: every write
          // bumps the revision, and the revision is a media URL.
          if (JSON.stringify(next) !== JSON.stringify(current)) writeConfig(next)
          replyJson(res, 200, statePayload())
        } catch (cause) {
          failJson(res, cause)
        }
      })
    } catch (cause) {
      failJson(res, cause)
    }
  }

  // 3. POST /boot-skin/upload?id=boot|wallpaper
  const serveUpload = (req, res) => {
    try {
      if (req.method !== 'POST') {
        replyJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      if (isForeignRequest(ctx, req)) {
        replyJson(res, 403, { ok: false, error: 'forbidden origin' })
        return
      }
      const slot = queryParam(req, 'id')
      if (slot !== 'boot' && slot !== 'wallpaper') {
        replyJson(res, 400, { ok: false, error: 'id must be boot or wallpaper' })
        return
      }
      const mime = normalizeMime((req.headers ?? {})['content-type'])
      if (mime === null || !ALLOWED_MIME[slot].includes(mime)) {
        replyJson(res, 415, { ok: false, error: `unsupported content-type for ${slot}` })
        return
      }
      const displayName = displayNameOf(req, slot, mime)
      let tempPath
      try {
        mkdirSync(mediaDir(), { recursive: true })
        tempPath = join(mediaDir(), tempFileName())
      } catch (cause) {
        failJson(res, cause)
        return
      }
      receiveBodyToFile(req, tempPath, UPLOAD_LIMIT_BYTES[slot], (error, result) => {
        try {
          if (error !== null && error !== undefined) {
            if (error instanceof PayloadTooLargeError) {
              replyJson(res, 413, { ok: false, error: 'upload too large' })
              return
            }
            if (error.message === 'empty body') {
              replyJson(res, 400, { ok: false, error: 'empty body' })
              return
            }
            if (req.aborted === true || (typeof error === 'object' && error !== null && error.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
              replyJson(res, 400, { ok: false, error: 'upload aborted' })
              return
            }
            failJson(res, error)
            return
          }
          const extension = MIME_EXTENSION[mime]
          const file = `${SLOT_FILE_PREFIX[slot]}-${result.digest}.${extension}`
          const targetPath = join(mediaDir(), file)
          try {
            // Same bytes -> same name: re-uploading a file is idempotent and
            // never leaves a second copy behind.
            if (existsSync(targetPath)) removeQuietly(tempPath)
            else renameSync(tempPath, targetPath)
          } catch (cause) {
            removeQuietly(tempPath)
            failJson(res, cause)
            return
          }
          const current = readConfig()
          const previous = current.media[slot]
          const next = cloneConfig(current)
          next.media[slot] = {
            file,
            mime,
            bytes: result.bytes,
            name: displayName,
            updatedAt: new Date().toISOString(),
          }
          try {
            writeConfig(next)
          } catch (cause) {
            failJson(res, cause)
            return
          }
          if (previous !== null && previous.file !== file) {
            removeQuietly(join(mediaDir(), previous.file))
          }
          replyJson(res, 200, statePayload())
        } catch (cause) {
          removeQuietly(tempPath)
          failJson(res, cause)
        }
      })
    } catch (cause) {
      failJson(res, cause)
    }
  }

  // 4. POST /boot-skin/reset?id=boot|wallpaper
  const serveReset = (req, res) => {
    try {
      if (req.method !== 'POST') {
        replyJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      if (isForeignRequest(ctx, req)) {
        replyJson(res, 403, { ok: false, error: 'forbidden origin' })
        return
      }
      const slot = queryParam(req, 'id')
      if (slot !== 'boot' && slot !== 'wallpaper') {
        replyJson(res, 400, { ok: false, error: 'id must be boot or wallpaper' })
        return
      }
      const current = readConfig()
      const entry = current.media[slot]
      if (entry !== null) {
        const next = cloneConfig(current)
        next.media[slot] = null
        writeConfig(next)
        removeQuietly(join(mediaDir(), entry.file))
      }
      replyJson(res, 200, statePayload())
    } catch (cause) {
      failJson(res, cause)
    }
  }

  // 5. GET|HEAD /boot-skin/media/boot and /boot-skin/media/wallpaper
  const serveMedia = (req, res) => {
    let fd = -1
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        replyJson(res, 405, { ok: false, error: 'GET required' })
        return
      }
      const suffix = pathnameOf(req).slice(MEDIA_ROUTE.length)
      const slot = suffix === '/boot' ? 'boot' : suffix === '/wallpaper' ? 'wallpaper' : null
      if (slot === null) {
        sendText(res, 404, 'boot-skin: no such media slot')
        return
      }
      const entry = readConfig().media[slot]
      if (entry === null) {
        sendText(res, 404, `boot-skin: no ${slot} media uploaded`)
        return
      }
      const filePath = mediaFilePath(entry.file)
      if (filePath === null) {
        sendText(res, 404, 'boot-skin: media file name is not safe')
        return
      }
      try {
        fd = openSync(filePath, 'r')
      } catch (cause) {
        if (cause !== null && typeof cause === 'object' && cause.code === 'ENOENT') {
          sendText(res, 404, 'boot-skin: media file is missing')
          return
        }
        warn(cause)
        sendText(res, 500, 'boot-skin: could not open media file')
        return
      }
      let stats
      try {
        stats = fstatSync(fd)
      } catch (cause) {
        warn(cause)
        closeQuietly(fd)
        sendText(res, 500, 'boot-skin: could not stat media file')
        return
      }
      if (!stats.isFile()) {
        closeQuietly(fd)
        sendText(res, 404, 'boot-skin: media file is missing')
        return
      }
      serveOpenedFile(req, res, fd, filePath, stats, entry, currentMediaRevision())
    } catch (cause) {
      warn(cause)
      closeQuietly(fd)
      sendText(res, 500, 'boot-skin: media unavailable')
    }
  }

  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: STATE_ROUTE, handler: serveState }),
      'boot-skin: state',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: CONFIG_ROUTE, handler: serveConfig }),
      'boot-skin: config',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: UPLOAD_ROUTE, handler: serveUpload }),
      'boot-skin: upload',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: RESET_ROUTE, handler: serveReset }),
      'boot-skin: reset',
    )
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: MEDIA_ROUTE, handler: serveMedia }),
      'boot-skin: media',
    )
  } catch (cause) {
    warn(cause)
    throw cause instanceof Error ? cause : new Error(`boot-skin: route registration failed: ${String(cause)}`)
  }
}
