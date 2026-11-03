# 本地 HTTP API

和 MCP 工具同一套实现（`studio/server/mcp/tools.mjs`），给脚本、自己的前端、本地 agent 用。只监听本机，不联网。

## 鉴权

Studio 启动后把地址和 key 写进 `~/.openfilm/run.json`：

```json
{ "origin": "http://127.0.0.1:60939", "key": "…" }
```

每个请求带上：

```
x-studio-key: <key>
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/batch/api` | 接口清单（自描述，先调这个） |
| GET | `/api/batch/assets?project=&tag=` | 素材、时长、尺寸、标签、是否识别过；`tag` 按标签筛 |
| GET | `/api/batch/timeline-text?project=&path=` | 识别时间线纯文本；加 `format=json` 返回结构化 |
| GET | `/api/batch/shotlist?project=&path=&format=` | 分镜表：`md`（默认）/ `csv`（带 BOM）/ `tsv`；加 `json=1` 返回结构化 |
| POST | `/api/batch/mix` | 直接生成混剪工程；`export: true` 同步导出 MP4，`subtitles: true` 时导出后烧字幕 |
| POST | `/api/batch/run` | 一句话任务，同步返回每一步 |
| POST | `/api/batch/run/start` | 异步任务，立即返回 `id`（长片用这个） |
| GET | `/api/batch/run/progress?id=` | 任务进度：SSE；加 `format=json` 改轮询 |
| POST | `/api/batch/run/wait` | 等异步任务结束（`{ id, timeoutMs }`） |
| GET | `/api/batch/agent/jobs` | 后台 agent 任务记录 |
| GET | `/api/batch` | 已导出的成片 |
| POST | `/api/batch/outputs/analyze` | 成片质检 + 0.01 秒级内容描述；`files` 省略则取最近 3 条 |
| GET | `/api/batch/tts` | 配音状态：`{ mode, saved, local, providers }`（本地服务 + 可用的云端服务商） |
| GET | `/api/batch/tts/mode` | 同上，读取当前配音来源 |
| PUT | `/api/batch/tts/mode` | 保存配音来源：`{ mode: 'local'|'api', provider?, model?, voice? }`；本地/API 音色分开记 |
| GET | `/api/batch/tts/voices` | `?provider=openai` 列出该服务商音色；省略则看本地 |
| POST | `/api/batch/tts` | 配音：台词 → 音频，存进素材库 `assets/voice/`；可传 `mode`/`provider`/`model`/`voice`/`speed`/`pause` |
| GET | `/api/batch/cues?project=&path=` | 读一条配音的逐句时间轴；旧配音没有 `.cues.json` 时用本机 Whisper 现场对齐并落盘 |
| POST | `/api/batch/subtitles` | 把字幕烧进成片；`cues` 省略时用最近一条配音的逐句时间轴 |
| POST | `/api/batch/agent` | 异步起一个后台任务（页面用） |

## 生成混剪

```powershell
$run = Get-Content "$env:USERPROFILE\.openfilm\run.json" | ConvertFrom-Json
$body = @{ tag = '产品'; seconds = 15; count = 2; aspect = '9:16'; export = $true } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/mix" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

返回：

```json
{
  "library": "tmQZEE3PxVtq",
  "made": [{ "project": "fcTeEujFnShP", "name": "HTTP-API 验证", "seconds": 10, "shots": 4, "used": { "assets/a.mp4": 2 } }],
  "exported": ["C:\\Users\\me\\Desktop\\HTTP-API 验证 1080p.mp4"]
}
```

参数：`project`（工程 id 或名字，默认“混剪素材库”）、`tag`（按标签筛素材）、`paths`（指定素材相对路径）、
`seconds`（默认 20）、`count`（1–12）、`aspect`（`9:16` / `16:9`）、`pace`（`fast` / `normal` / `slow`）、
`seed`、`name`、`export`、`folder`、`audio`、
`useTimeline`（按识别出的分镜选段，素材要先跑过识别）、`query`（关键词数组，命中台词/画面/标签的段优先）、
`shotSeconds`（每段最多取多长，省略按分镜段自身时长）。

按分镜选段示例：

```powershell
$body = @{ useTimeline = $true; query = @('底座','金属'); seconds = 8; name = '分镜选段' } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/mix" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

## 一句话任务

```powershell
$body = @{ text = '只用产品标签的素材生成 2 条 15 秒竖屏成片并导出' } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/run" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

返回 `{ text, mode, reply, ms, steps: [{ tool, args, why, ok, result, ms }] }`。

## 时间线文本

```powershell
Invoke-RestMethod "$($run.origin)/api/batch/timeline-text?path=assets/a.mp4" -Headers @{ 'x-studio-key' = $run.key }
```

```
## assets/a.mp4
0:00-3.82s 口播解说，偏暗，清晰，深色，主体居中中部，由暗转亮，画面较稳
台词：三周调节,随手一转就到位。
```

## 分镜表

识别结果排成表，一条素材一段，可以直接进表格或者交给 agent 挑片段。

```powershell
Invoke-RestMethod "$($run.origin)/api/batch/shotlist?project=&format=csv" -Headers @{ 'x-studio-key' = $run.key }
```

`format=md` 是带表头的 Markdown 表；`csv` 带 BOM，Excel 打开中文不乱码；`tsv` 适合直接贴给 agent。
`path=` 可以重复，不给就是全部已识别的。

## 和 MCP 的关系

- MCP（stdio）：给 Codex / Claude Desktop / Cursor 这类本地 agent，工具名 `list_assets` / `analyze_assets` / `tag_assets` / `get_timeline` / `shot_list` / `generate_mix` / `list_outputs` / `analyze_outputs` / `export_film`。
- HTTP：给脚本、自己的前端、别的程序；能力相同，参数更扁平。

## 异步任务 + 进度

长片导出会跑几十秒，别让调用方干等：先起任务，再订阅进度。

```powershell
$body = @{ text = '用产品标签的素材生成 2 条 15 秒竖屏成片并导出' } | ConvertTo-Json
$job = Invoke-RestMethod "$($run.origin)/api/batch/run/start" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
$job.id
```

返回 `202 { id, job, progress: "/api/batch/run/progress?id=…" }`。

进度两种读法：

```powershell
# 轮询（最简单）
Invoke-RestMethod "$($run.origin)/api/batch/run/progress?id=$($job.id)&format=json" -Headers @{ 'x-studio-key' = $run.key }

# 等它结束
Invoke-RestMethod "$($run.origin)/api/batch/run/wait" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body (@{ id = $job.id } | ConvertTo-Json)
```

SSE：`GET /api/batch/run/progress?id=…`，每次进度变化推一条 `data: <job>`，任务结束自动断开。运行中的 `steps` 里会有 `tool: "progress"` 的步骤：

```json
{ "tool": "progress", "result": { "project": "fcTeEujFnShP", "name": "混剪 20261028-1113", "status": "running", "progress": 0.62, "phase": "rendering" } }
```

`progress` 是 0–1。任务结束后这条进度不再返回，`steps` 只剩真正执行过的工具。

## 成片质检 + 0.01 秒级内容描述

素材和成片用同一套本地识别（ffmpeg 抽帧 + faster-whisper），成片额外跑质检。

```powershell
$body = @{ files = @('C:\\Users\\me\\Desktop\\混剪 20261028-1137 2 1080p.mp4'); skipSpeech = $false } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/outputs/analyze" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

`files` 省略或为空时，取最近 3 条成片。返回里每条：

```json
{
  "path": "C:\\Users\\me\\Desktop\\混剪 20261028-1137 2 1080p.mp4",
  "ok": true,
  "quality": {
    "ok": false,
    "issues": [{ "code": "black", "level": "error", "at": 2.67, "span": 0.83, "text": "0:02.67 起有 0.83s 黑帧" }],
    "metrics": { "duration": 8, "width": 1080, "height": 1920, "hasAudio": true, "meanVolumeDb": -29, "motion": 0.032, "darkRatio": 0.104 }
  },
  "segments": 3,
  "text": "0:00.00-2.50s 中等亮度，清晰，主体居中中部，画面较稳\n0:02.50-5.33s 口播解说，偏暗……\n台词：三周调节,随手一转。\n0:05.33-8.00s 偏暗，清晰……"
}
```

- 时间码统一 `分:秒.两位小数`，起点从 `0:00.00` 开始，末段一定落到成片真实时长。
- 质检项：`black`（黑帧，error）、`no-audio` / `silent`（warn）、`too-short`（error）、`jitter`（warn）、`low-res`（warn）。
- `quality.ok` 只表示没有 error 级问题；warn 需要人工看一眼。
- 结果同时写进素材库工程的 `.film/batch-notes.json`，成片管理页卡片上直接显示质检徽标。

## 配音：本地 CosyVoice2 / 云端 API

两种来源，默认本地，随时可切。模式存 `~/.openfilm/voice.json`，MCP、HTTP API、页面共用同一份。

- `local`：本机 CosyVoice2（`127.0.0.1:9880`），不联网，带逐句 cues 与回读打分。
- `api`：用自己 key 的云端服务商（OpenAI / ElevenLabs / Google / Groq / Azure），key 在「设置 → 服务商」里配。

```powershell
# 看当前模式、本地状态、可用服务商
Invoke-RestMethod "$($run.origin)/api/batch/tts" -Headers @{ 'x-studio-key' = $run.key }

# 切到本地 / 切到云端（音色按模式分开保存，来回切不会互相覆盖）
$toLocal = @{ mode = 'local'; voice = 'n6' } | ConvertTo-Json
$toApi = @{ mode = 'api'; provider = 'openai'; model = 'gpt-4o-mini-tts'; voice = 'marin' } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/tts/mode" -Method Put -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $toApi

# 某一条临时用另一种来源：POST 里带 mode/provider/model，不改保存的设置
```

两种来源产出同一种结果：`assets/voice/` 里一条音频 + 同名 `.cues.json` + ffprobe 量的真实时长，字幕与烧字幕完全共用。

### 本地 CosyVoice2

完全本地，不联网。推理服务在 `$OPENFILM_TTS_HOME`，模型 `CosyVoice2-0.5B`，常驻 `127.0.0.1:9880`。

```powershell
# 先起服务（第一次加载模型约 20-40 秒）
start-tts.cmd

# 看它在不在（local.ok / local.loaded / local.voices）
Invoke-RestMethod "$($run.origin)/api/batch/tts" -Headers @{ 'x-studio-key' = $run.key }

# 看有哪些音色（refs/<id>.wav + 同名 .txt 就是一条）
Invoke-RestMethod "$($run.origin)/api/batch/tts/voices" -Headers @{ 'x-studio-key' = $run.key }

# 生成一条配音
$body = @{ text = '三周调节，随手一转就到位。'; name = 'A1 口播'; voice = 'a3'; speed = 1.0; pause = 0.16 } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/tts" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

返回：

```json
{
  "project": "tmQZEE3PxVtq", "path": "assets/voice/A1 口播.wav", "seconds": 3.42, "bytes": 164000,
  "text": "三周调节，随手一转就到位。", "engine": "cosyvoice2", "voice": "a3",
  "sentences": 1, "score": 0.93,
  "report": [{ "text": "三周调节，随手一转就到位。", "score": 0.93, "tries": 1 }]
}
```

- `seconds` 是 ffprobe 量出来的真实时长，混剪按它对齐画面。
- `score` 是最低一句的回读相似度；低于 0.86 建议试听或换音色重生成。
- 一次最多 800 字；长稿会自动按整句切开逐句合成，句号处停 0.16s、逗号处停约一半。
- 音色就是 `$OPENFILM_TTS_HOME\refs` 下的一对文件：`<id>.wav` 参考音 + `<id>.txt` 参考文本。想加音色，切一段 1–3 秒干净口播丢进去即可。
- 一句话也能触发：`配一段旁白：三周调节，随手一转就到位。`（规则规划器 → `make_voice`）。
- 服务没开时接口会明确说“先运行 start-tts.cmd 或切到 API 模式”，不会偷偷退回云端。
- API 失败也不会静默回退本地：报清楚是哪个服务商、哪一步，钱花没花用户能判断。

### 配音进成片

```powershell
$body = @{
  project = 'tmQZEE3PxVtq'; seconds = 11; aspect = '9:16'
  voice = 'assets/voice/A1 口播.wav'; voiceSeconds = 10.9
  export = $true
} | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/mix" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

画面按 `voiceSeconds` 铺满，配音铺在声音轨 0 秒处；`export:true` 时即使传 `audio:false` 也会保留配音轨（原声照旧可关）。

## 字幕

`make_voice` / `POST /api/batch/tts` 返回的 `cues` 是逐句起止（秒），同时写在 wav 旁边的 `.cues.json`。

```powershell
$body = @{ file = "C:\Users\me\Desktop\成片.mp4" } | ConvertTo-Json
Invoke-RestMethod "$($run.origin)/api/batch/subtitles" -Method Post -Headers @{ 'x-studio-key' = $run.key } -ContentType 'application/json' -Body $body
```

- 产物是同目录的「… 字幕.mp4」，原片保留
- 本机 `ffmpeg -vf ass=`（libass + Microsoft YaHei），不联网；按画布宽度自动折行
- 想换时间轴就传 `cues: [{ text, start, end }]`；想换某条配音就传 `voice`
- `bottom`：字幕贴底的高度，默认 `0.14`（画面高度的 14%），素材本身底部带文案时往上抬，例如 `0.2`

## 旧配音的逐句时间轴

早期生成的 wav 可能没有随附的 `.cues.json`。这时接口不会失败：

1. `GET /api/batch/cues` 与 `POST /api/batch/subtitles` 都走同一段 `ensureCues`（`studio/server/mcp/tools.mjs`）；
2. 第一次遇到时调用本机 Whisper（`analyze.py --cues`，只转写音频、不抽帧）对齐；
3. 结果写成同名 `.cues.json`，之后直接命中，不再重复转写。

纯音乐或静音配音转写不出台词时会明确报错，不会静默出一版没字幕的成片。
