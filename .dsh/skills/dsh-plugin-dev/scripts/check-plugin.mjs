#!/usr/bin/env node
/**
 * check-plugin.mjs — 本仓库插件的静态自检。
 *
 * 用法：
 *   node check-plugin.mjs                      # 检查 packages/* 全部插件
 *   node check-plugin.mjs packages/dsh-demo    # 检查单个插件
 *   node check-plugin.mjs packages/dsh-demo --repo
 *                                              # 额外校验根 README 与 market/index.json
 *                                              # （--repo 时以当前目录为仓库根）
 *
 * 只做「确定性、装完才会暴露」的检查：exports/files 覆盖、patch 行、
 * locale meta、client module id、README 必需章节、语法。行为验收仍需人工。
 *
 * 只依赖 Node 内置模块。退出码：0 无 FAIL；1 有 FAIL。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const targets = args.filter((arg) => !arg.startsWith('--'))
const knownFlags = new Set(['--repo', '--help', '-h'])
for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    console.error(`check-plugin: 未知参数 ${flag}`)
    process.exit(1)
  }
}
if (flags.has('--help') || flags.has('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'))
  process.exit(0)
}

const useRepo = flags.has('--repo')
const detectedRoot = findRepoRoot(process.cwd())
const repoRoot = detectedRoot
if (useRepo && repoRoot === null) {
  console.error('check-plugin: --repo 需要在 oh-my-dsh-plugin 仓库内执行（找不到仓库根）')
  process.exit(1)
}
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const NAME = /^(@[a-z0-9][\w.-]*\/)?dsh-[a-z0-9][a-z0-9-]*$/


/** 向上寻找仓库根：包名 oh-my-dsh-plugin，或 pnpm-workspace.yaml + packages/。 */
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

const results = []

function checkPackage(dir) {
  const issues = []
  const fail = (message) => issues.push({ level: 'FAIL', message })
  const warn = (message) => issues.push({ level: 'WARN', message })
  const read = (file) => readFileSync(join(dir, file), 'utf8')
  const exists = (file) => existsSync(join(dir, file))

  let manifest
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail('缺少 package.json')
    return { dir, issues }
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`package.json 不是合法 JSON：${error.message}`)
    return { dir, issues }
  }

  const name = manifest.name
  const version = manifest.version
  if (typeof name !== 'string' || !NAME.test(name)) fail(`包名不合法：${name}（应为 dsh-<短名> 或 @scope/dsh-<短名>）`)
  if (typeof version !== 'string' || !SEMVER.test(version)) fail(`version 不是 SemVer：${version}`)
  if (manifest.license !== 'MIT') warn(`license 应为 MIT（当前 ${manifest.license ?? '缺失'}）`)
  if (manifest.type !== 'module') fail('缺少 "type": "module"（纯 ESM 插件必需）')
  if (manifest.private === true) fail('private: true 的包不能发布')

  if (typeof manifest.main !== 'string') warn('缺少 main 字段；Host 侧解析依赖 exports，但建议保留 main: "index.js"')

  const exportsField = manifest.exports
  if (exportsField === null || typeof exportsField !== 'object') {
    fail('缺少 exports 对象')
  } else {
    for (const key of ['.', './client']) {
      if (!(key in exportsField)) fail(`exports 缺少 "${key}"`)
    }
    if (!('./locale/*.json' in exportsField)) warn('exports 缺少 "./locale/*.json"（插件管理与市场展示需要）')
    if (!('./icon' in exportsField)) warn('exports 缺少 "./icon"（插件管理与市场展示需要）')
  }

  const files = Array.isArray(manifest.files) ? manifest.files : null
  if (files === null) fail('缺少 files 数组（npm 包会漏运行时文件）')

  /** 简化 npm files 匹配：支持字面路径/目录与 * 通配。 */
  const covered = (relative) => {
    if (files === null) return false
    const escaped = (pattern) =>
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('**', '\u0000')
        .replaceAll('*', '[^/]*')
        .replaceAll('\u0000', '.*')
    return files.some((entry) => {
      const normalized = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
      if (normalized === relative) return true
      if (!/[*]/.test(normalized) && relative.startsWith(`${normalized}/`)) return true
      return new RegExp(`^${escaped(normalized)}$`).test(relative)
    })
  }

  // ── 运行时文件：必须存在、被 exports 指向、被 files 覆盖 ─────────────────
  const runtimeFiles = new Set()
  const addRuntime = (relative) => runtimeFiles.add(relative)
  if (typeof manifest.main === 'string') addRuntime(manifest.main.replace(/^\.\//, ''))
  if (exportsField && typeof exportsField === 'object') {
    for (const value of Object.values(exportsField)) {
      if (typeof value === 'string' && !value.includes('*')) addRuntime(value.replace(/^\.\//, ''))
    }
  }
  const patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string') {
    fail('缺少 dsh.bundle.patch（装成依赖也不会成为一层 patch）')
  } else {
    addRuntime(patchRel.replace(/^\.\//, ''))
  }
  if (exists('client.js')) addRuntime('client.js')
  if (exists('icon.svg')) addRuntime('icon.svg')
  if (exists('locale')) {
    for (const file of readdirSync(join(dir, 'locale'))) {
      if (file.endsWith('.json')) addRuntime(`locale/${file}`)
    }
  }
  for (const relative of runtimeFiles) {
    if (!exists(relative)) {
      fail(`运行时文件不存在：${relative}`)
      continue
    }
    if (!covered(relative)) fail(`files 未覆盖运行时文件：${relative}（安装后会缺文件）`)
  }
  for (const entry of files ?? []) {
    const normalized = String(entry).replace(/^\.\//, '')
    if (!normalized.includes('*') && !exists(normalized)) warn(`files 里的路径不存在：${entry}`)
  }

  // ── dsh.client ────────────────────────────────────────────────────────────
  const client = manifest.dsh?.client
  if (client === null || typeof client !== 'object') {
    fail('缺少 dsh.client（浏览器半边不会被加载）')
  } else {
    if (client.platform !== 'web') fail(`dsh.client.platform 应为 "web"（当前 ${client.platform ?? '缺失'}）`)
    if (client.immediately !== true) warn('dsh.client.immediately 建议为 true')
    if (!Array.isArray(client.inject)) warn('dsh.client.inject 建议给出（只影响激活顺序）')
  }

  if (manifest.engines?.dsh === undefined) warn('缺少 engines.dsh（安装/启动的兼容性门禁）')

  // ── 语法 ──────────────────────────────────────────────────────────────────
  for (const half of ['index.js', 'client.js']) {
    if (!exists(half)) {
      if (half === 'client.js' && client !== undefined) fail('缺少 client.js（package.json 声明了 dsh.client）')
      continue
    }
    try {
      execFileSync(process.execPath, ['--check', join(dir, half)], { stdio: 'pipe' })
    } catch (error) {
      fail(`${half} 语法检查失败：${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
    }
  }

  // ── client.js 契约 ────────────────────────────────────────────────────────
  if (exists('client.js')) {
    const text = read('client.js')
    if (!text.includes('window.__ModuleLoader__.load(')) fail('client.js 没有 window.__ModuleLoader__.load({...}) 入口')
    const idMatch = text.match(/\bid:\s*['"]([^'"]+)['"]/)
    if (idMatch === null) warn('client.js 没有找到 module id')
    else if (idMatch[1] !== name) fail(`client.js 的 id (${idMatch[1]}) 必须等于包名 (${name})`)
    if (!/\bfactory\s*\(/.test(text)) fail('client.js 没有 factory(require)')
    if (!text.includes('catch')) warn('client.js 没有 try/catch：装饰性插件建议整体兜底')
    if (!/ctx\.effect\s*\(/.test(text)) warn('client.js 没有使用 ctx.effect 管理资源')
    if (name && text.includes('require(') && /from ['"]react['"]/.test(text)) warn('client.js 不应 import react 源码；用 require("react")')
  }

  // ── index.js 契约 ─────────────────────────────────────────────────────────
  if (exists('index.js')) {
    const text = read('index.js')
    if (!/export\s+function\s+apply\s*\(/.test(text) && !/export\s+default\s+class/.test(text)) {
      warn('index.js 既没有 export function apply 也没有 default Service 类')
    }
  }

  // ── cordis.patch.yml ──────────────────────────────────────────────────────
  if (typeof patchRel === 'string' && exists(patchRel)) {
    const text = read(patchRel)
    if (!/^-\s*(insert|id):/m.test(text)) fail('cordis.patch.yml 不是 patch 数组（应以 - insert: 或 - id: 开头）')
    if (!text.includes('insert:')) warn('cordis.patch.yml 没有 insert 段')
    if (typeof name === 'string' && !text.includes(`'${name}'`) && !text.includes(`"${name}"`) && !text.includes(`name: ${name}`)) {
      fail(`cordis.patch.yml 里的 name 必须引用包名 ${name}`)
    }
    if (!/^\s*(?:-\s*)?id:\s*\S+/m.test(text)) warn('cordis.patch.yml 的行缺少 id')
  }

  // ── locale meta ───────────────────────────────────────────────────────────
  for (const lang of ['zh', 'en']) {
    const file = `locale/${lang}.json`
    if (!exists(file)) continue
    try {
      const parsed = JSON.parse(read(file))
      if (typeof parsed?.meta?.title !== 'string' || parsed.meta.title.trim() === '') fail(`${file} 缺少 meta.title`)
      if (typeof parsed?.meta?.description !== 'string' || parsed.meta.description.trim() === '') {
        fail(`${file} 缺少 meta.description`)
      }
    } catch (error) {
      fail(`${file} 不是合法 JSON：${error.message}`)
    }
  }

  // ── README ────────────────────────────────────────────────────────────────
  if (!exists('README.md')) {
    fail('缺少 README.md')
  } else {
    const text = read('README.md')
    if (!text.includes('## 安装方式')) fail('README 缺少「## 安装方式」章节')
    if (!text.includes('## 许可证')) warn('README 缺少「## 许可证」章节（补一节 MIT 链接）')
    if (!text.includes('## 能做什么')) warn('README 缺少「## 能做什么」章节')
    if (!/## 数据(与隐私|与文件)?/.test(text)) warn('README 缺少「数据」章节（写清数据落在哪）')
    if (typeof name === 'string' && text.includes('版本') && /`\d+\.\d+\.\d+`/.test(text)) {
      warn('README 里疑似写死了版本号（每次发版都会产生无意义 diff）')
    }
  }

  return { dir, name, version, issues }
}

// ── 仓库级检查 ──────────────────────────────────────────────────────────────
function checkRepo(report) {
  const issues = report.issues
  if (!existsSync(join(repoRoot, 'market', 'index.json'))) {
    issues.push({ level: 'WARN', message: '仓库根没有 market/index.json，跳过市场索引检查' })
    return
  }
  const rootReadme = join(repoRoot, 'README.md')
  if (existsSync(rootReadme)) {
    const text = readFileSync(rootReadme, 'utf8')
    if (!text.includes(report.name)) issues.push({ level: 'FAIL', message: `根 README 的插件表没有 ${report.name}` })
  } else {
    issues.push({ level: 'FAIL', message: '仓库根缺少 README.md' })
  }
  try {
    const index = JSON.parse(readFileSync(join(repoRoot, 'market', 'index.json'), 'utf8'))
    const entry = (index.plugins ?? []).find((plugin) => plugin.name === report.name)
    if (entry === undefined) {
      issues.push({
        level: 'FAIL',
        message: `market/index.json 没有 ${report.name}（发版后用 scripts/market-index.mjs 重新生成；新插件的展示文案来自 locale/*.json 的 meta）`,
      })
    } else if ((entry.versions?.[0]?.version ?? '') !== report.version) {
      issues.push({
        level: 'FAIL',
        message: `market/index.json 最新版本 ${entry.versions?.[0]?.version ?? '缺失'} ≠ package.json ${report.version}（发版后重新生成索引）`,
      })
    }
  } catch (error) {
    issues.push({ level: 'FAIL', message: `market/index.json 不是合法 JSON：${error.message}` })
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const resolveTarget = (target) => {
  const fromCwd = resolve(target)
  if (existsSync(fromCwd)) return fromCwd
  if (repoRoot !== null) {
    const fromRepo = resolve(repoRoot, target)
    if (existsSync(fromRepo)) return fromRepo
  }
  return fromCwd
}

const dirs = targets.length > 0
  ? targets.map(resolveTarget)
  : (() => {
      const packagesDir = join(repoRoot ?? process.cwd(), 'packages')
      if (!existsSync(packagesDir)) {
        console.error('check-plugin: 没给目录，且当前目录下没有 packages/')
        process.exit(1)
      }
      return readdirSync(packagesDir)
        .filter((entry) => statSync(join(packagesDir, entry)).isDirectory())
        .map((entry) => join(packagesDir, entry))
    })()

let failed = false
for (const dir of dirs) {
  const report = checkPackage(dir)
  if (useRepo) checkRepo(report)
  const name = report.name ?? dir
  console.log(`\n${name}${report.version ? ` @ ${report.version}` : ''}  (${dir})`)
  if (report.issues.length === 0) {
    console.log('  ✓ 全部检查通过')
    results.push({ name, ok: true })
    continue
  }
  for (const issue of report.issues) {
    if (issue.level === 'FAIL') failed = true
    console.log(`  ${issue.level === 'FAIL' ? '✗' : '!'} ${issue.level === 'FAIL' ? '' : '[warn] '}${issue.message}`)
  }
  results.push({ name, ok: !report.issues.some((issue) => issue.level === 'FAIL') })
}

const failCount = results.filter((result) => !result.ok).length
console.log(`\n${results.length} 个插件：${results.length - failCount} 通过，${failCount} 个有 FAIL`)
process.exit(failed ? 1 : 0)
