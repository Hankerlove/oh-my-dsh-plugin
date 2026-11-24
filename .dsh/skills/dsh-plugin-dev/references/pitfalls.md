# 踩坑目录（全部来自本仓库真实提交/调试）

按「症状 → 原因 → 做法」组织。验收前过一遍，能省掉大部分返工。

## 加载与生效

| 症状 | 原因 | 做法 |
| --- | --- | --- |
| `dsh plugin add` 成功但界面没变化 | 包没有 `dsh.bundle.patch`，只装成普通依赖；或 profile 的 `dsh.profile.bundles` 没加入 | 检查 `package.json` 的 `dsh.bundle`；看 profile 的 `package.json` 是否有包名；重启 DSH |
| 启动日志里插件被跳过 | `engines.dsh` 与运行中的 DSH 不兼容；或 bundle 解析不到 | 调到匹配的 DSH 版本范围，或升级包 |
| 改了 `client.js` 但表现没变 | 浏览器缓存了旧的 client bundle | 禁用→启用插件后**刷新页面**；只热换宿主行不够 |
| 改了 `index.js` 但没生效 | 宿主侧代码需要重新加载 | 重启 DSH，或 disable→enable 触发 HMR |
| 整个 Web UI 打不开，日志说 `web boot: N entry did not activate` | client `inject` 里有服务没人提供，entry 停在 pending | 静态 `inject` 只留 `slots`/`locale`；其余用 `ctx.inject`/`ctx.get` |
| 插件装完缺文件 / 报 `Cannot find module` | `files` 或 `exports` 漏了运行时文件 | 跑 `scripts/check-plugin.mjs`，把 `index.js`/`client.js`/patch/locale/icon 全列上 |
| 直接改 profile 文件后状态错乱 | 有人手写了 profile 的 `package.json` / patch，或手动跑了 pnpm | 只用 `plugin_manager` 的 install/remove 或 `dsh plugin --profile <p> add/remove` |

## 视觉与布局

| 症状 | 原因 | 做法 |
| --- | --- | --- |
| 暗色主题下文字/角标看不清 | 硬编码浅色，没有用 token | 全量改用 `--dsw-*`，暗色用 `body[data-ds-dark-theme]`，亮暗各验一次 |
| `z-index` 设了很大还是不覆盖 | 祖先 `transform`/`filter`/`contain` 形成 stacking context | 真正全屏的层挂 `document.body`，并在代码注释里写清理由 |
| 浮层挡住整个界面点击 | `shell.overlay` 容器 `pointer-events:none` | 子元素显式 `pointer-events:auto`，遮罩自己处理 Esc/点击关闭 |
| 窗口拖不动（第一次能拖、之后不行） | 盖住了顶部约 48px 的 `-webkit-app-region` 拖动区；或隐藏根节点用了 `visibility:hidden` | 不盖拖动区；隐藏根用 `opacity:0` |
| 启动先闪一下裸界面再出现片头 | client slot 挂载晚于首帧 | 用 Host 的 `webserver/index-inject` 提前注入 style/script 盖板，并带 10s 超时兜底 |
| 片头把界面永久卡住 | 客户端模块没跑到，盖板没人释放 | 注入脚本里必须有超时释放；Host 读配置失败时不要注入 |

## 数据与生命周期

| 症状 | 原因 | 做法 |
| --- | --- | --- |
| 项目目录被插件数据污染 | 把配置写到了 cwd/工作区 | 一律写 `$DSH_HOME/<短名>/` |
| 配置文件写一半断电变坏，插件从此加载失败 | 直接 `writeFile` | 临时文件 + rename；坏文件移 `.bak` 后用默认值继续 |
| 第二个窗口看不到另一个窗口的修改 | 用了内存缓存当真相 | 每次请求重新读文件 |
| 插件禁用后样式/定时器还在 | 注册没有对应 disposer | 所有注册进 `ctx.effect`，禁用后逐项验证 |
| 卸载后拖拽/焦点/键盘行为异常 | 全局事件监听没解绑 | 监听器成对注册/解绑，`ctx.effect` 返回 cleanup |
| 升级后旧 localStorage 数据把界面打崩 | 数据结构变了没有迁移 | key 带版本 + 显式迁移；读失败回默认值 |

## Host 安全与边界

| 症状 | 原因 | 做法 |
| --- | --- | --- |
| 变更接口被任意网页调用 | 插件路由不在 web token 后面，且没做来源校验 | 先 `connection.requestRejection`，退化 Origin/Host 同源校验 |
| 超大 body 把进程内存打满 | 没有读 body 上限 | 累计字节超限立即 `req.destroy()` + 413 |
| 上传了未知类型文件，静态服务后变成风险 | MIME 没白名单 | `mime → 扩展名` 白名单 + 每槽体积上限 + 哈希文件名 |
| 浏览器传个 `/etc/passwd` 就能读 | 接受浏览器传来的路径 | 浏览器只传会话 id，路径由 Host 从会话服务解析 |
| 只读 HOME 导致插件直接加载失败 | `ensureStore()` 没有兜底 | mkdir/写默认配置 try/catch，后续写操作各自报错 |

## 文档与发版

| 症状 | 原因 | 做法 |
| --- | --- | --- |
| 每次发版都产生一堆 README diff | 包 README 写死了版本号 | 不在 README 写版本；只写 npm 包名/适用范围/协议 |
| 插件页截图 404 / 包体积变大 | 截图放在包内 `docs/`，或用了会变的路径 | 截图统一放 `assets/`，用 `refs/heads/<分支>` 的 raw 绝对链接 |
| 市场里看不到新版本 | 只发 npm，没重新生成索引；或插件还没 publish 就生成索引 | 先 `npm publish`，再跑 `scripts/market-index.mjs`，最后 `check-plugin.mjs --repo` |
| 索引源添加失败 | URL 有重定向、带用户名/密码或 `#` 片段 | 用 raw.githubusercontent 直出地址 |
| tag 推不上去 / 写错 | 带 scope 的 tag 没加引号被 shell 解释 | `git tag '@ultraslow/dsh-x@0.1.0'` |
| 公共包发到了公司镜像 | 本机 registry 指向 bnpm | 显式 `--registry https://registry.npmjs.org`，发完 `npm view` 验证 |
| 误提交 `.dsh/`、`docs/research/`、`.npmrc` | 没看 `git status` | 提交前 `git status --short`，`.gitignore` 已覆盖但新增文件要自己确认 |

## 设计层面的提醒

- **装饰性插件的失败优先级**：宁可「什么都没加」，也不要让 GUI 挂掉。所有 `apply`、所有 handler、所有 fetch 都要有失败路径。
- **不要把宿主私有实现当契约**：类名、内部事件、未公开服务都会随版本变。优先 slot、token、公开服务；确实需要读宿主源码时（如 `dsh-skill-mcp-manager` 读 rank 表），必须有内置回退值，并在设置页显示「读到了什么」。
- **不要为单个会话硬编码**：会话/工作区数据用 slot props 或 `ctx.sessions`/`ctx.workspaces` 快照，切换会话后要能跟着变。
- **别让「一次性验证」污染真实 profile**：要么用专门的 dev profile，要么验收后删掉；真实 profile 里的 link 依赖只用于本地开发，不要把个人的 link 路径带进提交。
