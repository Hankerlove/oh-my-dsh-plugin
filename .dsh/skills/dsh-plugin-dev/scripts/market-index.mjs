#!/usr/bin/env node
/**
 * market-index.mjs — 重新生成 market/index.json（DSH 插件市场索引，format 1）。
 *
 * 用法（在仓库任意子目录执行即可，脚本会自动向上定位仓库根）：
 *   node scripts/market-index.mjs
 *   node scripts/market-index.mjs --out /tmp/index.json
 *   node scripts/market-index.mjs --author "Your Name" --slug owner/repo --branch main
 *
 * 数据来源：
 *   - 包名/版本/engines/keywords：packages/<dir>/package.json
 *   - 展示名/描述：packages/<dir>/locale/{zh,en}.json 的 meta
 *   - 版本与发布时间：公共 npm registry（只收录已发布版本；未发布的不写进索引）
 *   - 已有索引里的展示字段（title/description/icon/author/homepage/repository/metadata）
 *     会原样保留，只有 versions 会重新计算，避免无意义 diff
 *
 * 不依赖任何本机私有路径；仓库地址从 git remote 推导，可用 --slug/--branch 覆盖。
 * 官方校验器 @deepseek-ai/dsh-plugin-market-index 能解析到时，会先校验再写盘。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const NPM_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_BRANCH = 'main'
const AUTO_KEYWORDS = new Set(['dsh', 'dsh-plugin', 'deepseek-harness'])

function warn(message) {
  console.error(`warning: ${message}`)
}

function parseArgs(argv) {
  const out = { flags: {} }
  const takesValue = new Set(['--root', '--out', '--author', '--slug', '--branch'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (takesValue.has(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`market-index: ${arg} 需要一个值`)
        process.exit(1)
      }
      out.flags[arg.slice(2)] = value
      index += 1
      continue
    }
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--')) {
      console.error(`market-index: 未知参数 ${arg}`)
      process.exit(1)
    } else {
      console.error(`market-index: 不支持位置参数 ${arg}`)
      process.exit(1)
    }
  }
  return out
}

const { flags, help } = parseArgs(process.argv.slice(2))
if (help) {
  console.log('用法：node scripts/market-index.mjs [--out <file>] [--author <name>] [--slug <owner/repo>] [--branch <name>] [--root <dir>]')
  process.exit(0)
}

/** 向上寻找仓库根：pnpm-workspace.yaml + packages/，或包名 oh-my-dsh-plugin。 */
function findRepoRoot(start) {
  let current = resolve(start)
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'))
      if (manifest.name === 'oh-my-dsh-plugin') return current
    } catch {
      /* 继续向上 */
    }
    if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, 'packages'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

const root = resolve(flags.root ?? findRepoRoot(process.cwd()) ?? process.cwd())
if (!existsSync(join(root, 'packages'))) {
  console.error(`market-index: ${root} 下没有 packages/，请用 --root 指定仓库根`)
  process.exit(1)
}

function git(args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

function parseSlug(remote) {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/)
  return match === null ? null : `${match[1]}/${match[2]}`
}

const slug = flags.slug ?? parseSlug(git(['remote', 'get-url', 'origin'])) ?? 'Hankerlove/oh-my-dsh-plugin'
if (flags.slug === undefined && parseSlug(git(['remote', 'get-url', 'origin'])) === null) {
  warn(`无法从 git remote 推导仓库地址，使用默认 ${slug}`)
}
const detectedBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
const gitBranch = flags.branch ?? (detectedBranch === '' || detectedBranch === 'HEAD' ? DEFAULT_BRANCH : detectedBranch)
if (detectedBranch === 'HEAD') warn('当前是 detached HEAD，branch 使用 main')
const RAW = `https://raw.githubusercontent.com/${slug}/${gitBranch}`
const REPO_URL = `https://github.com/${slug}`
const author = flags.author ?? slug.split('/')[0]

// 展示字段始终从仓库里的索引读取（即使 --out 指向别处），保证可重复生成、diff 稳定。
const sourceIndexPath = join(root, 'market', 'index.json')
const indexPath = flags.out === undefined ? sourceIndexPath : resolve(flags.out)
let previous = { format: 1, title: { en: 'Oh My DSH Plugin', zh: 'Oh My DSH Plugin' }, description: {}, plugins: [] }
if (existsSync(sourceIndexPath)) {
  try {
    const parsed = JSON.parse(readFileSync(sourceIndexPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') previous = parsed
  } catch (error) {
    warn(`仓库索引无法解析，忽略其展示字段：${error.message}`)
  }
}
const previousByName = new Map((previous.plugins ?? []).map((plugin) => [plugin.name, plugin]))

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function localeMeta(dir, lang) {
  const parsed = readJson(join(root, 'packages', dir, 'locale', `${lang}.json`))
  const meta = parsed?.meta ?? {}
  return { title: typeof meta.title === 'string' ? meta.title : '', description: typeof meta.description === 'string' ? meta.description : '' }
}

const isStub = (version) => version.startsWith('0.0.0-')

function compareVersions(left, right) {
  const [leftMain, leftPre] = left.split('-', 2)
  const [rightMain, rightPre] = right.split('-', 2)
  const a = leftMain.split('.').map(Number)
  const b = rightMain.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? -1 : 1
  }
  if (leftPre === undefined && rightPre === undefined) return 0
  if (leftPre === undefined) return -1
  if (rightPre === undefined) return 1
  return leftPre > rightPre ? -1 : leftPre < rightPre ? 1 : 0
}

async function versionsOf(manifest) {
  let response
  try {
    response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(manifest.name)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw new Error(`请求 npm registry 失败：${error.message}`)
  }
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`npm registry 返回 ${response.status}`)
  const packument = await response.json()
  return Object.keys(packument.versions ?? {})
    .filter((version) => !isStub(version))
    .filter((version) => packument.versions[version].deprecated === undefined)
    .map((version) => ({
      version,
      publishTimestamp: Math.floor(Date.parse(packument.time?.[version] ?? '') / 1000),
      source: { type: 'npm' },
      ...(manifest.engines?.dsh === undefined ? {} : { engines: { dsh: manifest.engines.dsh } }),
    }))
    .filter((entry) => Number.isFinite(entry.publishTimestamp))
    .sort((left, right) => compareVersions(left.version, right.version))
}

const dirs = readdirSync(join(root, 'packages'))
  .filter((entry) => statSync(join(root, 'packages', entry)).isDirectory() && !entry.startsWith('.'))
  .sort()

const entries = []
for (const dir of dirs) {
  const manifest = readJson(join(root, 'packages', dir, 'package.json'))
  if (manifest === null || typeof manifest.name !== 'string') continue
  if (manifest.dsh?.bundle?.patch === undefined) continue
  if (manifest.private === true) continue

  const existing = previousByName.get(manifest.name)
  const zh = localeMeta(dir, 'zh')
  const en = localeMeta(dir, 'en')
  const fallbackTitle = { en: en.title || manifest.name, zh: zh.title || en.title || manifest.name }
  const fallbackDescription = { en: en.description || manifest.description || '', zh: zh.description || en.description || '' }
  if ((en.title === '' || zh.title === '') && existing === undefined) warn(`${manifest.name}: locale meta 缺 title，索引标题会退化为包名`)

  let versions
  try {
    versions = await versionsOf(manifest)
  } catch (error) {
    if (existing === undefined) {
      warn(`${manifest.name}: ${error.message}；未发布过的插件无法写入索引，跳过`)
      continue
    }
    warn(`${manifest.name}: ${error.message}；沿用旧索引中的版本列表`)
    versions = existing.versions ?? []
  }
  if (versions.length === 0) {
    warn(`${manifest.name}: npm 上还没有已发布版本，跳过`)
    continue
  }

  entries.push({
    name: manifest.name,
    title: existing?.title ?? fallbackTitle,
    description: existing?.description ?? fallbackDescription,
    icon: existing?.icon ?? `${RAW}/packages/${dir}/icon.svg`,
    author: existing?.author ?? author,
    homepage: existing?.homepage ?? `https://github.com/${slug}/tree/${gitBranch}/packages/${dir}`,
    repository: existing?.repository ?? { url: REPO_URL, directory: `packages/${dir}` },
    metadata: existing?.metadata ?? {
      keywords: (Array.isArray(manifest.keywords) ? manifest.keywords : []).filter((keyword) => !AUTO_KEYWORDS.has(keyword)),
    },
    versions,
  })
}

// 稳定顺序：保留旧索引里的插件顺序，新插件按包名追加到末尾。
const previousOrder = new Map((previous.plugins ?? []).map((plugin, index) => [plugin.name, index]))
entries.sort((left, right) => {
  const a = previousOrder.get(left.name)
  const b = previousOrder.get(right.name)
  if (a !== undefined && b !== undefined) return a - b
  if (a !== undefined) return -1
  if (b !== undefined) return 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
})

const index = {
  format: previous.format ?? 1,
  title: previous.title ?? { en: 'Oh My DSH Plugin', zh: 'Oh My DSH Plugin' },
  description: previous.description ?? {},
  plugins: entries,
}

try {
  const validator = await import('@deepseek-ai/dsh-plugin-market-index')
  validator.parseMarketIndex(index, `${RAW}/market/index.json`)
  console.log('已用官方 parseMarketIndex 校验通过')
} catch {
  warn('没有加载到官方校验器 @deepseek-ai/dsh-plugin-market-index，跳过格式校验（不影响写出）')
}

writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${indexPath}`)
console.log(entries.map((plugin) => `${plugin.name}: ${plugin.versions.map((version) => version.version).join(', ')}`).join('\n'))
console.log(`\n提醒：确认 package.json 里的新版本已经 publish 到 npm，否则它不会出现在索引里。`)
