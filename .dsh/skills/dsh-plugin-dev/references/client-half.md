# Client 半边（client.js）

浏览器半边由 `dsh-client-modules` 从 `package.json` 的 `dsh.client` 发现并加载，是一个用 `window.__ModuleLoader__.load` 包装的 ESM 工厂。它拿到宿主的 React、slot、locale、theme 等服务。

## 模块契约

```js
window.__ModuleLoader__.load({
  id: '@ultraslow/dsh-demo',   // 必须等于 npm 包名
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')   // 需要时
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'demo'                       // 服务命名空间，与 patch id 对齐

    return {
      name: NS,                             // 可选，便于日志
      inject: ['slots', 'locale'],          // 静态：只放必有服务
      apply(ctx) { /* ... */ },
    }
  },
})
```

- `require('react')` 拿的是宿主共享实例：不要打包第二份 React、不要 CDN、不要 UMD 包装；hooks 用法与宿主自身代码一致。
- `id` 与包名不一致会导致调试困惑；现有三个插件全部用包名。
- 没有 JSX：手写 `h(...)`。样式不要走构建，用 `createElement('style')` 注入。

## 静态 inject 是致命项

静态 `inject` 里的服务只要缺一个，这个 client entry 就停在 `pending`；web boot 把任何非 active entry 当致命错误，结果**整个 Web UI 打不开**。所以：

- 静态只放 `slots`、`locale`。
- 可能缺失的服务（`theme`、`sessions`、`workspaces`、`tools`…）用动态注入或 `ctx.get`：

```js
let themeService = null
if (typeof ctx.inject === 'function') {
  ctx.inject(['theme'], (ready) => {
    themeService = ready.theme
    syncTokens()          // 有了 theme 才做 token 覆盖
  })
}
```

宿主提供的客户端服务里，`ctx.sessions.list.getSnapshot()` 与 `ctx.workspaces.list.getSnapshot()` 可同步读快照，用于把 `sessionId` 映射到 workspace 路径；服务没 ready 时 `try/catch` 后降级。

## apply 必须自己兜底

```js
apply(ctx) {
  try {
    // 所有初始化
  } catch (error) {
    try { console.error('[demo] failed to start', error) } catch { /* console 不可用 */ }
  }
}
```

装饰性插件不能成为「界面打不开」的原因。任何可失败的初始化都放进 try，失败后停在「什么都没加」的状态，而不是抛出去。

## 文案

```js
const ZH = { 'panel.title': '演示', 'panel.hint': '插件已加载' }
const EN = { 'panel.title': 'Demo', 'panel.hint': 'Plugin loaded' }

ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'demo: dictionaries')
const t = ctx.locale.bind(NS)
// 需要跟随语言切换重渲染时：
ctx.effect(() => ctx.locale.subscribe(() => store.refresh()), 'demo: locale changes')
```

- 运行时字典在 `client.js` 内，`locale/zh.json`/`en.json` 只放 `meta.title`/`meta.description`（插件管理器和设置页显示用）。
- `ctx.locale.bind(NS)` 返回的 `t` 支持 `t('key', { name })` 插值；slot 组件的 props 里也可能带 `t`，优先用 props 的（跟随该 slot 的上下文）。

## slot 注册

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'demo-floating-panel',   // 全树唯一，建议带插件前缀
  order: 6,                     // 同 slot 内的排序
  locale: NS,                   // 让 slot 上下文使用本插件字典
  inject: (sessionId) => ({ sessionId, t }),   // 按会话/工作区喂 props（会话级 slot 才有）
}, DemoCard))
```

- 用 `ctx.slots.inject(owner, () => register(...))` 这种 folding 写法：父 slot 折叠时自动卸载，回来时自动恢复。
- `inject` 回调的参数是 slot 自身的上下文（会话级 slot 给 `sessionId`），不要把全局单例当 props 乱塞。
- 组件是纯 React 组件：自己做订阅（`useEffect` + store）而不是让宿主帮你重渲染。
- slot 名不要猜，从 `docs/research/03-dsh-api-surface.md` §2.5/§3 或运行中的 DSH 里查。

## 主题与颜色

- 只用 `--dsw-*` CSS 变量（示例：`--dsw-alias-label-primary`、`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-state-error-primary`）。
- 暗色差异靠 `body[data-ds-dark-theme] <你的类>` 选择器；不要用 `prefers-color-scheme`（DSH 的主题可以与系统不同）。
- 需要随主题变化的组件，订阅 `ctx.on('theme/change', snapshot => ...)`，初始值用 `ctx.theme.getTheme()`。
- 高级：`ctx.theme.overrideTokens(NS, { '--dsw-alias-bg-layer-1': { light: '...', dark: '...' } })` 返回 disposer，必须交给 `ctx.effect`；明暗必须成对给。这是「壁纸/半透明界面」这类效果的官方通道，不要改私有类名。
- 真实回归：硬编码浅色在暗色主题下让角标和实心控件不可读（`fix(todo-list): 修复深色主题下计数角标与实心控件不可读`）。改颜色后必须亮/暗各看一次。

## 样式注入

```js
function ensureStyles() {
  const existing = document.getElementById('demo-styles')
  if (existing) return existing
  const node = document.createElement('style')
  node.id = 'demo-styles'
  node.textContent = CSS_TEXT
  document.head.appendChild(node)
  return node
}
ctx.effect(() => { const node = ensureStyles(); return () => node.remove() }, 'demo: styles')
```

类名统一前缀（`demo-`、`smm-`、`dsh-todo-` 这种），避免和宿主/其它插件撞车。

## 布局陷阱

| 现象 | 原因与做法 |
| --- | --- |
| 自己设的 `z-index` 不生效 | 祖先有 `transform`/`filter`/`contain` 形成 stacking context。`shell.overlay` 在 frame 内，真正要压住所有东西的层（片头/壁纸）直接挂 `document.body` 并写清理由 |
| 浮层挡住点击 | `shell.overlay` 容器是 `pointer-events:none`，子元素要显式 `pointer-events:auto`；全屏遮罩自己负责 Esc/点击关闭 |
| 窗口拖不动 | 顶部约 48px 是 `-webkit-app-region` 拖动区，别盖住它；需要隐藏根节点时用 `opacity:0` 而不是 `visibility:hidden` |
| 首帧闪一下旧界面 | client entry 的激活晚于首帧；要抢首帧只能靠 Host 的 `webserver/index-inject` |
| 旧代码还在跑 | client bundle 由页面加载时拉取，改完必须刷新页面；只 disable/enable 不刷新无效 |

其它：`prefers-reduced-motion` 时不要播放动画；按钮要有 `focus-visible` 样式和 `aria-label`；`Esc` 能关面板。

## 数据

- 浏览器本地：`localStorage`，key 带命名空间与版本（`dsh.demo.v1`），升级时写显式迁移；读坏数据回默认值，不要抛。
- 需要跨窗口/跨设备/文件时改走 Host 路由：`fetch('/demo/state', { signal })` + 8s 超时 + 失败时隐藏功能并在设置页里显示原因，不要加载转圈卡死。
- 不要在浏览器里存会话/工作区真相，用 `sessionId` 向 Host 要。

## Client 半边自检

- [ ] `node --check client.js` 通过
- [ ] `id` 等于包名；`inject` 静态项只有 `slots`/`locale`
- [ ] `apply` 整体 try/catch
- [ ] 每个 style/timer/listener/token 覆盖都有 `ctx.effect` 清理
- [ ] 亮色/暗色外观都正常，无硬编码颜色
- [ ] 中英文切换后文案更新
- [ ] 刷新页面加载新代码；禁用插件后层、样式、定时器全部消失
- [ ] 无主题/无会话服务时降级不报错
