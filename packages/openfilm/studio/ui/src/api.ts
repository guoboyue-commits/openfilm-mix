/**
 * Studio's API, as the editor calls it (studio/server/server.mjs). Same origin, so the launch key travels as the
 * cookie `/open` set; writes are refused from any other origin.
 */
import type { ExportJob } from '@/lib/export-jobs';
import { studioHost } from '@/lib/host';
import { watchStudioVersion } from '@/lib/studio-version';

/** `working`: an agent of the app's chat is working in it right now (it cannot be deleted meanwhile). */
/** GET /api/version: this Studio's, and npm's latest (null when never learnt; `checking` false: never asked). */
export interface StudioVersion { version: string; latest: string | null; newer: boolean; checkedAt: number | null; checking: boolean; source: boolean;
  /** the update Studio runs from the top bar (lib/web-update), or one that failed */
  update?: { status: 'updating' | 'failed'; version: string; error?: string } }

/** `cover`: when the person set a cover of its own (studio/server/cover.mjs), absent when it has none. */
export type Project = { id: string; path: string; name: string; openedAt: number; missing: boolean; working?: boolean; cover?: number };
export type Clip = { src: string; id: string; at?: number; time?: [number] | [number, number];
  box?: { x: number; y: number; w?: number; h?: number; r?: number }; volume?: number; speed?: number; overrides?: unknown[];
  /** a page that sets no size of its own: the px it is laid out at (the stage's without it) */
  size?: { w: number; h: number };
  /** a video's sound alone (an <audio> of its file) */
  sound?: true;
  /** its look: class names for the film's styles, and its own CSS */
  class?: string; style?: string; attrs?: Record<string, string> };
export type Track = { clips: Clip[]; locked?: boolean; hidden?: boolean; muted?: boolean; attrs?: Record<string, string> };
export type Film = { stage?: { w: number; h: number }; tracks: Track[] };
/** `value`: film.html as read, every clip named (a clip with no id takes its file's name, as the server and preview do). */
export type ProjectFilm = { project: Project; folder: string; text: string; rev: string; value: Film | null; doc: Film | null; problems: string[] };
export type MediaFile = { path: string; kind: 'video' | 'image' | 'audio' | 'page' | 'other'; size: number; mtime: number; added?: number };
/** A project's editor settings (studio/server/project-settings.mjs). */
export type ProjectSettings = { fps?: number; trackNames?: { name: string; index: number; clips: string[] }[]; trackHeights?: { height: number; index: number; clips: string[] }[] };
export type Listing = { files: MediaFile[]; folders: string[]; pages: { path: string; size: number; mtime: number }[] };
export type Op =
  | { op: 'set'; clip: string; field: string; value?: unknown }
  | { op: 'move'; clip: string; at: number; track?: number; newTrack?: number }
  | { op: 'insert'; clip?: Partial<Clip> & { src: string }; from?: string; at?: number; after?: string; track?: number | { insert: number }; newTrack?: number; link?: string | null }
  | { op: 'remove'; clip: string }
  | { op: 'split'; clip: string; at: number; time: [number, number]; restTime: [number, number] }
  | { op: 'split'; clip: string; left: Record<string, PropValue>; right: Record<string, PropValue>; rightId?: string }
  | { op: 'track'; track: number; field: 'locked' | 'hidden' | 'muted'; value: boolean }
  | { op: 'reorder'; from: number; to: number }
  | { op: 'props'; edits: PropEdit[] }
  | { op: 'stage'; w: number; h: number }
  | { op: 'fields'; clip: string; fields: Record<string, unknown> };

/** A value a clip's property takes (null removes it). */
export type PropValue = number | string | boolean | readonly number[] | Record<string, unknown> | null;
/** One property of one clip, by the clip's id (see studio/server/ops.mjs). */
export type PropEdit = { clip: string; prop: string; value: PropValue };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Writes on their way (edits, renames…): a reload for a new Studio waits for them (studioVersion). */
let writing = 0;

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const write = (rest.method ?? 'GET') !== 'GET';
  if (write) writing += 1;
  try {
    const res = await fetch(`/api/${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) markLocked();
    if (!res.ok) throw new ApiError(String(body.error ?? `Studio answered ${res.status}`), res.status, body);
    return body as T;
  } finally {
    if (write) writing -= 1;
  }
}

const p = (id: string) => `projects/${encodeURIComponent(id)}`;

/** Studio's own preferences, the same for every project (studio/server/prefs.mjs). */
export interface StudioPrefs {
  proxies: { on: boolean; height: 540 | 720 | 1080 };
  seenVersion: string | null;
  projectsFolder: string | null;
  /** the keyboard shortcuts: the scheme in use and the custom ones (lib/keymap `KeyPrefs`, checked there) */
  keys?: unknown;
}
/** Where the projects library is (src/locations.mjs): the folder, its default, whether the person chose it, the free space on its disk, how many projects are in it. */
export interface StudioLocation { path: string; default: string; chosen: boolean; free: number | null; count: number }
export interface StudioLocations { projects: StudioLocation }
/** Said on the window when they change, for what plays by them (the preview's proxies). */
export const PREFS_EVENT = 'openfilm:prefs';
/** Said on the window when the library moved, for the Projects list. */
export const LIBRARY_EVENT = 'openfilm:library';

/** A problem as Studio keeps it (src/problems.mjs): when, what it was about, what it said. */
export interface StudioProblem {
  t: string;
  area: string;
  what: string;
  agent?: string;
  step?: string;
}

/* ── 混剪后台：素材库、成片列表（studio/server/server.mjs 的 batch 路由） ── */

/** 一个成片文件，来自某个项目的一次视频导出。 */
export type BatchOutput = { project: string; projectName: string; job: string; path: string; name: string; bytes: number; at: number; label: string };

/** 本地识别出来的一段：起止秒、画面描述、台词、小标签。 */
export type BatchSegment = { start: number; end: number; text: string; speech: string | null; tags: string[] };
/** 成片质检的一条问题：黑帧、静音、抖动、分辨率等，时间精确到 0.01 秒。 */
export type BatchQualityIssue = { code: string; level: 'error' | 'warn' | 'info'; at?: number; span?: number; text: string };
/** 成片质检结果：ok 只表示没有 error 级问题。 */
export type BatchQuality = {
  ok: boolean;
  issues: BatchQualityIssue[];
  metrics: { duration: number; width: number; height: number; hasAudio: boolean; meanVolumeDb: number | null; motion: number; darkRatio: number };
};
/** 一个素材/成片的内容时间线（存在素材库工程的 .film/batch-notes.json）。 */
export type BatchNote = {
  segments: BatchSegment[];
  tags: string[];
  duration: number;
  language: string | null;
  hasSpeech: boolean;
  analyzedAt: number;
  engine: string;
  quality?: BatchQuality | null;
};
/** 本地识别能力：Python、ffmpeg、faster-whisper。 */
export type AnalyzeStatus = { ok: boolean; python: string | null; script: boolean; ffmpeg: boolean; whisper: boolean; whisperVersion?: string | null; error: string | null };
/** 一次识别里一条文件的结果。 */
export type AnalyzeResult = { path: string; rel: string; ok: boolean; error: string | null; segments: BatchSegment[]; tags: string[]; duration: number | null; language: string | null; hasSpeech: boolean; notes: BatchNote | null };

/** 后台 Agent 的一步：调了哪个 MCP 工具、参数、结果、耗时。 */
export type AgentStep = { tool: string; args: Record<string, unknown>; why: string; ok: boolean; error?: string; result?: AgentProgress | unknown; ms: number };
/** 一次后台 Agent 任务（存在 ~/.openfilm/agent-jobs.json）。 */
export type AgentJob = { id: string; text: string; mode: 'rule' | 'model'; status: 'running' | 'done' | 'failed' | 'stopped';
  reply: string; error: string | null; at: number; endedAt: number | null; ms: number; steps: AgentStep[] };
/** 运行中的细粒度进度（渲染帧、阶段），只在内存里，任务结束后不再有。 */
export type AgentProgress = { project: string; name?: string; status: 'queued' | 'running' | 'done'; progress: number; phase?: string | null; etaMs?: number | null; outputs?: string[] };
/** 本机 agent 能力：规则规划器，或已连上的本地模型（Ollama / LM Studio）。 */
export type AgentStatus = { kind: 'none' | 'local'; endpoint: string; model: string; models: string[]; local: boolean; error: string | null;
  tools: Array<{ name: string; description: string }>;
  analyze?: { ok: boolean; engine: string; python?: string | null; whisper?: string | null; ffmpeg?: boolean | null; error?: string };
  mcp?: { transport: string; calls: Array<{ tool: string; ok: boolean; ms: number; at: number; error?: string | null }> } };
export type AgentContext = { libraryId: string; libraryName: string; assets: Array<{ path: string; name: string; kind: string; tags: string[]; analyzed: boolean }>;
  tags: string[]; outputs: number; config: { kind: 'none' | 'local'; endpoint: string; model: string } };

export const agentApi = {
  status: () => call<AgentStatus>('batch/agent', { cache: 'no-store' }),
  context: (project?: string) => call<AgentContext>(`batch/agent/context${project ? `?project=${encodeURIComponent(project)}` : ''}`, { cache: 'no-store' }),
  jobs: () => call<{ jobs: AgentJob[] }>('batch/agent/jobs', { cache: 'no-store' }).then((r) => r.jobs),
  preview: (text: string, project?: string) => call<{ mode: 'rule' | 'model'; steps: Array<{ tool: string; args: Record<string, unknown>; why: string }>; reply: string }>(
    'batch/agent', { method: 'POST', json: { text, project, preview: true } }),
  start: (text: string, project?: string) => call<{ job: AgentJob }>('batch/agent', { method: 'POST', json: { text, project } }).then((r) => r.job),
  stop: (id: string) => call<{ stopped: boolean }>('batch/agent/stop', { method: 'POST', json: { id } }),
  clear: () => call<{ jobs: AgentJob[] }>('batch/agent/clear', { method: 'POST', json: {} }),
  /** 已识别的时间线转成文字（0:00-1.28s … / 台词：…）。 */
  timeline: (project: string, path?: string) => call<{ timelines: Record<string, string> }>(
    `batch/timeline?project=${encodeURIComponent(project)}${path ? `&path=${encodeURIComponent(path)}` : ''}`, { cache: 'no-store' }),
};
/** 一个可选音色。id 传给 voice 参数；zeroShot 表示带参考文本（更稳）。 */
export type TtsVoice = { id: string; zeroShot?: boolean; name?: string; description?: string | null };
/** 配音模式：local（本机 CosyVoice2）/ api（自己 key 的云端服务商）。 */
export type VoiceMode = 'local' | 'api';
/** 一个能配音的云端服务商：连接的排在前面，带它的模型和当前选择。 */
export type VoiceProvider = {
  id: string; name: string; connected: boolean; keysUrl: string; env: string;
  models: Array<{ id: string; name: string }>; model: string | null;
};
export type VoiceModeState = {
  mode: VoiceMode;
  saved: { mode: VoiceMode; provider: string | null; model: string | null; voice: string | null; localVoice?: string | null; apiVoice?: string | null };
  local: TtsStatus;
  providers: VoiceProvider[];
};
/** 本地配音服务（CosyVoice2，127.0.0.1:9880）的状态。 */
export type TtsStatus = {
  ok: boolean; origin: string; loaded?: boolean; model?: string; cuda?: boolean; error?: string;
  voice?: string; asrDevice?: string; defaultVoice?: string | null; voices?: TtsVoice[];
  /** 新模式状态里，本地服务只是其中一个字段 */
  mode?: VoiceMode;
};
/** 一句合成结果：回读打分与重试次数，低于阈值说明这句要留意。 */
export type VoiceSentence = { text: string; score: number; tries: number };
/** 一条生成好的配音：库内路径、真实时长、原文、用的音色和自检结果。 */
/** 一句字幕的起止（秒）：配音合成时一起算好，导出后直接烧进画面。 */
export type VoiceCue = { text: string; start: number; end: number };
export type VoiceTake = {
  project: string; path: string; seconds: number | null; bytes: number; text: string; engine: string; at: number;
  voice?: string | null; sentences?: number | null; score?: number | null; report?: VoiceSentence[] | null;
  cues?: VoiceCue[] | null;
};

export const batchApi = {
  /** 所有项目已完成的视频成片，按完成时间倒序。 */
  outputs: () => call<{ outputs: BatchOutput[] }>('batch', { cache: 'no-store' }).then((r) => r.outputs),
  reveal: (project: string, path: string) => call<object>('batch/reveal', { method: 'POST', json: { project, path } }),
  open: (project: string, path: string) => call<object>('batch/open', { method: 'POST', json: { project, path } }),
  remove: (project: string, path: string) => call<object>('batch/delete', { method: 'POST', json: { project, path } }),
  /** 成片原文件（浏览器里预览用）。 */
  outputFile: (project: string, path: string, at: number) => `/api/batch/output?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&v=${at}`,
  /** 一个素材的时长、尺寸和声音。 */
  probe: (project: string, path: string) => call<{ duration?: number; width?: number; height?: number; fps?: number; audio?: boolean }>(
    `projects/${encodeURIComponent(project)}/media?what=probe&path=${encodeURIComponent(path)}`, { cache: 'no-store' },
  ),
  /** 素材缩略图（视频取一帧，图片就是它自己）。 */
  poster: (project: string, path: string, mtime: number) => `/api/projects/${encodeURIComponent(project)}/media?what=poster&path=${encodeURIComponent(path)}&v=${mtime}`,
  /** 素材原文件（预览用）。 */
  file: (project: string, path: string, mtime: number) => `/api/batch/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&v=${mtime}`,
  /** 成片工程里的素材（只认 Studio 导出记录里这条成片自己的工程）。 */
  filmFile: (project: string, path: string, mtime: number) => `/api/batch/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&v=${mtime}&film=1`,
  /** 素材库的标签：项目内相对路径 → 标签名列表（存在素材库工程的 .film/batch-tags.json）。 */
  tags: (project: string) => call<{ tags: Record<string, string[]> }>(`batch/tags?project=${encodeURIComponent(project)}`, { cache: 'no-store' }).then((r) => r.tags),
  /** 整份标签表一次写回（素材库页面的每次改动都带整份，几条请求同时到也不会互相覆盖）。 */
  setTagsAll: (project: string, tags: Record<string, string[]>) => call<{ tags: Record<string, string[]> }>('batch/tags', { method: 'PUT', json: { project, all: tags } }).then((r) => r.tags),
  /** 从素材库删掉一个文件（进系统回收站）。 */
  /** 已识别的内容时间线：项目内相对路径 → 时间线。 */
  notes: (project: string) => call<{ notes: Record<string, BatchNote> }>(`batch/notes?project=${encodeURIComponent(project)}`, { cache: 'no-store' }).then((r) => r.notes),
  /** 本机识别能力（Python、ffmpeg、faster-whisper）。 */
  analyzeStatus: () => call<AnalyzeStatus>('batch/analyze', { cache: 'no-store' }),
  /** 本地识别一组素材或成片；applyTags 为真时把识别出的标签并进素材标签。 */
  analyze: (project: string, input: { paths?: string[]; outputs?: Array<{ project: string; path: string }>; applyTags?: boolean; skipSpeech?: boolean; runId?: string }) =>
    call<{ results: AnalyzeResult[]; notes: Record<string, BatchNote>; tags: Record<string, string[]> }>('batch/analyze', { method: 'POST', json: { project, ...input } }),
  /** 分镜表：序号 / 起止 / 时长 / 画面 / 台词 / 标签，可以一次带多条素材。format 默认 md。 */
  shotlist: (project: string, input: { paths?: string[]; format?: 'md' | 'csv' | 'tsv' } = {}) => {
    const query = [`project=${encodeURIComponent(project)}`, `format=${input.format ?? 'md'}`,
      ...(input.paths ?? []).map((one) => `path=${encodeURIComponent(one)}`), 'json=1'].join('&');
    return call<{ files: Array<{ path: string; name: string; duration: number }>; rows: unknown[]; text: string; seconds: number }>(
      `batch/shotlist?${query}`, { cache: 'no-store' });
  },
  /** 配音状态：当前模式（local/api）、本地服务、可用的云端服务商。 */
  ttsStatus: () => call<VoiceModeState>('batch/tts', { cache: 'no-store' }),
  /** 只取模式和保存的选择。 */
  voiceMode: () => call<VoiceModeState>('batch/tts/mode', { cache: 'no-store' }),
  /** 保存配音模式与服务商/模型/音色。 */
  setVoiceMode: (input: { mode?: VoiceMode; provider?: string | null; model?: string | null; voice?: string | null }) =>
    call<VoiceModeState>('batch/tts/mode', { method: 'PUT', json: input }),
  /** 音色清单：省略 provider 看本地，给了看该服务商（没 key 时返回空数组）。 */
  voices: (provider?: string) => call<{ provider?: string; voices: TtsVoice[]; default?: string | null; ok?: boolean }>(
    `batch/tts/voices${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, { cache: 'no-store' }),
  /** 配音：一段台词 → 素材库 assets/voice/ 里的一条音频。不传 mode 就用保存的模式。 */
  voice: (input: { project?: string; text: string; name?: string; voice?: string; speed?: number; pause?: number; verify?: boolean; natural?: boolean; mode?: VoiceMode; provider?: string; model?: string }) =>
    call<VoiceTake>('batch/tts', { method: 'POST', json: input }),
  /** 读一条配音的逐句时间轴（wav 旁边的 .cues.json）；旧配音也能读出来。 */
  cues: (project: string, path: string) =>
    call<{ project: string; path: string; cues: VoiceCue[] }>(`batch/cues?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' }),
  /** 把字幕烧进成片：cues 省略时用素材库里最近一条配音的逐句时间轴。 */
  burnSubtitles: (input: { file: string; project?: string; voice?: string; cues?: VoiceCue[]; bottom?: number }) =>
    call<{ file: string; cues: number; source: string }>('batch/subtitles', { method: 'POST', json: input }),
  /** 识别进度（SSE）：每识别完一条推一次，结束就关。返回取消函数。 */
  analyzeProgress: (runId: string, onTick: (tick: { total: number; done: number; names: string[] }) => void) => {
    const source = new EventSource(`/api/batch/analyze/progress?id=${encodeURIComponent(runId)}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { total?: number; done?: number; names?: string[]; done_all?: boolean };
        if (data.total != null && data.done != null) onTick({ total: data.total, done: data.done, names: data.names ?? [] });
      } catch { /* 忽略坏帧 */ }
    };
    return () => source.close();
  },
  removeFile: async (project: string, path: string) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Studio answered ${res.status}`);
    }
  },
  /** 上传一个文件到项目的 assets/（同名文件覆盖），回答它落下的路径。 */
  upload: async (project: string, file: File, name = file.name) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(`assets/${name}`)}`, {
      method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    const body = await res.json().catch(() => ({})) as { path?: string; error?: string; unreadable?: string };
    if (!res.ok) throw new Error(body.error ?? `Studio answered ${res.status}`);
    if (!body.path) throw new Error(`${name}: Studio did not say where it landed`);
    return { path: body.path, unreadable: body.unreadable ?? null };
  },
};

export const api = {
  /** this Studio's version and the latest openfilm on npm; `check`: ask npm now */
  version: (check = false) => call<StudioVersion>(`version${check ? '?check=1' : ''}`),
  /** the newest openfilm, run in the background (`openfilm update`): Studio starts again on it; refused (ApiError, `body.code`) while busy */
  update: () => call<{ update: NonNullable<StudioVersion['update']> }>('update', { method: 'POST', json: {} }),
  /** `openfilm doctor`, run by this Studio: the report to paste into an issue (src/doctor.mjs) */
  doctor: () => call<{ ok: boolean; text: string }>('doctor'),
  /** what went wrong in the last two weeks, newest first (src/problems.mjs) */
  problems: () => call<{ problems: StudioProblem[] }>('diagnostics/problems').then((r) => r.problems),
  /** the diagnostic file (server/diagnostics.mjs): `report` and the rest, zipped into the exports folder and shown there */
  exportDiagnostics: (report: string, conversations: boolean) => call<{ path: string; files: string[]; conversations: boolean }>('diagnostics/export', { method: 'POST', json: { report, conversations } }),
  projects: () => call<{ projects: Project[] }>('projects').then((r) => r.projects),
  prefs: () => call<StudioPrefs>('prefs'),
  /** where new projects and exports go, and the free space there */
  locations: () => call<StudioLocations>('locations'),
  /** move the library to `path` (null: the default); with `move`, its projects go too (those that could not are in `failed`) */
  moveLibrary: (path: string | null, move: boolean) => call<{ moved: number; failed: { name: string; error: string }[]; locations: StudioLocations }>('locations/projects', { method: 'PUT', json: { path, move } }).then((done) => {
    window.dispatchEvent(new Event(LIBRARY_EVENT));
    return done;
  }),
  /** a project's folder, shown in the system's file manager */
  revealProject: (id: string) => call<object>(`projects/${encodeURIComponent(id)}/reveal`, { method: 'POST', json: {} }),
  /** one of them in the system's file manager */
  openLocation: (which: keyof StudioLocations) => call<{ ok: true }>(`locations/${which}`, { method: 'POST', json: {} }),
  setPrefs: (patch: { proxies?: Partial<StudioPrefs['proxies']>; seenVersion?: string; projectsFolder?: string | null; keys?: unknown }) => call<StudioPrefs>('prefs', { method: 'PATCH', json: patch }).then((prefs) => {
    window.dispatchEvent(new Event(PREFS_EVENT));
    return prefs;
  }),
  /** the system's folder dialog, opened by Studio (a page in a browser cannot learn a path): the folder, or null when
      cancelled; throws (501) where this system has none */
  pickFolder: (title: string, at?: string) => call<{ path: string | null }>('pick-folder', { method: 'POST', json: { title, ...(at ? { at } : {}) } }).then((r) => r.path),
  newProject: (name?: string) => call<{ project: Project }>('projects', { method: 'POST', json: { name } }).then((r) => r.project),
  /** open a folder (its full path) as a project: made one when it is not yet */
  openFolder: (path: string) => call<{ project: Project }>('projects', { method: 'POST', json: { path } }).then((r) => r.project),
  rename: (id: string, name: string) => call<{ project: Project }>(p(id), { method: 'PATCH', json: { name } }).then((r) => {
    studioHost?.projectChanged?.(r.project);
    return r.project;
  }),
  forget: (id: string) => call<object>(p(id), { method: 'DELETE' }),
  film: (id: string) => call<ProjectFilm>(p(id)),
  /** 写项目根目录的一个网页（混剪后台的 film.html）；只允许项目内相对路径。 */
  writePage: (id: string, path: string, text: string) => call<{ path: string }>(`${p(id)}/pages`, { method: 'PUT', json: { path, text } }),
  /** the person opened it here: the one `openfilm open` alone comes back to */
  opened: (id: string) => call<{ project: Project }>(`${p(id)}/opened`, { method: 'POST' }),
  edit: (id: string, base: string | null, ops: Op[]) => call<{ text: string; rev: string; value: Film; doc: Film; rebased: boolean }>(`${p(id)}/edit`, { method: 'POST', json: { base, ops } }),
  files: (id: string) => call<Listing>(`${p(id)}/files`),
  /** the editor's settings of the project (`.film/settings.json`): its frame rate, its tracks' names */
  settings: (id: string) => call<{ settings: ProjectSettings }>(`${p(id)}/settings`).then((r) => r.settings),
  /** change some of them (null takes one away); answers them all as kept */
  patchSettings: (id: string, patch: { fps?: number | null; trackNames?: ProjectSettings['trackNames'] | null; trackHeights?: ProjectSettings['trackHeights'] | null }) => (
    call<{ settings: ProjectSettings }>(`${p(id)}/settings`, { method: 'PATCH', json: patch }).then((r) => r.settings)
  ),
  /** its markers (`.film/markers.json`, lib/markers): the whole list, read and written */
  markers: (id: string) => call<{ markers: unknown }>(`${p(id)}/markers`).then((r) => r.markers),
  putMarkers: (id: string, markers: unknown[]) => call<{ markers: unknown }>(`${p(id)}/markers`, { method: 'PUT', json: { markers } }).then((r) => r.markers),
  /** the loudness of a part of a file's sound (its own seconds): integrated LUFS (null: silent) and true peak */
  loudness: (id: string, path: string, from: number, to: number) => call<{ lufs: number | null; peak: number | null }>(
    `${p(id)}/media?what=loudness&path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
  ),
  /** a video's frame (`ms` of its own time) made a still beside it; answers its path */
  freezeFrame: (id: string, path: string, ms: number) => call<{ path: string }>(`${p(id)}/files/still`, { method: 'POST', json: { path, ms } }).then((r) => r.path),
  /** The project's own cover for its card (studio/server/cover.mjs): a picture from this computer, a picture of the project,
      the film at `ms`, or none (null: its film's poster again). Each answers when it was set. */
  setCover: (id: string, from: { file: Blob } | { path: string } | { ms: number }) => call<{ cover: number | null }>(`${p(id)}/cover`,
    'file' in from ? { method: 'PUT', body: from.file, headers: { 'content-type': 'application/octet-stream' } } : { method: 'POST', json: from }).then((r) => r.cover),
  clearCover: (id: string) => call<{ cover: null }>(`${p(id)}/cover`, { method: 'DELETE' }).then(() => null),
  answerAsk: (askId: string, allow: boolean) => call<{ answered: boolean }>(`get/asks/${encodeURIComponent(askId)}`, { method: 'POST', json: { allow } }),
  /** the provider's own page for its balance, opened in the person's browser */
  openBilling: (providerId: string) => call<Record<string, never>>(`providers/${encodeURIComponent(providerId)}/billing`, { method: 'POST' }),
  /** clips (by id), clips together (a group) and files (by path) of a project put in Saved (studio/server/saved.mjs):
      each one's place there */
  save: (id: string, what: { clips?: SavedAsk[]; groups?: Array<SavedAsk & { ids: string[] }>; files?: Array<SavedAsk & { path: string }>; into?: string }) => (
    call<{ paths: string[] }>(`${p(id)}/saved`, { method: 'POST', json: what }).then((r) => r.paths)
  ),
  /** a thing of Saved (its `saved/` path) used in the project: a file imported (its place), or a bundle's files brought in
      and the clip, a group's clips or the page to put on the timeline */
  takeSaved: (id: string, path: string) => call<{ clip: Record<string, unknown> & { src: string } } | { clips: SavedGroupClip[] } | { path: string }>(
    `${p(id)}/saved/take`, { method: 'POST', json: { path } },
  ),
};

/** A clip of a saved group: its track counted from the group's top one, its time in seconds from the group's start. */
export type SavedGroupClip = { track: number; at: number; clip: Record<string, unknown> & { src: string } };

/** What is said of a thing put in Saved: a clip's id (a file's path beside it), a name, and how long and big it is. */
export type SavedAsk = { id?: string; name?: string; durationMs?: number; w?: number; h?: number };

/** What an agent's `openfilm get` asks the person before it spends (studio/server/get.mjs). */
export type SpendAsk = {
  id: string; kind: 'video'; provider: string; model?: string; seconds?: number; prompt?: string;
};

/** What the person is told without a question (studio/server/get.mjs): a provider with no balance left for a run. */
export type StudioNotice = { id: string; kind: 'balance'; provider: string; providerId: string };

export type FolderEvent = { type: 'film'; rev: string } | { type: 'files'; paths?: string[] } | { type: 'history' } | { type: 'export'; job: ExportJob } | { type: 'open'; to: string }
  | { type: 'history-progress'; op: string; phase: string; done: number; total: number }
  | { type: 'ask'; ask: SpendAsk } | { type: 'asked'; id: string } | { type: 'notice'; notice: StudioNotice } | { type: 'project'; project: Project }
  /* the project was deleted, or its folder is not there any more: its pages leave it */
  | { type: 'gone' };

/**
 * Listen to a stream of events (a WebSocket: a browser's six HTTP connections to Studio stay free for the page's
 * requests, however many pages are open); returns a function that stops listening. It reconnects on its own;
 * `onBack` runs when it does (Studio stopped and started again: what changed meanwhile was not told). `watch`: this
 * stream says whether Studio answers (studioConnection), and reloads the page when Studio comes back as another
 * version (lib/studio-version); the page's own one does. It also tells Studio whether the page is in sight, so
 * `openfilm open` opens a browser when no page is (a tab behind others, a minimized window).
 */
export function listen(path: string, on: (event: FolderEvent) => void, { onBack, watch = false, gone }: { onBack?: () => void; watch?: boolean; gone?: () => Promise<boolean> } = {}): () => void {
  const inSight = () => document.visibilityState === 'visible';
  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${path}${watch ? `?visible=${inSight() ? 1 : 0}` : ''}`;
  const tell = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ visible: inSight() })); };
  if (watch) document.addEventListener('visibilitychange', tell);
  let socket: WebSocket | null = null;
  let stopped = false, lost = false, tries = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch ? watchConnection() : null;
  if (watch) studioVersion ??= watchStudioVersion({
    version: () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => (typeof h?.version === 'string' ? h.version : null)),
    idle: () => writing === 0,
    reload: () => location.reload(),
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  });
  const connect = () => {
    const s = new WebSocket(url());
    socket = s;
    s.onopen = () => {
      tries = 0;
      watcher?.up();
      if (lost) {
        lost = false;
        onBack?.();
        /* back as another version (a newer openfilm, or the desktop app's): this page's code is reloaded to match */
        if (watch) void studioVersion?.back();
      }
    };
    s.onmessage = (e) => { try { on(JSON.parse(String(e.data)) as FolderEvent); } catch { /* not ours */ } };
    s.onclose = () => {
      if (stopped) return;
      lost = true;
      watcher?.down();
      /* refused, not gone: Studio is there but this browser has no key (the stream says no reason, a request does) */
      if (watch && tries === 0) void fetch('/api/version', { cache: 'no-store' }).then((r) => { if (r.status === 401) markLocked(); }, () => {});
      /* soon at first, then every second: Studio restarting (`openfilm open` starts it afresh) is back within one
         or two, and waits a few for the pages before it */
      again = setTimeout(connect, Math.min(1000, 250 * 2 ** tries++));
      /* refused again and again while Studio answers: what it streams may be gone (a project deleted, its folder
         moved away), which reconnecting can't change; asked, and if so said once and left */
      if (gone && (tries === 3 || tries % 20 === 0)) {
        void gone().then((yes) => {
          if (!yes || stopped) return;
          stopped = true;
          if (again) clearTimeout(again);
          on({ type: 'gone' });
        }, () => {});
      }
    };
  };
  connect();
  return () => { stopped = true; if (again) clearTimeout(again); if (watch) document.removeEventListener('visibilitychange', tell); watcher?.stop(); socket?.close(); };
}

/** Which version of Studio served this page (see listen's `watch`). */
let studioVersion: ReturnType<typeof watchStudioVersion> | null = null;

/**
 * Whether Studio answers, for the notice when it does not: 'up', 'lost' (stopped a moment ago, reconnecting), 'gone'
 * (still not back), or 'locked': Studio answers but not this browser, which was never let in (its address was typed
 * or pasted without the key `openfilm open` prints, or its key is another launch's). Waiting does not fix that one.
 */
export type Connection = 'up' | 'lost' | 'gone' | 'locked';
let connection: Connection = 'up';
const connectionListeners = new Set<() => void>();
export const studioConnection = {
  get: () => connection,
  subscribe(fn: () => void) { connectionListeners.add(fn); return () => { connectionListeners.delete(fn); }; },
};
/** Studio answered this page 401: it was never let in (see Connection). */
export function markLocked() { setConnection('locked'); }
function setConnection(next: Connection) {
  if (next === connection || (connection === 'locked' && next !== 'up')) return;
  connection = next;
  for (const fn of [...connectionListeners]) fn();
}
/** A moment without Studio is said, a long one more plainly. */
function watchConnection() {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers = []; };
  return {
    down() {
      if (timers.length || connection !== 'up') return;
      /* a blip (the computer woke, the stream was cut and came straight back) is not worth a notice */
      timers = [setTimeout(() => setConnection('lost'), 2000), setTimeout(() => setConnection('gone'), 20_000)];
    },
    up() { clear(); setConnection('up'); },
    stop: clear,
  };
}
/* One stream per project, shared by everyone listening on the page. */
const streams = new Map<string, { stop: () => void; listeners: Set<(event: FolderEvent) => void> }>();
export function projectEvents(id: string, on: (event: FolderEvent) => void): () => void {
  let stream = streams.get(id);
  if (!stream) {
    const listeners = new Set<(event: FolderEvent) => void>();
    const tell = (event: FolderEvent) => {
      if (listeners.size && event.type === 'project') studioHost?.projectChanged?.(event.project);
      for (const fn of [...listeners]) fn(event);
    };
    /* back after Studio was away: the film, the files and the history may all have changed meanwhile */
    const stop = listen(`${p(id)}/events`, tell, {
      onBack: () => { tell({ type: 'film', rev: '' }); tell({ type: 'files' }); tell({ type: 'history' }); },
      /* the project off the list, or its folder missing: gone (a list that can't be read says nothing) */
      gone: () => call<{ projects: Project[] }>('projects').then((r) => { const found = r.projects.find((x) => x.id === id); return !found || Boolean(found.missing); }),
    });
    stream = { stop, listeners };
    streams.set(id, stream);
  }
  stream.listeners.add(on);
  const mine = stream;
  return () => {
    mine.listeners.delete(on);
    if (!mine.listeners.size && streams.get(id) === mine) { mine.stop(); streams.delete(id); }
  };
}




