<div align="center">

# Oh My DSH Plugin

**一组开源、可组合的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status: initializing](https://img.shields.io/badge/status-initializing-orange.svg)](#路线图)

</div>

## 简介

`oh-my-dsh-plugin` 是一个 DSH 插件仓库兼实验场。每个插件都是**一个独立 npm 包**，声明 `dsh.bundle` manifest，通过 `dsh plugin add` 安装进任意 profile 后按需启用；插件之间互不耦合，可以独立开发、发布和升级。

- **可组合** —— 每个插件只贡献一层 Cordis patch，不想要的插件不启用即可
- **可独立发布** —— 一个插件 = 一个 npm 包 + 一个版本 tag，单独维护语义化版本
- **开源** —— 全部以 [MIT](./LICENSE) 协议开放

> 当前状态：仓库初始化阶段，首个插件仍在规划中。插件清单见下方[插件](#插件)表格，开发约定见 [插件开发指南](./docs/plugin-guide.md)。

## 插件

| 插件 | 说明 | npm 包名 | 状态 |
| --- | --- | --- | --- |
| _待添加_ | 首个插件筹备中 | — | 规划中 |

> 维护约定：每合并一个新插件，就在上表补一行，并在 [`docs/`](./docs) 下补充它的使用说明。

## 安装

前置条件：

- 已经安装 DSH（`dsh --version` 可输出 `0.1.x` 或更高版本）
- 已经安装 pnpm（`npm i -g pnpm`）；`dsh plugin` 会把参数转发给 profile 目录里的 pnpm

```sh
# 安装插件到指定 profile（profile 不存在时会自动初始化）
dsh plugin --profile <profile> add <插件包名>

# 只查看组合后的配置，不启动，用于确认插件层是否生效
dsh --profile <profile> --dump-config

# 用该 profile 启动
dsh --profile <profile>

# 卸载
dsh plugin --profile <profile> remove <插件包名>
```

插件支持两种分发方式：

| 方式 | 适用场景 | 说明 |
| --- | --- | --- |
| npm registry | 正式发布 | `pnpm publish` 时已产出构建结果，开箱即用 |
| tarball | 内测、预发布 | `pnpm pack` 出包后 `dsh plugin add ./<包名>-<版本>.tgz`，同样使用预构建产物 |
| git | 尝鲜、未发布 | 拉取的是源码，需要包内自带 `prepare` 脚本，且用户需在 profile 的 `pnpm-workspace.yaml` 中显式允许该包的构建脚本。本仓库是多包（monorepo）结构，优先用 npm 或 tarball 分发 |

## 仓库结构

```text
.
├── README.md                  # 项目入口（本文件）：简介、插件清单、路线图
├── LICENSE                    # MIT
├── package.json               # 根 workspace：统一脚本，不发布
├── pnpm-workspace.yaml        # 定义 packages/* 工作区
├── docs/
│   └── plugin-guide.md        # 插件开发与发布约定
└── packages/                  # 规划中：每个子目录是一个独立 npm 包
    └── <plugin-name>/
        ├── package.json       # 声明 dsh.bundle
        ├── cordis.patch.yml   # 插件层
        └── src/index.ts       # 插件入口，导出 apply(ctx)
```

根目录不发布到 npm；`packages/*` 下的每个包单独发布。

## 开发

```sh
# 安装依赖（pnpm workspace）
pnpm install

# 构建全部插件
pnpm -r build

# 把本地插件链接进一个用于调试的 profile
dsh plugin --profile dev add ./packages/<plugin-name>

# 校验 patch 层是否被正确组合
dsh --profile dev --dump-config
```

> 当前仓库还没有第三方依赖，因此暂不提交 `pnpm-lock.yaml`；首个插件引入依赖后，把 `pnpm install` 生成的锁文件一并提交。

开发与发布的具体约定（插件形态、manifest、命名、版本、发布检查清单）见 **[docs/plugin-guide.md](./docs/plugin-guide.md)**。

## 路线图

- [x] 初始化仓库：git、README、MIT LICENSE、.gitignore
- [x] 沉淀插件开发与发布约定
- [ ] 确定首批插件清单
- [ ] 搭建第一个插件包（脚手架 + 本地调试）
- [ ] 发布首个插件到 npm
- [ ] 补充 CI：构建、类型检查、发布流水线

## 贡献

欢迎 Issue 与 PR。提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，例如 `feat(<plugin>): 支持 xxx`、`docs: 更新插件清单`。新增插件请同时更新[插件](#插件)表格与对应文档。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，`packages/*` 下的每个插件包沿用同一协议。
