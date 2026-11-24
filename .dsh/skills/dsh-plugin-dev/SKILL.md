---
name: dsh-plugin-dev
description: 在 oh-my-dsh-plugin 仓库开发、修改、验证、发布 DSH（DeepSeek Harness）Web UI 插件的端到端工作流与仓库规范：新增 packages/dsh-* 插件、写 index.js 与 client.js（slot、主题 token、locale、__ModuleLoader__）、打包与 exports/files 自检、装进 profile 验证、更新包 README 与根 README、重新生成 market/index.json 市场索引、版本号与 npm 发布、打 tag、排查「装了但界面没出现 / 装完缺文件 / 改了没生效」。只要用户提到 DSH 插件、packages/dsh-、cordis.patch.yml、插件市场索引、dsh plugin add 或给插件发版，就使用本 skill，即使没说「插件开发」四个字。
---

# DSH 插件开发（本仓库工作流）

这个 skill 把 oh-my-dsh-plugin 仓库已经踩过的坑固化成流程：插件形态怎么选、两个半边怎么写、怎么本地验证、怎么发版并同步文档与市场索引。目标是让你不用重新读一遍 `app.asar`、不用凭记忆猜 API，也不要在打包和发版这类机械步骤上翻车。

## 0. 先读事实源（按顺序，别跳过）

1. **`docs/plugin-guide.md`**：仓库权威约定（bundle/patch/profile 层叠、包结构、命名、本地调试、发布）。和本 skill 冲突时以它为准。
2. **`packages/` 里最新的同类插件**：`dsh-boot-skin`（Host 路由 + 首帧注入 + 主题 token）、`dsh-skill-mcp-manager`（Host 数据面 + 会话/工作区服务）、`dsh-todo-list`（纯浏览器插件 + localStorage）。动手前先 `read` 对应文件，照抄它们的结构和错误处理，不要另发明一套。
3. **`docs/research/03-dsh-api-surface.md`**（如果仓库里有）：宿主扩展点实测清单（slot 名、`--dsw-*` token、事件、官方模板原文）。这个调研包默认不入库，换机器时可能没有；没有就改查运行中 DSH 的随包文档/源码或官方文档，仍然不要猜 slot 名和 token。
4. URL 类事实（npm 包页、市场索引格式、官方文档）：需要确认时再查，不要写进 skill 当常量。

**最重要的判断**：装饰性插件必须「失败也不影响 GUI」。这是三个现有插件共同的最高设计约束（见各 `index.js` / `client.js` 顶部注释）。写代码时先问：这里失败会不会让用户打不开界面？会，就必须降级。

## 1. 三十秒决策：这是哪种插件

| 需求 | 形态 | 文件 |
| --- | --- | --- |
| 只加界面/交互，数据存浏览器 | **Client-only**（推荐默认） | `index.js` 只有 `export function apply() {}`；全部逻辑在 `client.js` |
| 要读写本机文件、上传媒体、探测端口、调宿主服务 | **Host + Client** | 两边都写，浏览器通过 `/前缀/...` 路由和 Host 通信 |
| 要给别的插件提供服务 | **Service 类** | `export default class extends Service`，本仓库目前没有先例，慎重 |
| 需要 TypeScript 类型/编译 | 本仓库当前不用 | 若确需走 `src/` → `lib/`，必须遵守 `docs/plugin-guide.md` §3 的例外说明并在包 README 里解释 |

红线：浏览器侧不做文件 IO（没有 Node fs）；Host 侧不碰 DOM。跨半边一律走 HTTP 路由 + JSON，Host 只信自己解析出来的会话/工作区，不信浏览器传来的路径。

用户没说清形态时，按「最快能验证」的方向给建议：先做 Client-only 跑通可见效果，需要持久化再升级为 Host + Client。升级成本主要在 `index.js` 加路由和存储，client 侧只多一个 `fetch` 封装。

## 2. 搭骨架

优先用脚本生成，再按需改。本 skill 的脚本在 `<本 skill 目录>/scripts/`（在本仓库里就是 `.dsh/skills/dsh-plugin-dev/scripts/`），它们会从当前目录向上自动定位仓库根，所以在仓库任意子目录都能执行：

```sh
node .dsh/skills/dsh-plugin-dev/scripts/scaffold-plugin.mjs \
  packages/dsh-demo \
  --name @ultraslow/dsh-demo \
  --title-zh 演示插件 --title-en "Demo plugin" \
  --desc-zh "一句话说明" --desc-en "One-line summary"
```

生成的文件集就是本仓库的现行标准（纯 ESM，双半边，无构建）：

```text
packages/dsh-<short>/
├── package.json        # bundle 声明 + client 声明 + 打包清单
├── cordis.patch.yml    # 往 profile 的插件树里插一行
├── index.js            # Host 半边（Node/Cordis）；Client-only 时为空 apply
├── client.js           # 浏览器半边（window.__ModuleLoader__）
├── locale/zh.json      # 插件管理/设置里的展示名与描述（meta.title / meta.description）
├── locale/en.json
├── icon.svg            # 64×64 圆角方块，市场与插件列表都用它
└── README.md
```

命名规则（不要临时发挥）：

| 项 | 规则 | 例 |
| --- | --- | --- |
| 目录 | `packages/dsh-<短名>` | `packages/dsh-boot-skin` |
| npm 包名 | `@ultraslow/dsh-<短名>`（无 scope 时优先 `dsh-<短名>`；名字被占则用 scope） | `@ultraslow/dsh-todo-list` |
| patch 行 `id` | 短名，全树唯一 | `boot-skin` |
| `client.js` 的 module id | **必须等于 npm 包名** | `@ultraslow/dsh-boot-skin` |
| commit scope | 短名 | `feat(boot-skin): ...` |
| tag | `<包名>@<版本>`（带 scope、要加引号） | `@ultraslow/dsh-todo-list@0.2.0` |

`package.json` 每个字段都有用途，别删：`main`/`exports` 让 Host 与 Client 半边都能被解析，`exports["./client"]` 是浏览器产物入口，`exports["./locale/*.json"]` 与 `exports["./icon"]` 是插件管理器的展示元数据，`files` 决定 npm 包里到底有什么，`dsh.bundle.patch` 声明这是一层 patch，`dsh.client` 声明有浏览器半边，`engines.dsh` 决定安装/启动时的兼容性检查。字段模板与解释见 `references/packaging-and-release.md`。

`files` 与 `exports` 漏一个运行时文件，本地怎么都正常，装到别的 profile 就缺文件——这是最容易发生、最难排查的一类问题。写完立刻跑检查脚本：

```sh
node .dsh/skills/dsh-plugin-dev/scripts/check-plugin.mjs packages/dsh-demo
```

## 3. 写 Host 半边（需要路由/持久化时）

结构照 `packages/dsh-boot-skin/index.js`：顶部注释写清数据放哪、暴露哪些路由、错误策略；`export const name`、`export const inject = ['webServer']`；`export function apply(ctx)` 里按「首帧注入 → 路由注册」顺序同步注册，所有注册都包在 `ctx.effect(() => disposer, '标签')` 里。

必须遵守的几条：

- **`inject` 只放硬依赖**；可能不存在的服务（`agents`、`tools`、`connection`、`yaml`）用 `ctx.inject([...], (sub) => {})` 或 `ctx.get('name')`，缺失时降级而不是让整行不激活。
- **路由**用 `ctx.webServer.register({ kind: 'prefix', path, handler })`，`handler(req, res)` 自己写状态码、头、body。注册要同步发生在 `apply` 里；只有「注册本身失败」可以抛出，其它错误在 handler 内消化成响应。
- **插件路由不在 web token 后面**。任何变更请求先过 `ctx.get('connection')?.requestRejection(req)`，没有该服务时退化为 `Origin`/`Host` 同源校验；body 有硬上限，超限立即 `req.destroy()`；上传走 MIME 白名单 + 每槽体积上限。
- **数据只写 `$DSH_HOME/<短名>/`**（`process.env.DSH_HOME || ~/.dsh`），绝不写项目目录。配置用「临时文件 + rename」原子写，每次请求重新读；文件损坏就移到 `.bak` 并用默认值继续，不要把整个插件拖挂。HOME 只读时加载仍要成功。
- **失败策略**：装饰性插件的 handler 永不 throw，错误变成 `{ ok: false, error }` 或 4xx/5xx；日志走 `ctx.logger?.warn`，不能让日志本身再抛错。
- 首帧场景才用 `ctx.on('webserver/index-inject', (table) => table.push({ kind: 'style', text }, { kind: 'script', placement: 'head', text }))`：必须同步、在第一个 `await` 之前注册，并带超时兜底脚本，避免客户端模块没跑到时界面永远不出现。

细节、可直接抄的片段和安全围栏见 `references/host-half.md`。

## 4. 写 Client 半边

结构是这个固定形状：

```js
window.__ModuleLoader__.load({
  id: '@ultraslow/dsh-demo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    return {
      name: 'demo',
      inject: ['slots', 'locale'],   // 只放必有服务！
      apply(ctx) { /* 用 ctx.effect 注册一切 */ },
    };
  },
});
```

规则（每条都对应一次真实故障）：

- React 从 `require('react')` 取宿主的共享实例，**不要**打包/CDN/UMD 第二份 React。
- **静态 `inject` 只放 `slots`、`locale` 这种一定有提供的服务**。静态依赖缺一个，这个 entry 就停在 `pending`，而 web boot 把「非 active 的 client entry」当致命错误——整个界面打不开。`theme`、`sessions`、`workspaces` 这类用 `ctx.inject(['theme'], (ready) => ...)` 动态接，缺了就少个功能。
- `apply` 整体 `try/catch`，装饰性插件失败只 `console.error` 后静默退出，绝不向外抛。
- 每项注册（`<style>` 节点、定时器、事件、token 覆盖、audio）都用 `ctx.effect(() => cleanup, '标签')`；`ctx.slots.inject(owner, () => ctx.slots.register(...))` 用 folding 写法，父 slot 折叠时自动卸载。
- 文案走 `ctx.locale.register(NS, { zh, en })` + `ctx.locale.bind(NS)`；`locale/*.json` 里的 `meta` 是给插件管理器的，不是运行时字典。
- **颜色只用 `--dsw-*` token**，暗色差异用 `body[data-ds-dark-theme]` 选择器，需要跟随主题变化时订阅 `theme/change`。硬编码浅色会导致暗色下不可读（真实回归：`fix(todo-list): 修复深色主题下计数角标与实心控件不可读`）。
- 数据存浏览器时 key 带版本 `dsh.<插件>.v<N>` 并写迁移；卸载/升级不能让旧数据把新界面打崩。
- 布局选择见下表；`shell.overlay` 在 frame 的 stacking context 里，全屏片头/壁纸这类要真正压住所有东西的层才需要直接挂 `body` 并自己收尾（照 `dsh-boot-skin/client.js` 的理由注释写进代码）。

常用 slot（本仓库已实测）：

| slot | 用途 | 例子 |
| --- | --- | --- |
| `shell.overlay` | 整窗浮层：悬浮卡片、提醒、全屏装饰 | `dsh-todo-list` |
| `conversation.composer.dock` | 输入框下方的 dock | `dsh-boot-skin` 的会话探测 |
| `conversation.session.header.actions` | 普通会话头部工具条 | `dsh-skill-mcp-manager` 的齿轮 |
| `conversation.hero.options` | 新建会话（blank/hero）输入框上方 | `dsh-skill-mcp-manager` 的 `◎` 入口 |
| `settings.plugins.tab` | 设置 → 插件 里的独立页签 | `dsh-boot-skin` 设置页 |
| `settings.general.item` | 设置 → 通用 里的一行 | 主题、快捷键类插件 |

`ctx.slots.register` 的 `options` 至少要 `name` + `id` + `order`；需要按会话取上下文时用 `inject: (sessionId) => ({...})` 往组件 props 里喂数据，而不是在组件里自己猜。

## 5. 文档与市场索引（和代码同等重要）

- **包 README**：用 `templates/README.template.md`。固定章节「能做什么 / 安装方式 / 使用 / 数据与隐私 / 许可证」，复杂插件再加「边界 / 故障排查 / 开发与验证 / 文件结构」。**不写死版本号**（每次发版都要改，纯噪声；`chore: skill-mcp-manager 0.1.2（README 去掉版本号…）` 就是在修这个。现有 boot-skin / todo-list 的 README 还留着「版本」行，属历史遗留，新写不要再加）。
- **截图**：统一放仓库根 `assets/`，用 `https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/assets/<图>` 绝对链接；包内不再放 `docs/` 截图（包体积 + 路径失效）。
- **根 README**：插件表加一行（插件 / 能做什么 / npm 包名），并在「插件使用」补一段面向用户的入口与要点。
- **`market/index.json`**：不要手改，用本 skill 的生成脚本重算：

  ```sh
  node .dsh/skills/dsh-plugin-dev/scripts/market-index.mjs
  ```

  它从各包 `package.json`（包名/版本/engines/keywords）、`locale/{zh,en}.json` 的 `meta`（展示名与描述）和 npm registry（已发布版本与发布时间）生成；仓库地址从 `git remote` 推导，展示字段沿用旧索引。新插件只要 `locale` meta 写好了就会自动进索引，不需要改脚本。需要覆盖时用 `--author`、`--slug`、`--branch`。脚本只收录 npm 上已经发布的版本，所以顺序是「先 publish，再生成索引」。
- 索引 URL 要直出 200、无重定向；优先用 `https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/market/index.json` 这种带 `refs/heads/` 的形式（历史上不带它的路径出现过旧 404 缓存）。

## 6. 验证（顺序执行，别跳步）

1. **语法**：`node --check index.js && node --check client.js`。
2. **打包自检**：`node .dsh/skills/dsh-plugin-dev/scripts/check-plugin.mjs [packages/dsh-<short>]`（校验 `exports`/`files` 覆盖、patch 行、locale meta、README 章节；加 `--repo` 校验根 README 与 market 索引；不给目录时检查全部插件）。
3. **安装进 profile**：优先用 DSH 的 `plugin_manager` 工具（`install_bundle` + 包目录绝对路径）；命令行等价物是 `dsh plugin --profile <profile> add ./packages/dsh-<short>`。**不要手写 profile 的 package.json / cordis.patch.yml，也不要在 profile 目录里跑 pnpm**——那正是 `dsh plugin` 在维护的东西。装完确认 profile 的 `package.json` 里出现 `link:` 依赖，且 `dsh.profile.bundles` 含本包名。
4. **重启并观察加载**：Host 改动需要重启 DSH；只改 `client.js` 时禁用→启用插件并**刷新页面**（浏览器缓存的 client bundle 只有刷新才换）。启动日志里不应出现 `did not activate` 或该插件名相关报错。
5. **行为验收**（亮色/暗色各一遍）：入口出现在预期位置；文案中英切换正确；数据落盘/重启保留；无权限/无服务时降级不崩；禁用插件后 UI、样式、token 覆盖、定时器全部消失；卸载后无残留行。
6. **发布前再跑一次 `check-plugin --repo`**，确保文档、索引、版本三处一致。

「装了但界面没出现」的排查顺序：profile 里有没有 link 依赖 → `dsh.profile.bundles` 有没有包名 → 重启日志有没有跳过该 bundle（`engines.dsh` 不满足会被跳过）→ 页面是否刷新过 → DevTools Console 是否有 client entry 报错。完整清单见 `references/pitfalls.md`。

## 7. 发布

```sh
# 1. 改 package.json 版本（每个插件独立语义化版本，互不联动）
# 2. 发布到公共 npm（不要用公司 registry 镜像发公共包；确认 npm 配置里没有把 token 带进仓库）
npm publish --access public            # 或在仓库根：pnpm --filter @ultraslow/dsh-<short> publish --access public
# 3. 打 tag 并推送（带 scope 要引号）
git tag '@ultraslow/dsh-<short>@0.1.0' && git push origin main --tags
# 4. 重新生成市场索引并提交
```

发版清单、npm/registry 细节、市场索引字段、提交信息规范见 `references/packaging-and-release.md`。

## 8. 提交

Conventional Commits，scope 用插件短名；一条提交只做一件事（代码 / 文档 / 版本号可以分开，也可以在小改动时合并，但不要顺手改无关文件）。示例：

```text
feat(boot-skin): 新增开屏视频与壁纸插件
fix(todo-list): 修复深色主题下计数角标不可读
chore: skill-mcp-manager 0.1.2（索引补 0.1.2）
docs: 根 README 增加插件市场安装说明
```

## 参考文件

本 skill 位于仓库的 `.dsh/skills/dsh-plugin-dev/`（该目录随仓库跟踪，其它 `.dsh/` 内容不入库）。下面的脚本路径都按这个位置写；skill 装到别处时替换成实际路径——脚本本身会自动定位仓库根，不依赖任何本机绝对路径。

| 文件 | 什么时候读 |
| --- | --- |
| `references/host-half.md` | 写 `index.js`、加路由、做持久化/上传/安全围栏 |
| `references/client-half.md` | 写 `client.js`、选 slot、接主题/国际化/样式、处理布局陷阱 |
| `references/packaging-and-release.md` | 改 `package.json`、写文档、发 npm、更新市场索引 |
| `references/pitfalls.md` | 验收前、排查问题时、以及想改既有实现之前 |
| `templates/README.template.md` | 写包 README |
| `scripts/scaffold-plugin.mjs` | 新建插件包 |
| `scripts/check-plugin.mjs` | 每次改完 `package.json`/文件结构后自检 |
| `scripts/market-index.mjs` | 发版后重新生成 `market/index.json` |

如果做完发现某条流程和仓库现状不一致，先信代码与 `docs/plugin-guide.md`，然后回来更新这个 skill——它应该是活的。
