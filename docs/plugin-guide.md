# DSH 插件开发指南

本文件记录 **oh-my-dsh-plugin** 仓库的插件开发与发布约定。通用教程以 DSH 官方文档为准，链接见文末[参考](#参考)。

## 1. DSH 插件是什么

DSH 构建在 [Cordis](https://github.com/deepseek-ai/cordis) 之上：插件就是一个导出 `apply` 函数的模块，框架加载时调用它，并传入 `ctx`。所有能力都通过 `ctx` 注册。

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  // 在这里注册工具、事件监听、服务……
}
```

要点：

- **自动清理**：通过 `ctx` 注册的东西（事件、工具、定时器）在插件卸载时自动回收；需要手动释放的资源（连接、进程）用 `ctx.effect(() => disposer)` 登记。
- **依赖声明**：消费其他服务时用 `export const inject = ['tools']` 声明，框架会等依赖就绪后再调用 `apply`。
- **三种形态**：函数（最常用）、对象（`{ name, inject, apply }`）、类（`extends Service`，用于向其他插件提供服务）。本仓库默认使用函数形态，除非确实需要提供服务。

## 2. 两个 manifest：bundle 与 profile

| 概念 | 位置 | 作用 | 由谁编写 |
| --- | --- | --- | --- |
| **组合包**（bundle） | npm 包，`package.json` 声明 `dsh.bundle` | 贡献一层 Cordis patch：插入或覆盖插件行 | 我们（插件作者） |
| **profile** | `$DSH_HOME/profiles/<name>`，`package.json` 声明 `dsh.profile` | 按顺序列出启用哪些 bundle | 用户（通过 `dsh plugin add` 自动维护） |

本仓库只产出 **bundle**。生效配置的层顺序为：

1. profile 的 `dsh.profile.bundles` 中各个 bundle 的 patch，按列表顺序（`@deepseek-ai/dsh-base` 最前）
2. profile 自己的 `cordis.patch.yml`
3. home 级 `$DSH_HOME/cordis.patch.yml`
4. 命令行 `--patch` overlay，按参数顺序

后应用的层按行胜出；**patch 替换目标行的整个 `config`，而不是深度合并**。因此覆盖别人的行时必须重述该行需要的所有键。

## 3. 一个最小插件包

```text
packages/example-plugin/
├── package.json
├── cordis.patch.yml
├── README.md
└── src/
    └── index.ts
```

`package.json`：

```json
{
  "name": "dsh-example-plugin",
  "version": "0.1.0",
  "description": "一句话说明这个插件做什么",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml"],
  "license": "MIT",
  "engines": { "dsh": ">=0.1.2 <0.2.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "^0.1.2-rc.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "^0.1.2-rc.1",
    "typescript": "^5.9.0"
  }
}
```

约定与注意事项：

- `dsh.bundle.patch` 指向插件层文件，也可以是有序文件列表（`["./base.patch.yml", "./web.patch.yml"]`）。
- `engines.dsh` 声明兼容的 DSH 版本范围；不写时会退化为检查 `@deepseek-ai/dsh*` 的 peer 依赖范围。安装与启动都会拒绝不满足范围的包。
- 需要与宿主共享实例的 dsh 包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 等）**同时**放进 `peerDependencies` 与 `devDependencies`：peer 保证运行时共享同一份，dev 依赖用于本地类型检查与测试。
- 构建产物放 `lib/`（`tsc` 输出），`lib/` 已被 `.gitignore` 忽略，发布时通过 `files` 带上。

`cordis.patch.yml`：

```yaml
- insert:
    - id: example-plugin
      name: dsh-example-plugin
```

插件行用**包名**引用，而不是源码相对路径，这样安装后 Node 才能解析到模块；`id` 在组合后的树中必须唯一。

`src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'example-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // 这里注册能力
}
```

**例外：纯 ESM 的 Client 半边。** 如果某个 bundle 的 Client 半边是手写的纯 ESM，通过 `dsh.client` 挂在 Web UI 上、并由 `package.json` 的 `exports["./client"]` 暴露，就不必走 `src/` → `lib/` 的 TypeScript 编译链路：DSH 把它当作浏览器侧产物加载，不需要 `tsc` 输出，包内也可以不出现 `src/`、`lib/` 和 `tsconfig.json`。这类包必须保证 `files` 与 `exports` 覆盖每一个运行时文件（Host 入口、`./client`、patch 文件、`locale/*.json`、图标等），否则安装后会漏文件；也建议在包内 README 里说明为什么偏离通用约定。本仓库的 [`@hankerlove/dsh-todo-list`](../packages/dsh-todo-list/README.md) 就是这种形态：Host 半边 `apply()` 为空，功能全部在浏览器侧。

## 4. 本仓库约定

| 项 | 约定 |
| --- | --- |
| 目录 | `packages/<plugin-name>/`，一个插件一个包，互不依赖 |
| 包名 | 与官方生态对齐使用 `dsh-` 前缀：`dsh-<name>`；若 npm 上该名字已被占用，则用 `@hankerlove/dsh-<name>`（首个插件已确认为 `@hankerlove/dsh-todo-list`，因为 `dsh-todo-list` 在 npm 上已被占用） |
| 源码 / 产物 | `src/` → `lib/`，产物不提交；每个包自带 `tsconfig.json` |
| 版本 | 每个插件独立语义化版本，互不联动 |
| tag | `<包名>@<版本>`，例如 `dsh-example-plugin@0.1.0` |
| 文档 | 每个包一份 `README.md`：用途、安装、配置项、示例；根 README 的[插件表](../README.md#插件)同步更新 |
| 协议 | 沿用根目录 [MIT](../LICENSE) |
| 提交信息 | Conventional Commits，scope 用插件短名，如 `feat(example-plugin): ...` |

## 5. 本地开发与调试

完成构建后，有两种把本地改动加载进 DSH 的方式。

**方式 A：`--patch` overlay 直接加载本地构建产物**（改完重新构建即生效，适合快速迭代）

```sh
# 指向构建产物，路径必须是绝对路径
cat > ./debug.patch.yml <<'EOF'
- insert:
    - id: example-plugin
      name: '/absolute/path/to/packages/example-plugin/lib/index.js'
EOF

dsh --profile web --patch ./debug.patch.yml
```

> 如果你运行的是 DSH 源码检出（`pnpm dsh ...`），可以直接把 `name` 指向 `src/index.ts`，省去构建步骤；安装版 `dsh` 只加载构建后的 JS。

**方式 B：链接安装进调试 profile**（更接近真实安装形态，适合验证 `dsh.bundle` manifest）

```sh
pnpm --filter dsh-example-plugin build
dsh plugin --profile dev add ./packages/example-plugin
dsh --profile dev --dump-config   # 应能看到 "# == dsh-example-plugin" 层
dsh --profile dev
```

调试提示：

- `--dump-config` 只组合配置、不启动，是确认插件层是否生效最快的方式。
- linked 安装的包保留自己的 `node_modules`；改完源码需要重新构建，DSH 不会自动转译 TypeScript。
- 插件里的 `console.log` 会输出到 DSH 启动它的终端。

## 6. 发布流程

```sh
# 1. 更新版本号与 CHANGELOG（如有）
pnpm --filter dsh-example-plugin build

# 2. 发布到 npm（预构建产物，用户安装时不需要构建权限）
pnpm --filter dsh-example-plugin publish --access public

# 3. 打 tag 并推送
git tag dsh-example-plugin@0.1.0
git push origin main --tags
```

补充说明：

- **npm 是首选分发方式**：`pnpm publish` 时已产出 `lib/`，`dsh plugin add <包名>` 装到的是预构建代码。
- **从 git 安装的代价**：git 安装拉取的是源码，不会自动执行 `build`，因此包内必须提供自包含的 `prepare` 脚本；同时 pnpm ≥ 10 默认拒绝执行 git 依赖的构建脚本，用户需要在该 profile 的 `pnpm-workspace.yaml` 中显式加入 `allowBuilds` 授权——这等价于允许包代码在安装时于本机执行，只应对可信来源授权。因此除非有特殊需求，优先发布到 npm 或交付 `pnpm pack` 出来的 tarball。
- **tarball 分发**：`pnpm pack` 后用 `dsh plugin add ./dsh-example-plugin-0.1.0.tgz` 安装，不需要任何构建授权。
- **兼容性**：升级依赖的 DSH 主版本前，先确认 `engines.dsh` 范围，避免用户安装时被拒绝。

## 7. 新增插件检查清单

- [ ] `packages/<plugin-name>/` 目录、`package.json` 中 `name` / `version` / `license` / `files` / `dsh.bundle` / `engines.dsh` 齐全
- [ ] dsh 相关包同时出现在 `peerDependencies` 与 `devDependencies`
- [ ] `cordis.patch.yml` 中插件行 `id` 唯一，`name` 为包名
- [ ] `pnpm --filter <包名> build` 通过，`lib/` 未被提交
- [ ] 包内 `README.md` 写明用途、安装、配置与示例
- [ ] 根 README 的插件表已更新
- [ ] `dsh plugin --profile dev add ./packages/<plugin-name>` 后 `--dump-config` 验证通过
- [ ] 版本号与 tag 一致，`git push --tags` 完成

> 纯 ESM 插件（如 [`@hankerlove/dsh-todo-list`](../packages/dsh-todo-list/README.md)）可以跳过构建相关的检查项（`pnpm --filter <包名> build`、`lib/` 不提交），但仍需确认 `files` / `exports` 列全运行时文件，并在 `--dump-config` 中看到对应插件层。

## 参考

- [第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)
- [插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.zh.md)
- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)
- [服务与依赖](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.zh.md)
- [能力的三种角色设计](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/index.zh.md)
- [Cordis 教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.zh.md)
- [CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)
