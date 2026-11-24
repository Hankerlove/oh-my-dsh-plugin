# __TITLE_ZH__ · __PKG__

__SUMMARY__

| 项 | 值 |
| --- | --- |
| npm 包名 | [`__PKG__`](https://www.npmjs.com/package/__PKG__) |
| 适用 | DSH `__DSH_RANGE__`（Web UI；已在 DSH Desktop 验证） |
| 协议 | [MIT](../../LICENSE) |

## 能做什么

| 能力 | 说明 |
| --- | --- |
| __CAPABILITY_NAME__ | __CAPABILITY_DETAIL__ |

## 安装方式

`<profile>` 换成你的 profile 名（例如 `desktop`、`web`）。

### 从插件市场安装

1. **插件 → 实验性插件**，打开 **自定义插件索引**；
2. **插件 → 发现 → 添加索引源**，粘贴
   `https://raw.githubusercontent.com/Hankerlove/oh-my-dsh-plugin/refs/heads/main/market/index.json`；
3. 在列表里选择 **__TITLE_ZH__** 安装。

### 从 npm 安装

```sh
dsh plugin --profile <profile> add __PKG__
```

### 从源码安装

```sh
git clone https://github.com/Hankerlove/oh-my-dsh-plugin.git
cd oh-my-dsh-plugin
dsh plugin --profile <profile> add ./packages/__DIR__
```

安装后用该 profile 启动 DSH，并**刷新 Web UI 页面**。

卸载：

```sh
dsh plugin --profile <profile> remove __PKG__
```

__UNINSTALL_NOTE__

## 使用

### 入口

__ENTRY_NOTE__

### 常用操作

__USAGE_NOTE__

## 数据与隐私

__DATA_NOTE__

## 许可证

[MIT](../../LICENSE)，与仓库根目录一致。
