# 本地 MCP：让本地 agent 驱使混剪后台

这个 MCP 只在本机跑，stdio 传输、不监听端口、不联网。按下面的配置接入你的 agent 即可直接调用。识别用本机 ffmpeg + faster-whisper，混剪和导出用本机 Studio。

## 配置

把 `mcp.json` 里的内容合并到你的 agent 配置：

- Codex：`~/.codex/config.toml` 的 `[mcp_servers.openfilm-mix]`（或项目级配置）
- Claude Desktop：`claude_desktop_config.json` 的 `mcpServers`
- Cursor：`.cursor/mcp.json` 的 `mcpServers`

```toml
[mcp_servers.openfilm-mix]
command = "node"
args = ["./studio/server/mcp/server.mjs"]
```

## HTTP API

不想走 MCP 的话，Studio 也开了同一套能力的本地 HTTP API：

```powershell
node studio/server/mcp/client.mjs "用产品标签的素材生成 2 条 15 秒竖屏成片并导出"
```

接口清单 `GET /api/batch/api`，完整说明见 `studio/server/mcp/API.md`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_assets` | 列出素材库的素材、时长、标签、是否识别过 |
| `analyze_assets` | 本地识别，写时间线（`0:00-1.28s 画面描述` / `台词：…`）和标签 |
| `tag_assets` | 加 / 去 / 换标签 |
| `get_timeline` | 读已识别的时间线 |
| `generate_mix` | 生成混剪工程（带素材副本） |
| `list_outputs` | 列出本机导出过的成片 |
| `analyze_outputs` | 成片质检 + 0.01 秒级内容描述（黑帧/静音/抖动/分辨率） |
| `tts_status` | 本地配音服务（CosyVoice2）在不在线、有几个音色 |
| `list_voices` | 列出可选音色（`n1`–`n6` 真人参考音，`a`/`b`/`c` 系旧参考音） |
| `make_voice` | 本地配音：台词 → 真人感 wav，存进素材库；可传 `voice`/`speed`/`pause`，返回逐句 `cues` |
| `burn_subtitles` | 把字幕烧进成片（本机 ffmpeg + libass）；不给 `cues` 就用最近一条配音的时间轴 |
| `export_film` | 交给正在运行的 Studio 导出队列渲染 MP4；传 `subtitles` 时导出后自动烧字幕 |

资源：`openfilm://status`（本机能力）、`openfilm://agent-jobs`（后台 agent 任务）。

## 一句话示例

- “看看素材库里有什么”
- “识别全部素材并打上产品标签”
- “把产品镜头标成卖点”
- “用全部素材生成 3 条 20 秒竖屏成片”
- “只用产品标签的素材生成 2 条 15 秒竖屏成片”（按标签筛素材）
- “生成 2 条 15 秒竖屏成片并导出”
- “质检一下最近两条成片”
- “配一段旁白：三周调节，随手一转就到位。”
- “用 n2 音色配这段，语速 0.95，然后生成 12 秒竖屏成片并导出”

`export_film` 需要 Studio 正在运行（`~/.openfilm/run.json` 指向它）；没有 Studio 时会明确报错，不会偷偷起渲染进程。

## 配音（本地 CosyVoice2）

常驻服务在 `127.0.0.1:9880`，完全离线。

- `GET /voices` 列出音色；`refs/<id>.wav` + 同名 `.txt` 就是一条音色
- 长文本自动按整句切分，逐句合成再拼；句号停顿长、逗号停顿短
- 每句做完去首尾静音 + 淡入淡出 + 响度归一
- 默认逐句用本地 whisper 回读校验，读不准就换种子重生成（最多 2 次）
- 默认整段合成（`natural: true`），句间停顿只有 ~0.33s，比逐句拼接更像一口气说完；`natural: false` 才回退逐句拼
- 默认音色 `n4`；`n1`–`n6` 是真人长参考音（无 `.txt`，走 cross_lingual），jitter 0.18–0.19，接近真人 0.216；`a`/`b`/`c` 系是旧参考音，jitter 只有 0.07–0.09，听起来平
- 结果走 `POST /tts-file` 的 JSON 返回，`cues` 不再塞进响应头，长稿不会被 4000 字符裁掉

HTTP：

```http
POST /tts-file
{ "text": "…", "voice": "n4", "speed": 1.0, "pause": 0.16, "verify": true, "natural": true }
→ { file, name, duration, sentences, score, voice, cues: [{ text, start, end }], report }
```

混剪带配音：`POST /api/batch/mix` 传 `voice`（库内路径）和 `voiceSeconds`，画面按配音时长铺满；`export:true` 时即使 `audio:false` 也会保留配音轨。

## 字幕（本地烧录）

`make_voice` 按句切分，合成时顺手算出每句起止秒，返回 `cues: [{ text, start, end }]`，同时在 wav 旁边写一份 `<名字>.cues.json`。烧字幕读的就是这条时间轴，不需要再跑一遍识别。

- MCP：`export_film` 传 `subtitles`，导出后自动生成「… 字幕.mp4」
- MCP：`burn_subtitles` 给已有成片补字幕；`cues` 省略时取素材库最近一条配音的时间轴
- HTTP：`POST /api/batch/subtitles { file, voice?, cues? }`
- 渲染用本机 `ffmpeg -vf ass=…`（libass + Microsoft YaHei），不联网；按画布宽度自动折行，落在底部安全区

一句话闭环：

用音色 c2 配一段旁白：全金属机身，稳得住。三周调节，随手一转就到位。然后生成竖屏成片并导出

规划器拆成 `make_voice → generate_mix（画面按配音时长铺满）→ export_film（带 subtitles）`。
