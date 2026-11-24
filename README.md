<div align="center">

# Oh My DSH Plugin

**个人开发、开箱即用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

## 简介

每个插件是一个独立的 npm 包，装上就能在 DSH 的 Web UI 里多一块能力，不用改 DSH 本身，也不用自己编译。

- **开箱即用**：一条安装命令，刷新页面即可使用。
- **独立打包**：一个插件一个包，按需安装、互不依赖。
- **本地优先**：数据默认存在本机，不上传。

## 插件列表

| 插件 | 能做什么 | npm 包名 |
| --- | --- | --- |
| [待办清单](./packages/dsh-todo-list/README.md) | 右上角悬浮待办面板：按天查看、重复事项每日独立实例、优先级与到点提醒。 | [`@ultraslow/dsh-todo-list`](https://www.npmjs.com/package/@ultraslow/dsh-todo-list) |
| [Skills & MCP](./packages/dsh-skill-mcp-manager/README.md) | <img src="https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/assets/skill-mcp-manager.png" width="320" alt="按工作区管理 Skill 与 MCP"><br>按 DSH 真实优先级开关 Skill（只对模型隐藏，`/名字` 仍可用），并管理全局与工作区两级 MCP。 | [`@ultraslow/dsh-skill-mcp-manager`](https://www.npmjs.com/package/@ultraslow/dsh-skill-mcp-manager) |
| [开屏与壁纸](./packages/dsh-boot-skin/README.md) | <img src="https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/assets/boot-skin-demo.gif" width="320" alt="开屏与壁纸演示：点击启动 → 开屏片头 → 主界面壁纸"><br>启动时播放自己的开屏视频，并把图片/视频铺成整屏壁纸，参数实时可调。 | [`@ultraslow/dsh-boot-skin`](https://www.npmjs.com/package/@ultraslow/dsh-boot-skin) |
| [机票 / 酒店价格监控](./packages/dsh-price-watch/README.md) | 盯机票与酒店价格：看未来一年最低价，或按日期采真实报价，变化时推飞书卡片。 | [`@ultraslow/dsh-price-watch`](https://www.npmjs.com/package/@ultraslow/dsh-price-watch) |

## 安装方式

`<profile>` 换成你的 profile 名（如 `desktop`、`web`）。

**从插件市场**：DSH 里打开 **插件 → 实验性插件 → 自定义插件索引**，添加索引源

```text
https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/main/market/index.json
```

然后在 **插件 → 发现** 里选择安装。

**从 npm**：

```sh
dsh plugin --profile <profile> add @ultraslow/dsh-todo-list
dsh plugin --profile <profile> add @ultraslow/dsh-skill-mcp-manager
dsh plugin --profile <profile> add @ultraslow/dsh-boot-skin
dsh plugin --profile <profile> add @ultraslow/dsh-price-watch
```

**从源码**：

```sh
git clone https://github.com/Hankerlove/oh-my-dsh-plugin.git
cd oh-my-dsh-plugin
dsh plugin --profile <profile> add ./packages/dsh-price-watch
```

装完用该 profile 启动 DSH 并刷新页面即可；卸载把 `add` 换成 `remove`。

## 插件使用

### [待办清单](./packages/dsh-todo-list/README.md)

- **入口**：页面右上角的悬浮面板，收起后是一个可拖动的小胶囊。
- **位置**：拖动标题栏移动；准星按钮或双击标题栏回到默认位置。
- **按天查看**：默认今天，`‹` `›` 翻日、点日期跳任意一天；「逾期 N」跳到最早的逾期日。
- **添加**：标题 + 日期 + 可选时间 + 重复规则 + 优先级，回车即添加。
- **重复规则**：不重复 / 工作日 / 周末 / 每天 / 每周 / 每月 / 每年，工作日与周末跟随法定节假日与调休（内置 2026–2027 年）。
- **优先级**：无 / P0 / P1 / P2，行首色条 + 彩色徽章区分。
- **完成与历史**：勾选只影响当天实例，重复事项漏做只记「未完成」、不算逾期。
- **到点提醒**：页内提醒卡片（完成 / 稍后 10 分钟 / 知道了）+ 轻提示音，系统支持时还会发系统通知。

### [Skills & MCP](./packages/dsh-skill-mcp-manager/README.md)

- **入口**：普通会话在头部工具条齿轮；新会话在输入框上方「标准模式」右侧的 `◎ Skill 与 MCP`。
- **Skill**：按 DSH 真实优先级分组展示，取消勾选只让模型看不到。
- **整组与拖动**：支持整组开关，也能按住拖动连续切换。
- **MCP**：分「全局」与「本工作区」两级，保存后立即生效（全局写入 profile 的 `cordis.patch.yml`）。

### [开屏与壁纸](./packages/dsh-boot-skin/README.md)

- **入口**：设置 → 插件 → 「开屏与壁纸」。
- **开屏视频**：选本地视频（建议 5–10 秒 H.264 mp4），下次启动全屏播一次。
- **跳过与兜底**：点击画面或 `Esc` 跳过；坏文件或超时会自动放行，不会卡住界面。
- **壁纸**：选图片或视频铺在界面下方；被界面挡住时把「界面不透明度」调低（建议 75–90）。
- **可调参数**：开屏的不透明度 / 渐入渐隐 / 最长时长 / 静音 / 是否可跳过，壁纸的不透明度 / 模糊 / 暗化 / 填充方式 / 界面通透度。
- **即时生效**：滑杆松手即生效，不需要重启；媒体与配置存在 `$DSH_HOME/boot-skin/`。
- **素材来源**：[NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation/tree/main/media)、[lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation/tree/main/assets/videos)（使用时请遵守对应仓库的许可）。

### [机票 / 酒店价格监控](./packages/dsh-price-watch/README.md)

- **入口**：左侧栏的价格标签图标，打开整页面板；顶部按「机票 / 酒店」切换。
- **机票 · 行情**（不填日期）：一次拿到未来一年每天的最低含税价，画成日历图。
- **机票 · 钉住**：点日历上某一天的柱子，就能把这天变成监控任务。
- **机票 · 监控**（填了日期）：从登录态的携程页面读真实航班（航班号 / 航司 / 时刻 / 机场）与每位乘客的含税实付价。
- **机票 · 往返**：可选往返，自动比较「联程组合」与「两段单买」哪个更便宜。
- **酒店 · 新建**：填城市 + 酒店名称 + 入住 / 离店日期 + 入住人数；酒店名支持实时联想，点选具体门店。
- **酒店 · 校验**：提交前先去携程确认这家酒店存在，查不到或匹配到多家都会直接报错、不建任务。
- **酒店 · 采集**：输出该住期的房型列表（房型 / 床型 / 面积 / 每晚 / 整段）与最低整段总价。
- **采集频率**：30 分钟到 24 小时自选（默认 6 小时），调度带 ±15% 抖动，被风控挡住时跳过一轮。
- **飞书通知**：每轮采集推一张卡片（结论 / 走势图 / 明细 / 采集信息），内容与上次相同则不推。
- **登录与依赖**：机票监控与酒店价格需要先登录携程；行情与酒店联想不需要登录；采集驱动本机已安装的 Chrome。
- **数据与清理**：数据存在 `$DSH_HOME/price-watch/`；已过期的机票 / 酒店监控会自动删除。
- **手机查看**：同一局域网内可直接打开 DSH 的 `/price-watch/` 只读页面。

## 许可证

[MIT](./LICENSE)
