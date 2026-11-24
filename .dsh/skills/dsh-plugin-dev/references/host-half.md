# Host 半边（index.js）

Host 半边跑在 Node 里、由 Cordis 加载，负责 HTTP 路由、磁盘、宿主服务调用。浏览器侧只拿到 JSON 和字节，拿不到 fs、进程或配置层。

## 最小契约

```js
/** 一句话说明数据放哪、暴露哪些路由、错误策略。 */
export const name = 'demo'            // 与 patch 行的 id 对齐，便于日志定位
export const inject = ['webServer']   // 硬依赖；缺一个整行不激活

export function apply(ctx) {
  // 1) 需要抢首帧的注入：同步、第一个 await 之前完成
  // 2) 路由注册：同步完成，失败可以抛（此时插件确实无法工作）
  // 3) 其它都是 ctx.effect 管理的资源
}
```

- 函数形态是默认；只有「向别的插件提供服务」才用 `export default class extends Service`。同一文件不要混用函数与 Service。
- `export const Config` 只在该插件需要在 patch 行写 `config:` 时才有意义；本仓库三个插件都没有用到。真要用时注意：**patch 覆盖目标行时是整块替换 `config`，不是 merge**。
- 不要在模块顶层做 IO 或起定时器：加载顺序、多次实例化、禁用/启用都会让你踩到。全部放进 `apply`。

## 资源与生命周期

```js
ctx.effect(() => {
  const timer = setInterval(tick, 30_000)
  return () => clearInterval(timer)       // 必须返回清理函数
}, 'demo: clock')

ctx.effect(
  () => ctx.webServer.register({ kind: 'prefix', path: '/demo/state', handler: serveState }),
  'demo: state route',
)
```

- 每一个注册都要有自己的 `ctx.effect`；标签会在 debug/日志里出现，统一写成 `<短名>: <用途>`。
- `ctx.webServer.register` 返回 disposer；把它交给 `ctx.effect`，禁用插件时路由才会消失。
- 禁用→启用（HMR 换行）时同一个 `apply` 会重新跑一遍，所以任何全局单例状态都要可重入。

## 可选服务：不要写成静态 inject

```js
// 可选依赖：有就用，没有就降级
if (typeof ctx.inject === 'function') {
  ctx.inject(['yaml'], (sub) => {
    // sub.yaml 可用；子 fiber 卸载时这里的注册随之回收
  })
}
const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
```

静态 `inject` 里的服务缺失会让整行处于 pending；对装饰性插件来说这等于「插件不工作」。凡是「没有它也能退化」的能力，一律用 `ctx.inject` / `ctx.get`。

## 路由

`ctx.webServer.register({ kind: 'prefix', path, handler })`，`handler(req, res)` 是裸 Node 请求响应，状态码/头/body 都要自己写。prefix 路由意味着 `path` 下的子路径都会进同一个 handler，用 `req.url` 自己分流。

```js
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function serveState(req, res) {
  try {
    sendJson(res, 200, { ok: true, state: readState() })
  } catch (error) {
    warn(error)
    sendJson(res, 500, { ok: false, error: 'demo: internal error' })
  }
}
```

要点：

- 先 `ensureStore()`（`mkdir -p` + 默认配置），但**用 try/catch 包住**：HOME 只读不能让插件加载失败，之后每次写入在各自 handler 里失败即可。
- 每个 handler 自己兜底。装饰性插件的 handler 永不抛异常——抛出去会变成宿主日志里的未处理错误，严重时影响请求管线。
- 唯一允许抛的是**路由注册失败**：那说明插件完全无法工作，应该让加载期报一次清楚错误。
- 读请求不要缓存磁盘内容：配置以文件为唯一真相，每次请求重新读，第二个窗口/另一个进程才能一致。
- 变更请求（POST/PUT/DELETE）必须先过安全围栏，见下。
- 大响应（媒体）才需要 Range/ETag/304；用 `createReadStream` + `pipeline`，不要 `readFile` 整个 80MB 视频进内存。

## 安全围栏（插件路由不在 web token 后面）

```js
function isForeignRequest(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    const reject = connection?.requestRejection
    if (typeof reject === 'function') return Boolean(reject.call(connection, req))
  } catch {
    /* 围栏自身失败：退到下面的 Origin 校验 */
  }
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

if (isForeignRequest(ctx, req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
```

配套硬约束：

- **body 上限**：读 body 时累计字节数，超限立即 `req.destroy()` 并返回 413；不要先把超限内容缓冲下来再判断。
- **上传白名单**：`mime → 扩展名` 一张表同时当白名单；每槽位单独体积上限；落盘文件名用内容哈希，不用用户文件名（用户文件名只作为展示字段，且要限长、去控制字符）。
- **探测/子进程**：命令用绝对路径或明确 PATH，`env` 显式传入，超时必须有。
- 全局配置类写入（比如改 profile 的 `cordis.patch.yml`）属于危险操作：先读、校验 YAML 是序列、再做原子写，失败回滚；不要把用户的其它行改坏。

## 持久化

- 目录：`$DSH_HOME/<短名>/`，`$DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')`。**不要写项目目录**（用户的项目目录会被 git 跟踪、会被同步、会被别的工具扫描）。
- 原子写：写 `config.json.tmp` → `renameSync`。读之前不锁文件；出现解析错误就把坏文件复制成 `.bak`，落回默认值继续，绝不让一次坏文件让插件永久失败。
- 读时保留 `revision`（如 `sha1(配置 + 媒体元数据)`）给前端做 cache-busting 和「配置是否变化」判断。
- 需要跨窗口一致时，每次请求重新读，不用内存缓存当真相。
- 卸载插件不删用户数据，但 README 的「数据与隐私」要写清位置和清理方式。

## 首帧注入（只有全屏装饰才需要）

`ctx.on('webserver/index-inject', (table) => …)` 在宿主渲染 HTML 时被同步调用一次：

```js
ctx.effect(
  () => ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      if (!shouldCover()) return
      table.push({ kind: 'style', text: COVER_STYLE })              // 内联 style
      table.push({ kind: 'script', placement: 'head', text: GUARD }) // head 里的脚本
    } catch {
      /* 配置读失败绝不能影响页面渲染 */
    }
  }),
  'demo: first-paint cover',
)
```

三条血泪规则（来自 `dsh-boot-skin`）：

1. **必须同步注册**：宿主在启动时只收集一次行表，`apply` 里第一个 `await` 之前就要把 handler 注册上。
2. **必须带超时兜底**：客户端模块可能根本没跑到（插件刚被移除、模块报错），脚本里要有 `setTimeout(release, 10000)`，否则界面永远被盖住。
3. **隐藏根节点用 `opacity: 0`，不要 `visibility: hidden`**：后者会让窗口拖动区（`-webkit-app-region`）的重算失效，出现「第一次能拖、之后拖不动」。

## 与 Client 半边的分工

Host 只信自己解析出来的上下文：会话 id 由浏览器传，但工作区路径必须由 Host 自己从会话服务解析，不接受浏览器传来的任意路径。浏览器传「想做什么」，Host 决定「允许做什么」，并把结果以 JSON 返回。

## Host 半边自检

- [ ] `node --check index.js` 通过
- [ ] 每个注册都有 `ctx.effect` + 清理函数
- [ ] 变更路由有围栏、有 body 上限、有 MIME/体积校验
- [ ] 所有 handler 都有 try/catch，错误变成响应
- [ ] 数据目录在 `$DSH_HOME`，原子写，坏文件可恢复
- [ ] 可选服务用 `ctx.inject`/`ctx.get`，缺失时降级
- [ ] 禁用插件后路由 404、无残留定时器/子进程
