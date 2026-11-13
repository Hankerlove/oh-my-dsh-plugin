/**
 * Host half of the workspace-scoped Skill / MCP manager.
 *
 * Everything is keyed by a workspace directory, never by the profile, so two
 * projects can keep different skill sets and MCP servers inside one running DSH.
 *
 * Three data planes:
 *   1. Skill visibility — the manager never edits SKILL.md. A prepended
 *      `agent/pre-step` wrapper filters the model-facing `<available_skills>`
 *      catalog for the session's workspace and a tool guard refuses disabled
 *      skills. The catalog message keeps its original `source.entries`, so
 *      dsh-tool-skill's digest stays stable and the catalog is not re-published
 *      on every step.
 *   2. MCP servers — one config list per workspace. Enabled rows are mounted on
 *      each session's own agent context through `@deepseek-ai/dsh-mcp-client`
 *      (the same mechanism the ACP bridge uses); the mounted fiber dies with
 *      the session, so sessions never share a stdio child process.
 *   3. Browser — a `/skill-mcp` route family returns the joined view for one
 *      session and accepts toggles.
 *
 * Persistence: `$DSH_HOME/skill-mcp-manager/config.json` (atomic rename), so the
 * project directory is never polluted.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'skill-mcp-manager'

/**
 * `webServer` carries the browser routes. `agents` and `tools` are injected in a
 * child fiber so a composition without them (headless) still loads the plugin.
 */
export const inject = ['webServer']

const NS = 'skill-mcp-manager'
const BASE = '/skill-mcp'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MAX_SERVERS = 32
const MAX_FIELD = 8192
const MAX_SKILL_CHANGES = 4096

/**
 * Fallback rank table, used only when the running DSH source cannot be read or
 * parsed. The live table is parsed from `@deepseek-ai/dsh-skill-filesystem/lib/index.js`
 * (see {@link loadRankCatalog}) so a DSH upgrade with different ranks keeps
 * working and a failed read is visible in the panel instead of silently wrong.
 */
const BUILTIN_RANK = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

/** Readable labels for the sources DSH ships; unknown sources fall back to their raw id. */
const SOURCE_LABELS = {
  'project-dsh': 'project .dsh/skills',
  'project-agents': 'project .agents/skills',
  custom: 'custom skill dirs',
  'user-dsh': 'user .dsh/skills',
  'user-agents': 'user .agents/skills',
  bundled: 'bundled with DSH',
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const storePath = () => join(dshHome(), NS, 'config.json')

/* ------------------------------------------------------------------ storage */

const emptyStore = () => ({ version: 1, workspaces: {} })

let cache = { mtimeMs: -1, data: emptyStore() }

function normalizeServer(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const serverName = typeof raw.serverName === 'string' ? raw.serverName.trim() : ''
  if (!SERVER_NAME.test(serverName)) return undefined
  const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${transport}-${serverName}`
  const strings = (value) => {
    if (value === null || typeof value !== 'object') return undefined
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (key !== '' && typeof item === 'string') out[key] = item
    }
    return Object.keys(out).length === 0 ? undefined : out
  }
  if (transport === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (command === '') return undefined
    return {
      id,
      serverName,
      transport,
      enabled: raw.enabled !== false,
      command,
      args: Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === 'string') : [],
      env: strings(raw.env),
      cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : undefined,
    }
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) return undefined
  return { id, serverName, transport, enabled: raw.enabled !== false, url, headers: strings(raw.headers) }
}

function normalizeStore(value) {
  const store = emptyStore()
  if (value === null || typeof value !== 'object') return store
  const workspaces = value.workspaces
  if (workspaces === null || typeof workspaces !== 'object') return store
  for (const [path, entry] of Object.entries(workspaces)) {
    if (typeof path !== 'string' || path === '') continue
    const disabled = Array.isArray(entry?.disabledSkills)
      ? entry.disabledSkills.filter((item) => typeof item === 'string' && item !== '')
      : []
    const servers = []
    const seen = new Set()
    for (const raw of Array.isArray(entry?.servers) ? entry.servers : []) {
      const server = normalizeServer(raw)
      if (server === undefined || seen.has(server.id)) continue
      seen.add(server.id)
      servers.push(server)
    }
    store.workspaces[path] = { disabledSkills: [...new Set(disabled)], servers }
  }
  return store
}

/** Last-good store; a corrupt file keeps the previous snapshot instead of throwing. */
async function readStore() {
  const file = storePath()
  let info
  try {
    info = await stat(file)
  } catch {
    cache = { mtimeMs: 0, data: emptyStore() }
    return cache.data
  }
  if (info.mtimeMs === cache.mtimeMs) return cache.data
  try {
    const data = normalizeStore(JSON.parse(await readFile(file, 'utf8')))
    cache = { mtimeMs: info.mtimeMs, data }
    return data
  } catch {
    return cache.data
  }
}

/** Read-modify-write under one promise chain; the file is replaced atomically. */
let writeChain = Promise.resolve()
function updateStore(mutate) {
  const run = writeChain.then(async () => {
    const data = await readStore()
    const draft = normalizeStore(structuredClone(data))
    const result = mutate(draft)
    const file = storePath()
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`)
    await rename(temp, file)
    const info = await stat(file)
    cache = { mtimeMs: info.mtimeMs, data: draft }
    return result
  })
  writeChain = run.catch(() => {})
  return run
}

function entryFor(store, path, create) {
  if (typeof path !== 'string' || path === '') return undefined
  const key = resolve(path)
  let entry = store.workspaces[key]
  if (entry === undefined && create) {
    entry = { disabledSkills: [], servers: [] }
    store.workspaces[key] = entry
  }
  return entry
}

const disabledSetFor = (store, path) => new Set(entryFor(store, path, false)?.disabledSkills ?? [])

/* ------------------------------------------------- rank catalog (DSH source) */

/**
 * The rank table and the directory template of every source are parsed from the
 * running `@deepseek-ai/dsh-skill-filesystem/lib/index.js` instead of being
 * hard-coded here, so a DSH upgrade that renumbers ranks or moves a directory
 * keeps the panel honest, and a parse failure is reported in the panel instead
 * of silently showing wrong priorities.
 */
let rankCatalogPromise

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Nearest ancestor holding `.git`, else the workspace itself — the DSH project-root rule. */
async function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function resolvePackageFile(ctx, spec) {
  const anchor = ctx.get('profileContext')?.installAnchor
  if (typeof anchor === 'string' && anchor !== '') {
    try {
      return createRequire(anchor).resolve(spec)
    } catch {
      /* fall through to ESM resolution */
    }
  }
  try {
    return fileURLToPath(import.meta.resolve(spec))
  } catch {
    return undefined
  }
}

/** `source: "x", rank: SOME_RANK` pairs plus the closest preceding `path:` expression. */
function parseRankCatalog(text, bundledRank) {
  const constants = new Map()
  for (const match of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_RANK)\s*=\s*(\d+)\s*;/g)) {
    constants.set(match[1], Number(match[2]))
  }
  if (bundledRank !== undefined) constants.set('BUNDLED_SKILL_RANK', bundledRank)
  const groups = []
  const fallbackFor = []
  for (const match of text.matchAll(/source:\s*"([a-z0-9-]+)"\s*,\s*rank:\s*([A-Z_]+)\s*(?:,|\})/g)) {
    const source = match[1]
    let rank = constants.get(match[2])
    if (rank === undefined) {
      // A constant imported from another package (BUNDLED_SKILL_RANK) without a
      // reachable export: keep the group visible with the builtin fallback and
      // record it, so the panel can show that this row is not source-derived.
      rank = BUILTIN_RANK[source]
      if (rank === undefined) continue
      fallbackFor.push(`${source} (${match[2]})`)
    }
    const before = text.slice(Math.max(0, match.index - 260), match.index)
    const objectStart = before.lastIndexOf('{')
    const segment = objectStart < 0 ? before : before.slice(objectStart)
    const exprs = [...segment.matchAll(/path:\s*(join\([^)]*\)|this\.[A-Za-z0-9_]+|[A-Za-z0-9_]+)/g)]
    // A shorthand `{ path, source, rank }` (custom dirs) keeps the caller-provided path.
    const pathExpr = exprs.at(-1)?.[1]?.trim() ?? (/\bpath\s*,/.test(segment) ? 'path' : undefined)
    groups.push({ source, rank, pathExpr })
  }
  return { groups, fallbackFor }
}

async function loadRankCatalog(ctx) {
  if (rankCatalogPromise !== undefined) return rankCatalogPromise
  rankCatalogPromise = (async () => {
    const builtinGroups = Object.entries(BUILTIN_RANK).map(([source, rank]) => ({
      source,
      rank,
      label: SOURCE_LABELS[source] ?? source,
      pathExpr: undefined,
    }))
    const fallback = { mode: 'fallback', groups: builtinGroups, reason: undefined, sourcePath: undefined }
    try {
      const file = resolvePackageFile(ctx, '@deepseek-ai/dsh-skill-filesystem')
      if (file === undefined) return { ...fallback, reason: 'cannot resolve @deepseek-ai/dsh-skill-filesystem' }
      const text = await readFile(file, 'utf8')
      let bundledRank
      try {
        const skillModule = await import('@deepseek-ai/dsh-skill')
        if (typeof skillModule.BUNDLED_SKILL_RANK === 'number') bundledRank = skillModule.BUNDLED_SKILL_RANK
      } catch {
        /* fall back to reading the constant out of the dsh-skill source below */
      }
      if (bundledRank === undefined) {
        try {
          const skillFile = resolvePackageFile(ctx, '@deepseek-ai/dsh-skill')
          if (skillFile !== undefined) {
            const skillText = await readFile(skillFile, 'utf8')
            const match = skillText.match(/\bconst\s+BUNDLED_SKILL_RANK\s*=\s*(\d+)\s*;/)
            if (match !== null) bundledRank = Number(match[1])
          }
        } catch {
          /* the parser reports the missing group when even the source is unreachable */
        }
      }
      const parsed = parseRankCatalog(text, bundledRank)
      if (parsed.groups.length === 0) return { ...fallback, reason: 'no rank declarations found in the DSH source', sourcePath: file }
      for (const group of parsed.groups) group.label = SOURCE_LABELS[group.source] ?? group.source
      return { mode: 'source', groups: parsed.groups, sourcePath: file, fallbackFor: parsed.fallbackFor }
    } catch (error) {
      return { ...fallback, reason: String(error?.message ?? error) }
    }
  })()
  return rankCatalogPromise
}

const agentsHome = () => process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')

/** Evaluate the parsed `path:` template with the values DSH itself would use. */
function resolveDirectoryTemplate(group, projectRoot) {
  const expr = group.pathExpr
  if (typeof expr !== 'string') return undefined
  const quoted = [...expr.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (expr.startsWith('join(projectRoot')) return resolve(projectRoot, ...quoted)
  if (expr.startsWith('join(this.dshHome')) return resolve(dshHome(), ...quoted)
  if (expr.startsWith('join(this.agentsHome')) return resolve(agentsHome(), ...quoted)
  if (expr === 'this.bundledSkillDir') return process.env.DSH_BUNDLED_SKILL_DIR || undefined
  return undefined
}

/** One row per rank: where it would be read from, how that path was derived, and how many skills it holds. */
async function rankGroupsFor(ctx, cwd, skills) {
  const catalog = await loadRankCatalog(ctx)
  const projectRoot = await findProjectRoot(cwd)
  const observed = new Map()
  for (const skill of skills) {
    if (typeof skill.directory !== 'string' || skill.directory === '') continue
    const dirs = observed.get(skill.source) ?? new Set()
    dirs.add(skill.directory)
    observed.set(skill.source, dirs)
  }
  const groups = new Map()
  for (const parsed of catalog.groups) {
    const directory = resolveDirectoryTemplate(parsed, projectRoot)
    groups.set(parsed.source, {
      rank: parsed.rank,
      source: parsed.source,
      label: parsed.label ?? SOURCE_LABELS[parsed.source] ?? parsed.source,
      directory: directory ?? null,
      kind: directory === undefined ? (typeof parsed.pathExpr === 'string' ? 'pattern' : 'unknown') : 'resolved',
      pattern: parsed.pathExpr ?? null,
      observed: [],
      count: 0,
    })
  }
  for (const [source, dirs] of observed) {
    if (groups.has(source)) continue
    groups.set(source, {
      rank: BUILTIN_RANK[source] ?? 999,
      source,
      label: SOURCE_LABELS[source] ?? source,
      directory: [...dirs].sort()[0] ?? null,
      kind: 'observed',
      pattern: null,
      observed: [...dirs].sort(),
      count: 0,
    })
  }
  for (const [source, group] of groups) {
    const dirs = observed.get(source)
    if (dirs === undefined || dirs.size === 0) continue
    group.observed = [...dirs].sort()
    if (group.directory === null) {
      group.directory = group.observed[0]
      group.kind = 'observed'
    }
  }
  const rows = [...groups.values()].sort((left, right) =>
    left.rank === right.rank ? left.source.localeCompare(right.source) : left.rank - right.rank,
  )
  return {
    groups: rows,
    rankSource: {
      mode: catalog.mode,
      sourcePath: catalog.sourcePath ?? null,
      reason: catalog.reason ?? null,
      fallbackFor: catalog.fallbackFor ?? [],
    },
    rankOf: (source) => groups.get(source)?.rank ?? BUILTIN_RANK[source] ?? 0,
  }
}

/* ------------------------------------------------------ workspace + session */

function workspaceOf(ctx, sessionId) {
  try {
    const items = ctx.get('workspaceRegistry')?.list?.() ?? []
    const hit = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
    if (hit !== undefined) return { workspaceId: hit.workspaceId, path: hit.path, title: hit.title }
  } catch {
    /* registry unavailable */
  }
  return undefined
}

/** The cwd the host itself would use for this session's project roots. */
async function cwdOfAgent(ctx, agent, signal) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory?.ensure !== undefined) {
    try {
      return await workingDirectory.ensure(agent, signal)
    } catch {
      /* fall through to the header value */
    }
  }
  const header = agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd
  return workingDirectory?.defaultDirectory
}

/**
 * Resolve the workspace directory a session belongs to. Writes never fall back
 * to the process default directory, so a missing session cannot land config in
 * the wrong workspace.
 */
async function cwdOfSession(ctx, sessionId, { allowDefault = false } = {}) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent !== undefined) {
    const cwd = await cwdOfAgent(ctx, agent)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  const workspace = workspaceOf(ctx, sessionId)
  if (workspace !== undefined) return workspace.path
  const query = ctx.get('sessionQuery')
  if (query?.observeSession !== undefined) {
    let lease
    try {
      lease = await query.observeSession(sessionId, {})
      const cwd = lease?.projections?.values?.workingDirectory ?? lease?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* session unknown to the host */
    } finally {
      try {
        await lease?.dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
  return allowDefault ? ctx.get('workingDirectory')?.defaultDirectory : undefined
}

/* ------------------------------------------------------------------- skills */

async function listSkills(ctx, sessionId, cwd) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  const presets = ctx.get('agentPresets')
  let registry = ctx.get('skills')
  if (agent !== undefined && presets?.serviceFor !== undefined) {
    try {
      registry = presets.serviceFor(agent, 'skills') ?? registry
    } catch {
      /* preset service not mounted */
    }
  }
  let rows = []
  if (registry?.list !== undefined) {
    try {
      rows = await registry.list({ cwd, scope: agent })
    } catch {
      try {
        rows = await registry.list({ cwd })
      } catch {
        rows = []
      }
    }
  }
  return rows.map((skill) => {
    const path = typeof skill.path === 'string' ? skill.path : undefined
    const source = skill.source ?? 'unknown'
    return {
      name: skill.name,
      path: path ?? null,
      directory: path === undefined ? null : dirname(path),
      description: skill.description ?? '',
      whenToUse: skill.whenToUse ?? null,
      source,
      provider: skill.provider ?? null,
      modelInvocable: skill.invocation?.modelInvocable !== false,
      userInvocable: skill.invocation?.userInvocable !== false,
    }
  })
}

const escapeText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const INCOMPLETE_NOTICE =
  'Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.'

const ZERO_TEXT = {
  initial: [
    'Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
  ],
  update: [
    'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
    'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
  ],
}

const AVAILABLE_TEXT = [
  'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
  'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
]

/**
 * Rebuild the model-facing catalog text for the visible entries.
 *
 * Only the text changes: `source.entries` on the message stays untouched so the
 * digest dsh-tool-skill compares against is unchanged and the catalog is not
 * re-published every step. The wording mirrors dsh-tool-skill 0.2.2; when every
 * skill of a workspace is disabled the intro names that reason instead.
 */
function catalogText(entries, { update, incomplete, filtered }) {
  const lines = entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
  const empty = entries.length === 0
  const intro = update
    ? incomplete
      ? 'Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:'
      : 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
    : empty && filtered
      ? 'Every skill discovered for this workspace is disabled by the user.'
      : empty
        ? 'No skills could be confirmed in this discovery attempt.'
        : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:'
  const availability = empty ? (update ? ZERO_TEXT.update : ZERO_TEXT.initial) : update ? AVAILABLE_TEXT : [
    'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
  ]
  return [
    '<system-reminder>',
    intro,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    ...(incomplete ? [INCOMPLETE_NOTICE, ''] : []),
    ...availability,
    '</system-reminder>',
  ].join('\n')
}

function rewriteCatalog(message, visible) {
  const parts = message?.content
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  const first = parts[0]
  if (first === null || typeof first !== 'object' || typeof first.text !== 'string') return undefined
  // Only touch the catalog this plugin knows how to render.
  if (!first.text.includes('<available_skills>') || !first.text.includes('</available_skills>')) return undefined
  const update = message.source?.update === true
  const incomplete = message.source?.incomplete === true
  return catalogText(visible, { update, incomplete, filtered: true })
}

/* ---------------------------------------------------------------------- MCP */

let mcpModulePromise
async function loadMcpModule(ctx) {
  if (mcpModulePromise !== undefined) return mcpModulePromise
  mcpModulePromise = (async () => {
    try {
      return await import(MCP_CLIENT)
    } catch {
      /* fall back to resolving from the installation the profile booted */
    }
    try {
      const anchor = ctx.get('profileContext')?.installAnchor
      if (typeof anchor === 'string' && anchor !== '') {
        const file = createRequire(anchor).resolve(MCP_CLIENT)
        return await import(pathToFileURL(file).href)
      }
    } catch {
      /* the host cannot reach its own MCP client package */
    }
    return null
  })()
  return mcpModulePromise
}

/** MCP SDK modules used by a one-shot connection probe (same SDK the mounted client uses). */
let mcpSdkPromise
async function loadMcpSdk(ctx) {
  if (mcpSdkPromise !== undefined) return mcpSdkPromise
  mcpSdkPromise = (async () => {
    const resolve = (spec) => {
      const file = resolvePackageFile(ctx, spec)
      return file === undefined ? spec : pathToFileURL(file).href
    }
    const [main, stdio] = await Promise.all([import(resolve('@modelcontextprotocol/client')), import(resolve('@modelcontextprotocol/client/stdio'))])
    return {
      Client: main.Client,
      StreamableHTTPClientTransport: main.StreamableHTTPClientTransport,
      StdioClientTransport: stdio.StdioClientTransport,
    }
  })()
  return mcpSdkPromise
}

/** The same credential-scrubbed parent env the mounted client gives its stdio child. */
async function childEnv(ctx, extra) {
  let base = process.env
  try {
    const file = resolvePackageFile(ctx, '@deepseek-ai/dsh-subprocess')
    const mod = file === undefined ? undefined : await import(pathToFileURL(file).href)
    if (typeof mod?.scrubbedParentEnv === 'function') base = mod.scrubbedParentEnv()
  } catch {
    /* fall back to the raw environment */
  }
  return { ...base, ...(extra ?? {}) }
}

const PROBE_TIMEOUT_MS = 20000

function withTimeout(promise, ms, label) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * One-shot MCP handshake for the editor's "test connection" button: connect,
 * list tools, report server identity, then close. Never persists anything and
 * never registers tools on the live tree.
 */
async function probeServer(ctx, server) {
  const sdk = await loadMcpSdk(ctx)
  const config = toMcpConfig(server, ctx.get('workingDirectory')?.defaultDirectory)
  const env = config.transport === 'stdio' ? await childEnv(ctx, config.env) : undefined
  const transport =
    config.transport === 'stdio'
      ? new sdk.StdioClientTransport({ command: config.command, args: config.args, env, cwd: config.cwd })
      : new sdk.StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
  const client = new sdk.Client(
    { name: 'dsh-skill-mcp-manager-probe', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  const startedAt = Date.now()
  try {
    await withTimeout(client.connect(transport), PROBE_TIMEOUT_MS, 'connect')
    let tools = []
    if (client.getServerCapabilities?.()?.tools !== undefined) {
      const response = await withTimeout(client.listTools(undefined, { cacheMode: 'refresh' }), PROBE_TIMEOUT_MS, 'tools/list')
      tools = (response?.tools ?? []).map((tool) => ({ name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, 200) : undefined }))
    }
    return {
      elapsedMs: Date.now() - startedAt,
      server: client.getServerVersion?.() ?? null,
      instructions: typeof client.getInstructions?.() === 'string' ? client.getInstructions().slice(0, 2000) : null,
      tools,
    }
  } finally {
    try {
      await withTimeout(client.close(), 3000, 'close')
    } catch {
      try {
        await withTimeout(transport.close(), 3000, 'transport close')
      } catch {
        /* the probe process is gone either way */
      }
    }
  }
}

function toMcpConfig(server, cwd) {
  const base = { serverName: server.serverName, failOnStartupError: false, toolCallTimeoutMs: 60000 }
  if (server.transport === 'streamable-http') {
    return { ...base, transport: 'streamable-http', url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
  }
  return {
    ...base,
    transport: 'stdio',
    command: server.command,
    args: [...(server.args ?? [])],
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server.cwd === undefined
      ? {}
      : { cwd: isAbsolute(server.cwd) ? server.cwd : resolve(cwd ?? process.cwd(), server.cwd) }),
  }
}

function mcpToolCount(ctx, agent, serverName) {
  try {
    const definitions = ctx.get('tools')?.definitions?.(agent) ?? []
    let count = 0
    for (const definition of definitions) {
      const name = definition?.name ?? definition?.definition?.name ?? ''
      if (typeof name === 'string' && name.startsWith(`mcp__${serverName}__`)) count += 1
    }
    return count
  } catch {
    return 0
  }
}

/** Live mounting per agent: one fiber per enabled server. */
const mounts = new Map() // agentId -> { agent, path, servers: Map<id, mount>, unavailable? }

async function disposeMount(mount) {
  try {
    await mount.fiber?.dispose?.()
  } catch {
    /* already gone */
  }
  mount.status = 'disposed'
}

/** Reconcile one agent's mounted servers with its workspace config. */
async function syncAgent(ctx, agent) {
  if (agent?.ctx === undefined) return
  const cwd = await cwdOfAgent(ctx, agent)
  if (cwd === undefined) return
  const store = await readStore()
  const entry = entryFor(store, cwd, false)
  const wanted = new Map()
  for (const server of entry?.servers ?? []) if (server.enabled !== false) wanted.set(server.id, server)
  let record = mounts.get(agent.id)
  if (record === undefined) {
    record = { agent, path: cwd, servers: new Map(), unavailable: false }
    mounts.set(agent.id, record)
  }
  record.path = cwd
  for (const [id, mount] of record.servers) {
    if (!wanted.has(id)) {
      record.servers.delete(id)
      await disposeMount(mount)
    }
  }
  if (wanted.size === 0) return
  const module = await loadMcpModule(ctx)
  if (module === null) {
    record.unavailable = true
    return
  }
  record.unavailable = false
  for (const [id, server] of wanted) {
    if (record.servers.has(id)) continue
    const mount = { server, fiber: undefined, status: 'starting', error: undefined }
    record.servers.set(id, mount)
    try {
      const fiber = agent.ctx.plugin(module, toMcpConfig(server, cwd))
      mount.fiber = fiber
      Promise.resolve(fiber).then(
        () => {
          mount.status = 'ready'
        },
        (error) => {
          mount.status = 'failed'
          mount.error = String(error?.message ?? error)
        },
      )
    } catch (error) {
      mount.status = 'failed'
      mount.error = String(error?.message ?? error)
    }
  }
}

function runtimeOf(ctx, sessionId) {
  const record = mounts.get(sessionId)
  if (record === undefined) return { mounted: false, unavailable: false, servers: [] }
  return {
    mounted: true,
    unavailable: record.unavailable === true,
    servers: [...record.servers.values()].map((mount) => ({
      id: mount.server.id,
      serverName: mount.server.serverName,
      transport: mount.server.transport,
      status: mount.status,
      error: mount.error ?? null,
      toolCount: mount.status === 'ready' ? mcpToolCount(ctx, record.agent, mount.server.serverName) : 0,
    })),
  }
}

/* ------------------------------------------------------------------- browser */

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const queryOf = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams

const readBody = (req) =>
  new Promise((resolveBody, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 256 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolveBody(raw === '' ? {} : JSON.parse(raw))
      } catch (cause) {
        reject(cause)
      }
    })
    req.on('error', reject)
  })

function sanitizeServers(input) {
  if (!Array.isArray(input)) throw new Error('servers must be an array')
  if (input.length > MAX_SERVERS) throw new Error(`at most ${MAX_SERVERS} servers per workspace`)
  const servers = []
  const seen = new Set()
  for (const raw of input) {
    const server = normalizeServer(raw)
    if (server === undefined) throw new Error('invalid MCP server entry (serverName / command / url)')
    if (seen.has(server.id)) throw new Error(`duplicate MCP server id ${JSON.stringify(server.id)}`)
    seen.add(server.id)
    for (const value of [server.command, server.url, ...(server.args ?? [])]) {
      if (typeof value === 'string' && value.length > MAX_FIELD) throw new Error('MCP field too long')
    }
    servers.push(server)
  }
  return servers
}

/**
 * Normalise the skill endpoint body into a list of `{ name, enabled }` writes.
 *
 * One row, one rank group, or a drag-selected run all arrive here: the client
 * sends `changes` for mixed states and the older `name`/`names` + `enabled`
 * shape stays supported.
 */
function skillChanges(body) {
  const changes = []
  if (Array.isArray(body?.changes)) {
    for (const change of body.changes) {
      if (typeof change?.name !== 'string' || change.name === '') continue
      changes.push({ name: change.name, enabled: change.enabled !== false })
    }
  } else if (Array.isArray(body?.names)) {
    for (const name of body.names) if (typeof name === 'string' && name !== '') changes.push({ name, enabled: body.enabled !== false })
  } else if (typeof body?.name === 'string' && body.name !== '') {
    changes.push({ name: body.name, enabled: body.enabled !== false })
  }
  if (changes.length > MAX_SKILL_CHANGES) throw new Error(`at most ${MAX_SKILL_CHANGES} skill changes per request`)
  return changes
}

/* -------------------------------------------------------------- global MCP
 *
 * Global MCP servers are ordinary `@deepseek-ai/dsh-mcp-client` entries in the
 * profile patch layer (`<profile>/cordis.patch.yml`), i.e. the same layer a user
 * edits by hand. This plugin only touches the entries it is asked about; every
 * other patch item and every comment stays as written. DSH watches that file on
 * long-lived surfaces (dsh-hmr), so a write is applied to the live tree — a new
 * entry mounts, `disabled: true` disposes it, a removed entry disappears — with
 * no restart. Entries that come from bundle/home patch layers are shown read-only.
 */

const PATCH_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }

/** The YAML parser the host itself uses; resolved from the running installation. */
let yamlPromise
async function loadYaml(ctx) {
  if (yamlPromise !== undefined) return yamlPromise
  yamlPromise = (async () => {
    try {
      return await import('yaml')
    } catch {
      /* fall back to the installation's copy */
    }
    try {
      const anchor = ctx.get('profileContext')?.installAnchor
      if (typeof anchor === 'string' && anchor !== '') {
        const file = createRequire(anchor).resolve('yaml')
        return await import(pathToFileURL(file).href)
      }
    } catch {
      /* no YAML parser available */
    }
    return null
  })()
  return yamlPromise
}

function patchPathOf(ctx) {
  const path = ctx.get('profileContext')?.patchPath
  return typeof path === 'string' && path !== '' ? path : undefined
}

async function readPatchFile(ctx) {
  const yaml = await loadYaml(ctx)
  if (yaml === null) throw new Error('this DSH runtime cannot resolve a YAML parser, so global MCP servers cannot be edited')
  const filename = patchPathOf(ctx)
  if (filename === undefined) throw new Error('this DSH runtime did not expose the profile patch path, so global MCP servers cannot be edited')
  let text = '[]\n'
  let mode
  try {
    const info = await stat(filename)
    mode = info.mode
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const doc = yaml.parseDocument(text, { customTags: [PATCH_JS_TAG] })
  if (doc.errors.length > 0) throw new Error(`profile patch is not valid YAML: ${doc.errors[0].message}`)
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode([])
  if (!yaml.isSeq(doc.contents)) throw new Error('the profile patch must be a YAML sequence of patch items')
  // `[]` parses as a flow sequence; new patch items read better as a block list.
  if (doc.contents.items.length === 0) doc.contents.flow = false
  return { yaml, filename, mode, doc }
}

/** Every mcp-client entry inserted by the profile patch, in file order. */
function patchMcpEntries(yaml, doc) {
  const found = []
  const root = doc.contents
  root.items.forEach((item, patchIndex) => {
    if (!yaml.isMap(item)) return
    const insert = item.get('insert')
    if (!yaml.isSeq(insert)) return
    insert.items.forEach((node, entryIndex) => {
      if (!yaml.isMap(node)) return
      if (node.get('name') !== MCP_CLIENT) return
      const configNode = node.get('config')
      const config = yaml.isMap(configNode) ? configNode.toJSON() : {}
      const id = node.get('id')
      found.push({
        patchIndex,
        entryIndex,
        node,
        id: typeof id === 'string' && id !== '' ? id : undefined,
        config: config ?? {},
        enabled: node.get('disabled') !== true,
      })
    })
  })
  return found
}

/** mcp-client entries from bundle and home layers: visible everywhere, not ours to edit. */
function composedMcpEntries(ctx) {
  try {
    return Array.from(ctx.loader?.entries?.() ?? []).filter(
      (entry) => !entry.options?.group && entry.options?.name === MCP_CLIENT,
    )
  } catch {
    return []
  }
}

const globalKeyOf = (row, index) => `global:${row.id ?? row.serverName ?? 'entry'}:${index}`

async function globalMcpRows(ctx) {
  let entries = []
  let error
  try {
    const { yaml, doc } = await readPatchFile(ctx)
    entries = patchMcpEntries(yaml, doc)
  } catch (cause) {
    error = String(cause?.message ?? cause)
  }
  const rows = []
  const claimed = new Set()
  entries.forEach((entry, index) => {
    const server = normalizeServer({ ...entry.config, ...(entry.enabled ? {} : { enabled: false }) })
    const serverName = server?.serverName ?? (typeof entry.config.serverName === 'string' ? entry.config.serverName : null)
    if (serverName !== null) claimed.add(serverName)
    rows.push({
      scope: 'global',
      key: globalKeyOf({ ...entry, serverName }, index),
      id: entry.id ?? null,
      entryId: entry.id === undefined ? null : `include:${entry.id}`,
      serverName,
      transport: server?.transport ?? entry.config.transport ?? 'stdio',
      enabled: entry.enabled,
      editable: true,
      origin: 'profile',
      server: server ?? null,
    })
  })
  for (const entry of composedMcpEntries(ctx)) {
    const config = entry.options?.config
    const serverName = typeof config?.serverName === 'string' ? config.serverName : null
    if (serverName !== null && claimed.has(serverName)) continue
    const enabled = !entry.disabled
    rows.push({
      scope: 'global',
      key: `entry:${entry.id}`,
      id: null,
      entryId: entry.id,
      serverName,
      transport: config?.transport ?? 'stdio',
      enabled,
      editable: false,
      origin: 'layer',
      server: normalizeServer({ ...config, enabled }) ?? null,
    })
  }
  return { rows, error: error ?? null }
}

/** Write the document back atomically, after proving it still parses as a patch list. */
async function writePatchFile(ctx, { yaml, filename, mode, doc }) {
  const text = String(doc)
  const reparsed = yaml.parse(text, { customTags: [PATCH_JS_TAG] })
  if (!Array.isArray(reparsed)) throw new Error('refusing to write a profile patch that is not a sequence')
  const temp = `${filename}.${process.pid}.skill-mcp.tmp`
  await writeFile(temp, text, mode === undefined ? {} : { mode })
  await rename(temp, filename)
}

function findPatchEntry(entries, selector) {
  if (selector !== null && typeof selector === 'object') {
    if (typeof selector.id === 'string' && selector.id !== '') {
      const byId = entries.find((entry) => entry.id === selector.id)
      if (byId !== undefined) return byId
    }
    if (typeof selector.serverName === 'string' && selector.serverName !== '') {
      const byName = entries.find((entry) => entry.config?.serverName === selector.serverName)
      if (byName !== undefined) return byName
    }
  }
  return undefined
}

function entryConfigOf(server) {
  const base = { serverName: server.serverName, transport: server.transport }
  if (server.transport === 'stdio') {
    return {
      ...base,
      command: server.command,
      ...((server.args ?? []).length === 0 ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    }
  }
  return { ...base, url: server.url, ...(server.headers === undefined ? {} : { headers: { ...server.headers } }) }
}

/** Unique entry id for the composition: ids are global to the loader tree. */
function uniqueGlobalId(ctx, entries, serverName) {
  const taken = new Set()
  for (const entry of entries) if (entry.id !== undefined) taken.add(entry.id)
  try {
    for (const entry of ctx.loader?.entries?.() ?? []) {
      if (typeof entry.id === 'string') taken.add(entry.id.replace(/^include:/, ''))
      if (typeof entry.options?.id === 'string') taken.add(entry.options.id)
    }
  } catch {
    /* loader unavailable: the patch-file ids are enough */
  }
  const base = `mcp-${serverName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '') || 'server'}`
  let id = base
  let index = 2
  while (taken.has(id)) id = `${base}-${index++}`
  return id
}

/** Two mounts of one serverName publish the same tool names: refuse that across scopes. */
function assertGlobalNameFree(ctx, store, global, server, selector) {
  const own = findPatchEntryName(global, selector)
  for (const [path, entry] of Object.entries(store.workspaces ?? {})) {
    for (const other of entry.servers ?? []) {
      if (other.serverName === server.serverName) {
        throw new Error(`server name "${server.serverName}" is already used by a workspace MCP server (${path})`)
      }
    }
  }
  for (const row of global.rows) {
    if (row.editable !== true || row.serverName !== server.serverName) continue
    if (selector !== undefined && selector !== null && (row.id === selector.id || row.serverName === selector.serverName)) continue
    if (own !== undefined && row.serverName === own) continue
    throw new Error(`server name "${server.serverName}" is already used by another global MCP server`)
  }
}

function findPatchEntryName(global, selector) {
  if (selector === undefined || selector === null) return undefined
  for (const row of global.rows) {
    if (row.editable !== true) continue
    if (typeof selector.id === 'string' && selector.id !== '' && row.id === selector.id) return row.serverName
    if (typeof selector.serverName === 'string' && selector.serverName !== '' && row.serverName === selector.serverName) return row.serverName
  }
  return undefined
}

function assertWorkspaceNameFree(store, global, cwd, server, selector) {
  for (const [path, entry] of Object.entries(store.workspaces ?? {})) {
    for (const other of entry.servers ?? []) {
      if (other.serverName !== server.serverName) continue
      const same = path === cwd && selector !== undefined && selector !== null && (other.id === selector.id || other.serverName === selector.serverName)
      if (same) continue
      throw new Error(`server name "${server.serverName}" is already used by another MCP server (${path})`)
    }
  }
  for (const row of global.rows) {
    if (row.serverName === server.serverName) throw new Error(`server name "${server.serverName}" is already used by a global MCP server`)
  }
}

function uniqueServerId(servers, server) {
  const taken = new Set(servers.map((item) => item.id))
  const base = server.id
  let id = base
  let index = 2
  while (taken.has(id)) id = `${base}-${index++}`
  return id
}

async function saveWorkspaceServer(ctx, cwd, server, selector) {
  let savedId = server.id
  await updateStore((store) => {
    const entry = entryFor(store, cwd, true)
    let index = -1
    if (selector !== undefined && selector !== null) {
      if (typeof selector.id === 'string' && selector.id !== '') index = entry.servers.findIndex((item) => item.id === selector.id)
      if (index < 0 && typeof selector.serverName === 'string' && selector.serverName !== '') {
        index = entry.servers.findIndex((item) => item.serverName === selector.serverName)
      }
    }
    if (index < 0) {
      if (entry.servers.length >= MAX_SERVERS) throw new Error(`at most ${MAX_SERVERS} MCP servers per workspace`)
      savedId = uniqueServerId(entry.servers, server)
      entry.servers.push({ ...server, id: savedId })
    } else {
      savedId = entry.servers[index].id
      entry.servers[index] = { ...server, id: savedId }
    }
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) void syncAgent(ctx, agent).catch(() => {})
  return { id: savedId, applied: true, restartRequired: false }
}

/**
 * Apply a patch write to the live tree now instead of waiting for dsh-hmr's
 * debounced watcher: the same reconciliation the watcher runs, called through
 * the HMR transaction queue. The watcher then re-reads an unchanged file and
 * does nothing.
 */
async function reconcileProfileNow(ctx) {
  const hmr = ctx.get('hmr')
  if (hmr === null || hmr === undefined) return false
  if (typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') return false
  try {
    await hmr.runExclusive(() => hmr.reconcileProfile([]))
    return true
  } catch {
    return false
  }
}

/** Wait until the live tree reflects a patch write (dsh-hmr debounces the file change). */
async function waitForGlobal(ctx, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (predicate()) return true
    } catch {
      /* tree mid-reload */
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
}

function liveGlobalEntry(ctx, { id, serverName }) {
  for (const entry of composedMcpEntries(ctx)) {
    const config = entry.options?.config
    if (id !== null && id !== undefined) {
      if (entry.id === `include:${id}` || entry.options?.id === id) return entry
    }
    if (typeof serverName === 'string' && config?.serverName === serverName) return entry
  }
  return undefined
}

async function saveGlobalServer(ctx, store, server, previous) {
  const loaded = await readPatchFile(ctx)
  const { yaml, doc } = loaded
  const entries = patchMcpEntries(yaml, doc)
  const existing = findPatchEntry(entries, previous)
  const patch = entryConfigOf(server)
  let id
  if (existing === undefined) {
    id = uniqueGlobalId(ctx, entries, server.serverName)
    const node = doc.createNode({ id, name: MCP_CLIENT, config: patch, ...(server.enabled ? {} : { disabled: true }) })
    const item = doc.createNode({ insert: [node] })
    item.flow = false
    doc.add(item)
  } else {
    id = existing.id
    existing.node.set('config', doc.createNode(patch))
    if (server.enabled) existing.node.delete('disabled')
    else existing.node.set('disabled', true)
  }
  await writePatchFile(ctx, loaded)
  await reconcileProfileNow(ctx)
  const applied = await waitForGlobal(ctx, () => {
    const live = liveGlobalEntry(ctx, { id, serverName: server.serverName })
    return live !== undefined && !live.disabled === server.enabled
  })
  return { id: id ?? null, applied, restartRequired: ctx.get('hmr') === undefined }
}

async function toggleGlobalServer(ctx, selector, enabled) {
  const loaded = await readPatchFile(ctx)
  const { yaml, doc } = loaded
  const entries = patchMcpEntries(yaml, doc)
  const existing = findPatchEntry(entries, selector)
  if (existing === undefined) throw new Error('that global MCP server is no longer in the profile patch')
  if (enabled) existing.node.delete('disabled')
  else existing.node.set('disabled', true)
  await writePatchFile(ctx, loaded)
  await reconcileProfileNow(ctx)
  const applied = await waitForGlobal(ctx, () => {
    const live = liveGlobalEntry(ctx, { id: existing.id, serverName: existing.config?.serverName })
    return live !== undefined && !live.disabled === enabled
  })
  return { applied, restartRequired: ctx.get('hmr') === undefined }
}

async function deleteGlobalServer(ctx, selector) {
  const loaded = await readPatchFile(ctx)
  const { yaml, doc } = loaded
  const entries = patchMcpEntries(yaml, doc)
  const existing = findPatchEntry(entries, selector)
  if (existing === undefined) throw new Error('that global MCP server is no longer in the profile patch')
  const insert = doc.contents.items[existing.patchIndex]?.get?.('insert')
  if (insert === undefined || !yaml.isSeq(insert)) throw new Error('the profile patch item for that server is not an insert list')
  if (insert.items.length <= 1 && doc.contents.items[existing.patchIndex]?.items?.length === 1) {
    doc.deleteIn([existing.patchIndex])
  } else {
    doc.deleteIn([existing.patchIndex, 'insert', existing.entryIndex])
    const remaining = doc.contents.items[existing.patchIndex]?.get?.('insert')
    if (yaml.isSeq(remaining) && remaining.items.length === 0) doc.deleteIn([existing.patchIndex, 'insert'])
  }
  // A hand-added `{ id, disabled }` override would dangle: drop it with the entry.
  if (existing.id !== undefined) {
    for (let index = doc.contents.items.length - 1; index >= 0; index -= 1) {
      const item = doc.contents.items[index]
      if (!yaml.isMap(item) || item.has('insert')) continue
      if (item.get('id') === existing.id) doc.deleteIn([index])
    }
  }
  await writePatchFile(ctx, loaded)
  await reconcileProfileNow(ctx)
  const applied = await waitForGlobal(ctx, () => liveGlobalEntry(ctx, { id: existing.id, serverName: existing.config?.serverName }) === undefined)
  return { applied, restartRequired: ctx.get('hmr') === undefined }
}

async function viewOf(ctx, store, sessionId, cwd) {
  const workspace = workspaceOf(ctx, sessionId)
  const entry = entryFor(store, cwd, false)
  const disabled = new Set(entry?.disabledSkills ?? [])
  const servers = (entry?.servers ?? []).map((server) => ({
    ...server,
    scope: 'workspace',
    editable: true,
    envKeys: server.env === undefined ? [] : Object.keys(server.env),
    headerKeys: server.headers === undefined ? [] : Object.keys(server.headers),
  }))
  const global = await globalMcpRows(ctx)
  return {
    ok: true,
    workspace: { workspaceId: workspace?.workspaceId ?? null, title: workspace?.title ?? null, path: cwd ?? null },
    skills: [],
    rank: { groups: [], source: null },
    disabled: [...disabled],
    mcp: {
      servers,
      global: global.rows,
      globalError: global.error,
      runtime: runtimeOf(ctx, sessionId),
      patchPath: patchPathOf(ctx) ?? null,
    },
  }
}

export function apply(ctx) {
  void readStore() // warm the snapshot used by the synchronous tool guard

  // Mount MCP servers for sessions that already exist when the plugin loads.
  ctx.inject(['agents'], (sub) => {
    try {
      for (const agent of sub.agents.roots()) void syncAgent(ctx, agent).catch(() => {})
    } catch {
      /* registry not ready */
    }
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent !== undefined) void syncAgent(ctx, agent).catch(() => {})
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== undefined) mounts.delete(agent.id)
  })

  /**
   * Model-facing catalog filter. Registered with `prepend` so it wraps
   * dsh-tool-skill's own pre-step listener and sees the catalog it produced.
   */
  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      const decision = await next()
      try {
        if (decision?.kind === 'reject') return decision
        const messages = Array.isArray(decision?.messages) ? decision.messages : undefined
        if (messages === undefined) return decision
        const index = messages.findIndex((message) => message?.source?.kind === 'skill-catalog')
        if (index < 0) return decision
        const message = messages[index]
        const entries = Array.isArray(message.source?.entries) ? message.source.entries : []
        const cwd = await cwdOfAgent(ctx, agent, signal)
        if (cwd === undefined) return decision
        const disabled = disabledSetFor(await readStore(), cwd)
        if (disabled.size === 0) return decision
        const visible = entries.filter((entry) => !disabled.has(entry.name))
        if (visible.length === entries.length) return decision
        const text = rewriteCatalog(message, visible)
        if (text === undefined) return decision
        const clone = structuredClone(message)
        clone.content = clone.content.map((part, partIndex) => (partIndex === 0 ? { ...part, text } : part))
        const nextMessages = [...messages]
        nextMessages[index] = clone
        return { ...decision, messages: nextMessages }
      } catch {
        // Fail open: an unexpected message shape must never break a step.
        return decision
      }
    },
    { prepend: true },
  )

  // Refuse disabled skills even when the model names one directly.
  ctx.inject(['tools'], (sub) => {
    sub.effect(
      () =>
        sub.tools.guard((exec) => {
          try {
            if (exec?.name !== 'skill') return undefined
            const agent = exec.agent
            if (agent === undefined) return undefined
            const name = exec.arguments?.name
            if (typeof name !== 'string') return undefined
            const cwd = agent.session?.header?.cwd ?? ctx.get('workingDirectory')?.defaultDirectory
            if (cwd === undefined) return undefined
            if (!disabledSetFor(cache.data, cwd).has(name)) return undefined
            return `skill "${name}" is disabled for this workspace in the skills panel; ask the user to enable it there`
          } catch {
            return undefined
          }
        }),
      'skill-mcp-manager: skill guard',
    )
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${BASE}/view`,
        handler: async (req, res) => {
          try {
            const sessionId = queryOf(req).get('session') ?? ''
            const store = await readStore()
            const cwd = await cwdOfSession(ctx, sessionId, { allowDefault: true })
            const view = await viewOf(ctx, store, sessionId, cwd)
            const disabled = new Set(view.disabled)
            if (cwd !== undefined) {
              const listed = await listSkills(ctx, sessionId, cwd)
              const ranked = await rankGroupsFor(ctx, cwd, listed)
              view.skills = listed.map((skill) => ({ ...skill, rank: ranked.rankOf(skill.source), enabled: !disabled.has(skill.name) }))
              for (const group of ranked.groups) group.count = view.skills.filter((skill) => skill.source === group.source).length
              view.rank = { groups: ranked.groups, source: ranked.rankSource }
            }
            view.mcp.available = (await loadMcpModule(ctx)) !== null
            send(res, 200, view)
          } catch (error) {
            send(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'skill-mcp-manager: view route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${BASE}/skills`,
        handler: async (req, res) => {
          try {
            const body = await readBody(req)
            const sessionId = typeof body.session === 'string' ? body.session : ''
            const changes = skillChanges(body)
            if (changes.length === 0) throw new Error('skill name is required')
            const cwd = await cwdOfSession(ctx, sessionId)
            if (cwd === undefined) throw new Error('session has no workspace')
            await updateStore((store) => {
              const entry = entryFor(store, cwd, true)
              const disabled = new Set(entry.disabledSkills)
              for (const change of changes) {
                if (change.enabled) disabled.delete(change.name)
                else disabled.add(change.name)
              }
              entry.disabledSkills = [...disabled]
            })
            send(res, 200, { ok: true, changed: changes.length })
          } catch (error) {
            send(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'skill-mcp-manager: skill route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${BASE}/mcp`,
        handler: async (req, res) => {
          try {
            const body = await readBody(req)
            const sessionId = typeof body.session === 'string' ? body.session : ''
            const scope = body.scope === 'global' ? 'global' : 'workspace'
            const cwd = await cwdOfSession(ctx, sessionId)
            if (body.action === 'test') {
              const draft = sanitizeServers([body.server])[0]
              const result = await probeServer(ctx, draft)
              send(res, 200, { ok: true, result })
              return
            }
            if (cwd === undefined && scope !== 'global') throw new Error('session has no workspace')
            const store = await readStore()
            const global = await globalMcpRows(ctx)
            if (global.error !== null) throw new Error(global.error)
            const selector = body.previous !== undefined && body.previous !== null ? body.previous : body
            if (body.action === 'save') {
              const server = sanitizeServers([body.server])[0]
              if (scope === 'global') {
                await assertGlobalNameFree(ctx, store, global, server, selector)
                const saved = await saveGlobalServer(ctx, store, server, selector)
                send(res, 200, { ok: true, ...saved })
              } else {
                assertWorkspaceNameFree(store, global, cwd, server, selector)
                const saved = await saveWorkspaceServer(ctx, cwd, server, selector)
                send(res, 200, { ok: true, ...saved })
              }
              return
            }
            if (body.action === 'toggle') {
              if (scope === 'global') {
                const saved = await toggleGlobalServer(ctx, selector, body.enabled !== false)
                send(res, 200, { ok: true, ...saved })
              } else {
                await updateStore((draft) => {
                  const entry = entryFor(draft, cwd, true)
                  for (const server of entry.servers) {
                    if (server.id === selector.id || server.serverName === selector.serverName) server.enabled = body.enabled !== false
                  }
                })
                for (const agent of ctx.get('agents')?.list?.() ?? []) void syncAgent(ctx, agent).catch(() => {})
                send(res, 200, { ok: true, applied: true, restartRequired: false })
              }
              return
            }
            if (body.action === 'delete') {
              if (scope === 'global') {
                const saved = await deleteGlobalServer(ctx, selector)
                send(res, 200, { ok: true, ...saved })
              } else {
                await updateStore((draft) => {
                  const entry = entryFor(draft, cwd, true)
                  entry.servers = entry.servers.filter(
                    (server) => server.id !== selector.id && server.serverName !== selector.serverName,
                  )
                })
                for (const agent of ctx.get('agents')?.list?.() ?? []) void syncAgent(ctx, agent).catch(() => {})
                send(res, 200, { ok: true, applied: true, restartRequired: false })
              }
              return
            }
            throw new Error(`unknown action ${JSON.stringify(body.action)}`)
          } catch (error) {
            send(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'skill-mcp-manager: mcp route',
  )

  ctx.effect(
    () => () => {
      for (const record of mounts.values()) for (const mount of record.servers.values()) void disposeMount(mount)
      mounts.clear()
    },
    'skill-mcp-manager: mcp mounts',
  )
}
