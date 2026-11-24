# 打包、文档与发布

本仓库只产出 **bundle**（一层 Cordis patch 的 npm 包）。用户通过 `dsh plugin add` 或插件市场安装，profile 自动维护依赖与 `dsh.profile.bundles`。

## package.json（逐字段）

```json
{
  "name": "@ultraslow/dsh-demo",
  "version": "0.1.0",
  "description": "English one-liner for npm search.",
  "license": "MIT",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/en.json",
    "locale/zh.json",
    "icon.svg"
  ],
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "demo"],
  "homepage": "https://github.com/Hankerlove/oh-my-dsh-plugin/tree/main/packages/dsh-demo",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Hankerlove/oh-my-dsh-plugin.git",
    "directory": "packages/dsh-demo"
  },
  "bugs": { "url": "https://github.com/Hankerlove/oh-my-dsh-plugin/issues" },
  "publishConfig": { "access": "public" },
  "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-layout"]
    }
  }
}
```

| 字段 | 作用 | 常见错误 |
| --- | --- | --- |
| `exports["./client"]` | 浏览器半边入口 | 漏了 → client 根本不加载 |
| `exports["./locale/*.json"]` / `"./icon"` | 插件管理与市场展示 | 漏了 → 列表里没名字没图标 |
| `files` | npm 包实际内容（package.json/README/LICENSE 自动带） | 漏运行时文件 → 装完缺文件；多带源码/截图 → 包变大 |
| `dsh.bundle.patch` | 声明这是 bundle，指明 patch 文件 | 漏了 → `dsh plugin add` 只装依赖不成层，插件不生效 |
| `dsh.client` | 声明浏览器半边 | `platform` 不是 `web` → client 不挂载 |
| `dsh.client.inject` | **只影响激活顺序**，不提供模块 | 误以为从这拿 React/服务 |
| `engines.dsh` | 安装/启动时的兼容性门禁 | 漏了退化为 peer 检查；范围写太宽会装上不兼容版本 |
| `publishConfig.access` | 公共 npm 发布 | 私有包发不上去 / 误发私有 |

纯 ESM 包不需要 `src/`、`lib/`、`tsconfig.json`，也不需要在 `files` 里列构建产物。若某个包确实走 TypeScript 构建，就回到 `docs/plugin-guide.md` §3 的通用约定，并在包 README 里说明为什么偏离。

## cordis.patch.yml

```yaml
# 这一行会插入 profile 的 Loader 树；注释说清 id 与 client 半边的关系。
- insert:
    - id: demo
      name: '@ultraslow/dsh-demo'
```

- `name` 必须是**包名**（安装后由 Node 解析）。本地 `--patch` overlay 调试时才可以写绝对路径。
- `id` 在组合后的整棵树里唯一，并且与 `client.js` 的 `NS`、slot id 前缀保持一致，日志里才认得出。
- 想覆盖已有行时用 `- id: xxx` + `config:`：**patch 替换目标行的整个 config，不做深度合并**，必须重述该行需要的所有键。
- 一个 bundle 可以声明多个 patch 文件（`dsh.bundle.patch` 用数组），按数组顺序应用。

## README

用 `templates/README.template.md`。硬规则：

- 标题 `# 中文名 · @ultraslow/dsh-<短名>`，开头一段说清「给谁、解决什么」。
- 元信息表只写 npm 包名 / 适用 DSH 范围 / 协议，**不要写死版本号**——每次发版都要改，纯 diff 噪声。
- 「安装方式」三段：从插件市场安装、从 npm 安装、从源码安装；后面跟卸载命令和「卸载后什么会留下」。
- 「数据与隐私」写清 `$DSH_HOME/<短名>/` 或 localStorage 的 key、是否联网、卸载是否删除。
- 复杂插件加「边界（不做什么）」「故障排查」「开发与验证」「文件结构」；开发与验证段落要保持可执行（`node --check`、`--dump-config`、临时 profile 的做法）。
- 截图只放仓库根 `assets/`，用 `https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/assets/<文件>` 引用；包内不要放 `docs/` 截图。

根 `README.md` 同步：插件表加一行（插件 / 能做什么 / npm 包名），「插件使用」补一段面向用户的入口与注意事项。

## 插件市场索引 market/index.json

DSH 的「市场」就是一份 **format 1 JSON 索引**，放在任意 https 静态主机上。本仓库的索引固定地址：

```text
https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/market/index.json
```

**不要手写这个文件。** 用本 skill 的生成脚本（随仓库跟踪，跨机器可用，不依赖任何本机路径）：

```sh
# 在仓库任意子目录执行都可以；脚本会向上定位仓库根
node .dsh/skills/dsh-plugin-dev/scripts/market-index.mjs

# 需要覆盖默认值（默认从 git remote/branch 推导，展示字段沿用旧索引）
node .dsh/skills/dsh-plugin-dev/scripts/market-index.mjs --author "Your Name" --slug owner/repo --branch main
```

数据来源：

| 字段 | 来源 |
| --- | --- |
| `name` / `version` / `engines.dsh` | 各包 `package.json` |
| `title` / `description` | 各包 `locale/{zh,en}.json` 的 `meta`（新插件先把这里写好） |
| `keywords` | 包 `package.json` 的 `keywords`（去掉 `dsh`/`dsh-plugin`/`deepseek-harness`） |
| `versions` / `publishTimestamp` | 公共 npm registry（只收已发布、非 deprecated、非 `0.0.0-*` 的版本） |
| `icon` / `homepage` / `repository` / `author` | 由 `git remote` 与目录推导；已有索引里的值优先保留 |

脚本只在 npm 上存在该版本时才写入，所以**先 publish，再生成索引**。能解析到官方 `@deepseek-ai/dsh-plugin-market-index` 时会先校验格式（解析不到只警告，不影响写出）。生成后跑一次 `check-plugin.mjs --repo` 确认版本一致。

索引结构（生成器已覆盖，这里用于排查）：

| 层级 | 字段 |
| --- | --- |
| 索引 | `format: 1`、`title`（必须有 `en`）、`description`、`plugins` |
| 插件 | `name`（npm 包名，索引内唯一）、`title`/`description`（`en`/`zh`）、`icon`（绝对 https raw URL）、`author`、`homepage`、`repository{url,directory}`、`metadata.keywords`、`versions` |
| 版本 | `version`（精确 SemVer）、`publishTimestamp`（npm 发布时间，Unix 秒）、`source{type:"npm"}`、`engines.dsh`（可选） |

- 版本按新→旧排序。
- `publishTimestamp` 一定来自 npm，不要手填。
- 索引地址必须直出 200、无重定向（DSH 不跟随重定向）。
- 发布后验证：raw URL 能打开、JSON 合法、新版本出现在 `versions[0]`。

## 发布流程

```sh
# 先确认工作区干净、文档与索引已更新
git status --short

# 1) 版本号（每个插件独立，互不联动）
#    breaking → major；新功能 → minor；修复 → patch。0.x 也照此语义递增。

# 2) 发布到公共 npm
npm publish --access public          # 在包目录
# 或：pnpm --filter @ultraslow/dsh-demo publish --access public

# 3) 确认真的上去了
npm view @ultraslow/dsh-demo version

# 4) 打 tag 并推送（带 scope 的 tag 要加引号）
git tag '@ultraslow/dsh-demo@0.1.0'
git push origin main --tags

# 5) 重新生成并提交市场索引（见上一节）
```

注意：

- 本机 npm 可能配置了公司镜像（`npm_config_registry=https://bnpm.byted.org`）。**公共包要发到 `https://registry.npmjs.org`**，不要被镜像配置带偏；必要时显式 `--registry`。
- `.npmrc` 里的 token 永远不进仓库；发布前确认 `git status` 没有配置文件。
- git 安装（`dsh plugin add git+...`）不会自动构建，pnpm ≥10 默认拒绝执行依赖构建脚本；因此首选 npm 或 `pnpm pack` 的 tarball。
- 版本、tag、npm 上的一致性是发版完成的唯一标准；market/index.json 的 `versions` 会自动从 npm 读到，所以顺序是「先 publish，再生成索引」。

## 提交规范

Conventional Commits，scope 用插件短名：

```text
feat(demo): 新增演示插件
fix(demo): 修复暗色主题下按钮不可读
docs(demo): 补充数据位置与故障排查
chore: demo 0.1.1（市场索引补 0.1.1）
```

一条提交只做一件事；版本号、代码、文档、索引可以分多次提交，提交信息里写清为什么，不要只写「update」。

## 发布前检查清单

- [ ] `node --check` 两个半边通过
- [ ] `check-plugin.mjs --repo` 通过（exports/files/patch/locale/README/根 README/市场索引）
- [ ] 真实 profile 安装 + 重启 + 刷新，行为验收通过
- [ ] `package.json` 版本已递增；README 没有写死版本
- [ ] `npm publish` 成功且 `npm view` 能看到
- [ ] tag 已推（`git tag --list` 确认）
- [ ] market/index.json 重新生成并提交，`versions[0]` 是新版本
- [ ] 根 README、包 README、assets 截图同步
- [ ] 没有把 `.dsh/`、`docs/research/`、`.npmrc`、调试 patch 文件提交进去
