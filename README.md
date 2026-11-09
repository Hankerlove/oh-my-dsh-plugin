<div align="center">

# Oh My DSH Plugin

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的开源插件集合**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

## 这是什么

Oh My DSH Plugin 收集可以直接安装进 DSH 的插件。每个插件是一个独立的 npm 包，装好之后会在 DSH 的 Web UI 里增加一块能力，不需要修改 DSH 本身，也不需要自己编译。

- **装好即用**：`dsh plugin add` 安装，刷新页面就能看到
- **一个插件一个包**：按需安装，互不依赖
- **数据留在本机**：插件默认只把数据存在本地，不上传

## 插件列表

| 插件 | 能做什么 | npm 包名 | 状态 |
| --- | --- | --- | --- |
| [待办清单](./packages/dsh-todo-list/README.md) | 悬浮在 Web UI 右上角的待办面板：可拖动、可收起，按天查看，支持优先级、重复规则与到点提醒 | `@hankerlove/dsh-todo-list` | 可用 |

后续插件会继续补充到这张表里。

## 环境要求

| 项 | 说明 |
| --- | --- |
| DSH | 桌面版或 Web 版，能够打开 Web UI（当前版本在 DSH `0.2.2-rc.1` 上验证） |
| pnpm | 只有命令行安装需要：`dsh plugin` 会把参数转发给 profile 目录里的 pnpm |
| 平台 | 插件运行在 DSH Web UI 内，macOS 已验证 |

## 安装

下面的 `<profile>` 换成你的 profile 名（例如 `desktop`）。

### 方式一：从 npm 安装

```sh
dsh plugin --profile <profile> add @hankerlove/dsh-todo-list
```

> 如果 npm 上还取不到这个版本，用方式二或方式三。

### 方式二：从 tarball 安装

```sh
# 在仓库里打包
cd packages/dsh-todo-list
pnpm pack            # 生成 hankerlove-dsh-todo-list-0.1.0.tgz

# 安装这个 tarball
dsh plugin --profile <profile> add ./hankerlove-dsh-todo-list-0.1.0.tgz
```

也可以从本仓库的 [Releases](https://github.com/Hankerlove/oh-my-dsh-plugin/releases) 下载对应的 tarball，把路径换掉即可。

### 方式三：从源码目录安装

```sh
git clone https://github.com/Hankerlove/oh-my-dsh-plugin.git
cd oh-my-dsh-plugin
dsh plugin --profile <profile> add ./packages/dsh-todo-list
```

### 安装之后

1. 用该 profile 启动 DSH（桌面版重启即可）
2. 刷新 Web UI 页面，插件就会出现在界面上（待办清单出现在页面右上角）
3. 卸载：

```sh
dsh plugin --profile <profile> remove @hankerlove/dsh-todo-list
```

## 插件使用

### 待办清单

- **位置**：默认停在页面右上角。拖动标题栏可以把它放到任意位置；右上角的收起按钮会把它缩成一个小胶囊，胶囊也能拖动，点击胶囊重新展开；准星按钮或双击标题栏回到默认位置。
- **按天查看**：默认只显示今天。用 `‹` `›` 逐日翻页，点击日期可以直接选任意一天；「逾期 N」「未来 N」会跳到最近的对应日期。翻到过去某天，可以看到当天完成了什么、哪些重复事项没有完成。
- **添加待办**：标题 + 日期（默认今天）+ 可选时间 + 重复规则 + 优先级，按回车或点「＋」添加。
- **重复规则**：不重复 / 工作日 / 周末 / 每天 / 每周 / 每月 / 每年。工作日与周末使用中国法定节假日与调休安排（内置 2026–2027 年）。
- **优先级**：无 / P0 / P1 / P2，行首色条与彩色徽章区分（P0 红、P1 琥珀、P2 蓝）。
- **完成与历史**：圆形勾选框，勾选后变灰划线并移到底部「已完成」；重复事项错过的当次会记录在「未完成」里，不会变成今天的逾期任务。
- **到点提醒**：带时间的待办到点后，页面顶部会弹出提醒卡片（完成 / 稍后 10 分钟 / 知道了），同时播放轻提示音；系统与 WebView 支持时还会发系统通知并更新应用角标。提醒只在 Web UI 页面打开时生效。
- **数据**：保存在浏览器 `localStorage`，不经过网络；卸载插件不会删除已有数据。

更细的说明（重复规则、工作日历覆盖范围、存储项、已知限制）见[插件说明](./packages/dsh-todo-list/README.md)。

## 数据与隐私

- 插件默认把数据保存在本机，不上传，也不向第三方发起请求。
- 卸载插件不会自动清理已有数据；需要清理时，请清除对应站点的浏览器数据。
- 各插件具体存了哪些数据，见该插件的说明文档。

## 已知限制

- 插件都运行在 DSH Web UI 里，终端、headless 等没有 Web UI 的场景无法使用。
- 待办清单的「工作日 / 周末」重复内置了 2026–2027 年的中国节假日安排；超出这两个年份会回退成周一至周五。
- 待办提醒需要页面保持打开；系统通知与应用角标是否可用取决于 WebView 与操作系统。

## 许可证

[MIT](./LICENSE)
