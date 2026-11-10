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
| `boot-skin-demo.gif` | 启动 → 开屏片头 → 主界面壁纸 | 660×426 / 8fps / 5.1s / 2.7MB |
| `boot-skin-demo.mp4` | 同内容高画质版 | 880×568, H.264, 1.3MB |

生成方式（录制原片 3564×2064@30fps，24.3s）：

```sh
# 1) 裁到 DSH 窗口 + 分段变速：等待段 30×、启动黑屏 1×、开屏 3×、界面 1.5×
ffmpeg -i raw.mp4 -filter_complex "
[0:v]trim=start=0:end=10.4,setpts=(PTS-STARTPTS)/30,crop=2562:1654:619:47[a];
[0:v]trim=start=10.4:end=10.9,setpts=PTS-STARTPTS,crop=2562:1654:619:47[b];
[0:v]trim=start=10.9:end=18.15,setpts=(PTS-STARTPTS)/3.0,crop=2562:1654:619:47[c];
[0:v]trim=start=18.15:end=20.9,setpts=(PTS-STARTPTS)/1.5,crop=2562:1654:619:47[d];
[a][b][c][d]concat=n=4:v=1:a=0,scale=1760:-2:flags=lanczos[out]" \
  -map "[out]" -r 30 -c:v libx264 -crf 18 -pix_fmt yuv420p edit.mp4

# 2) Screen Studio 式缓慢推镜（1.00 → 1.06，中心锚定）
ffmpeg -i edit.mp4 -vf "zoompan=z='min(1+0.06*on/155,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=880x568:fps=30" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p assets/boot-skin-demo.mp4

# 3) 压成 GIF（660px / 8fps / 64 色 / bayer 抖动）
ffmpeg -i assets/boot-skin-demo.mp4 -vf "fps=8,scale=660:-1:flags=lanczos,split[a][b];\
[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 assets/boot-skin-demo.gif
```

裁剪框（`crop=2562:1654:619:47`）是用「窗口帧与桌面帧的逐像素差异」自动求出来的，换机器/换窗口大小时需要重算。
