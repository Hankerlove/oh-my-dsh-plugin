#!/usr/bin/env node
/**
 * scaffold-plugin.mjs — 生成符合 oh-my-dsh-plugin 现行约定的纯 ESM 插件骨架。
 *
 * 用法：
 *   node scaffold-plugin.mjs packages/dsh-demo \
 *     --name @ultraslow/dsh-demo \
 *     --title-zh 演示插件 --title-en "Demo plugin" \
 *     --desc-zh "一句话说明" --desc-en "One-line summary." \
 *     [--slot shell.overlay] [--host-route /demo] [--settings-tab] \
 *     [--engines ">=0.2.2-rc.1 <0.3.0"] [--force]
 *
 * 生成：package.json / cordis.patch.yml / index.js / client.js /
 *       locale/{zh,en}.json / icon.svg / README.md
 *
 * 只依赖 Node 内置模块；不联网、不安装依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_README = join(HERE, '..', 'templates', 'README.template.md')


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

function fail(message) {
  console.error(`scaffold-plugin: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { positionals: [] }
  const flags = new Set(['--host-route', '--slot', '--name', '--title-zh', '--title-en', '--desc-zh', '--desc-en', '--engines'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (flags.has(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${arg} 需要一个值`)
      out[arg.slice(2)] = value
      index += 1
      continue
    }
    if (arg === '--settings-tab' || arg === '--force') {
      out[arg.slice(2)] = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (arg.startsWith('--')) fail(`未知参数 ${arg}`)
    out.positionals.push(arg)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || args.positionals.length === 0) {
  console.log(`用法：
  node scaffold-plugin.mjs <packages/dsh-xxx> --name @ultraslow/dsh-xxx \\
    --title-zh 中文名 --title-en "English title" \\
    --desc-zh "中文一句话" --desc-en "English one-liner." \\
    [--slot shell.overlay] [--host-route /prefix] [--settings-tab] \\
    [--engines ">=0.2.2-rc.1 <0.3.0"] [--force]

说明：
  --host-route  生成 Host 半边的最小可用路由（GET <prefix>/state），并让 client 拉取
  --settings-tab 额外注册「设置 → 插件」页签
  --force       目标目录已存在时仍然写入（默认拒绝）`)
  process.exit(args.help ? 0 : 1)
}

const repoRoot = findRepoRoot(process.cwd())
const targetDir = resolve(repoRoot ?? process.cwd(), args.positionals[0])
const pkgName = args.name
if (typeof pkgName !== 'string' || !/^(@[a-z0-9][\w.-]*\/)?dsh-[a-z0-9][a-z0-9-]*$/.test(pkgName)) {
  fail('--name 必须是 dsh-<短名> 或 @scope/dsh-<短名>（小写）')
}

const dirName = basename(targetDir)
const short = pkgName.replace(/^@[^/]+\//, '').replace(/^dsh-/, '')
if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) fail(`无法从包名推导短名：${short}`)
const patchId = short
const ns = short
const slot = args.slot ?? 'shell.overlay'
const engineRange = args.engines ?? '>=0.2.2-rc.1 <0.3.0'
const titleZh = args['title-zh'] ?? short
const titleEn = args['title-en'] ?? short
const descZh = args['desc-zh'] ?? '一句话说明这个插件做什么。'
const descEn = args['desc-en'] ?? 'One-line summary of what this plugin does.'
const hostRoute = args['host-route'] === undefined ? null : args['host-route'].replace(/\/+$/, '')
const settingsTab = args['settings-tab'] === true

if (!/^[a-z][a-z0-9.-]*$/.test(ns)) fail(`短名不适合做命名空间：${ns}`)

if (existsSync(targetDir) && args.force !== true) {
  const entries = existsSync(join(targetDir, 'package.json'))
  if (entries) fail(`目标目录已存在插件包：${targetDir}（确认要覆盖时加 --force）`)
}

const relativeTarget = repoRoot === null ? args.positionals[0] : targetDir.startsWith(repoRoot) ? targetDir.slice(repoRoot.length + 1) : args.positionals[0]
const files = []
function write(relative, content) {
  const full = join(targetDir, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content.endsWith('\n') ? content : `${content}\n`)
  files.push(relative)
}

// ── package.json ────────────────────────────────────────────────────────────
const manifest = {
  name: pkgName,
  version: '0.1.0',
  description: descEn,
  license: 'MIT',
  type: 'module',
  main: 'index.js',
  exports: {
    '.': './index.js',
    './client': './client.js',
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
  },
  files: ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg'],
  keywords: ['dsh', 'dsh-plugin', 'deepseek-harness', ...short.split('-')],
  homepage: `https://github.com/Hankerlove/oh-my-dsh-plugin/tree/main/packages/${dirName}`,
  repository: {
    type: 'git',
    url: 'git+https://github.com/Hankerlove/oh-my-dsh-plugin.git',
    directory: `packages/${dirName}`,
  },
  bugs: { url: 'https://github.com/Hankerlove/oh-my-dsh-plugin/issues' },
  publishConfig: { access: 'public' },
  engines: { dsh: engineRange },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: true,
      inject: ['@deepseek-ai/dsh-client-ui-layout'],
    },
  },
}
write('package.json', JSON.stringify(manifest, null, 2))

// ── cordis.patch.yml ────────────────────────────────────────────────────────
write(
  'cordis.patch.yml',
  `# Bundle patch for ${pkgName}.
#
# 这一行把插件插入 profile 的 Loader 树；\`id\` 同时是设置页/日志里的命名空间。
# 浏览器半边由 package.json 的 \`dsh.client\` 声明，不需要单独一行。
- insert:
    - id: ${patchId}
      name: '${pkgName}'
`,
)

// ── index.js ────────────────────────────────────────────────────────────────
const hostRouteBlock = hostRoute === null
  ? `export function apply(ctx) {\n  // Client-only 插件：Host 半边不需要注册任何东西。\n  // 需要读写本机文件时，参考 references/host-half.md 增加路由与存储。\n}\n`
  : `const ROUTE = '${hostRoute}/state'\n\n/**\n * 最小可用路由：GET ${hostRoute}/state 返回一段欢迎语。\n * 真实插件在这里读 \`$DSH_HOME/${ns}/config.json\`，并给变更接口加安全围栏。\n */\nexport function apply(ctx) {\n  try {\n    ctx.effect(\n      () => ctx.webServer.register({\n        kind: 'prefix',\n        path: ROUTE,\n        handler: (req, res) => {\n          try {\n            const body = JSON.stringify({ ok: true, plugin: '${ns}' })\n            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })\n            res.end(body)\n          } catch (error) {\n            try { ctx.logger?.warn?.(error) } catch { /* 日志失败不能影响响应 */ }\n            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })\n            res.end(JSON.stringify({ ok: false, error: '${ns}: internal error' }))\n          }\n        },\n      }),\n      '${ns}: state route',\n    )\n  } catch (cause) {\n    // 路由注册失败说明插件无法工作，让加载期报一次清楚错误。\n    throw cause instanceof Error ? cause : new Error(\`${ns}: route registration failed: \${String(cause)}\`)\n  }\n}\n`

write(
  'index.js',
  `/**\n * ${pkgName} — Host half.\n *\n * ${hostRoute === null ? '这个插件完全在浏览器侧工作，Host 半边只满足 bundle 的加载契约。' : `暴露 ${hostRoute}/state；数据应写 \`$DSH_HOME/${ns}/\`，不要污染用户项目目录。`}\n *\n * 约定见仓库 docs/plugin-guide.md 与 skill references/host-half.md。\n */\nexport const name = '${ns}'\n\n${hostRoute === null ? "export const inject = []\n" : "export const inject = ['webServer']\n"}\n${hostRouteBlock}`,
)

// ── client.js ───────────────────────────────────────────────────────────────
const fetchBlock = hostRoute === null
  ? `        // Client-only：数据存 localStorage（key 带版本，见 references/client-half.md）。\n        const [status] = useState('ready');\n`
  : `        const [status, setStatus] = useState('loading');\n        useEffect(() => {\n          let disposed = false;\n          const controller = new AbortController();\n          const timer = setTimeout(() => controller.abort(), 8000);\n          fetch('${hostRoute}/state', { signal: controller.signal })\n            .then((response) => response.json())\n            .then((payload) => { if (!disposed) setStatus(payload?.ok === true ? 'connected' : 'unavailable'); })\n            .catch(() => { if (!disposed) setStatus('unavailable'); })\n            .finally(() => clearTimeout(timer));\n          return () => { disposed = true; clearTimeout(timer); controller.abort(); };\n        }, []);\n`

write(
  'client.js',
  `window.__ModuleLoader__.load({\n  id: '${pkgName}',\n  /**\n   * ${pkgName} — Client half.\n   *\n   * 一个最小的 ${slot} 卡片：验证插件已加载、文案可切换、主题 token 生效。\n   * 删掉它再开始写真正的界面；不要在这个文件里引入第二份 React。\n   */\n  factory(require) {\n    const React = require('react');\n    const h = React.createElement;\n    const { useEffect, useState } = React;\n\n    const NS = '${ns}';\n\n    const ZH = {\n      'card.title': '${titleZh}',\n      'card.hint': '插件已加载。把这张卡片换成真正的界面。',\n      'card.connected': 'Host 路由已连接',\n      'card.unavailable': 'Host 路由不可用（功能降级）',\n      'card.ready': '浏览器侧就绪',\n      'settings.title': '${titleZh}',\n      'settings.intro': '${descZh}',\n    };\n    const EN = {\n      'card.title': '${titleEn}',\n      'card.hint': 'Plugin loaded. Replace this card with the real UI.',\n      'card.connected': 'Host route connected',\n      'card.unavailable': 'Host route unavailable (degraded)',\n      'card.ready': 'Browser half ready',\n      'settings.title': '${titleEn}',\n      'settings.intro': '${descEn}',\n    };\n\n    /** 只用 --dsw-* token，暗色主题自动适配。 */\n    const cardStyle = {\n      position: 'fixed',\n      right: 24,\n      bottom: 96,\n      width: 260,\n      padding: '12px 14px',\n      borderRadius: 14,\n      border: '1px solid var(--dsw-alias-border-l2)',\n      background: 'var(--dsw-alias-bg-overlay)',\n      color: 'var(--dsw-alias-label-primary)',\n      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',\n      font: '13px/1.5 system-ui, -apple-system, sans-serif',\n      pointerEvents: 'auto',\n    };\n    const titleStyle = { margin: '0 0 4px', fontSize: 14, fontWeight: 600 };\n    const hintStyle = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };\n\n    function DemoCard(props) {\n      const t = typeof props.t === 'function' ? props.t : (key) => key;\n${fetchBlock}        return h('div', { style: cardStyle, role: 'status' },\n          h('h3', { style: titleStyle }, t('card.title')),\n          h('p', { style: hintStyle }, t('card.hint')),\n          h('p', { style: hintStyle }, status === 'connected' ? t('card.connected')\n            : status === 'unavailable' ? t('card.unavailable') : t('card.ready')),\n        );\n    }\n\n    function SettingsPage(props) {\n      const t = typeof props.t === 'function' ? props.t : (key) => key;\n      return h('div', { style: { padding: 16, font: '13px/1.6 system-ui, -apple-system, sans-serif' } },\n        h('h2', { style: { margin: '0 0 8px', fontSize: 16 } }, t('settings.title')),\n        h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.intro')),\n      );\n    }\n\n    return {\n      name: NS,\n      inject: ['slots', 'locale'],\n      apply(ctx) {\n        try {\n          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), '${ns}: dictionaries');\n          const t = ctx.locale.bind(NS);\n\n          ctx.slots.inject('${slot}', () => ctx.slots.register({\n            name: '${slot}',\n            id: '${ns}-card',\n            order: 80,\n            locale: NS,\n          }, (props) => h(DemoCard, { ...props, t })));\n${settingsTab ? `\n          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({\n            name: 'settings.plugins.tab',\n            id: '${ns}-settings',\n            order: 80,\n            label: () => t('settings.title'),\n            locale: NS,\n          }, (props) => h(SettingsPage, { ...props, t })));\n` : ''}        } catch (error) {\n          // 装饰性插件失败只降级，绝不把整个 Web UI 拖挂。\n          try { console.error('[${ns}] failed to start', error); } catch { /* console 不可用 */ }\n        }\n      },\n    };\n  },\n});\n`,
)

// ── locale ──────────────────────────────────────────────────────────────────
write(
  'locale/zh.json',
  JSON.stringify({ meta: { title: titleZh, description: descZh } }, null, 2),
)
write(
  'locale/en.json',
  JSON.stringify({ meta: { title: titleEn, description: descEn } }, null, 2),
)

// ── icon.svg ────────────────────────────────────────────────────────────────
const initial = titleEn.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || 'D'
write(
  'icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${titleEn.replace(/["<&]/g, ' ')}">
  <defs>
    <linearGradient id="${ns}-bg" x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4F8CFF"/>
      <stop offset="1" stop-color="#7A46E8"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#${ns}-bg)"/>
  <rect x="12" y="12" width="40" height="40" rx="10" fill="none" stroke="#FFFFFF" stroke-width="2.4" opacity=".9"/>
  <text x="32" y="39" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="600" fill="#FFFFFF">${initial}</text>
</svg>
`,
)

// ── README.md ───────────────────────────────────────────────────────────────
const entryNote = settingsTab
  ? '设置 → 插件 → 「__TITLE_ZH__」；主界面入口见下方说明。'
  : '主界面入口见下方说明。'
let template = ''
try {
  template = readFileSync(TEMPLATE_README, 'utf8')
} catch {
  template = '# __TITLE_ZH__ · __PKG__\n\n__SUMMARY__\n'
}
const readme = template
  .replaceAll('__TITLE_ZH__', titleZh)
  .replaceAll('__PKG__', pkgName)
  .replaceAll('__DIR__', dirName)
  .replaceAll('__SUMMARY__', `${descZh}（${titleEn}）`)
  .replaceAll('__DSH_RANGE__', engineRange)
  .replaceAll('__CAPABILITY_NAME__', '待补充')
  .replaceAll('__CAPABILITY_DETAIL__', '一句话说明这个能力做什么。')
  .replaceAll('__UNINSTALL_NOTE__', `卸载不会删除 \`$DSH_HOME/${ns}/\` 下的数据；需要时手动删除。`)
  .replaceAll('__ENTRY_NOTE__', entryNote)
  .replaceAll('__USAGE_NOTE__', '待补充：用户完成主要任务的步骤。')
  .replaceAll('__DATA_NOTE__', `全部数据保存在本机 \`$DSH_HOME/${ns}/\`，不上传网络。`)
write('README.md', readme)

console.log(`已生成 ${pkgName} → ${targetDir}`)
for (const file of files) console.log(`  + ${file}`)
console.log(`
下一步：
  1. node --check ${join(targetDir, 'index.js')} && node --check ${join(targetDir, 'client.js')}
  2. node "${join(HERE, 'check-plugin.mjs')}" ${relativeTarget}
  3. 用 plugin_manager（install_bundle）或 dsh plugin --profile <p> add ${args.positionals[0]} 装进 profile
  4. 重启 DSH + 刷新页面，确认卡片出现，再开始写真正的功能
  5. 删除 DemoCard/SettingsPage 里的占位内容，补 README 的「能做什么 / 使用 / 数据与隐私」`)
