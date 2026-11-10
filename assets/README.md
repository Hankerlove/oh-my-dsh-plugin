# assets

README 里展示用的动图与截图。

## 约定

| 项 | 约定 |
| --- | --- |
| 命名 | 一个插件一份演示：`boot-skin-demo.gif`、`todo-list-demo.gif`；同时保留一份高码率 `*-demo.mp4` 供需要看清细节的人点击查看 |
| 尺寸 | 宽度 ≤ 900px（GitHub 正文列宽约 880px，超过会被压缩） |
| 帧率 | 8–12fps。GIF 没有音频，帧率再高只是变大 |
| 体积 | 单个 ≤ 3MB，避免仓库和 npm 包变重 |
| 内容 | **只截取 DSH 窗口本身**，不要包含其它窗口、聊天记录、个人信息；不要包含第三方素材画面 |

## 从录屏转 GIF

macOS 自带录屏：`⌘⇧5` → 录制所选部分 → 存为 `.mov`，然后：

```sh
ffmpeg -i raw.mov -filter_complex \
  "[0:v]fps=10,scale=880:-1:flags=lanczos,split[a][b];\
   [a]palettegen=max_colors=128:stats_mode=diff[p];\
   [b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 packages/<plugin>/assets/demo.gif
```

- `palettegen` + `paletteuse` 是必须的：直接用 `ffmpeg -i in.mov out.gif` 会得到 256 色抖动、体积大好几倍的劣质 GIF。
- 想再压一点：把 `fps` 降到 8、`scale` 降到 720、`max_colors` 降到 96。
- 裁剪窗口边界：`-vf "crop=w:h:x:y,..."`，坐标可用「预览」App 量出来。

## 校验

```sh
ffprobe -v error -show_entries stream=width,height,nb_frames,r_frame_rate \
  -show_entries format=size,duration -of default=nw=1 demo.gif
```

体积超标时优先降 `fps` 和 `max_colors`，不要把宽度压到 600 以下——正文里会看不清。

## 已收录

| 文件 | 内容 | 规格 |
| --- | --- | --- |
| `boot-skin-demo.gif` | 光标移动到 dock → 点击启动 → 推入窗口 → 开屏片头 → 主界面壁纸（播完） | 600×390 / 10fps / 17.0s / **5.3MB** |
| `boot-skin-demo.mp4` | 同内容高画质版（README 里以链接形式给出） | 1200×780, H.264, 3.0MB |

> 这个动图偏大（5.3MB），原因是它包含两段**原速播放**的高细节动画（开屏片头 ~7s + 壁纸）。如果后续要控制体积，优先砍时长而不是降帧率/降色数——10fps / 64 色已经是观感的下限。

### 生成方式（关键帧变换，不是整段裁切）

原片 3592×2076@30fps，27.8s。步骤：

1. **卡时间点**（用中心区亮度变化定位）：片头录屏栏消失 ~1.5s、点击 ≈10.45s、窗口黑屏 10.95s、开屏动画 11.6–18.75s、UI 出现 19.0s、壁纸完全出现 ~22.0s。
2. **定位光标**：在 `10.4s` 帧里裁 dock 区域放大，量出光标热点在 `(1455, 2032)`。
3. **量窗口矩形**：对窗口帧做「暗像素行列覆盖率 > 85%」统计，得到 `2562×1667 @ (619,53)`；再按窗高比把画面横向裁到同比例（`3190×2076`，左右各裁 201px），保证最后推入窗口时四边不露桌面。
4. **按关键帧逐帧重采样**（见 `render_kf.py` 的思路，不需要 ffmpeg 表达式）：

   | 输出时间 | 缩放 | 锚点 |
   | --- | --- | --- |
   | 0.00s | 1.00 | 屏幕中心 |
   | 0.55s | 2.40 | **光标位置**（放大到 dock） |
   | 1.70s | 2.40 | 光标位置（保持，覆盖点击 ≈10.45s） |
   | 2.45s | 1.00 | 屏幕中心（**0.75s 缓慢回落**） |
   | 2.62s | 1.00 | 屏幕中心（短暂停顿） |
   | 3.85s | 1.245 | **窗口中心**（**1.23s 缓慢推入**，正好在窗口黑屏到开屏淡入之间） |
   | 之后 | 1.245 | 窗口中心（开屏 + 壁纸原速，播完整） |

   缩放/平移之间用 `easeInOutCubic` 缓动，逐帧 `crop + LANCZOS resize` 到 1200×780。
5. **编码**：帧序列 → `libx264 -crf 20`；GIF 走 `hqdn3d` 去噪 + `fps=10` + `palettegen 64 色`。
