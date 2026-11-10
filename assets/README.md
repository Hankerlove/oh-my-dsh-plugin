# assets

README 里展示用的动图与截图。

## 约定

| 项 | 约定 |
| --- | --- |
| 命名 | 一个插件一份演示：`boot-skin-demo.gif`、`todo-list-demo.gif`；静态图用 `*.png` |
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
