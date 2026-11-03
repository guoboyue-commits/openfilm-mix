# 本地 Agent + MCP 混剪后台

这个包把 OpenFilm Studio 改造成“混剪工作后台”：素材库、标签、本地识别、一键成片、成片管理，以及一个由本地 agent 驱使的 MCP。

## 启动

```powershell
cd packages/openfilm
node _dev-studio.mjs
```

地址和 key 会写在输出里，同时写进 `~/.openfilm/run.json`（外部 MCP 靠它找到 Studio）。

## 配音：本地 / API 两种来源

默认走本机 CosyVoice2（`127.0.0.1:9880`），不联网：先在 TTS 运行目录（`$OPENFILM_TTS_HOME`）启动 `start-tts.cmd`，
再用 `make_voice` 或 `POST /api/batch/tts` 生成，落到素材库 `assets/voice/`，返回 ffprobe 量出的真实时长。

也可以切到 `api`，用自己的 key 走云端服务商（OpenAI / ElevenLabs / Google / Groq / Azure）。

- 页面上：配音页和快速出片页都有「本地 / API」切换；API 下选服务商、模型、音色，没配 key 会给出获取入口。
- 接口：`GET/PUT /api/batch/tts/mode` 存模式，`GET /api/batch/tts/voices?provider=openai` 列音色。
- 两种模式都产出同一条音频 + `.cues.json`（逐句时间轴）+ 真实时长，字幕和烧字幕共用。
- 本地和 API 的音色分开记在 `~/.openfilm/voice.json`，来回切不会被覆盖。
- 失败不静默回退：本地没开就提示启动命令，云端失败就说清是哪个服务商，避免用户不知道钱花没花。

## 字幕与旧配音对齐

- 配音页、快速出片页挑中一条配音后，选完就能看到每句落在第几秒，不用重新生成。
- 旧配音没有 `.cues.json` 也不报错：`GET /api/batch/cues` 第一次遇到它会用本机 Whisper 对齐一次，并把结果写成 sidecar，之后直接命中。
- 出片时勾了字幕，导出完成后自动烧录；字幕用的是**素材库里那条配音**的时间轴，不是成片工程里查不到的副本。
- 字幕默认贴底 14%（抖音底部安全区内）；素材本身底部带文案时，用页面上的「字幕离底边」滑块或 `bottom: 0.22` 往上抬。

## 界面模式：极简 vs 专业

- **极简模式（默认）**：只留「快速出片」「成片管理」「任务队列」三个入口。三步完成：选素材 → 选比例（竖屏 9:16 / 横屏 16:9 / 方形 1:1）和时长（15s / 20s / 30s）→ 点「一键成片」。其余参数（按本地分镜选段、每段 4s、首尾淡入淡出、自动排重、原声保留）自动走最佳默认值。
- **专业模式**：可在左侧导航随时切到「专业」，放开全部 7 个功能页：素材库打标、配音生成（本地 / API）、选段关键词加权、多条批次出片、模板预设、Agent 调度、时间线精修。两套模式共享同一份表单状态，切来切去参数不丢。
## 本地 MCP

配置示例：`studio/server/mcp/mcp.json`；说明：`studio/server/mcp/README.md`。

工具：`list_assets` / `analyze_assets` / `tag_assets` / `get_timeline` / `shot_list` / `generate_mix` / `list_outputs` / `analyze_outputs` / `tts_status` / `make_voice` / `export_film`。

成片和素材共用一套本地识别（ffmpeg 抽帧 + faster-whisper），`analyze_outputs` 额外做质检：黑帧、静音、时长、抖动、分辨率，时间精确到 0.01 秒（黑帧时间按成片秒数报，与 ffmpeg `blackdetect` 对得上）；结果写进素材库工程的 `.film/batch-notes.json`，成片管理页直接显示质检徽标。

- 识别：本机 ffmpeg 抽帧 + faster-whisper 转写，不联网；画面描述目前是镜头特征（亮度/色彩/运动/主体位置），不是 VLM 语义理解。
- 片头黑场：分镜段开头如果是黑场或渐亮，识别时会把起点推进到画面真正出现处（最多推 2.5s），避免成片按这段取画面时带一段空白；暗色但有细节的镜头不受影响。
- 时间线：`0:00-1.28s 画面描述`，有台词时下一行 `台词：…`。
- 混剪：生成的工程自带一份素材副本，素材库删了也不影响成片。
- 按分镜选段：`generate_mix` 传 `useTimeline: true`，可选 `query`（关键词数组）和 `shotSeconds`；素材要先 `analyze_assets`，否则会报“还没有识别结果”。关键词命中台词/画面/标签的段落优先，成片直接用该段的素材内起止点。
- 页面上的“按分镜选段”默认每段最长 4 秒，可在开关旁改成别的值；0 表示用完整分镜段。
- 导出：外部 MCP 的 `export_film` 交给正在运行的 Studio 导出队列；Studio 没开时会明确报错。

## 分镜表

识别结果可以排成分镜表：每条素材的逐段 序号 / 起止 / 时长 / 画面 / 台词 / 标签。

- 素材库页「导出分镜表」：把已识别的素材一次导出成 CSV（带 BOM，Excel 打开中文不乱码）。
- 成片管理页「导出分镜表」：成片的识别结果同样能导出。
- 单条素材的识别弹窗里可以「复制分镜表」（制表符分隔，直接贴进 Excel / 飞书表格 / 发给 agent）或「导出 CSV」。
- agent 侧：MCP 工具 `shot_list`（`format`: `md` / `csv` / `tsv`），tsv 最适合让模型按台词挑片段。

## 本地 HTTP API

Studio 运行时提供同一套能力的 HTTP 接口（`x-studio-key` 鉴权）：

- `GET /api/batch/api` 接口清单
- `GET /api/batch/assets?tag=产品` 按标签筛素材
- `GET /api/batch/timeline-text?path=assets/a.mp4` 时间线纯文本
- `POST /api/batch/mix` 直接生成混剪，`export: true` 一键导出
- `POST /api/batch/run` 一句话任务，同步返回每一步
- `POST /api/batch/run/start` + `GET /api/batch/run/progress?id=` 异步任务和 SSE 进度（长片用）
- `POST /api/batch/run/wait` 等异步任务结束

说明见 `studio/server/mcp/API.md`，示例脚本 `studio/server/mcp/client.mjs`。

## 后台 Agent

页面左侧“Agent 调度”：一句话 → 规则规划器（或本机 OpenAI 兼容模型）→ 逐步调用同一套 MCP 工具。

- 规则模式零依赖，支持识别、打标、去标签、按标签筛素材、生成混剪、导出、列成片、看素材。
- 页面右上“给外部 agent”会显示 Codex / Claude Desktop 最近调过哪些 MCP 工具。
- 本地模型模式：`~/.openfilm/agent.json` 写 `{"kind":"local","endpoint":"http://127.0.0.1:11434/v1","model":"qwen2.5:7b"}`（只允许 127.0.0.1/localhost）。
- 任务和每一步都存 `~/.openfilm/agent-jobs.json`，刷新/重启后还在。

## 测试

```powershell
node --test studio/server/mcp/protocol.test.mjs studio/server/mcp/agent.test.mjs studio/server/mix-plan.test.mjs
npx tsc -p studio/server
npx tsc -p studio/ui
npx vite build --config studio/ui/vite.config.ts
```
