<div align="center">

# Oh My DSH Plugin

**个人开发、开箱即用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

## 简介

Oh My DSH Plugin 收集个人开发、好用的 DSH 插件。每个插件是一个独立的 npm 包，装好之后会在 DSH 的 Web UI 里增加一块能力，不需要修改 DSH 本身，也不需要自己编译。

- **开箱即用**：执行一次安装命令，刷新页面即可使用，无需额外配置。
- **独立打包**：一个插件对应一个 npm 包，按需安装，互不依赖。
- **本地优先**：插件数据默认保存在本机，不上传。

## 插件列表

| 插件 | 能做什么 | npm 包名 |
| --- | --- | --- |
| [待办清单](./packages/dsh-todo-list/README.md) | 悬浮在 Web UI 右上角的待办面板：可拖动、可收起，按天查看；重复事项每天一条独立实例，支持优先级、工作日历与到点提醒 | [`@ultraslow/dsh-todo-list`](https://www.npmjs.com/package/@ultraslow/dsh-todo-list) |
| [开屏与壁纸](./packages/dsh-boot-skin/README.md) | 启动时全屏播你自己的视频，并把图片/视频铺成界面壁纸；不透明度、渐入渐隐、模糊、暗化、界面通透度都能在设置里实时调 | [`@ultraslow/dsh-boot-skin`](https://www.npmjs.com/package/@ultraslow/dsh-boot-skin) |

## 安装方式

`<profile>` 换成你的 profile 名，例如 `desktop`、`web`。

### 从 npm 安装

```sh
dsh plugin --profile <profile> add @ultraslow/dsh-todo-list
dsh plugin --profile <profile> add @ultraslow/dsh-boot-skin
```

### 从源码安装

```sh
git clone https://github.com/Hankerlove/oh-my-dsh-plugin.git
cd oh-my-dsh-plugin
dsh plugin --profile <profile> add ./packages/dsh-todo-list
dsh plugin --profile <profile> add ./packages/dsh-boot-skin
```

安装后用该 profile 启动 DSH，并刷新 Web UI 页面，插件会出现在界面上。

卸载：

```sh
dsh plugin --profile <profile> remove @ultraslow/dsh-todo-list
dsh plugin --profile <profile> remove @ultraslow/dsh-boot-skin
```

## 插件使用

### 待办清单

- **位置**：默认停在页面右上角。拖动标题栏可移动；右上角的收起按钮会把它缩成小胶囊，胶囊也能拖动，点击胶囊重新展开；准星按钮或双击标题栏回到默认位置。
- **按天查看**：默认只显示今天，用 `‹` `›` 逐日翻页，点击日期可跳任意一天；「逾期 N」可跳到最早的逾期日期。翻到过去某天能看到当天完成了什么、哪些重复事项没有完成，未来日期只读。
- **添加待办**：标题 + 日期（默认今天）+ 可选时间 + 重复规则 + 优先级，按回车或点「＋」添加；选择重复规则会按天生成独立实例。
- **重复规则**：不重复 / 工作日 / 周末 / 每天 / 每周 / 每月 / 每年。工作日与周末使用中国法定节假日与调休安排（内置 2026–2027 年）；重复事项每天一条独立实例，完成今天不影响明天，漏做只记「未完成」、不算逾期。
- **优先级**：无 / P0 / P1 / P2，行首色条与彩色徽章区分（P0 红、P1 琥珀、P2 蓝）。
- **完成与历史**：圆形勾选框，勾选只影响当天实例；完成后变灰划线并移到底部「已完成」，漏做的重复实例只记在「未完成」里，不会变成今天的逾期任务。
- **到点提醒**：带时间的当天实例到点后，页面顶部会弹出提醒卡片（完成 / 稍后 10 分钟 / 知道了），同时播放轻提示音；系统与 WebView 支持时还会发系统通知并更新应用角标。

更细的说明（重复规则、工作日历覆盖范围、存储项等）见[插件说明](./packages/dsh-todo-list/README.md)。

### 开屏与壁纸

- **入口**：设置 → 插件 → 「开屏与壁纸」。
- **开屏视频**：选一段本地视频（推荐 5–10 秒、H.264 的 mp4），打开「启用开屏视频」，下次启动 DSH 时全屏播放一次；点击画面或按 `Esc` 可跳过；超大或坏文件会自动放行，不会把界面卡在开屏后面。
- **视频参数**：不透明度、渐入时长、渐隐时长、最长时长、静音、允许跳过、每次启动是否只播一次。
- **壁纸**：选一张图片或一段视频，打开「启用壁纸」。若壁纸被界面挡住，把「界面不透明度」往低调（建议 75–90）。
- **壁纸参数**：不透明度、模糊、暗化、填充方式（cover / contain / fill）、界面通透度。
- **视频壁纸播放方式**：循环播放一直播；播放一次会在片头结束后播一遍并停住，切换会话时重播。
- **立即看效果**：点「预览开屏」或刷新页面；滑杆松手即生效，不需要重启。
- 媒体与配置全部保存在本机 `$DSH_HOME/boot-skin/`，不上传网络。
- **素材来源**：感谢这两个项目开源的开屏 / 壁纸视频，可直接下载后上传（使用前请遵守对应仓库的许可与素材版权说明）：
  - [NativeDog1/dsh-boot-animation · media](https://github.com/NativeDog1/dsh-boot-animation/tree/main/media)
  - [lxj5820/dsh-boot-animation · assets/videos](https://github.com/lxj5820/dsh-boot-animation/tree/main/assets/videos)

更细的说明（参数范围、素材建议、排查方法）见[插件说明](./packages/dsh-boot-skin/README.md)。

## 许可证

[MIT](./LICENSE)
