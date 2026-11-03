/**
 * 混剪后台：素材库、一键成片、任务队列、成片管理、模板预设。
 *
 * 这里是“工作后台”，不是时间线编辑器：成片在后台按批次排队渲染，需要精修时再跳到
 * /projects/<id> 的高级编辑。素材只上传一次，所有成片共用；每条成片另开一个工程，
 * 里面是可直接继续编辑、导出的 film.html。
 */
import React from 'react';
import {
  AudioLines, Bot, Check, ChevronRight, Download, Clapperboard, Clock, Cpu, Film, FolderOpen, Mic,
  Image as ImageIcon, LayoutGrid, ListChecks, Loader2, Music, Pause, Play, RefreshCw,
  Plus, ScanLine, Search, Settings2, ShieldCheck, Shuffle, Sparkles, SquareStack, Tag, Terminal, Trash2, Upload, Wand2, X, Zap,
} from 'lucide-react';
import { agentApi, api, batchApi, projectEvents, type AgentContext, type AgentJob, type AgentProgress, type AgentStatus, type AnalyzeStatus, type BatchNote, type BatchOutput, type Project, type TtsVoice, type VoiceMode, type VoiceModeState, type VoiceTake } from '@/api';
import { useT } from '@/i18n';
import { cancelExport, listExports, startExports, type ExportJob } from '@/lib/export-jobs';
import { mixFreshOps, mixableAssets, planContentMix, planMix, type MixAsset, type MixOptions, type MixPlan } from '@/lib/mix-plan';
import { ConfirmDialog } from './ConfirmDialog';
import { Toast, useToast } from './Toast';

const LIBRARY_NAME = '混剪素材库';
/** 配音参数：来源（本地/API）、服务商、模型、音色，以及本地引擎的语速/停顿/回读。 */
type VoiceOpts = {
  mode: VoiceMode; provider: string; model: string; voice: string;
  speed: number; pause: number; natural: boolean; verify: boolean;
};

/** 已选中的配音：路径、时长、原文，加上服务端的自检明细（老素材没有就为 null）。 */
type VoicePick = {
  path: string; seconds: number; text: string; at: number;
  voice?: string | null; score?: number | null; report?: { text: string; score: number; tries: number }[] | null;
  /** 逐句起止（秒）：合成时一起算好，字幕和画面铺满都用它 */
  cues?: { text: string; start: number; end: number }[] | null;
};
const TASKS_KEY = 'openfilm.batch.tasks';
const FORM_KEY = 'openfilm.batch.form';
const AUTO_KEY = 'openfilm.batch.autoAnalyze';
const MODE_KEY = 'openfilm.batch.mode';

type Tab = 'quick' | 'library' | 'voice' | 'generate' | 'tasks' | 'outputs' | 'templates' | 'agent';
/** 简单模式只留三个入口；专业模式是完整的七页后台。 */
type UiMode = 'simple' | 'pro';
type Aspect = '9:16' | '16:9' | '1:1' | '4:3';
type TaskStatus = 'waiting' | 'preparing' | 'planning' | 'rendering' | 'done' | 'failed' | 'cancelled';

export interface BatchForm {
  preset: string;
  seconds: number;
  aspect: Aspect;
  pace: MixOptions['pace'];
  avoidRepeat: number;
  shuffle: boolean;
  seed: number;
  voiceSeconds: string;
  fps: number;
  audio: boolean;
  count: number;
  name: string;
  folder: string;
  /** 导出后把配音逐句字幕烧进画面 */
  subtitles: boolean;
  /** 字幕离底边的高度（画面高度的比例）：素材底部自带文案时调大避开 */
  subtitleBottom: number;
  /** 按本地识别出的分镜选段（而不是随机取画面） */
  useTimeline: boolean;
  /** 选段关键词：命中台词/画面/标签的段优先（空格分隔） */
  query: string;
  /** 按分镜选段时每段最长多少秒；0 表示用完整分镜段 */
  shotSeconds: string;
}

type Asset = MixAsset & { size: number; mtime: number; fps?: number; audio?: boolean };

type Task = {
  id: string;
  name: string;
  seed: number;
  status: TaskStatus;
  progress: number;
  etaMs: number | null;
  message: string;
  projectId: string | null;
  projectName: string | null;
  jobId: string | null;
  output: string | null;
  shots: number;
  duration: number;
  error: string | null;
  at: number;
  options: MixOptions;
  assets: Asset[];
  libraryId: string;
  folder: string;
  /** 成片是否带素材原声（每条任务自己记住，改表单不影响已排队的） */
  audio: boolean;
  /** 这条任务用的配音（素材库内路径，assets/voice/…）；null：没有旁白 */
  voice?: string | null;
  /** 导出后是否把配音字幕烧进画面 */
  subtitles?: boolean;
  /** 字幕离底边的高度（0.11 = 底部 11%），跟着任务走，改表单不影响已排队的 */
  subtitleBottom?: number;
};

const PRESETS: Array<{ id: string; seconds: number; aspect: Aspect; pace: MixOptions['pace']; note: string }> = [
  { id: 'douyin', seconds: 20, aspect: '9:16', pace: 'normal', note: '快节奏开场，适合信息流投放' },
  { id: 'wechat', seconds: 30, aspect: '9:16', pace: 'slow', note: '留白多一点，适合完整讲清卖点' },
  { id: 'xhs', seconds: 15, aspect: '4:3', pace: 'fast', note: '前三秒抓人，适合种草笔记' },
  { id: 'landscape', seconds: 30, aspect: '16:9', pace: 'normal', note: '官网、B 站和横屏投放' },
  { id: 'square', seconds: 15, aspect: '1:1', pace: 'fast', note: '朋友圈、公众号和方形封面' },
];

const ASPECTS: Array<{ value: Aspect; stage: { w: number; h: number } }> = [
  { value: '9:16', stage: { w: 1080, h: 1920 } },
  { value: '16:9', stage: { w: 1920, h: 1080 } },
  { value: '1:1', stage: { w: 1080, h: 1080 } },
  { value: '4:3', stage: { w: 1080, h: 1440 } },
];

/** 计划里的素材路径换到成片工程自己的 assets/（按路径映射）。 */
function remapPlanSrc(plan: MixPlan, remap: Map<string, string>): MixPlan {
  const swap = (src: string) => remap.get(src) ?? src;
  const used: Record<string, number> = {};
  for (const [src, count] of Object.entries(plan.used)) used[swap(src)] = (used[swap(src)] ?? 0) + count;
  return {
    ...plan,
    tracks: plan.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip, src: swap(clip.src) })) })),
    segments: plan.segments.map((segment) => ({ ...segment, src: swap(segment.src) })),
    used,
  };
}
const stageFor = (aspect: Aspect) => ASPECTS.find((a) => a.value === aspect)?.stage ?? { w: 1080, h: 1920 };
const defaultForm = (): BatchForm => ({
  preset: 'douyin', seconds: 20, aspect: '9:16', pace: 'normal', avoidRepeat: 3, shuffle: true,
  seed: Math.floor(Math.random() * 900000) + 1000, voiceSeconds: '', fps: 30, audio: true, count: 1,
  name: '', folder: '', subtitles: true, subtitleBottom: 0.14, useTimeline: true, query: '', shotSeconds: '4',
});

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fmtTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};
const stampOf = (seconds: number) => {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
/** 时间线时间码：和成片质检、后端 timelineText 用同一套 m:ss.cc（0:00.00 / 1:28.50） */
const startOf = (seconds: number) => {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const rest = Math.round((t - m * 60) * 100) / 100;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
};

const fmtBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const INPUT = 'h-9 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12.5px] text-[var(--text)] outline-none transition hover:border-[var(--border-strong)] focus:border-[var(--accent)]';
const BTN = 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
const BTN_PRIMARY = `${BTN} bg-[var(--accent)] text-[var(--accent-text,#fff)] hover:opacity-90`;

/** 把一段文本存成本地文件（分镜表导出用）。 */
function saveTextFile(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** 分镜表：把一组素材的识别结果导出成 CSV（带 BOM，Excel 打开中文不乱码）。 */
async function saveShotList(project: string, paths: string[], name: string) {
  const list = await batchApi.shotlist(project, { paths, format: 'csv' });
  saveTextFile(name, list.text, 'text/csv;charset=utf-8');
  return list;
}
const BTN_SOFT = `${BTN} bg-[var(--fill-tsp)] text-[var(--text)] hover:bg-[var(--bg-hover)]`;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2 text-[12px] font-medium text-[var(--text)]">
        {label}
        {hint ? <span className="text-[11px] font-normal text-[var(--text-faint)]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} title={hint} onClick={() => onChange(!checked)}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-left text-[12.5px] text-[var(--text)] transition hover:border-[var(--border-strong)]">
      <span className="truncate">{label}</span>
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition ${checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${checked ? 'left-3.5' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-[var(--fill-tsp)] px-2.5 py-2">
      <span className="text-[10.5px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <span className="truncate text-[13px] font-semibold tabular-nums text-[var(--text)]">{value}</span>
    </div>
  );
}

function readForm(): BatchForm {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return defaultForm();
    const kept = JSON.parse(raw) as Partial<BatchForm>;
    return { ...defaultForm(), ...kept, count: Math.max(1, Math.min(12, Number(kept.count) || 1)) };
  } catch { return defaultForm(); }
}

function readTasks(): Task[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const list = raw ? JSON.parse(raw) as Task[] : [];
    return Array.isArray(list) ? list.map((task) => ({ ...task, audio: task.audio !== false })) : [];
  } catch { return []; }
}

/** 一条素材的时长、尺寸、帧率和有没有声音。读不出时给保守值，计划器会按图片/短视频处理。 */
async function probeAsset(projectId: string, file: { path: string; kind: MixAsset['kind']; size: number; mtime: number }): Promise<Asset> {
  const base: Asset = { path: file.path, name: file.path.split('/').pop(), kind: file.kind, size: file.size, mtime: file.mtime };
  try {
    const facts = await batchApi.probe(projectId, file.path);
    return {
      ...base,
      ...(facts.duration && facts.duration > 0 ? { durationMs: Math.round(facts.duration * 1000) } : {}),
      ...(facts.width ? { w: facts.width } : {}),
      ...(facts.height ? { h: facts.height } : {}),
      ...(facts.fps ? { fps: facts.fps } : {}),
      ...(facts.audio !== undefined ? { audio: facts.audio } : {}),
    };
  } catch { return base; }
}

function taskIsActive(task: Task): boolean {
  return task.status === 'waiting' || task.status === 'preparing' || task.status === 'planning' || task.status === 'rendering';
}

const videoOf = (job: ExportJob) => job.outputs.find((file) => /\.(mp4|mov|webm)$/i.test(file)) ?? null;

export function BatchWorkspace({ onOpenEditor, onOpenProjects }: {
  /** 精修某一条成片：跳到时间线编辑器 */
  onOpenEditor: (projectId: string) => void;
  /** 项目管理（新建、改名、删除、从文件夹打开） */
  onOpenProjects: () => void;
}) {
  const t = useT();
  const toast = useToast();
  /** 简单模式（默认）只给三步；专业模式是原来的完整后台。 */
  const [mode, setMode] = React.useState<UiMode>(() => {
    try { return localStorage.getItem(MODE_KEY) === 'pro' ? 'pro' : 'simple'; } catch { return 'simple'; }
  });
  const [tab, setTab] = React.useState<Tab>(() => {
    try { return localStorage.getItem(MODE_KEY) === 'pro' ? 'library' : 'quick'; } catch { return 'quick'; }
  });
  const [library, setLibrary] = React.useState<Project | null>(null);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(true);
  const [loadingAssets, setLoadingAssets] = React.useState(false);
  const [uploading, setUploading] = React.useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [filter, setFilter] = React.useState<'all' | 'video' | 'image'>('all');
  /** 素材标签：路径 → 标签名；存在素材库工程里，换浏览器也还在 */
  const [tags, setTags] = React.useState<Record<string, string[]>>({});
  /** 当前按哪个标签筛（null：全部） */
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  /** 正在给哪些素材改标签（null：关着） */
  const [tagging, setTagging] = React.useState<string[] | null>(null);
  /** 本地识别出来的内容时间线：路径 → 时间线 */
  const [notes, setNotes] = React.useState<Record<string, BatchNote>>({});
  /** 正在看哪条素材/成片的内容时间线 */
  const [reading, setReading] = React.useState<{ title: string; note: BatchNote | null } | null>(null);
  /** Agent 识别完的整批时间线：按素材排，右侧可逐条看 */
  const [agentTimeline, setAgentTimeline] = React.useState<Array<{ title: string; note: BatchNote | null }> | null>(null);
  /** Agent 页的“最近完成”：给工作台一个一眼能看懂的结果区 */
  const [agentFocus, setAgentFocus] = React.useState<string | null>(null);
  /** 打开 Agent 时间线时先把最新识别结果读进 notes，别拿旧状态去开弹窗 */
  const [timelineLoading, setTimelineLoading] = React.useState(false);
  /** Agent 识别完的整批时间线：按素材排，右侧可逐条看 */

  /** 本地识别中：进度和当前文件 */
  const [analyzing, setAnalyzing] = React.useState<{ done: number; total: number; name: string } | null>(null);
  /** 本机识别能力；null：还没问 */
  const [analyzer, setAnalyzer] = React.useState<AnalyzeStatus | null>(null);
  /** 新导入的素材自动做本地识别（记在浏览器里，下次打开还生效） */
  const [autoAnalyze, setAutoAnalyze] = React.useState(() => {
    try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; }
  });
  const [query, setQuery] = React.useState('');
  const [form, setForm] = React.useState<BatchForm>(readForm);
  const [tasks, setTasks] = React.useState<Task[]>(readTasks);
  /** 这次打开页面时的任务快照：本地列表被清掉时，恢复逻辑仍知道哪些要接着跑 */
  const initialTasks = React.useRef<Task[] | null>(null);
  initialTasks.current ??= tasks;
  /** 页面刷新前就在渲染的任务：工程和导出都还在，恢复跟踪即可，不重复出片 */
  const resumePending = React.useRef(false);
  /** 刷新前已经渲染到一半的任务：工程已经建好，接着用，不再复制一份素材 */
  const resuming = React.useRef(new Set<string>());
  const [outputs, setOutputs] = React.useState<BatchOutput[]>([]);
  const [outputsLoading, setOutputsLoading] = React.useState(false);
  const [outputQuery, setOutputQuery] = React.useState('');
  const [playing, setPlaying] = React.useState<BatchOutput | null>(null);
  /** 素材预览：视频/图片/声音都在同一个弹层里看 */
  const [looking, setLooking] = React.useState<Asset | null>(null);
  const [libraryId, setLibraryId] = React.useState('');
  /** 素材库在这台电脑上的位置（后台要知道东西落在哪） */
  const [where, setWhere] = React.useState<{ projects: string } | null>(null);
  const [confirmAsset, setConfirmAsset] = React.useState<Asset | null>(null);
  const [confirmOutput, setConfirmOutput] = React.useState<BatchOutput | null>(null);
  const [pickingFolder, setPickingFolder] = React.useState(false);
  /** 后台 Agent：本机能力、一句话任务、每一步的 MCP 工具调用 */
  const [agent, setAgent] = React.useState<AgentStatus | null>(null);
  const [agentJobs, setAgentJobs] = React.useState<AgentJob[]>([]);
  const [agentContext, setAgentContext] = React.useState<AgentContext | null>(null);
  /** 配音状态：当前模式（本地/API）、本地服务、可用服务商；null：还没问 */
  const [tts, setTts] = React.useState<VoiceModeState | null>(null);
  /** 正在生成哪段配音 */
  const [voiceBusy, setVoiceBusy] = React.useState(false);
  /** 配音脚本草稿（记住，切页签不丢） */
  const [voiceDraft, setVoiceDraft] = React.useState('');
  /** 配音参数：来源、服务商、模型、音色，以及本地引擎的语速/停顿/回读。 */
  const [voiceOpts, setVoiceOpts] = React.useState<VoiceOpts>(
    /* natural：整段合成。句间停顿只有 ~0.33s，听着像一口气说完；关掉就逐句拼接 */
    () => ({ mode: 'local', provider: '', model: '', voice: '', speed: 1, pause: 0.16, natural: true, verify: true }),
  );
  /** 当前选中的配音：出片时铺到声音轨，画面按它的时长铺满 */
  const [voice, setVoice] = React.useState<VoicePick | null>(null);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const cancelled = React.useRef(new Set<string>());
  const inputRef = React.useRef<HTMLInputElement>(null);

  /* Esc closes the player: the same key that closes the other dialogs */
  React.useEffect(() => {
    if (!playing && !looking) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPlaying(null); setLooking(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, looking]);

  React.useEffect(() => {
    try { localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch { /* 只在本次页面有效 */ }
  }, [form]);
  React.useEffect(() => {
    try { localStorage.setItem(AUTO_KEY, autoAnalyze ? '1' : '0'); } catch { /* 只在本次页面有效 */ }
  }, [autoAnalyze]);
  React.useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 只在本次页面有效 */ }
  }, [mode]);
  /* 任务列表是后台的状态：刷新页面、关掉再打开都还在（恢复出来的任务也要写回去） */
  React.useEffect(() => {
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch { /* 只在本次页面有效 */ }
  }, [tasks]);

  const patchTask = React.useCallback((id: string, patch: Partial<Task> | ((task: Task) => Partial<Task>)) => {
    setTasks((list) => list.map((task) => (task.id === id ? { ...task, ...(typeof patch === 'function' ? patch(task) : patch) } : task)));
  }, []);

  /* ── 素材库：固定一个工程放素材，找不到就新建 ── */
  const loadAssets = React.useCallback(async (project: Project) => {
    setLoadingAssets(true);
    try {
      const listing = await api.files(project.id);
      const files = listing.files.filter((file) => file.kind === 'video' || file.kind === 'image' || file.kind === 'audio');
      const base = files.map((file) => ({
        path: file.path,
        name: file.path.split('/').pop(),
        kind: file.kind as MixAsset['kind'],
        size: file.size,
        mtime: file.mtime,
      }));
      setAssets(base);
      /* 时长要问 ffmpeg：先给出列表，再逐条补上事实，卡片会自己更新 */
      for (const file of base) {
        const probed = await probeAsset(project.id, file);
        setAssets((list) => list.map((asset) => (asset.path === probed.path ? probed : asset)));
      }
    } catch (e) {
      toast.showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAssets(false);
    }
  }, [toast]);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const projects = await api.projects();
        let found = projects.find((p) => !p.missing && p.name === LIBRARY_NAME) ?? null;
        if (!found) found = await api.newProject(LIBRARY_NAME);
        if (!live) return;
        setLibrary(found);
        setLibraryId(found.id);
        setTags(await batchApi.tags(found.id).catch(() => ({})));
        setNotes(await batchApi.notes(found.id).catch(() => ({})));
        void batchApi.analyzeStatus().then(setAnalyzer).catch(() => {});
        await loadAssets(found);
      } catch (e) {
        if (live) toast.showError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [loadAssets, toast]);

  /** 上传后自动识别要用到的最新分析函数（定义在下面，避免循环依赖） */
  const analyzeNew = React.useRef<(paths: string[]) => void>(() => {});
  /** 成片导出完成后自动识别（同样在下面定义） */
  const analyzeNewFilm = React.useRef<(one: { project: string; path: string }) => void>(() => {});

  const upload = React.useCallback(async (files: FileList | File[]) => {
    if (!library) return;
    const list = [...files].filter((file) => /\.(mp4|mov|webm|m4v|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac)$/i.test(file.name));
    if (!list.length) { toast.showError(t('batch.library.dropHint')); return; }
    setUploading({ done: 0, total: list.length });
    let failed = 0;
    const landedPaths: string[] = [];
    try {
      for (let i = 0; i < list.length; i += 1) {
        const file = list[i]!;
        try {
          const landed = await batchApi.upload(library.id, file, file.name);
          if (landed.unreadable) failed += 1;
          else if (landed.path) landedPaths.push(landed.path);
        } catch (e) {
          failed += 1;
          toast.showError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
        setUploading({ done: i + 1, total: list.length });
      }
      await loadAssets(library);
      if (!failed) toast.show(t('batch.library.ready'));
      /* 开关打开时，新素材马上交给本机识别：标签和时间线一次到位 */
      if (autoAnalyze) analyzeNew.current(landedPaths);
    } finally {
      setUploading(null);
    }
  }, [autoAnalyze, library, loadAssets, t, toast]);

  const removeAssets = React.useCallback(async () => {
    const target = confirmAsset;
    if (!library || !target) return;
    try {
      await batchApi.removeFile(library.id, target.path);
      setSelected((now) => { const next = new Set(now); next.delete(target.path); return next; });
      await loadAssets(library);
      toast.show(t('batch.common.confirm'));
    } catch (e) {
      toast.showError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmAsset(null);
    }
  }, [confirmAsset, library, loadAssets, t, toast]);

  const usableAll = React.useMemo(() => mixableAssets(assets), [assets]);
  const usable = React.useMemo(() => {
    const chosen = selected.size ? usableAll.filter((asset) => selected.has(asset.path)) : usableAll;
    return chosen;
  }, [usableAll, selected]);

  const options = React.useMemo<MixOptions>(() => {
    const voice = Number(form.voiceSeconds);
    /* 按分镜选段：从识别结果里取每条素材的段落，路径用素材库内的相对路径。
       成片任务真正执行时会把这些路径重映射到成片工程自己的 assets/ 下。 */
    const shots = form.useTimeline ? usable.flatMap((asset) => {
      const note = notes[asset.path];
      return (note?.segments ?? [])
        .filter((segment) => Number(segment.end) > Number(segment.start))
        .map((segment) => ({
          src: asset.path, from: Number(segment.start), to: Number(segment.end),
          text: segment.text ?? '', speech: segment.speech ?? '', tags: Array.isArray(segment.tags) ? segment.tags : [],
        }));
    }) : undefined;
    const query = form.query.split(/[\s,，、]+/).map((one) => one.trim()).filter(Boolean);
    return {
      targetSeconds: form.seconds,
      minShotSeconds: form.pace === 'fast' ? 0.9 : form.pace === 'slow' ? 1.8 : 1.2,
      maxShotSeconds: form.pace === 'fast' ? 2.6 : form.pace === 'slow' ? 4.6 : 3.6,
      pace: form.pace,
      avoidRepeat: form.avoidRepeat,
      shuffle: form.shuffle,
      seed: form.seed,
      stage: stageFor(form.aspect),
      fps: form.fps,
      ...(voice > 0 ? { voiceSeconds: voice } : {}),
      ...(form.useTimeline ? { shots: shots ?? [], query, ...(Number(form.shotSeconds) > 0 ? { shotSeconds: Number(form.shotSeconds) } : {}) } : {}),
    };
  }, [form, notes, usable]);

  const preview = React.useMemo<{ plan: MixPlan | null; error: string | null }>(() => {
    if (!usable.length) return { plan: null, error: t('batch.form.noSelection') };
    try {
      return { plan: form.useTimeline ? planContentMix(usable, options) : planMix(usable, options), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [form.useTimeline, usable, options, t]);

  const repeats = preview.plan ? Math.max(0, preview.plan.shots - Object.keys(preview.plan.used).length) : 0;
  const activeCount = tasks.filter(taskIsActive).length;

  const set = <K extends keyof BatchForm>(key: K, value: BatchForm[K]) => setForm((now) => ({ ...now, [key]: value }));
  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setForm((now) => ({ ...now, preset: id, seconds: preset.seconds, aspect: preset.aspect, pace: preset.pace }));
  };

  const chooseFolder = async () => {
    setPickingFolder(true);
    try {
      const picked = await api.pickFolder(t('batch.form.folder'));
      if (picked) set('folder', picked);
    } catch (e) {
      toast.showError(e instanceof Error ? e.message : String(e));
    } finally {
      setPickingFolder(false);
    }
  };

  /**
   * 跟一条导出走到结束：进度、预计剩余、成片路径。页面刷新后恢复的任务也走这里，
   * 所以后台关掉再打开，正在渲染的那条仍会自己变成“已完成”。
   */
  /**
   * 一条任务要用字幕时，先从素材库取这条配音的逐句时间轴。
   * 配音在素材库，成片工程里只是复制品（路径不同），所以必须按 libraryId 查。
   * 旧配音没有 sidecar：服务端会现场用本地 Whisper 对齐一次并落盘，之后直接命中。
   */
  const cuesFor = React.useCallback(async (task: Task) => {
    if (!task.subtitles || !task.voice) return null;
    const project = task.libraryId || library?.id;
    if (!project) return null;
    const got = await batchApi.cues(project, task.voice).catch(() => null);
    return got?.cues?.length ? got.cues : null;
  }, [library]);
  const followExport = React.useCallback((task: Task, projectId: string, jobId: string, subtitles?: Array<{ text: string, start: number, end: number }> | null) => new Promise<void>((resolve) => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    let burning = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (settle) clearTimeout(settle);
      stop();
      resolve();
    };
    /* 有配音又要字幕：导出完把逐句字幕烧进画面，再把带字幕的那条记成结果 */
    const finish = async (raw: string) => {
      if (!subtitles?.length) return raw;
      patchTask(task.id, { message: t('batch.tasks.subtitles') });
      /* 直接给 cues：配音在素材库，成片工程里是另一条路径，按工程再查会查不到 */
      const bottom = task.subtitleBottom;
      const burned = await batchApi.burnSubtitles({ file: raw, cues: subtitles, ...(bottom ? { bottom } : {}) }).catch((e) => {
        toast.showError(e instanceof Error ? e.message : String(e));
        return null;
      });
      return burned?.file ?? raw;
    };
    const apply = (now: ExportJob) => {
      if (now.status === 'done') {
        if (burning) return;
        burning = true;
        const raw = videoOf(now);
        if (!raw) { done(); return; }
        void finish(raw).then((output) => {
          patchTask(task.id, { status: 'done', progress: 1, etaMs: null, output, message: t('batch.tasks.done') });
          /* 开关打开时，成片出来就自动识别：成片管理里马上有内容时间线 */
          if (autoAnalyze && output) setTimeout(() => analyzeNewFilm.current({ project: projectId, path: output }), 600);
          done();
        });
      } else if (now.status === 'failed' || now.status === 'cancelled') {
        const error = now.error ?? (now.status === 'cancelled' ? t('batch.tasks.cancelled') : 'export failed');
        patchTask(task.id, { status: now.status === 'cancelled' ? 'cancelled' : 'failed', error, message: error });
        done();
      } else {
        patchTask(task.id, {
          progress: Math.min(0.99, 0.4 + now.progress * 0.6),
          etaMs: now.etaMs,
          status: 'rendering',
          message: now.phase === 'audio' ? `${t('batch.tasks.rendering')} · audio` : `${t('batch.tasks.rendering')} · ${Math.round(now.progress * 100)}%`,
        });
      }
    };
    const stop = projectEvents(projectId, (event) => {
      if (event.type === 'export' && event.job.id === jobId) apply(event.job);
    });
    /* 事件流建立之前可能已经导完（很短的一条）：先查一次，之后仍靠事件 */
    settle = setTimeout(() => {
      void listExports(projectId).then((res) => {
        const now = res.exports.find((x) => x.id === jobId);
        if (now) apply(now);
      }).catch(() => {});
    }, 1500);
  }), [patchTask, t]);

  /* ── 任务：准备工程 → 复制素材 → 写时间线 → 渲染 ── */
  const runTask = React.useCallback(async (task: Task) => {
    if (!library) return;
    const alive = () => !cancelled.current.has(task.id);
    const fail = (error: string) => patchTask(task.id, { status: 'failed', error, message: error });
    const stopIfCancelled = () => {
      if (alive()) return false;
      patchTask(task.id, { status: 'cancelled', message: t('batch.tasks.cancelled') });
      return true;
    };
    try {
      patchTask(task.id, { status: 'preparing', progress: 0.02, message: t('batch.tasks.preparing') });
      const resume = resuming.current.delete(task.id) && task.projectId ? { id: task.projectId, name: task.projectName ?? task.name } : null;
      const project = resume ?? await api.newProject(task.name);
      const sources = resume
        ? await api.files(project.id).then((listing) => task.assets.map((asset) => {
          const landed = listing.files.find((file) => file.path.split('/').pop() === asset.name);
          return landed ? { ...asset, path: landed.path } : null;
        }).filter((asset): asset is Asset => asset !== null))
        : [];
      patchTask(task.id, { projectId: project.id, projectName: project.name });

      /* 先按素材库里的元数据排时间线：只把真正用到的素材复制进成片工程。 */
      const planningAssets = resume ? sources : task.assets;
      const landedByName = new Map(sources.map((asset) => [asset.name ?? asset.path.split('/').pop(), asset.path]));
      const planOptions = task.options.shots
        ? { ...task.options, shots: task.options.shots.map((shot) => ({ ...shot, src: landedByName.get(shot.src.split('/').pop() ?? '') ?? shot.src })) }
        : task.options;
      let plan = task.options.shots ? planContentMix(planningAssets, planOptions) : planMix(planningAssets, task.options);

      /* 素材从库里读出来，再写进这条成片自己的工程：成片工程搬走也完整。 */
      const usedPaths = new Set(plan.segments.map((segment) => segment.src));
      const toCopy = resume ? [] : task.assets.filter((asset) => usedPaths.has(asset.path));
      const local: Asset[] = [];
      for (let i = 0; i < toCopy.length; i += 1) {
        if (stopIfCancelled()) return;
        const asset = toCopy[i]!;
        const blob = await fetch(batchApi.file(library.id, asset.path, asset.mtime)).then((r) => {
          if (!r.ok) throw new Error(`${asset.name ?? asset.path}: ${r.status}`);
          return r.blob();
        });
        const file = new File([blob], asset.name ?? asset.path.split('/').pop() ?? 'asset.mp4', { type: blob.type });
        const landed = await batchApi.upload(project.id, file, file.name);
        local.push({ ...asset, path: landed.path });
        patchTask(task.id, { progress: 0.02 + (i + 1) / toCopy.length * 0.3, message: `${t('batch.tasks.preparing')} ${i + 1}/${toCopy.length}` });
      }

      /* 成片工程里的素材路径和素材库不同，把计划里的 src 换成本工程的位置。 */
      if (local.length) {
        const localByName = new Map(local.map((asset) => [asset.name ?? asset.path.split('/').pop(), asset.path]));
        const remap = new Map<string, string>();
        for (const asset of toCopy) {
          const landed = localByName.get(asset.name ?? asset.path.split('/').pop());
          if (landed) remap.set(asset.path, landed);
        }
        plan = remapPlanSrc(plan, remap);
      }
      /* 旁白：从素材库取出这条 wav，作为成片工程自己的素材，铺一条声音轨 */
      let voiceSrc = '';
      if (task.voice) {
        const landedVoice = await fetch(batchApi.file(library.id, task.voice, Date.now()))
          .then((r) => (r.ok ? r.blob() : null)).catch(() => null);
        if (landedVoice) {
          const file = new File([landedVoice], task.voice.split('/').pop() ?? 'voice.wav', { type: landedVoice.type || 'audio/wav' });
          voiceSrc = (await batchApi.upload(project.id, file, file.name)).path;
        }
      }

      if (stopIfCancelled()) return;
      patchTask(task.id, { status: 'planning', progress: 0.34, message: t('batch.tasks.planning') });
      const film = await api.film(project.id);
      const ops = [...mixFreshOps(plan)] as Array<Record<string, unknown>>;
      if (voiceSrc) ops.push({ op: 'insert', clip: { src: voiceSrc, at: 0 }, track: { insert: 1 } });
      await api.edit(project.id, film.rev, ops as never);
      await api.patchSettings(project.id, { fps: task.options.fps ?? 30 });
      patchTask(task.id, { shots: plan.shots, duration: plan.durationSeconds, progress: 0.4, status: 'rendering', message: t('batch.tasks.rendering') });

      if (stopIfCancelled()) return;
      const [job] = await startExports(project.id, [{
        kind: 'video', codec: 'h264', frame: 'native', fill: 'contain', shortEdge: 1080,
        fps: task.options.fps ?? 30, quality: 'high', audio: task.audio, label: t('batch.brand'), name: task.name,
      }], task.folder || undefined);
      if (!job) throw new Error('Studio did not start the export');
      patchTask(task.id, { jobId: job.id });

      await followExport(task, project.id, job.id, await cuesFor(task));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }, [cuesFor, library, patchTask, t]);

  const runBatch = async () => {
    if (!usable.length) { toast.showError(t('batch.form.noSelection')); return; }
    const count = Math.max(1, Math.min(12, Math.floor(form.count) || 1));
    const baseSeed = form.seed;
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const prefix = form.name.trim() || `混剪 ${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const created: Task[] = [];
    for (let i = 0; i < count; i += 1) {
      const name = count === 1 ? prefix : `${prefix}-${String(i + 1).padStart(2, '0')}`;
      created.push({
        id: uid(),
        name,
        seed: baseSeed + i * 7919,
        status: 'waiting',
        progress: 0,
        etaMs: null,
        message: t('batch.tasks.waiting'),
        projectId: null,
        projectName: null,
        jobId: null,
        output: null,
        shots: 0,
        duration: 0,
        error: null,
        at: Date.now() + i,
        options: { ...options, seed: baseSeed + i * 7919 },
        assets: usable.map((asset) => asset as Asset),
        libraryId: library?.id ?? '',
        folder: form.folder.trim(),
        audio: form.audio,
        voice: voice?.path ?? null,
        subtitles: form.subtitles && !!voice,
        subtitleBottom: form.subtitleBottom,
      });
    }
    setTasks((list) => [...created, ...list]);
    setTab('tasks');
    toast.show(t('batch.form.queued').replace('{n}', String(count)));
    for (const task of created) {
      queue.current = queue.current.then(() => runTask(task));
    }
    void queue.current.then(() => { void refreshOutputs(); });
  };

  /** 把一条任务放进串行队列（重试、沿用参数重跑都走这里） */
  const enqueue = (task: Task) => {
    cancelled.current.delete(task.id);
    setTasks((list) => [task, ...list]);
    queue.current = queue.current.then(() => runTask(task));
    void queue.current.then(() => { void refreshOutputs(); });
  };

  const cancelTask = async (task: Task) => {
    cancelled.current.add(task.id);
    patchTask(task.id, { status: 'cancelled', message: t('batch.tasks.cancelled'), etaMs: null });
    if (task.projectId && task.jobId) await cancelExport(task.projectId, task.jobId).catch(() => {});
  };

  const retryTask = (task: Task) => {
    const again: Task = {
      ...task, id: uid(), status: 'waiting', progress: 0, etaMs: null, message: t('batch.tasks.waiting'),
      projectId: null, projectName: null, jobId: null, output: null, error: null, at: Date.now(),
      name: `${task.name.replace(/-重试\d+$/, '')}-重试${tasks.filter((x) => x.name.startsWith(task.name)).length + 1}`,
    };
    enqueue(again);
  };

  /** 沿用这条任务的全部参数和素材，换一个种子再出一条（批量出片后常见：这条不错，再来一版） */
  const runAgain = (task: Task) => {
    const seed = task.seed + 7919;
    enqueue({
      ...task, id: uid(), seed, status: 'waiting', progress: 0, etaMs: null, message: t('batch.tasks.waiting'),
      projectId: null, projectName: null, jobId: null, output: null, error: null, at: Date.now(),
      name: `${task.name.replace(/-v\d+$/, '')}-v${tasks.filter((x) => x.name.startsWith(task.name.replace(/-v\d+$/, ''))).length + 1}`,
      options: { ...task.options, seed },
    });
    setTab('tasks');
    toast.show(t('batch.tasks.waiting'));
  };

  const refreshOutputs = React.useCallback(async () => {
    setOutputsLoading(true);
    try { setOutputs(await batchApi.outputs()); }
    catch (e) { toast.showError(e instanceof Error ? e.message : String(e)); }
    finally { setOutputsLoading(false); }
  }, [toast]);

  React.useEffect(() => { void refreshOutputs(); }, [refreshOutputs]);
  React.useEffect(() => {
    void api.locations().then((locations) => setWhere({ projects: locations.projects.path })).catch(() => {});
  }, []);
  /* 刷新页面、Studio 重启后再打开：正在渲染的任务接着跟；已经导完的直接收尾 */
  React.useEffect(() => {
    if (resumePending.current || !library) return;
    resumePending.current = true;
    for (const task of initialTasks.current ?? readTasks()) {
      if (!taskIsActive(task)) continue;
      /* 还没轮到它（没有工程）：重新排队，接着跑 */
      if (!task.projectId) {
        queue.current = queue.current.then(() => runTask(task));
        continue;
      }
      /* 工程在、导出还没开始：在这个工程里重写时间线再渲染 */
      if (!task.jobId) {
        resuming.current.add(task.id);
        queue.current = queue.current.then(() => runTask(task));
        continue;
      }
      void listExports(task.projectId).then((res) => {
        const job = res.exports.find((x) => x.id === task.jobId);
        if (!job) {
          patchTask(task.id, { status: 'failed', error: '导出记录已不在，任务中断；点重试重新生成', message: '任务中断' });
          return;
        }
        if (job.status === 'done') {
          patchTask(task.id, { status: 'done', progress: 1, etaMs: null, output: videoOf(job), message: t('batch.tasks.done') });
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          const error = job.error ?? (job.status === 'cancelled' ? t('batch.tasks.cancelled') : 'export failed');
          patchTask(task.id, { status: job.status === 'cancelled' ? 'cancelled' : 'failed', error, message: error });
        } else {
          void cuesFor(task).then((cues) => followExport(task, task.projectId!, task.jobId!, cues));
        }
      }).catch(() => {});
    }
  }, [cuesFor, followExport, library, patchTask, runTask, t]);


  /* ── 配音：本地 CosyVoice2 常驻 127.0.0.1:9880；也可以用自己 key 的云端服务商 ── */
  const refreshTts = React.useCallback(async () => {
    const status = await batchApi.ttsStatus().catch(() => null);
    setTts(status);
    if (!status) return;
    /* 服务端保存过选择就以它为准；没选过就用本地默认音色。本地/API 音色分开取，切换不互相覆盖 */
    const saved = status.saved;
    const fallback = status.local?.defaultVoice || status.local?.voice || '';
    setVoiceOpts((now) => {
      const next = {
        ...now,
        mode: status.mode,
        provider: saved.provider ?? (status.providers.find((p) => p.connected)?.id ?? now.provider),
        model: saved.model ?? '',
        voice: status.mode === 'api'
          ? (saved.apiVoice ?? '')
          : (saved.localVoice ?? fallback ?? now.voice),
      };
      return next.mode === now.mode && next.provider === now.provider && next.model === now.model && next.voice === now.voice ? now : next;
    });
  }, []);
  React.useEffect(() => { void refreshTts(); }, [refreshTts]);

  /** 切模式/服务商/模型/音色：写进 ~/.openfilm/voice.json，下一次合成和出片都用它。 */
  const chooseVoiceMode = React.useCallback(async (patch: { mode?: VoiceMode; provider?: string; model?: string | null; voice?: string | null }) => {
    try {
      const next = await batchApi.setVoiceMode({
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider || null } : {}),
        ...(patch.model !== undefined ? { model: patch.model || null } : {}),
        ...(patch.voice !== undefined ? { voice: patch.voice || null } : {}),
      });
      setTts(next);
      setVoiceOpts((now) => ({
        ...now,
        mode: next.mode,
        provider: next.saved.provider ?? '',
        model: next.saved.model ?? '',
        voice: next.mode === 'api'
          ? (next.saved.apiVoice ?? '')
          : (next.saved.localVoice ?? next.local?.defaultVoice ?? now.voice),
      }));
    } catch (e) {
      toast.showError(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  /**
   * 选用一条配音：出片时铺到声音轨，画面按它的真实时长铺满。
   * 生成完、配音页点一条、快速出片页挑最近一条，都走这里，行为一致。
   * 旧配音没有随选带回 cues：补读 wav 旁边的 .cues.json，好让每句秒数也能看到。
   */
  const chooseVoiceTake = React.useCallback((take: VoiceTake) => {
    const seconds = take.seconds ?? 0;
    setVoice({ path: take.path, seconds, text: take.text || take.path, at: take.at, voice: take.voice ?? null, score: take.score ?? null, report: take.report ?? null, cues: take.cues ?? null });
    if (seconds > 0) setForm((now) => ({ ...now, voiceSeconds: seconds.toFixed(2) }));
    if (!library || take.cues?.length) return;
    void batchApi.cues(library.id, take.path)
      .then((got) => { if (got.cues?.length) setVoice((now) => (now && now.path === take.path ? { ...now, cues: got.cues } : now)); })
      .catch(() => { /* 没有时间轴就算了，不影响选用 */ });
  }, [library]);
  const makeVoice = React.useCallback(async (text: string, name?: string) => {
    if (!library) return null;
    setVoiceBusy(true);
    try {
      const took = await batchApi.voice({
        project: library.id, text,
        ...(name ? { name } : {}),
        mode: voiceOpts.mode,
        ...(voiceOpts.mode === 'api' && voiceOpts.provider ? { provider: voiceOpts.provider } : {}),
        ...(voiceOpts.mode === 'api' && voiceOpts.model ? { model: voiceOpts.model } : {}),
        ...(voiceOpts.voice ? { voice: voiceOpts.voice } : {}),
        speed: voiceOpts.speed,
        pause: voiceOpts.pause,
        natural: voiceOpts.natural,
        verify: voiceOpts.verify,
      });
      const seconds = took.seconds ?? 0;
      chooseVoiceTake(took as VoiceTake);
      setVoiceDraft(took.text);
      /* 本地模式逐句回读过，有一句念得不对就直说；API 模式说清楚是谁念的 */
      const worst = typeof took.score === 'number' ? took.score : null;
      const shaky = (took.report ?? []).filter((one) => one.score < 0.86);
      if (worst !== null && worst < 0.86) {
        toast.show(t('batch.voice.doneShaky').replace('{s}', seconds.toFixed(2)).replace('{n}', String(shaky.length)));
      } else if ((took.engine ?? '').startsWith('api:')) {
        const name = tts?.providers.find((one) => one.id === (took.engine ?? '').slice(4))?.name ?? 'API';
        toast.show(t('batch.voice.doneApi').replace('{s}', seconds.toFixed(2)).replace('{name}', name));
      } else {
        toast.show(t('batch.voice.done').replace('{s}', seconds.toFixed(2)));
      }
      /* 先让按钮恢复可点，再慢慢刷素材库；不然合成完还停在“正在合成…” */
      setVoiceBusy(false);
      await loadAssets(library);
      return took as VoiceTake;
    } catch (e) {
      toast.showError(e instanceof Error ? e.message : String(e));
      void refreshTts();
      return null;
    } finally {
      setVoiceBusy(false);
    }
  }, [chooseVoiceTake, library, loadAssets, refreshTts, t, toast, voiceOpts, tts]);


  /* ── 后台 Agent：和外部 agent 调的是同一套本地 MCP 工具 ── */
  const refreshAgent = React.useCallback(async () => {
    const [status, jobs] = await Promise.all([
      agentApi.status().catch(() => null),
      agentApi.jobs().catch(() => [] as AgentJob[]),
    ]);
    if (status) setAgent(status);
    setAgentJobs(jobs);
  }, []);
  React.useEffect(() => { void refreshAgent(); }, [refreshAgent]);
  /* 有任务在跑时每秒取一次：每一步调了哪个工具、返回了什么，页面自己长出来 */
  React.useEffect(() => {
    if (!agentJobs.some((job) => job.status === 'running')) return undefined;
    const timer = setInterval(() => { void agentApi.jobs().then(setAgentJobs).catch(() => {}); }, 1000);
    return () => clearInterval(timer);
  }, [agentJobs]);

  const runAgentTask = React.useCallback(async (text: string) => {
    const job = await agentApi.start(text, library?.id);
    setAgentJobs((now) => [job, ...now.filter((one) => one.id !== job.id)]);
    setTab('agent');
  }, [library]);

  /** Agent 改过素材（识别、打标、出片）后，页面上的素材、标签、成片一起刷新 */
  const syncAfterAgent = React.useCallback(async () => {
    if (!library) return;
    const [nextTags, nextNotes] = await Promise.all([
      batchApi.tags(library.id).catch(() => null),
      batchApi.notes(library.id).catch(() => null),
    ]);
    if (nextTags) setTags(nextTags);
    if (nextNotes) setNotes(nextNotes);
    await refreshOutputs();
    void refreshAgent();
  }, [library, refreshAgent, refreshOutputs]);
  React.useEffect(() => {
    const running = agentJobs.some((job) => job.status === 'running');
    if (running) return undefined;
    const last = agentJobs[0];
    if (!last || last.status !== 'done' || last.endedAt == null) return undefined;
    void syncAfterAgent();
    return undefined;
  }, [agentJobs, syncAfterAgent]);
  React.useEffect(() => {
    if (tab !== 'agent' || agentContext) return;
    void agentApi.context(library?.id).then(setAgentContext).catch(() => {});
  }, [tab, agentContext, library]);
  /* 任务全部结束后自动刷新成片列表：不必手动点 */
  React.useEffect(() => {
    if (!tasks.length || tasks.some(taskIsActive)) return;
    void refreshOutputs();
  }, [tasks, refreshOutputs]);

  /* 标签库：按用得多的在前；素材删掉后没人用的标签自动消失 */
  const tagIndex = React.useMemo(() => {
    const count = new Map<string, number>();
    for (const list of Object.values(tags)) for (const name of list) count.set(name, (count.get(name) ?? 0) + 1);
    return [...count.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'));
  }, [tags]);

  /**
   * 给一组素材改标签：`add` 里的加上，`remove` 里的去掉；其他标签不动。
   * 先在页面上生效，写盘失败再退回原样，所以连点几下也不会等。
   */
  const editTags = React.useCallback(async (paths: string[], add: string[] = [], remove: string[] = []) => {
    if (!library || !paths.length) return;
    const before = tags;
    const next = { ...tags };
    for (const path of paths) {
      const names = new Set(next[path] ?? []);
      for (const name of add) if (name.trim()) names.add(name.trim());
      for (const name of remove) names.delete(name);
      if (names.size) next[path] = [...names].slice(0, 12);
      else delete next[path];
    }
    setTags(next);
    try {
      /* 一条请求带整份标签表：服务端整份替换，几条请求同时到也不会互相覆盖 */
      const saved = await batchApi.setTagsAll(library.id, next);
      setTags(saved);
    } catch (e) {
      setTags(before);
      toast.showError(e instanceof Error ? e.message : String(e));
    }
  }, [library, tags, toast]);

  const visibleAssets = React.useMemo(() => assets.filter((asset) => {
    if (tagFilter && !(tags[asset.path] ?? []).includes(tagFilter)) return false;
    if (filter !== 'all' && asset.kind !== filter) return false;
    const word = query.trim().toLowerCase();
    return !word || (asset.name ?? asset.path).toLowerCase().includes(word);
  }), [assets, filter, query, tagFilter, tags]);

  const visibleOutputs = React.useMemo(() => outputs.filter((output) => {
    const word = outputQuery.trim().toLowerCase();
    return !word || output.name.toLowerCase().includes(word) || output.projectName.toLowerCase().includes(word);
  }), [outputs, outputQuery]);

  const toggle = (path: string) => setSelected((now) => {
    const next = new Set(now);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  /**
   * 本地识别：本机 ffmpeg 看镜头和画面，faster-whisper 听台词；不联网、不上传素材。
   * 结果写进素材库工程的 .film/batch-notes.json，识别出的标签并进素材标签。
   * 一次交给常驻的本地识别进程，进度（每识别完一条）用 SSE 推回来。
   */
  const analyzePaths = React.useCallback(async (paths: string[]) => {
    if (!library || !paths.length || analyzing) return;
    const list = paths.filter((path) => /\.(mp4|mov|webm|m4v|mkv|mp3|wav|m4a|aac)$/i.test(path));
    if (!list.length) { toast.showError(t('batch.analyze.failed').replace('{error}', '只支持视频和声音')); return; }
    setAnalyzing({ done: 0, total: list.length, name: list[0]!.split('/').pop() ?? '' });
    try {
      const status = analyzer ?? await batchApi.analyzeStatus();
      setAnalyzer(status);
      if (!status.ok) throw new Error(status.error ?? 'local analysis unavailable');
      /* 一次交给本机 Python：模型只加载一次，整批比逐个文件快得多 */
      const runId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const stop = batchApi.analyzeProgress(runId, (tick) => {
        setAnalyzing({ done: tick.done, total: tick.total, name: tick.names[tick.names.length - 1]?.split('/').pop() ?? '' });
      });
      let res: Awaited<ReturnType<typeof batchApi.analyze>>;
      try {
        res = await batchApi.analyze(library.id, { paths: list, applyTags: true, skipSpeech: !status.whisper, runId });
      } finally {
        stop();
      }
      const bad = res.results.find((one) => !one.ok);
      if (bad) throw new Error(bad.error ?? 'analysis failed');
      setNotes((now) => ({ ...now, ...res.notes }));
      setTags(res.tags);
      setAnalyzing({ done: list.length, total: list.length, name: '' });
      toast.show(t('batch.analyze.done').replace('{n}', String(res.results.length)));
      if (!status.whisper) toast.showError(t('batch.analyze.noSpeech'));
    } catch (e) {
      toast.showError(t('batch.analyze.failed').replace('{error}', e instanceof Error ? e.message : String(e)));
    } finally {
      setAnalyzing(null);
    }
  }, [analyzer, analyzing, library, t, toast]);
  /** 上传完成后调用最新的识别函数（函数本身在 upload 之后才定义） */
  React.useEffect(() => { analyzeNew.current = (paths) => { void analyzePaths(paths); }; }, [analyzePaths]);

  const analyzeOutputs = React.useCallback(async (list: BatchOutput[]) => {
    if (!library || !list.length || analyzing) return;
    setAnalyzing({ done: 0, total: list.length, name: list[0]!.name });
    try {
      const status = analyzer ?? await batchApi.analyzeStatus();
      setAnalyzer(status);
      if (!status.ok) throw new Error(status.error ?? 'local analysis unavailable');
      const runId = `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const stop = batchApi.analyzeProgress(runId, (tick) => {
        setAnalyzing({ done: tick.done, total: tick.total, name: tick.names[tick.names.length - 1]?.split(/[\\/]/).pop() ?? '' });
      });
      let res: Awaited<ReturnType<typeof batchApi.analyze>>;
      try {
        res = await batchApi.analyze(library.id, {
          outputs: list.map((one) => ({ project: one.project, path: one.path })),
          applyTags: false,
          skipSpeech: !status.whisper,
          runId,
        });
      } finally {
        stop();
      }
      const bad = res.results.find((one) => !one.ok);
      if (bad) throw new Error(bad.error ?? 'analysis failed');
      setNotes((now) => ({ ...now, ...res.notes }));
      setAnalyzing({ done: list.length, total: list.length, name: '' });
      toast.show(t('batch.analyze.done').replace('{n}', String(res.results.length)));
      if (!status.whisper) toast.showError(t('batch.analyze.noSpeech'));
    } catch (e) {
      toast.showError(t('batch.analyze.failed').replace('{error}', e instanceof Error ? e.message : String(e)));
    } finally {
      setAnalyzing(null);
    }
  }, [analyzer, analyzing, library, t, toast]);
  React.useEffect(() => { analyzeNewFilm.current = (one) => { void analyzeOutputs([{ project: one.project, path: one.path, name: one.path.split(/[\\/]/).pop() ?? one.path } as BatchOutput]); }; }, [analyzeOutputs]);

  const quickTab: { id: Tab; icon: React.ReactNode; label: string; badge?: number } = { id: 'quick', icon: <Zap size={15} />, label: t('batch.nav.quick') };
  const tabs: Array<{ id: Tab; icon: React.ReactNode; label: string; badge?: number }> = mode === 'simple'
    ? [
      quickTab,
      { id: 'outputs', icon: <Film size={15} />, label: t('batch.nav.outputs'), badge: outputs.length || undefined },
      { id: 'tasks', icon: <ListChecks size={15} />, label: t('batch.nav.tasks'), badge: activeCount || undefined },
    ]
    : [
      quickTab,
      { id: 'library', icon: <LayoutGrid size={15} />, label: t('batch.nav.library'), badge: assets.length || undefined },
      { id: 'voice', icon: <AudioLines size={15} />, label: t('batch.nav.voice'), badge: voice ? 1 : undefined },
      { id: 'generate', icon: <Wand2 size={15} />, label: t('batch.nav.generate') },
      { id: 'tasks', icon: <ListChecks size={15} />, label: t('batch.nav.tasks'), badge: activeCount || undefined },
      { id: 'outputs', icon: <Film size={15} />, label: t('batch.nav.outputs'), badge: outputs.length || undefined },
      { id: 'templates', icon: <SquareStack size={15} />, label: t('batch.nav.templates') },
      { id: 'agent', icon: <Bot size={15} />, label: t('batch.nav.agent'), badge: agentJobs.filter((job) => job.status === 'running').length || undefined },
    ];

  document.title = t('batch.brand');

  return (
    <div className="flex h-screen min-h-0 w-full overflow-hidden bg-[var(--dock-shell)] text-[var(--text)]">
      {/* 左侧：后台导航 */}
      <aside className="flex w-[196px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent)] text-white"><Clapperboard size={18} /></span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{t('batch.brand')}</div>
            <div className="truncate text-[10.5px] text-[var(--text-faint)]">{t('batch.brandSub')}</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)}
              className={`flex h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition ${tab === item.id ? 'bg-[var(--bg-active)] font-semibold text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge ? <span className="rounded-full bg-[var(--fill-tsp)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">{item.badge}</span> : null}
            </button>
          ))}
          <div className="my-2 h-px bg-[var(--border)]" />
          <div className="flex items-center gap-1 rounded-lg bg-[var(--fill-tsp)] p-0.5">
            <button type="button" onClick={() => { setMode('simple'); setTab('quick'); }}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11.5px] transition ${mode === 'simple' ? 'bg-[var(--surface)] font-semibold text-[var(--text)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {t('batch.nav.simple')}
            </button>
            <button type="button" onClick={() => { setMode('pro'); if (tab === 'quick') setTab('library'); }}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11.5px] transition ${mode === 'pro' ? 'bg-[var(--surface)] font-semibold text-[var(--text)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {t('batch.nav.pro')}
            </button>
          </div>
          {mode === 'pro' ? (
            <>
              <button type="button" onClick={onOpenProjects}
                className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <Settings2 size={15} /><span className="truncate">{t('batch.nav.projects')}</span>
              </button>
              <button type="button" onClick={() => { const last = tasks.find((x) => x.projectId); if (last?.projectId) onOpenEditor(last.projectId); else toast.showError(t('batch.tasks.projectMissing')); }}
                className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <Clapperboard size={15} /><span className="truncate">{t('batch.nav.editor')}</span>
              </button>
            </>
          ) : null}
        </nav>
        <div className="mt-auto px-3 pb-4">
          <div className="rounded-xl bg-[var(--fill-tsp)] p-3">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium"><Sparkles size={12} className="text-[var(--accent)]" />{t('batch.library.project')}</div>
            <div className="mt-1 truncate text-[11px] text-[var(--text-faint)]">{library?.name ?? '…'}</div>
            <div className="mt-0.5 text-[10.5px] text-[var(--text-faint)]">{t('batch.library.count').replace('{n}', String(assets.length))}</div>
            {where ? (
              <div className="mt-2 flex flex-col gap-1 border-t border-[var(--border)] pt-2 text-[10px] text-[var(--text-faint)]">
                <button type="button" onClick={() => void api.openLocation('projects')} title={where.projects}
                  className="flex items-center gap-1 truncate text-left hover:text-[var(--text)]"><FolderOpen size={10} className="shrink-0" /><span className="truncate">{t('batch.library.project')}</span></button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3.5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[16px] font-semibold">{t(`batch.${tab === 'library' ? 'library' : tab === 'generate' ? 'form' : tab === 'agent' ? 'agent' : tab === 'voice' ? 'voice' : tab}.title`)}</h1>
            <p className="truncate text-[11.5px] text-[var(--text-faint)]">{t(`batch.${tab === 'library' ? 'library' : tab === 'generate' ? 'form' : tab === 'agent' ? 'agent' : tab === 'voice' ? 'voice' : tab}.subtitle`)}</p>
          </div>
          {tab === 'library' && (
            <label className="relative flex h-9 w-[210px] items-center gap-1.5 rounded-lg bg-[var(--fill-tsp)] px-2.5 text-[var(--text-muted)]">
              <Search size={13} className="shrink-0" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索素材" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
            </label>
          )}
          {tab === 'outputs' && (
            <label className="relative flex h-9 w-[210px] items-center gap-1.5 rounded-lg bg-[var(--fill-tsp)] px-2.5 text-[var(--text-muted)]">
              <Search size={13} className="shrink-0" />
              <input value={outputQuery} onChange={(e) => setOutputQuery(e.target.value)} placeholder={t('batch.outputs.search')} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
            </label>
          )}
          <button type="button" onClick={() => { void refreshOutputs(); if (library) void loadAssets(library); }} className={BTN_SOFT} title={t('batch.common.refresh')}>
            <RefreshCw size={13} className={loadingAssets || outputsLoading ? 'animate-spin' : ''} />{t('batch.common.refresh')}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" />正在打开素材库…</div>
          ) : tab === 'quick' ? (
            <QuickPane
              libraryId={library?.id ?? ''}
              assets={assets} usable={usable} notes={notes} uploading={uploading} dragging={dragging} setDragging={setDragging}
              inputRef={inputRef} onUpload={upload} form={form} set={set} preview={preview}
              onGenerate={() => void runBatch()} onReroll={() => set('seed', Math.floor(Math.random() * 900000) + 1000)}
              onLibrary={() => { setMode('pro'); setTab('library'); }}
              onPro={() => { setMode('pro'); setTab('generate'); }}
              onSeeOutputs={() => setTab('outputs')} onPreview={setPlaying}
              outputs={outputs} activeTasks={tasks.filter(taskIsActive)} voice={voice}
              voiceState={tts} voiceOpts={voiceOpts} onChooseMode={(patch) => void chooseVoiceMode(patch)}
              voiceDraft={voiceDraft} setVoiceDraft={setVoiceDraft} voiceBusy={voiceBusy}
              onMakeVoice={(text) => void makeVoice(text)} onClearVoice={() => { setVoice(null); setForm((now) => ({ ...now, voiceSeconds: '' })); }}
              recentVoices={assets.filter((asset) => asset.kind === 'audio' && asset.path.startsWith('assets/voice/'))}
              onPickVoice={(asset) => {
                chooseVoiceTake({ project: library?.id ?? '', path: asset.path, seconds: (asset.durationMs ?? 0) / 1000, bytes: asset.size, text: asset.name ?? asset.path, engine: 'cosyvoice2', at: asset.mtime });
                toast.show(t('batch.voice.chosen').replace('{s}', ((asset.durationMs ?? 0) / 1000).toFixed(2)));
              }} />
          ) : tab === 'library' ? (
            <LibraryPane
              libraryId={library?.id ?? ''}
              assets={visibleAssets} all={assets} selected={selected} filter={filter} setFilter={setFilter}
              uploading={uploading} dragging={dragging} setDragging={setDragging} inputRef={inputRef}
              onUpload={upload} onToggle={toggle} onSelectAll={() => setSelected(new Set(visibleAssets.map((a) => a.path)))}
              onClear={() => setSelected(new Set())} onRemove={setConfirmAsset} onUseAssets={() => setTab('generate')}
              onPreview={setLooking}
              tags={tags} tagIndex={tagIndex} tagFilter={tagFilter} onTagFilter={setTagFilter}
              onTagSelected={() => setTagging([...selected])} onEditTags={(paths) => setTagging(paths)}
              notes={notes} analyzing={analyzing} analyzer={analyzer}
              autoAnalyze={autoAnalyze} setAutoAnalyze={setAutoAnalyze}
              onAnalyze={(paths) => void analyzePaths(paths)} onRead={(asset) => setReading({ title: asset.name ?? asset.path, note: notes[asset.path] ?? null })}
              onOpenLibrary={() => { if (library) onOpenEditor(library.id); }} />
          ) : tab === 'voice' ? (
            <VoicePane tts={tts} busy={voiceBusy} draft={voiceDraft} setDraft={setVoiceDraft} chosen={voice} assets={assets}
              opts={voiceOpts} setOpts={setVoiceOpts} onChooseMode={(patch) => void chooseVoiceMode(patch)}
              libraryId={library?.id ?? ''}
              onRefresh={() => void refreshTts()} onMake={(text, name) => void makeVoice(text, name)}
              onChoose={(take) => {
                chooseVoiceTake(take);
                toast.show(t('batch.voice.chosen').replace('{s}', (take.seconds ?? 0).toFixed(2)));
              }}
              onClear={() => { setVoice(null); setForm((now) => ({ ...now, voiceSeconds: '' })); }}
              onGenerate={() => setTab('generate')}
              onOpenLibrary={() => setTab('library')} />
          ) : tab === 'generate' ? (
            <GeneratePane form={form} set={set} preview={preview} repeats={repeats} usable={usable} assets={assets} notes={notes}
              selectedCount={selected.size} presets={PRESETS} onPreset={applyPreset} onGenerate={() => void runBatch()}
              onChooseFolder={() => void chooseFolder()} pickingFolder={pickingFolder} onOpenLibrary={() => setTab('library')} />
          ) : tab === 'tasks' ? (
            <TasksPane tasks={tasks} onCancel={(task) => void cancelTask(task)} onRetry={retryTask} onAgain={runAgain}
              onOpenEditor={onOpenEditor} onReveal={(task) => { if (task.output) void batchApi.reveal(task.projectId ?? '', task.output); }}
              onOpen={(task) => { if (task.output) void batchApi.open(task.projectId ?? '', task.output); }}
              onClearDone={() => setTasks((list) => list.filter((task) => taskIsActive(task) || task.status === 'failed'))}
              onSeeOutputs={() => setTab('outputs')} />
          ) : tab === 'outputs' ? (
            <OutputsPane outputs={visibleOutputs} all={outputs} loading={outputsLoading} onPreview={setPlaying}
              notes={notes} analyzing={analyzing}
              onAnalyze={(output) => void analyzeOutputs([output])}
              onAnalyzeAll={() => void analyzeOutputs(outputs.filter((one) => !notes[one.path]?.quality))}
              libraryId={library?.id ?? ''}
              onRead={(output) => setReading({ title: output.name, note: notes[output.path] ?? null })}
              onReveal={(output) => void batchApi.reveal(output.project, output.path)}
              onEdit={(output) => onOpenEditor(output.project)}
              onDelete={setConfirmOutput} onRefresh={() => void refreshOutputs()} />
          ) : tab === 'agent' ? (
            <AgentPane status={agent} context={agentContext} jobs={agentJobs} libraryName={library?.name ?? ''}
              timeline={agentTimeline} timelineLoading={timelineLoading} onPickTimeline={(title) => setAgentFocus(title)} onClearTimeline={() => setAgentTimeline(null)}
              onRun={(text) => void runAgentTask(text)}
              onStop={(id) => void agentApi.stop(id).then(() => agentApi.jobs()).then(setAgentJobs).catch(() => {})}
              onClear={() => void agentApi.clear().then((r) => setAgentJobs(r.jobs)).catch(() => {})}
              onRefresh={() => void refreshAgent()}
              onTimeline={async (job) => {
                setTimelineLoading(true);
                const fresh = await batchApi.notes(library?.id ?? '').catch(() => null);
                if (fresh) setNotes(fresh);
                const source = fresh ?? notes;
                const paths = job.steps
                  .filter((step) => step.tool === 'analyze_assets')
                  .flatMap((step) => Array.isArray((step.args as { paths?: unknown }).paths) ? (step.args as { paths: string[] }).paths : []);
                const rows = paths.flatMap((one) => source[one] ? [{ title: one.split('/').pop() ?? one, note: source[one] }] : []);
                setTimelineLoading(false);
                if (rows.length) setAgentTimeline(rows);
                else if (paths[0]) setReading({ title: paths[0].split('/').pop() ?? paths[0], note: source[paths[0]] ?? null });
              }} />
          ) : (
            <TemplatesPane presets={PRESETS} assets={assets} onUse={(id) => { applyPreset(id); setTab('generate'); }} />
          )}
        </div>
      </main>

      {reading ? <NoteDialog title={reading.title} note={reading.note} onClose={() => setReading(null)} /> : null}
      {agentTimeline ? <TimelineDialog rows={agentTimeline} focus={agentFocus} onClose={() => { setAgentTimeline(null); setAgentFocus(null); }} /> : null}

      <ConfirmDialog open={Boolean(confirmAsset)} title={t('batch.library.remove')}
        description={confirmAsset ? t('batch.library.removeAsk').replace('{name}', confirmAsset.name ?? confirmAsset.path) : undefined}
        confirmLabel={t('batch.library.remove')} danger onConfirm={() => void removeAssets()} onCancel={() => setConfirmAsset(null)} />
      <ConfirmDialog open={Boolean(confirmOutput)} title={t('batch.outputs.delete')}
        description={confirmOutput ? t('batch.outputs.deleteAsk').replace('{name}', confirmOutput.name) : undefined}
        confirmLabel={t('batch.outputs.delete')} danger
        onConfirm={() => { const target = confirmOutput; setConfirmOutput(null); if (!target) return; void batchApi.remove(target.project, target.path).then(() => refreshOutputs(), (e) => toast.showError(e instanceof Error ? e.message : String(e))); }}
        onCancel={() => setConfirmOutput(null)} />

      {tagging ? (
        <TagDialog
          paths={tagging}
          names={assets.filter((asset) => tagging.includes(asset.path)).map((asset) => asset.name ?? asset.path)}
          tags={tags} tagIndex={tagIndex}
          onApply={(add, remove) => { void editTags(tagging, add, remove); }}
          onClose={() => setTagging(null)}
        />
      ) : null}
      {looking ? (
        <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-black/70 p-8" onClick={() => setLooking(null)}>
          <div className="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <Film size={14} className="text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{looking.name}</div>
                <div className="truncate text-[11px] text-[var(--text-faint)]">
                  {looking.durationMs ? fmtTime(looking.durationMs / 1000) : t('batch.library.noDuration')}
                  {looking.w && looking.h ? ` · ${looking.w}×${looking.h}` : ''}
                  {looking.fps ? ` · ${Math.round(looking.fps)}fps` : ''}
                  {' · '}{fmtBytes(looking.size)}
                </div>
              </div>
              <button type="button" onClick={() => setLooking(null)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X size={15} /></button>
            </div>
            <div className="min-h-0 flex-1 bg-black">
              {looking.kind === 'image' ? (
                <img src={batchApi.poster(libraryId, looking.path, looking.mtime)} alt="" className="mx-auto max-h-[70vh] w-full object-contain" />
              ) : looking.kind === 'audio' ? (
                <div className="flex flex-col items-center gap-4 px-6 py-12">
                  <Music size={34} className="text-white/50" />
                  <audio src={batchApi.file(libraryId, looking.path, looking.mtime)} controls autoPlay className="w-full" />
                </div>
              ) : (
                <video src={batchApi.file(libraryId, looking.path, looking.mtime)} controls autoPlay className="mx-auto max-h-[70vh] w-full" />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button type="button" className={BTN_SOFT} onClick={() => setLooking(null)}>{t('batch.common.close')}</button>
              <button type="button" className={BTN_PRIMARY} onClick={() => { setSelected((now) => new Set(now).add(looking.path)); setLooking(null); }}>
                <Check size={13} />{t('batch.library.selectedTag')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {playing ? (
        <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-black/60 p-8" onClick={() => setPlaying(null)}>
          <div className="flex max-h-full w-full max-w-[900px] flex-col overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <Play size={14} className="text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{playing.name}</div>
                <div className="truncate text-[11px] text-[var(--text-faint)]">{playing.projectName} · {fmtBytes(playing.bytes)}</div>
              </div>
              <button type="button" onClick={() => setPlaying(null)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X size={15} /></button>
            </div>
            <div className="min-h-0 flex-1 bg-black">
              <video src={batchApi.outputFile(playing.project, playing.path, playing.at)} controls autoPlay className="mx-auto max-h-[70vh] w-full" />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
              <button type="button" className={BTN_SOFT} onClick={() => void batchApi.reveal(playing.project, playing.path)}><FolderOpen size={13} />{t('batch.outputs.reveal')}</button>
              <button type="button" className={BTN_SOFT} onClick={() => onOpenEditor(playing.project)}><Clapperboard size={13} />{t('batch.outputs.edit')}</button>
              <button type="button" className={BTN_PRIMARY} onClick={() => void batchApi.open(playing.project, playing.path)}><Play size={13} />{t('batch.outputs.open')}</button>
            </div>
          </div>
        </div>
      ) : null}
      <Toast toast={toast.current} />
    </div>
  );
}

function LibraryPane({ libraryId, assets, all, selected, filter, setFilter, uploading, dragging, setDragging, inputRef, onUpload,
  onToggle, onSelectAll, onClear, onRemove, onUseAssets, onOpenLibrary, onPreview, tags, tagIndex, tagFilter, onTagFilter,
  onTagSelected, onEditTags, notes, analyzing, analyzer, onAnalyze, onRead, autoAnalyze, setAutoAnalyze }: {
  libraryId: string;
  assets: Asset[];
  all: Asset[];
  selected: Set<string>;
  filter: 'all' | 'video' | 'image';
  setFilter: (v: 'all' | 'video' | 'image') => void;
  uploading: { done: number; total: number } | null;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (files: FileList | File[]) => Promise<void>;
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRemove: (asset: Asset) => void;
  onUseAssets: () => void;
  onOpenLibrary: () => void;
  onPreview: (asset: Asset) => void;
  tags: Record<string, string[]>;
  tagIndex: Array<{ name: string; n: number }>;
  tagFilter: string | null;
  onTagFilter: (name: string | null) => void;
  /** 给当前选中的素材打标 */
  onTagSelected: () => void;
  /** 给某一张卡片的素材打标 */
  onEditTags: (paths: string[]) => void;
  /** 已识别的内容时间线 */
  notes: Record<string, BatchNote>;
  analyzing: { done: number; total: number; name: string } | null;
  analyzer: AnalyzeStatus | null;
  /** 本地识别这些素材 */
  onAnalyze: (paths: string[]) => void;
  /** 看一条素材的内容时间线 */
  onRead: (asset: Asset) => void;
  /** 新素材上传完就自动识别 */
  autoAnalyze: boolean;
  setAutoAnalyze: (v: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [exporting, setExporting] = React.useState(false);
  /* 整个素材库一条命令导出：只导出识别过的，没识别的本来就没有内容可写 */
  /* 导出走全量：素材库页面的搜索和筛选不该决定分镜表里有哪些素材 */
  const analyzed = React.useMemo(() => all.filter((asset) => notes[asset.path]), [all, notes]);
  const exportBoard = async (paths: string[], name: string) => {
    if (!paths.length) { toast.showError(t('batch.analyze.exportEmpty')); return; }
    setExporting(true);
    try {
      const list = await saveShotList(libraryId, paths, name);
      toast.show(t('batch.analyze.exported').replace('{n}', String(list.files.length)));
    } catch (e) { toast.showError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void onUpload(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-5 text-[12.5px] transition ${dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]' : 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)]'}`}>
        <Upload size={15} />
        <span>{uploading ? t('batch.library.uploadingCount').replace('{done}', String(uploading.done)).replace('{total}', String(uploading.total)) : t('batch.library.drop')}</span>
        <span className="text-[11px] text-[var(--text-faint)]">{t('batch.library.dropHint')}</span>
        <input ref={inputRef} type="file" multiple accept="video/*,image/*,audio/*" className="hidden"
          onChange={(e) => { if (e.target.files?.length) void onUpload(e.target.files); e.target.value = ''; }} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--fill-tsp)] p-0.5">
          {([['all', t('batch.library.filterAll')], ['video', t('batch.library.filterVideo')], ['image', t('batch.library.filterImage')]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setFilter(id)}
              className={`h-7 rounded-md px-2.5 text-[12px] transition ${filter === id ? 'bg-[var(--surface)] font-medium text-[var(--text)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>{label}</button>
          ))}
        </div>
        <span className="text-[12px] text-[var(--text-muted)]">{t('batch.library.selected').replace('{n}', String(selected.size))}</span>
        <button type="button" onClick={() => setAutoAnalyze(!autoAnalyze)}
          title={t('batch.analyze.autoHint')}
          className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition ${autoAnalyze ? 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
          <ScanLine size={11} />
          {autoAnalyze ? t('batch.analyze.autoOn') : t('batch.analyze.autoOff')}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onSelectAll} className={BTN_SOFT}><Check size={13} />{t('batch.library.selectAll')}</button>
          <button type="button" onClick={onTagSelected} disabled={!selected.size} className={BTN_SOFT}><Tag size={13} />{t('batch.tags.selected')}</button>
          <button type="button" onClick={() => onAnalyze([...selected])} disabled={!selected.size || Boolean(analyzing)}
            title={analyzer?.ok === false ? t('batch.analyze.unavailable').replace('{error}', analyzer.error ?? '') : t('batch.analyze.hint')}
            className={BTN_SOFT}>{analyzing ? <Loader2 size={13} className="animate-spin" /> : <ScanLine size={13} />}{t('batch.analyze.selected')}</button>
          <button type="button" onClick={() => void exportBoard(analyzed.map((asset) => asset.path), `分镜表-${new Date().toISOString().slice(0, 10)}.csv`)}
            disabled={!analyzed.length || exporting}
            title={t('batch.analyze.exportBoardHint')}
            className={BTN_SOFT}>
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <ListChecks size={13} />}{t('batch.analyze.exportBoard')}
          </button>
          <button type="button" onClick={onClear} disabled={!selected.size} className={BTN_SOFT}><X size={13} />{t('batch.library.clear')}</button>
          <button type="button" onClick={onUseAssets} disabled={!all.length} className={BTN_PRIMARY}><Wand2 size={13} />{t('batch.nav.generate')}</button>
        </div>
      </div>

      {analyzing ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-3 py-2 text-[11.5px] text-[var(--text)]">
          <Loader2 size={13} className="animate-spin text-[var(--accent)]" />
          <span className="font-medium">{t('batch.analyze.runningCount').replace('{done}', String(analyzing.done)).replace('{total}', String(analyzing.total))}</span>
          <span className="min-w-0 truncate text-[var(--text-muted)]">{analyzing.name}</span>
          <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('batch.analyze.hint')}</span>
        </div>
      ) : null}
      {analyzing && analyzing.total > 1 ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--fill-tsp)]">
          <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
            style={{ width: `${Math.round((analyzing.done / Math.max(1, analyzing.total)) * 100)}%` }} />
        </div>
      ) : null}
      {analyzer && (!analyzer.whisper || analyzer.ok === false) ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] text-[var(--text-faint)]">
          {analyzer.ok === false ? t('batch.analyze.unavailable').replace('{error}', analyzer.error ?? '') : t('batch.analyze.noSpeech')}
        </div>
      ) : null}

      {tagIndex.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-[var(--text-faint)]">{t('batch.tags.title')}</span>
          <button type="button" onClick={() => onTagFilter(null)}
            className={`h-6 rounded-full px-2.5 text-[11px] transition ${tagFilter === null ? 'bg-[var(--accent)] font-medium text-white' : 'bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
            {t('batch.tags.all')}
          </button>
          {tagIndex.map(({ name, n }) => (
            <button key={name} type="button" onClick={() => onTagFilter(tagFilter === name ? null : name)}
              title={t('batch.tags.count').replace('{n}', String(n))}
              className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition ${tagFilter === name ? 'border-transparent text-white' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}
              style={tagFilter === name ? { background: tagColor(name) } : undefined}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagFilter === name ? '#fff' : tagColor(name) }} />
              {name}
              <span className={tagFilter === name ? 'text-white/75' : 'text-[var(--text-faint)]'}>{n}</span>
            </button>
          ))}
        </div>
      ) : null}

      {assets.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-3">
          {assets.map((asset) => {
            const picked = selected.has(asset.path);
            const note = notes[asset.path];
            return (
              <div key={asset.path} role="button" tabIndex={0} onClick={() => onToggle(asset.path)}
                onDoubleClick={() => onPreview(asset)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(asset.path); } }}
                className={`group relative overflow-hidden rounded-xl border bg-[var(--surface)] text-left transition ${picked ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
                <div className="relative aspect-[4/3] bg-black/80">
                  {/* 音频没有画面可截：发请求只会拿到 422，直接画个波形底纹 */}
                  {asset.kind === 'audio' ? null : asset.kind === 'image' ? (
                    <img src={batchApi.poster(libraryId, asset.path, asset.mtime)} alt="" className="h-full w-full object-contain"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }} />
                  ) : (
                    <img src={batchApi.poster(libraryId, asset.path, asset.mtime)} alt="" className="h-full w-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }} />
                  )}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/25">
                    {asset.kind === 'audio' ? <Music size={22} /> : <Film size={22} />}
                  </div>
                  <span className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border text-white transition ${picked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-white/40 bg-black/40'}`}>
                    {picked ? <Check size={12} /> : null}
                  </span>
                  <span className="absolute bottom-2 right-2 rounded bg-black/65 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-white">
                    {asset.durationMs ? fmtTime(asset.durationMs / 1000) : t('batch.library.noDuration')}
                  </span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onEditTags([asset.path]); }}
                    className="absolute bottom-2 left-2 flex h-6 items-center gap-1 rounded-md bg-black/60 px-1.5 text-[10.5px] text-white/90 hover:bg-black/80" title={t('batch.tags.edit')}>
                    <Tag size={11} />{t('batch.tags.short')}
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onAnalyze([asset.path]); }}
                    title={t('batch.analyze.hint')}
                    className="absolute bottom-2 left-14 flex h-6 items-center gap-1 rounded-md bg-black/60 px-1.5 text-[10.5px] text-white/90 hover:bg-black/80">
                    {analyzing ? <Loader2 size={11} className="animate-spin" /> : <ScanLine size={11} />}{t('batch.analyze.card')}
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(asset); }}
                    className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white/85 hover:bg-[#b42318] group-hover:flex" title={t('batch.library.remove')}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="flex flex-col gap-1 px-2.5 py-2">
                  <span className="truncate text-[12px] font-medium text-[var(--text)]" title={asset.name}>{asset.name ?? asset.path}</span>
                  <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-faint)]">
                    {asset.w && asset.h ? <span className="tabular-nums">{asset.w}×{asset.h}</span> : <span>{asset.kind}</span>}
                    {asset.fps ? <span className="tabular-nums">{Math.round(asset.fps)}fps</span> : null}
                    <span>{fmtBytes(asset.size)}</span>
                  </span>
                  {(tags[asset.path] ?? []).length ? (
                    <span className="flex flex-wrap gap-1">
                      {(tags[asset.path] ?? []).map((name) => (
                        <span key={name} className="inline-flex items-center gap-1 rounded-full bg-[var(--fill-tsp)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(name) }} />{name}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {note ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onRead(asset); }}
                      className="mt-0.5 flex w-full items-start gap-1.5 rounded-md bg-[var(--fill-tsp)] px-1.5 py-1 text-left text-[10.5px] leading-snug text-[var(--text-muted)] hover:text-[var(--text)]" title={t('batch.analyze.timeline')}>
                      <Clock size={10} className="mt-0.5 shrink-0" />
                      <span className="line-clamp-2">{note.segments[0]?.text}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <ImageIcon size={26} className="text-[var(--text-faint)]" />
          <p className="text-[13px] font-medium text-[var(--text)]">{t('batch.library.empty')}</p>
          <p className="text-[11.5px] text-[var(--text-faint)]">{t('batch.library.projectHint')}</p>
          <button type="button" onClick={onOpenLibrary} className={`${BTN_SOFT} mt-1`}><FolderOpen size={13} />{t('batch.library.project')}</button>
        </div>
      )}
    </div>
  );
}


const AGENT_PROMPTS = [
  '识别全部素材，写时间线和标签',
  '看看素材库里有什么',
  '用全部素材生成 3 条 20 秒竖屏成片',
  '把产品镜头标成“卖点”，看看成片',
  '只用产品标签的素材生成 2 条 15 秒竖屏成片',
];

const TOOL_LABEL: Record<string, string> = {
  list_assets: '读取素材库', analyze_assets: '本地识别', tag_assets: '打标签',
  get_timeline: '读时间线', list_outputs: '列成片', generate_mix: '生成混剪工程',
};

/** 一步的结果写成一句人话：识别了几条、生成了哪几个工程、成片有几条。 */
function stepSummary(step: AgentJob['steps'][number]): string {
  if (!step.ok) return step.error ?? '失败';
  const value = step.result as Record<string, any> | undefined;
  if (!value || typeof value !== 'object') return '完成';
  if (Array.isArray(value.assets)) return `${value.assets.length} 个素材 · ${value.assets.reduce((n: number, a: any) => n + (a.tags?.length ?? 0), 0)} 个标签`;
  if (value.analyzed != null) return `识别 ${value.analyzed} 条${value.failed?.length ? `，${value.failed.length} 条失败` : ''}${value.speech === false ? '（未装 Whisper，只看了画面）' : ''}`;
  if (value.tagged != null) return `${value.tagged} 个素材已更新标签`;
  if (Array.isArray(value.made)) return value.made.map((one: any) => `${one.name} · ${one.seconds}s / ${one.shots} 段`).join('；');
  if (Array.isArray(value.outputs)) return `${value.outputs.length} 条成片`;
  if (Array.isArray(value)) return `${value.length} 条时间线`;
  return '完成';
}

/** 识别结果：左边素材、右边逐段轨道，台词单独一行，和 MCP 返回的格式一致。 */
function TimelineDialog({ rows, focus, onClose }: { rows: Array<{ title: string; note: BatchNote | null }>; focus: string | null; onClose: () => void }) {
  const t = useT();
  const [pick, setPick] = React.useState(() => Math.max(0, rows.findIndex((row) => row.title === focus)));
  const [copied, setCopied] = React.useState(false);
  const copy = async (/** @type {string} */ text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  const row = rows[Math.min(pick, rows.length - 1)];
  const segments = row?.note?.segments ?? [];
  const total = segments.length ? segments[segments.length - 1].end : 0;
  return (
    <div className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]" onClick={onClose}>
      <div className="flex h-[min(680px,84vh)] w-[min(920px,94vw)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]"><ScanLine size={15} /></span>
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold">{t('batch.agent.timeline')}</h2>
            <p className="text-[10.5px] text-[var(--text-faint)]">{rows.length} 条素材 · 本机识别 · 时间线可直接复制给 agent</p>
          </div>
          <button type="button" onClick={onClose} className={`${BTN_SOFT} ml-auto h-7`}><X size={12} />关闭</button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          <nav className="min-h-0 overflow-auto border-r border-[var(--border)] p-2">
            {rows.map((one, i) => (
              <button key={one.title + i} type="button" onClick={() => setPick(i)}
                className={`mb-1 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition ${i === pick ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--fill-tsp)]'}`}>
                <span className="truncate text-[11.5px] font-medium">{one.title}</span>
                <span className="text-[10px] text-[var(--text-faint)]">{one.note?.segments.length ?? 0} 段 · {(one.note?.segments.at(-1)?.end ?? 0).toFixed(1)}s</span>
              </button>
            ))}
          </nav>
          <div className="min-h-0 overflow-auto p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[12px] font-medium">{row?.title}</span>
              <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">{segments.length} 段 / {total.toFixed(2)}s</span>
              <span className="flex gap-1">
              <button type="button" onClick={() => void copy(segments.map((seg) => `${startOf(seg.start)}-${startOf(seg.end)}s ${seg.text}${seg.speech ? `\n台词：${seg.speech}` : ''}`).join('\n'))}
                className={`${BTN_SOFT} ml-auto h-7`}>{copied ? <Check size={12} /> : null}{copied ? t('batch.agent.copied') : t('batch.agent.copyTimeline')}</button>
              <button type="button" onClick={() => void copy(rows.map((one) => `${one.title}\n${(one.note?.segments ?? []).map((seg) => `${startOf(seg.start)}-${startOf(seg.end)}s ${seg.text}${seg.speech ? `\n台词：${seg.speech}` : ''}`).join('\n')}`).join('\n\n'))}
                className={`${BTN_SOFT} h-7`}>{t('batch.agent.copyAll')}</button>
              </span>
            </div>
            <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-[var(--fill-tsp)]">
              {segments.map((seg, i) => (
                <span key={i} title={seg.text} style={{ width: `${total ? (seg.end - seg.start) / total * 100 : 0}%` }} className={i % 2 ? 'bg-[var(--accent)]/45' : 'bg-[var(--accent)]/75'} />
              ))}
            </div>
            <ol className="flex flex-col gap-1.5">
              {segments.map((seg, i) => (
                <li key={i} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
                  <code className="pt-0.5 text-[10.5px] tabular-nums text-[var(--accent)]">{startOf(seg.start)}-{startOf(seg.end)}s</code>
                  <div className="min-w-0">
                    <p className="text-[12px] leading-relaxed">{seg.text}</p>
                    {seg.speech ? <p className="mt-1 border-l-2 border-[var(--border-strong)] pl-2 text-[11px] leading-relaxed text-[var(--text-muted)]">台词：{seg.speech}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentPane({ status, context, jobs, libraryName, onRun, onStop, onClear, onRefresh, onTimeline, timeline, timelineLoading, onPickTimeline, onClearTimeline }: {
  status: AgentStatus | null;
  context: AgentContext | null;
  jobs: AgentJob[];
  libraryName: string;
  onRun: (text: string) => void;
  onStop: (id: string) => void;
  onClear: () => void;
  onRefresh: () => void;
  onTimeline: (job: AgentJob) => void;
  timeline: Array<{ title: string; note: BatchNote | null }> | null;
  timelineLoading: boolean;
  onPickTimeline: (title: string) => void;
  onClearTimeline: () => void;
}) {

  const t = useT();
  const [text, setText] = React.useState('');
  const running = jobs.find((job) => job.status === 'running');
  const send = () => {
    const said = text.trim();
    if (!said || running) return;
    onRun(said);
    setText('');
  };
  const model = status?.kind === 'local' && status.local;
  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)_300px] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-[var(--accent)] opacity-[0.07] blur-3xl" />
          <div className="mb-4 flex items-center gap-2 border-b border-[var(--border)] pb-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--text-faint)]">Local agent</span>
            <span className="h-1 w-1 rounded-full bg-[var(--accent)]" />
            <span className="text-[10.5px] text-[var(--text-muted)]">{context ? `${context.assets.length} 素材 · ${context.tags.length} 标签 · ${context.outputs} 成片` : '读取素材库…'}</span>
            <span className="ml-auto flex items-center gap-1 rounded-full border border-[#22c55e]/25 bg-[#22c55e]/10 px-2 py-0.5 text-[10px] text-[#5fd18b]"><span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />MCP · stdio 本地</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]"><Bot size={20} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[14px] font-semibold tracking-tight">本地 Agent</h2>
                <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-faint)]">{t('batch.agent.onDevice')}</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                  <span className={`h-1.5 w-1.5 rounded-full ${model ? 'bg-[#22c55e]' : 'bg-[var(--accent)]'}`} />
                  {model ? `本地模型 · ${status?.model}` : '规则规划器 · 无需模型'}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                说一句要做什么，Agent 调本机 MCP 工具完成：读素材库、本地识别、打标签、生成混剪工程。不联网，素材不出本机。
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition focus-within:border-[var(--accent)]/60 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={600}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
              placeholder="例如：识别全部素材并打上“产品”标签，然后生成 3 条 20 秒竖屏成片"
              className="w-full resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
            <div className="flex items-center gap-2 px-1 pb-1">
              <div className="flex min-w-0 flex-wrap gap-1">
                {AGENT_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" disabled={Boolean(running)} onClick={() => setText(prompt)}
                    className="rounded-full bg-[var(--fill-tsp)] px-2 py-1 text-[10.5px] text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-40">{prompt}</button>
                ))}
              </div>
              <span className="ml-auto shrink-0 text-[10px] text-[var(--text-faint)]">⌘/Ctrl + Enter</span>
              <button type="button" onClick={send} disabled={Boolean(running) || !text.trim()}
                className={`${BTN_PRIMARY} h-8`}>
                {running ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}{running ? '执行中' : t('batch.agent.ask')}
              </button>
            </div>
          </div>
        </section>


        {timeline?.length ? (
          <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
              <ScanLine size={13} className="text-[var(--accent)]" />
              <span className="text-[12px] font-semibold">{t('batch.agent.timeline')}</span>
              <span className="text-[10.5px] text-[var(--text-faint)]">{timeline.length} 条素材</span>
              <button type="button" onClick={onClearTimeline} className="ml-auto text-[10.5px] text-[var(--text-faint)] hover:text-[var(--text)]">收起</button>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              {timeline.slice(0, 6).map((row, i) => (
                <button key={row.title + i} type="button" onClick={() => onPickTimeline(row.title)}
                  className="group min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-left transition hover:border-[var(--accent)]/40">
                  <div className="flex items-center gap-1.5"><span className="h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" /><span className="truncate text-[11px] font-medium">{row.title}</span></div>
                  <div className="mt-1 flex gap-1">
                    {(row.note?.segments ?? []).slice(0, 8).map((seg, k) => (
                      <span key={k} title={seg.text} style={{ flex: Math.max(1, seg.end - seg.start) }} className="h-1 rounded-full bg-[var(--accent)]/35 group-hover:bg-[var(--accent)]/55" />
                    ))}
                  </div>
                  <p className="mt-1 truncate text-[10px] text-[var(--text-faint)]">{row.note?.segments[0]?.text ?? '无画面描述'}</p>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium">{t('batch.agent.tasks')}</span>
          <span className="text-[11px] text-[var(--text-faint)]">{jobs.length ? `最近 ${jobs.length} 次` : '还没有任务'}</span>
          <button type="button" onClick={onRefresh} className={`${BTN_SOFT} ml-auto h-7`}><RefreshCw size={12} />刷新</button>
          {jobs.some((job) => job.status !== 'running') ? (
            <button type="button" onClick={onClear} className={`${BTN_SOFT} h-7`}><Trash2 size={12} />清空记录</button>
          ) : null}
        </div>

        {jobs.length ? (
          <div className="flex flex-col gap-2.5">
            {jobs.map((job) => (
              <article key={job.id} className={`group relative overflow-hidden rounded-xl border bg-[var(--surface)] p-3.5 transition ${job.status === 'running' ? 'border-[var(--accent)]/35 shadow-[0_0_0_1px_var(--accent-soft)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
                {job.status === 'running' ? <span className="absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent" /> : null}
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${job.status === 'running' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : job.status === 'done' ? 'bg-[#22c55e]/10 text-[#22c55e]' : 'bg-[var(--fill-tsp)] text-[var(--text-faint)]'}`}>
                    {job.status === 'running' ? <Loader2 size={13} className="animate-spin" /> : job.status === 'done' ? <Check size={13} /> : <X size={13} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium leading-snug">{job.text}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
                      <span>{job.mode === 'model' ? '本地模型' : '规则规划'}</span>
                      <span>{new Date(job.at).toLocaleTimeString()}</span>
                      {job.endedAt ? <span>{job.ms < 1000 ? `${job.ms}ms` : `${(job.ms / 1000).toFixed(1)}s`}</span> : null}
                      <span>{job.steps.length} 步</span>
                    </div>
                  </div>
                  {job.status === 'running' ? (
                    <button type="button" onClick={() => onStop(job.id)} className="flex h-7 items-center gap-1 rounded-md bg-[var(--fill-tsp)] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"><Pause size={11} />停止</button>
                  ) : null}
                </div>
                {(() => {
                  const live = job.status === 'running' ? [...job.steps].reverse().find((step) => step.tool === 'progress') : null;
                  if (!live) return null;
                  const pct = Math.max(0, Math.min(100, Math.round(Number((live.result as AgentProgress | undefined)?.progress ?? 0) * 100)));
                  return (
                    <div className="mt-2.5 rounded-lg border border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] px-2.5 py-2">
                      <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
                        <Loader2 size={10} className="animate-spin text-[var(--accent)]" />
                        <span className="truncate">{live.why || '渲染中'}</span>
                        <span className="ml-auto tabular-nums text-[var(--accent)]">{pct}%</span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill-tsp)]">
                        <span className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
                {job.steps.length ? (
                  <ol className="mt-3 flex flex-col gap-0 border-l border-[var(--border)] pl-3">
                    {job.steps.filter((step) => step.tool !== 'progress').map((step, i) => (
                      <li key={`${step.tool}-${i}`} className="relative py-1.5">
                        <span className={`absolute -left-[17px] top-3 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${step.ok ? 'bg-[var(--accent)]' : 'bg-[#ef4444]'}`} />
                        <div className="flex items-baseline gap-2">
                          <span className="text-[11.5px] font-medium">{TOOL_LABEL[step.tool] ?? step.tool}</span>
                          <code className="truncate text-[10px] text-[var(--text-faint)]">{step.tool}</code>
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{step.ms}ms</span>
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{step.why} · {stepSummary(step)}</div>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {job.reply && job.status !== 'running' ? (
                  <div className="mt-2 rounded-lg bg-[var(--fill-tsp)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--text)]">{job.reply}</div>
                ) : null}
                {job.error ? <div className="mt-2 text-[11px] text-[#ef4444]">{job.error}</div> : null}
                {job.status === 'done' && job.steps.some((step) => step.tool === 'analyze_assets') ? (
                  <button type="button" onClick={() => onTimeline(job)} disabled={timelineLoading} className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline disabled:opacity-50">{timelineLoading ? <Loader2 size={11} className="animate-spin" /> : <Clock size={11} />}{timelineLoading ? '读取时间线…' : '看识别时间线'}</button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--border-strong)] py-12 text-center">
            <Bot size={24} className="text-[var(--text-faint)]" />
            <p className="text-[12.5px] font-medium">还没有任务</p>
            <p className="text-[11px] text-[var(--text-faint)]">上面选一句，或自己写一句，Agent 会一步步调工具完成。</p>
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-3">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Cpu size={13} className="text-[var(--accent)]" />{t('batch.agent.capability')}</div>
          <dl className="mt-2 flex flex-col gap-1.5 text-[11px]">
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">素材库</dt><dd className="truncate">{libraryName || '…'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">素材</dt><dd className="tabular-nums">{context?.assets.length ?? '…'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">标签</dt><dd className="tabular-nums">{context?.tags.length ?? '…'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">成片</dt><dd className="tabular-nums">{context?.outputs ?? '…'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">规划器</dt><dd>{status?.kind === 'local' && status.local ? status.model : '规则'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">识别引擎</dt><dd className="flex items-center gap-1">{status?.analyze?.ok ? <><span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />就绪</> : <span className="text-[var(--text-faint)]">未就绪</span>}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-[var(--text-faint)]">Whisper</dt><dd>{status?.analyze?.whisper ? '本地模型' : '—'}</dd></div>
          </dl>
        </section>
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Terminal size={13} className="text-[var(--accent)]" />{t('batch.agent.tools')}</div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-faint)]">后台 Agent 和外部 agent 调的是同一套工具。</p>
          <ul className="mt-2 flex flex-col gap-1">
            {(status?.tools ?? []).map((tool) => (
              <li key={tool.name} className="flex items-center gap-1.5 text-[11px]"><span className="h-1 w-1 rounded-full bg-[var(--accent)]" /><code className="text-[var(--text)]">{tool.name}</code></li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Sparkles size={13} className="text-[var(--accent)]" />接本地模型</div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
            装 Ollama 或 LM Studio 后，在 <code className="text-[var(--text-muted)]">~/.openfilm/agent.json</code> 写
            <code className="text-[var(--text-muted)]"> {`{"kind":"local","endpoint":"http://127.0.0.1:11434/v1","model":"qwen2.5:7b"}`}</code>，
            模型会自己决定调哪个工具。没装时用规则规划器，功能一样。
          </p>
          {status?.error ? <p className="mt-1.5 text-[10px] text-[var(--text-faint)]">本地模型：未连接（{status.error}）</p> : null}
        </section>
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Bot size={13} className="text-[var(--accent)]" />给外部 agent</div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-faint)]">Codex / Claude Desktop / Cursor 也能直接连这个 MCP，配置见 <code className="text-[var(--text-muted)]">studio/server/mcp/mcp.json</code>。</p>
          {status?.mcp?.calls?.length ? (
            <ul className="mt-2 flex flex-col gap-1 border-t border-[var(--border)] pt-2">
              {status.mcp.calls.slice(0, 4).map((call, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                  <span className={call.ok ? "h-1 w-1 rounded-full bg-[#22c55e]" : "h-1 w-1 rounded-full bg-[#ef4444]"} />
                  <code className="text-[var(--text-muted)]">{call.tool}</code>
                  <span className="ml-auto tabular-nums">{new Date(call.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-1.5 text-[10px] text-[var(--text-faint)]">还没有外部 agent 调用记录。</p>}
        </section>
      </aside>
    </div>
  );
}
/**
 * 本地配音工作台：一段口播稿 → 一条真人感 wav，直接进素材库 assets/voice/。
 * 生成后自动带进一键成片，画面按这条配音的时长铺满；不联网，模型跑在本机 GPU 上。
 */
function VoicePane({ tts, busy, draft, setDraft, chosen, assets, libraryId, opts, setOpts, onChooseMode, onRefresh, onMake, onChoose, onClear, onGenerate, onOpenLibrary }: {
  tts: VoiceModeState | null;
  busy: boolean;
  draft: string;
  setDraft: (text: string) => void;
  chosen: VoicePick | null;
  assets: Asset[];
  libraryId: string;
  opts: VoiceOpts;
  setOpts: React.Dispatch<React.SetStateAction<VoiceOpts>>;
  onChooseMode: (patch: { mode?: VoiceMode; provider?: string; model?: string | null; voice?: string | null }) => void;
  onRefresh: () => void;
  onMake: (text: string, name?: string) => void;
  onChoose: (take: VoiceTake) => void;
  onClear: () => void;
  onGenerate: () => void;
  onOpenLibrary: () => void;
}) {
  const t = useT();
  const voices = React.useMemo(() => assets.filter((asset) => asset.kind === 'audio' && asset.path.startsWith('assets/voice/')), [assets]);
  const words = draft.trim().length;
  /* 中文口播大约每秒 4.2 个字；只用来给“预计时长”一个参考，真实时长以生成结果为准 */
  const estimate = words ? words / 4.2 : 0;
  const local = tts?.local ?? null;
  const apiProvider = tts?.providers.find((one) => one.id === opts.provider) ?? null;
  const ready = opts.mode === 'api' ? Boolean(tts?.providers.find((one) => one.id === opts.provider)?.connected) : local?.ok === true;
  /* 音色清单：n 系是本机刻录的真人长参考音（cross_lingual），比旧参考音更像真人在说话，排前面并标注。
     服务端没起来时至少留一个可选值，别让下拉塌成空框。 */
  const voiceList = React.useMemo(() => {
    const raw = local?.voices?.length ? local.voices : [{ id: opts.voice || 'n4', zeroShot: false }];
    const labeled = raw.map((one) => {
      const human = one.zeroShot === false || /^n\d+$/.test(one.id);
      return { id: one.id, human, label: human ? `${one.id} · ${t('batch.voice.humanTag')}` : `${one.id} · ${t('batch.voice.legacyTag')}` };
    });
    return labeled.sort((a, b) => Number(b.human) - Number(a.human) || a.id.localeCompare(b.id));
  }, [local?.voices, opts.voice]);
  const loaded = local?.loaded === true;

  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)_330px] items-start gap-4">
      <div className="flex flex-col gap-4">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Mic size={14} className="text-[var(--accent)]" />
            <span className="text-[12.5px] font-semibold">{t('batch.voice.script')}</span>
            <span className="text-[11px] text-[var(--text-faint)]">{t('batch.voice.scriptHint')}</span>
            <span className="ml-auto text-[11px] tabular-nums text-[var(--text-faint)]">{words} 字 · 约 {fmtTime(estimate)}</span>
          </div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={7}
            placeholder={t('batch.voice.placeholder')}
            className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text)] outline-none transition hover:border-[var(--border-strong)] focus:border-[var(--accent)]" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={busy || !draft.trim() || !ready}
              onClick={() => onMake(draft.trim())}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <AudioLines size={13} />}
              {busy ? t('batch.voice.making') : t('batch.voice.make')}
            </button>
            <button type="button" className={BTN_SOFT} onClick={onRefresh} disabled={busy}>
              <RefreshCw size={13} />{t('batch.voice.recheck')}
            </button>
            <span className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${ready ? (opts.mode === 'api' ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]' : loaded ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)]') : 'border-[#b42318]/40 bg-[#b42318]/10 text-[#b42318]'}`}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: ready ? 'var(--accent)' : '#b42318' }} />
              {opts.mode === 'api'
                ? t('batch.voice.apiReady').replace('{name}', tts?.providers.find((one) => one.id === opts.provider)?.name ?? 'API')
                : ready ? (loaded ? t('batch.voice.online') : t('batch.voice.loading')) : t('batch.voice.offline')}
            </span>
          </div>
          <div className="mt-3">
            <VoiceEngineSwitch state={tts} opts={opts} onChoose={onChooseMode} />
          </div>
          {/* 本地：音色 / 语速 / 停顿；API 下这段不渲染，音色由服务商决定 */}
          {opts.mode === 'local' ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
              {t('batch.voice.tone')}
              <select value={opts.voice} disabled={busy || !ready || !(local?.voices?.length)}
                onChange={(e) => onChooseMode({ mode: 'local', voice: e.target.value })}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]">
                {voiceList.map((one) => (
                  <option key={one.id} value={one.id}>{one.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
              {t('batch.voice.speed')}
              <input type="range" min={0.8} max={1.2} step={0.05} value={opts.speed} disabled={busy}
                onChange={(e) => setOpts((now) => ({ ...now, speed: Number(e.target.value) }))} className="h-1 w-24 accent-[var(--accent)]" />
              <span className="w-8 tabular-nums text-[11px] text-[var(--text-faint)]">{opts.speed.toFixed(2)}</span>
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]" title={opts.natural ? t('batch.voice.gapNaturalHint') : undefined}>
              {t('batch.voice.gap')}
              {/* 整段合成时停顿由模型自己换气，滑块不生效：置灰，不装作能调 */}
              <input type="range" min={0} max={0.5} step={0.02} value={opts.pause} disabled={busy || opts.natural}
                onChange={(e) => setOpts((now) => ({ ...now, pause: Number(e.target.value) }))} className="h-1 w-24 accent-[var(--accent)]" />
              <span className="w-8 tabular-nums text-[11px] text-[var(--text-faint)]">{opts.pause.toFixed(2)}s</span>
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]" title={t('batch.voice.naturalHint')}>
              <input type="checkbox" checked={opts.natural} disabled={busy}
                onChange={(e) => setOpts((now) => ({ ...now, natural: e.target.checked }))} className="h-3 w-3 accent-[var(--accent)]" />
              {t('batch.voice.natural')}
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]" title={t('batch.voice.verifyHint')}>
              <input type="checkbox" checked={opts.verify} disabled={busy}
                onChange={(e) => setOpts((now) => ({ ...now, verify: e.target.checked }))} className="h-3 w-3 accent-[var(--accent)]" />
              {t('batch.voice.verify')}
            </label>
            <span className="ml-auto text-[10.5px] leading-tight text-[var(--text-faint)]">{t('batch.voice.toneHint')}</span>
          </div>
          ) : null}
          {opts.mode === 'local' && !ready ? (
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {t('batch.voice.offlineHint')}
              <code className="ml-1 rounded bg-[var(--fill-tsp)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">start-tts.cmd</code>
            </div>
          ) : opts.mode === 'local' && local?.cuda === false ? (
            <div className="mt-3 rounded-xl border border-[#b58100]/40 bg-[#b58100]/10 px-3 py-2 text-[11.5px] text-[var(--text)]">{t('batch.voice.cpuWarn')}</div>
          ) : null}
        </section>

        {chosen ? (
          <section className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-4">
            <div className="flex items-center gap-2">
              <AudioLines size={14} className="text-[var(--accent)]" />
              <span className="text-[12.5px] font-semibold">{t('batch.voice.picked')}</span>
              <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-[10.5px] tabular-nums text-[var(--text-muted)]">{fmtTime(chosen.seconds ?? 0)}</span>
              <button type="button" onClick={onClear} className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><X size={11} />{t('batch.voice.unpick')}</button>
            </div>
            <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-[var(--text-muted)]">{chosen.text || chosen.path}</p>
            <audio className="mt-3 w-full" controls src={batchApi.file(libraryId, chosen.path, chosen.at)} />
            {/* 逐句时间轴 + 回读：既能看到每句落在第几秒（字幕就是这条轴），也能看出哪句念虚了 */}
            {chosen.cues?.length || chosen.report?.length ? (
              <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[var(--text-muted)]">{t('batch.voice.cues')}</span>
                  {typeof chosen.score === 'number' ? (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${chosen.score >= 0.9 ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : chosen.score >= 0.82 ? 'bg-[#b58100]/15 text-[#8a6300]' : 'bg-[#b42318]/12 text-[#b42318]'}`}>
                      {chosen.score.toFixed(2)}
                    </span>
                  ) : null}
                  {chosen.voice ? <span className="ml-auto text-[10px] text-[var(--text-faint)]">{chosen.voice}</span> : null}
                </div>
                <ul className="flex flex-col gap-1">
                  {(chosen.cues?.length ? chosen.cues : (chosen.report ?? []).map((one) => ({ text: one.text, start: null as number | null, end: null as number | null, score: one.score, tries: one.tries })))
                    .map((one, i) => {
                      const shaky = typeof (one as any).score === 'number' ? (one as any).score < 0.86 : false;
                      return (
                        <li key={i} className="flex items-start gap-2 text-[10.5px] leading-snug">
                          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${shaky ? 'bg-[#b42318]' : 'bg-[var(--accent)]'}`} />
                          <span className="shrink-0 tabular-nums text-[var(--text-faint)]">
                            {one.start !== null ? `${one.start.toFixed(2)}-${(one.end ?? 0).toFixed(2)}s` : `#${i + 1}`}
                          </span>
                          <span className="min-w-0 flex-1 text-[var(--text-muted)]">{one.text}</span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className={BTN_PRIMARY} onClick={onGenerate}><Wand2 size={13} />{t('batch.voice.toGenerate')}</button>
              <button type="button" className={BTN_SOFT} onClick={onOpenLibrary}><FolderOpen size={13} />{t('batch.voice.inLibrary')}</button>
            </div>
          </section>
        ) : null}

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <AudioLines size={14} className="text-[var(--text-muted)]" />
            <span className="text-[12.5px] font-semibold">{t('batch.voice.takes')}</span>
            <span className="text-[11px] text-[var(--text-faint)]">{t('batch.voice.takesHint')}</span>
            <span className="ml-auto text-[11px] tabular-nums text-[var(--text-faint)]">{voices.length}</span>
          </div>
          {voices.length ? (
            <div className="flex flex-col gap-1.5">
              {voices.map((asset) => (
                <div key={asset.path} className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${chosen?.path === asset.path ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => onChoose({ project: libraryId, path: asset.path, seconds: (asset.durationMs ?? 0) / 1000, bytes: asset.size, text: asset.name ?? asset.path, engine: 'cosyvoice2', at: asset.mtime })}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--text-muted)]"><AudioLines size={12} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text)]">{asset.name ?? asset.path.split('/').pop()}</span>
                      <span className="block truncate text-[10.5px] text-[var(--text-faint)]">{asset.durationMs ? fmtTime(asset.durationMs / 1000) : '—'} · {fmtBytes(asset.size)}</span>
                    </span>
                    {chosen?.path === asset.path ? <Check size={13} className="shrink-0 text-[var(--accent)]" /> : null}
                  </button>
                  <audio className="h-7 w-[150px] shrink-0" controls preload="none" src={batchApi.file(libraryId, asset.path, asset.mtime)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-8 text-center text-[12px] text-[var(--text-faint)]">{t('batch.voice.noTakes')}</div>
          )}
        </section>
      </div>

      <aside className="sticky top-0 flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-[12.5px] font-semibold">{t('batch.voice.engine')}</div>
        <div className="flex flex-col gap-1.5 text-[11.5px] text-[var(--text-muted)]">
          {opts.mode === 'api' ? (
            <>
              <div className="flex items-center justify-between gap-2"><span>{t('batch.voice.apiEngine')}</span><span className="truncate text-[var(--text)]">{apiProvider?.name ?? 'API'}</span></div>
              <div className="flex items-center justify-between gap-2"><span>{t('batch.voice.apiModel')}</span><span className="truncate text-[var(--text)]">{opts.model || apiProvider?.model || '—'}</span></div>
              <div className="flex items-center justify-between gap-2"><span>{t('batch.voice.apiVoice')}</span><span className="truncate text-[var(--text)]">{opts.voice || t('batch.voice.apiVoiceDefault')}</span></div>
              <div className="flex items-center justify-between gap-2"><span>联网</span><span className="text-[var(--text)]">需要</span></div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2"><span>模型</span><span className="truncate text-[var(--text)]">CosyVoice2-0.5B</span></div>
              <div className="flex items-center justify-between gap-2"><span>推理</span><span className="text-[var(--text)]">{local?.cuda ? '本地 GPU' : '本地 CPU'}</span></div>
              <div className="flex items-center justify-between gap-2"><span>联网</span><span className="text-[var(--text)]">不需要</span></div>
              <div className="flex items-center justify-between gap-2"><span>服务</span><span className="truncate text-[var(--text)]">{local?.origin ?? '—'}</span></div>
            </>
          )}
        </div>
        <div className="h-px bg-[var(--border)]" />
        <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">{t('batch.voice.tips')}</p>
        <div className="h-px bg-[var(--border)]" />
        <div className="flex flex-col gap-1.5 text-[11px] text-[var(--text-faint)]">
          <span>{opts.mode === 'api' ? t('batch.voice.flow1Api') : t('batch.voice.flow1')}</span>
          <span>{t('batch.voice.flow2')}</span>
          <span>{t('batch.voice.flow3')}</span>
        </div>
      </aside>
    </div>
  );
}

/**
 * 配音来源切换：本地 CosyVoice2 或自己 key 的云端服务商。
 * 只做展示与选择；真正合成仍走 /api/batch/tts，两条路产出同样的 cues 与时长。
 */
function VoiceEngineSwitch({ state, opts, onChoose, compact = false }: {
  state: VoiceModeState | null;
  opts: VoiceOpts;
  onChoose: (patch: { mode?: VoiceMode; provider?: string; model?: string | null; voice?: string | null }) => void;
  compact?: boolean;
}) {
  const t = useT();
  const [voices, setVoices] = React.useState<TtsVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = React.useState(false);
  const providers = state?.providers ?? [];
  const provider = providers.find((one) => one.id === opts.provider) ?? null;
  const localReady = state?.local?.ok === true;
  const api = opts.mode === 'api';

  /* 换服务商/模型时取它自己的音色清单：没 key 就是空，页面会说清楚 */
  React.useEffect(() => {
    if (!api || !provider) { setVoices([]); return undefined; }
    let live = true;
    setLoadingVoices(true);
    batchApi.voices(provider.id)
      .then((got) => { if (live) setVoices(got.voices ?? []); })
      .catch(() => { if (live) setVoices([]); })
      .finally(() => { if (live) setLoadingVoices(false); });
    return () => { live = false; };
  }, [api, provider?.id, provider?.model, opts.model]);

  const switchMode = (mode: VoiceMode) => {
    if (mode === opts.mode) return;
    if (mode === 'api') {
      const first = providers.find((one) => one.connected) ?? providers[0];
      /* 回到 API 时用它上次选的音色；服务商也变了才留空，让它走默认 */
      const keep = first?.id && first.id === state?.saved.provider ? (state?.saved.apiVoice ?? '') : '';
      onChoose({ mode, provider: first?.id, model: first?.model ?? null, voice: keep });
      return;
    }
    /* 切回本地时恢复本地自己的音色，不要用 API 的音色 */
    onChoose({ mode: 'local', voice: state?.saved.localVoice ?? state?.local?.defaultVoice ?? '' });
  };

  return (
    <div className={`flex flex-col gap-2 ${compact ? '' : 'rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--fill-tsp)] p-0.5">
          {(['local', 'api'] as VoiceMode[]).map((one) => (
            <button key={one} type="button" onClick={() => switchMode(one)}
              className={`h-7 rounded-md px-2.5 text-[11.5px] transition ${opts.mode === one ? 'bg-[var(--surface)] font-semibold text-[var(--text)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {one === 'local' ? t('batch.voice.modeLocal') : t('batch.voice.modeApi')}
            </button>
          ))}
        </div>
        {api ? (
          <>
            <select value={opts.provider} onChange={(e) => {
              const next = providers.find((one) => one.id === e.target.value);
              onChoose({ provider: e.target.value, model: next?.model ?? null, voice: '' });
            }} className="h-7 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[11.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]">
              {providers.map((one) => (
                <option key={one.id} value={one.id}>{(one.connected ? '' : '未连接 · ') + one.name}</option>
              ))}
            </select>
            {provider && provider.models.length ? (
              <select value={opts.model || provider.model || ''} onChange={(e) => onChoose({ model: e.target.value, voice: '' })}
                className="h-7 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[11.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]">
                {provider.models.map((one) => <option key={one.id} value={one.id}>{one.name}</option>)}
              </select>
            ) : null}
            <select value={opts.voice} onChange={(e) => onChoose({ voice: e.target.value })}
              className="h-7 max-w-[150px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[11.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]">
              {opts.voice ? null : <option value="">{loadingVoices ? '读取音色…' : voices.length ? '选音色' : '默认音色'}</option>}
              {voices.map((one) => <option key={one.id} value={one.id}>{one.name || one.id}</option>)}
            </select>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
            <span className={`h-1.5 w-1.5 rounded-full ${localReady ? 'bg-[var(--accent)]' : 'bg-[#b42318]'}`} />
            {localReady ? t('batch.voice.modeLocalOn') : t('batch.voice.modeLocalOff')}
          </span>
        )}
        <span className="ml-auto text-[10.5px] text-[var(--text-faint)]">{api ? t('batch.voice.modeApiHint') : t('batch.voice.modeLocalHint')}</span>
      </div>
      {api && provider && !provider.connected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#b58100]/40 bg-[#b58100]/10 px-2.5 py-1.5 text-[11px] text-[var(--text)]">
          <span>{t('batch.voice.apiNoKey').replace('{name}', provider.name)}</span>
          <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">{t('batch.voice.apiGetKey')}</a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 快速出片：给不熟参数的人用的三步页。
 *
 * 只问三件事——素材、尺寸、时长；其余全部走默认（按分镜选段、自动识别、本机渲染）。
 * 想改更多再进专业模式，两边的表单是同一份 state，切过去参数不会丢。
 */
function QuickPane({ libraryId, assets, usable, notes, uploading, dragging, setDragging, inputRef, onUpload, form, set, preview,
  onGenerate, onReroll, onLibrary, onPro, onSeeOutputs, onPreview, outputs, activeTasks, voice, voiceState, voiceOpts, onChooseMode,
  voiceDraft, setVoiceDraft, voiceBusy, onMakeVoice, onClearVoice, recentVoices, onPickVoice }: {
  libraryId: string;
  assets: Asset[];
  usable: MixAsset[];
  notes: Record<string, BatchNote>;
  uploading: { done: number; total: number } | null;
  dragging: boolean;
  setDragging: (on: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (files: FileList | File[]) => Promise<void>;
  form: BatchForm;
  set: <K extends keyof BatchForm>(key: K, value: BatchForm[K]) => void;
  preview: { plan: MixPlan | null; error: string | null };
  onGenerate: () => void;
  onReroll: () => void;
  onLibrary: () => void;
  onPro: () => void;
  onSeeOutputs: () => void;
  onPreview: (output: BatchOutput) => void;
  outputs: BatchOutput[];
  activeTasks: Task[];
  voice: VoicePick | null;
  voiceState: VoiceModeState | null;
  voiceOpts: VoiceOpts;
  onChooseMode: (patch: { mode?: VoiceMode; provider?: string; model?: string | null; voice?: string | null }) => void;
  voiceDraft: string;
  setVoiceDraft: (text: string) => void;
  voiceBusy: boolean;
  onMakeVoice: (text: string) => void;
  onClearVoice: () => void;
  recentVoices: Asset[];
  onPickVoice: (asset: Asset) => void;
}) {
  const t = useT();
  const plan = preview.plan;
  /* 和配音页同一套判断：本地看服务是否在线，API 看服务商是否连上 */
  const voiceReady = voiceOpts.mode === 'api'
    ? Boolean(voiceState?.providers.find((one) => one.id === voiceOpts.provider)?.connected)
    : voiceState?.local?.ok === true;
  const analyzed = React.useMemo(() => usable.filter((asset) => notes[asset.path]?.segments?.length).length, [notes, usable]);
  const clips = React.useMemo(() => assets.filter((asset) => asset.kind === 'video' || asset.kind === 'image').slice(0, 12), [assets]);
  const sizes: Array<{ value: Aspect; label: string }> = [
    { value: '9:16', label: t('batch.quick.vertical') },
    { value: '16:9', label: t('batch.quick.landscape') },
    { value: '1:1', label: t('batch.quick.square') },
  ];
  const durations = [15, 20, 30];
  const latest = outputs.slice(0, 3);
  const bars = React.useMemo(() => {
    if (!plan || !plan.durationSeconds) return [];
    return plan.segments.map((segment) => ({
      key: `${segment.src}-${segment.at}`,
      width: segment.length / plan.durationSeconds * 100,
      color: colorFor(segment.src),
      label: `${segment.src.split('/').pop()} · ${fmtTime(segment.length)}`,
    }));
  }, [plan]);

  return (
    <div className="flex flex-col gap-4">
      {/* 第一步：素材 */}
      <section
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void onUpload(e.dataTransfer.files); }}
        className={`rounded-2xl border-2 border-dashed p-5 transition ${dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface)]'}`}>
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[var(--accent-text,#fff)]">1</span>
          <span className="text-[13px] font-semibold">{t('batch.quick.step1')}</span>
          <span className="text-[11px] text-[var(--text-faint)]">{t('batch.quick.step1Hint')}</span>
          <button type="button" onClick={() => inputRef.current?.click()} className={`${BTN_SOFT} ml-auto`} disabled={!libraryId}>
            <Upload size={13} />{t('batch.library.upload')}
          </button>
        </div>
        <input ref={inputRef} type="file" multiple accept="video/*,image/*,audio/*" className="hidden"
          onChange={(e) => { if (e.target.files?.length) void onUpload(e.target.files); e.target.value = ''; }} />
        {uploading ? (
          <p className="mt-3 text-[12px] text-[var(--text-muted)]">{t('batch.library.uploadingCount').replace('{done}', String(uploading.done)).replace('{total}', String(uploading.total))}</p>
        ) : null}
        {clips.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {clips.map((asset) => {
              const done = Boolean(notes[asset.path]?.segments?.length);
              return (
                <div key={asset.path} className="relative h-16 w-11 overflow-hidden rounded-lg bg-[var(--fill-tsp)]">
                  <img src={batchApi.poster(libraryId, asset.path, asset.mtime)} alt="" className="h-full w-full object-cover" />
                  {done ? <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-white"><Check size={9} /></span> : null}
                </div>
              );
            })}
            <button type="button" onClick={onLibrary} className="flex h-16 w-11 flex-col items-center justify-center gap-0.5 rounded-lg border border-[var(--border)] text-[9.5px] text-[var(--text-faint)] hover:border-[var(--border-strong)] hover:text-[var(--text)]">
              <LayoutGrid size={13} />{assets.length}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => inputRef.current?.click()} disabled={!libraryId}
            className="mt-3 flex w-full flex-col items-center gap-1.5 rounded-xl py-7 text-[var(--text-faint)] transition hover:bg-[var(--fill-tsp)] hover:text-[var(--text-muted)]">
            <Upload size={20} />
            <span className="text-[12.5px]">{t('batch.quick.drop')}</span>
            <span className="text-[10.5px]">{t('batch.library.dropHint')}</span>
          </button>
        )}
        {clips.length ? (
          <p className="mt-2 text-[10.5px] text-[var(--text-faint)]">
            {t('batch.quick.ready').replace('{n}', String(usable.length)).replace('{done}', String(analyzed))}
          </p>
        ) : null}
      </section>

      {/* 配音：可不用；要用就当场写一句、选本地或 API，生成完自动带进成片 */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center gap-2">
          <Mic size={14} className="text-[var(--accent)]" />
          <span className="text-[13px] font-semibold">{t('batch.quick.voiceStep')}</span>
          <span className="text-[11px] text-[var(--text-faint)]">{t('batch.quick.voiceHint')}</span>
          {voice ? (
            <button type="button" onClick={onClearVoice}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] text-[var(--accent)] hover:brightness-95">
              <AudioLines size={11} />{t('batch.quick.voicePicked').replace('{s}', voice.seconds.toFixed(1))}
              <X size={10} />
            </button>
          ) : null}
        </div>
        <div className="mt-3">
          <VoiceEngineSwitch state={voiceState} opts={voiceOpts} onChoose={onChooseMode} compact />
        </div>
        <div className="mt-2.5 flex flex-col gap-2">
          <textarea value={voiceDraft} onChange={(e) => setVoiceDraft(e.target.value)} rows={2}
            placeholder={t('batch.quick.voicePlaceholder')}
            className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text)] outline-none transition hover:border-[var(--border-strong)] focus:border-[var(--accent)]" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={voiceBusy || !voiceDraft.trim() || !voiceReady} onClick={() => onMakeVoice(voiceDraft.trim())}
              className={BTN_SOFT}>
              {voiceBusy ? <Loader2 size={12} className="animate-spin" /> : <AudioLines size={12} />}
              {voiceBusy ? t('batch.quick.voiceMaking') : t('batch.quick.voiceMake')}
            </button>
            {voice ? <audio className="h-8 min-w-0 flex-1" controls preload="none" src={batchApi.file(libraryId, voice.path, voice.at)} /> : null}
            {!voice && !voiceReady ? <span className="text-[10.5px] text-[#b42318]">{t('batch.quick.voiceNotReady')}</span> : null}
          </div>
          {recentVoices.length ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-[var(--text-faint)]">{t('batch.quick.recentVoices')}</span>
              {recentVoices.slice(0, 3).map((take) => {
                const picked = voice?.path === take.path;
                const s = take.durationMs ? (take.durationMs / 1000).toFixed(1) + 's' : '';
                const name = take.name ?? take.path.split('/').pop() ?? '';
                return (
                  <button key={take.path} type="button" onClick={() => onPickVoice(take)}
                    title={name}
                    className={`inline-flex max-w-[200px] items-center gap-1 truncate rounded-lg border px-2 py-0.5 transition ${picked ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'}`}>
                    <span className="truncate">{name}</span>{s ? <span className="tabular-nums opacity-75">({s})</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      {/* 第二步：尺寸和时长 */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[var(--accent-text,#fff)]">2</span>
          <span className="text-[13px] font-semibold">{t('batch.quick.step2')}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {sizes.map((size) => (
            <button key={size.value} type="button" onClick={() => set('aspect', size.value)}
              className={`h-9 rounded-lg px-3.5 text-[12.5px] transition ${form.aspect === size.value ? 'bg-[var(--accent)] font-medium text-[var(--accent-text,#fff)]' : 'bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {size.label}
            </button>
          ))}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          {durations.map((seconds) => (
            <button key={seconds} type="button" onClick={() => set('seconds', seconds)}
              className={`h-9 rounded-lg px-3.5 text-[12.5px] tabular-nums transition ${form.seconds === seconds ? 'bg-[var(--accent)] font-medium text-[var(--accent-text,#fff)]' : 'bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              {seconds}s
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[var(--text-faint)]">{t('batch.quick.defaults')}</span>
          {voice ? <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent)]">{t('batch.quick.withVoice').replace('{s}', voice.seconds.toFixed(1))}</span> : null}
        </div>
      </section>

      {/* 第三步：出片 */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[var(--accent-text,#fff)]">3</span>
          <span className="text-[13px] font-semibold">{t('batch.quick.step3')}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" disabled={!plan} onClick={onGenerate} className={`${BTN_PRIMARY} h-11 px-6 text-[13px]`}>
            <Zap size={15} />{t('batch.quick.make')}
          </button>
          <button type="button" disabled={!plan} onClick={onReroll} className={`${BTN_SOFT} h-11`}>
            <Shuffle size={14} />{t('batch.quick.reroll')}
          </button>
          <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
            {preview.error ?? (plan ? `${fmtTime(plan.durationSeconds)} · ${plan.shots} ${t('batch.common.pieces')} · ${form.aspect}` : '')}
          </span>
          {activeTasks.length ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)]"><Loader2 size={12} className="animate-spin" />{t('batch.quick.running').replace('{n}', String(activeTasks.length))}</span>
          ) : null}
        </div>
        {bars.length ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--fill-tsp)]">
              {bars.map((bar) => <span key={bar.key} title={bar.label} style={{ width: `${bar.width}%`, background: bar.color }} />)}
            </div>
            <p className="text-[10.5px] text-[var(--text-faint)]">{t('batch.quick.stripHint')}</p>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px]">
          <button type="button" onClick={onPro} className="text-[var(--accent)] hover:underline">{t('batch.quick.more')}</button>
          <span className="text-[var(--text-faint)]">{t('batch.quick.moreHint')}</span>
        </div>
      </section>

      {/* 最近成片 */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center gap-2">
          <Film size={14} className="text-[var(--accent)]" />
          <span className="text-[12.5px] font-semibold">{t('batch.quick.recent')}</span>
          <button type="button" onClick={onSeeOutputs} className="ml-auto text-[11.5px] text-[var(--accent)] hover:underline">{t('batch.quick.seeAll')}</button>
        </div>
        {latest.length ? (
          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-3">
            {latest.map((output) => (
              <button key={output.path} type="button" onClick={() => onPreview(output)}
                className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] p-2 text-left transition hover:border-[var(--border-strong)]">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--text-muted)]"><Play size={13} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{output.name}</span>
                  <span className="block text-[10.5px] text-[var(--text-faint)]">{fmtBytes(output.bytes)} · {new Date(output.at).toLocaleDateString()}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[11.5px] text-[var(--text-faint)]">{t('batch.quick.noRecent')}</p>
        )}
      </section>
    </div>
  );
}
function GeneratePane({ form, set, preview, repeats, usable, assets, notes, selectedCount, presets, onPreset, onGenerate, onChooseFolder, pickingFolder, onOpenLibrary }: {
  form: BatchForm;
  set: <K extends keyof BatchForm>(key: K, value: BatchForm[K]) => void;
  preview: { plan: MixPlan | null; error: string | null };
  repeats: number;
  usable: MixAsset[];
  assets: Asset[];
  notes: Record<string, BatchNote>;
  selectedCount: number;
  presets: typeof PRESETS;
  onPreset: (id: string) => void;
  onGenerate: () => void;
  onChooseFolder: () => void;
  pickingFolder: boolean;
  onOpenLibrary: () => void;
}) {
  const t = useT();
  const plan = preview.plan;
  const bars = React.useMemo(() => {
    if (!plan || !plan.durationSeconds) return [];
    return plan.segments.map((segment) => ({
      key: `${segment.src}-${segment.at}`,
      width: segment.length / plan.durationSeconds * 100,
      color: colorFor(segment.src),
      label: `${segment.src.split('/').pop()} · ${fmtTime(segment.length)}`,
    }));
  }, [plan]);
  const voice = Number(form.voiceSeconds) > 0;
  /* 已识别的素材数：按分镜选段只用有识别结果的素材 */
  const analyzedCount = React.useMemo(() => usable.filter((asset) => notes[asset.path]?.segments?.length).length, [notes, usable]);
  /* 选段明细：让人直接看到每条成片用了哪一段、命中哪个关键词。 */
  const queryTerms = React.useMemo(() => form.query.split(/[\s,，、]+/).map((one) => one.trim().toLowerCase()).filter(Boolean), [form.query]);
  const detail = React.useMemo(() => {
    if (!form.useTimeline || !plan) return [];
    return plan.segments.slice(0, 8).map((segment) => {
      const name = segment.src.split('/').pop() ?? segment.src;
      const hay = `${segment.text ?? ''}\n${segment.speech ?? ''}\n${(segment.tags ?? []).join(' ')}`.toLowerCase();
      return { ...segment, name, hits: queryTerms.filter((word) => hay.includes(word)) };
    });
  }, [form.useTimeline, plan, queryTerms]);

  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)_320px] items-start gap-4">
      <div className="flex flex-col gap-4">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={14} className="text-[var(--accent)]" />
            <span className="text-[12.5px] font-semibold">{t('batch.form.preset')}</span>
            <span className="text-[11px] text-[var(--text-faint)]">点一下带进参数，之后仍可改</span>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {presets.map((preset) => (
              <button key={preset.id} type="button" onClick={() => onPreset(preset.id)}
                className={`flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition ${form.preset === preset.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}>
                <span className="text-[12px] font-medium">{t(`batch.presets.${preset.id}`)}</span>
                <span className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">{preset.note}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 text-[12.5px] font-semibold">{t('batch.form.basic')}</div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label={t('batch.form.duration')} hint="秒">
              <input type="number" min={3} max={180} value={form.seconds} onChange={(e) => set('seconds', Math.max(3, Math.min(180, Number(e.target.value) || 3)))} className={INPUT} />
            </Field>
            <Field label={t('batch.form.aspect')}>
              <select value={form.aspect} onChange={(e) => set('aspect', e.target.value as Aspect)} className={INPUT}>
                {ASPECTS.map((aspect) => <option key={aspect.value} value={aspect.value}>{aspect.value}</option>)}
              </select>
            </Field>
            <Field label={t('batch.form.pace')}>
              <select value={form.pace} onChange={(e) => set('pace', e.target.value as MixOptions['pace'])} className={INPUT}>
                <option value="fast">{t('batch.form.paceFast')}</option>
                <option value="normal">{t('batch.form.paceNormal')}</option>
                <option value="slow">{t('batch.form.paceSlow')}</option>
              </select>
            </Field>
            <Field label={t('batch.form.batch')} hint={t('batch.form.batchHint')}>
              <input type="number" min={1} max={12} value={form.count} onChange={(e) => set('count', Math.max(1, Math.min(12, Number(e.target.value) || 1)))} className={INPUT} />
            </Field>
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <ScanLine size={14} className="text-[var(--accent)]" />
            <span className="text-[12.5px] font-semibold">{t('batch.form.timeline')}</span>
            <span className="text-[11px] text-[var(--text-faint)]">{t('batch.form.timelineHint')}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[210px_120px_minmax(0,1fr)]">
            <Toggle checked={form.useTimeline} onChange={(v) => set('useTimeline', v)} label={t('batch.form.useTimeline')} hint={t('batch.form.useTimelineHint')} />
            <Field label={t('batch.form.shotSeconds')} hint={t('batch.form.shotSecondsHint')}>
              <input type="number" min={0} max={30} step={0.5} value={form.shotSeconds} disabled={!form.useTimeline}
                onChange={(e) => set('shotSeconds', String(Math.max(0, Math.min(30, Number(e.target.value) || 0))))}
                className={`${INPUT} disabled:opacity-50`} />
            </Field>
            <Field label={t('batch.form.query')} hint={t('batch.form.queryHint')}>
              <input value={form.query} disabled={!form.useTimeline} placeholder={t('batch.form.queryPlaceholder')}
                onChange={(e) => set('query', e.target.value)} className={`${INPUT} disabled:opacity-50`} />
            </Field>
          </div>
          <p className={`mt-2 text-[10.5px] leading-relaxed ${analyzedCount ? 'text-[var(--text-faint)]' : 'text-[var(--warning,#d97706)]'}`}>
            {analyzedCount ? t('batch.form.analyzed').replace('{done}', String(analyzedCount)).replace('{total}', String(usable.length)) : t('batch.form.timelineMissing')}
          </p>
        </section>
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[12.5px] font-semibold">{t('batch.form.advanced')}</span>
            <span className="text-[11px] text-[var(--text-faint)]">默认值已经够用</span>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label={t('batch.form.avoid')} hint={t('batch.form.avoidHint')}>
              <input type="number" min={0} max={9} value={form.avoidRepeat} onChange={(e) => set('avoidRepeat', Math.max(0, Math.min(9, Number(e.target.value) || 0)))} className={INPUT} />
            </Field>
            <Field label={t('batch.form.voice')} hint={t('batch.form.voiceHint')}>
              <input type="number" min={0} max={600} value={form.voiceSeconds} placeholder="—" onChange={(e) => set('voiceSeconds', e.target.value)} className={INPUT} />
            </Field>
            <Field label={t('batch.form.fps')}>
              <select value={form.fps} onChange={(e) => set('fps', Number(e.target.value))} className={INPUT}>
                {[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}
              </select>
            </Field>
            <Field label={t('batch.form.seed')}>
              <div className="flex gap-1.5">
                <input type="number" value={form.seed} onChange={(e) => set('seed', Number(e.target.value) || 1)} className={INPUT} />
                <button type="button" title={t('batch.form.reroll')} onClick={() => set('seed', Math.floor(Math.random() * 900000) + 1000)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]"><Shuffle size={13} /></button>
              </div>
            </Field>
            <Toggle checked={form.shuffle} onChange={(v) => set('shuffle', v)} label={t('batch.form.shuffle')} />
            <Toggle checked={form.audio} onChange={(v) => set('audio', v)} label={t('batch.form.audio')} />
            <Toggle checked={form.subtitles} onChange={(v) => set('subtitles', v)} label={t('batch.form.subtitles')} hint={t('batch.form.subtitlesHint')} />
            {form.subtitles ? (
              <Field label={t('batch.form.subtitleBottom')} hint={t('batch.form.subtitleBottomHint')}>
                <div className="flex items-center gap-2">
                  <input type="range" min={6} max={40} step={1} value={Math.round(form.subtitleBottom * 100)}
                    onChange={(e) => set('subtitleBottom', Math.max(6, Math.min(40, Number(e.target.value) || 14)) / 100)}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--fill-2)] accent-[var(--accent)]" />
                  <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--text-muted)]">
                    {t('batch.form.subtitleBottomValue').replace('{pct}', String(Math.round(form.subtitleBottom * 100)))}
                  </span>
                </div>
              </Field>
            ) : null}
            <Field label={t('batch.form.name')} hint={t('batch.form.nameHint')}>
              <input value={form.name} placeholder="A1-launch" onChange={(e) => set('name', e.target.value)} className={INPUT} />
            </Field>
            <Field label={t('batch.form.folder')} hint={t('batch.form.folderHint')}>
              <div className="flex gap-1.5">
                <input value={form.folder} placeholder="Studio 默认目录" onChange={(e) => set('folder', e.target.value)} className={INPUT} />
                <button type="button" onClick={onChooseFolder} title={t('batch.form.chooseFolder')}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]">
                  {pickingFolder ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                </button>
              </div>
            </Field>
          </div>
        </section>
      </div>

      <aside className="sticky top-0 flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-semibold">{t('batch.form.preview')}</span>
          <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[10.5px] tabular-nums text-[var(--text-muted)]">{form.aspect}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label={t('batch.form.durationLabel')} value={plan ? fmtTime(plan.durationSeconds) : '—'} />
          <Stat label={t('batch.form.shots')} value={plan ? plan.shots : '—'} />
          <Stat label={t('batch.form.assets')} value={plan ? Object.keys(plan.used).length : usable.length} />
          <Stat label={t('batch.form.reuse')} value={repeats} />
        </div>
        {bars.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--text-faint)]">{t('batch.form.segments')}</span>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--fill-tsp)]">
              {bars.map((bar) => <span key={bar.key} title={bar.label} style={{ width: `${bar.width}%`, background: bar.color }} />)}
            </div>
          </div>
        ) : null}
        {detail.length ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-faint)]">{t('batch.form.detail')}</span>
              <span className="tabular-nums text-[var(--text-muted)]">{plan?.segments.length ?? 0} {t('batch.common.pieces')}</span>
            </div>
            <ol className="flex max-h-60 flex-col gap-1 overflow-auto pr-1">
              {detail.map((segment, i) => (
                <li key={`${segment.src}-${segment.at}`} className="rounded-lg bg-[var(--fill-tsp)] px-2.5 py-1.5">
                  <div className="flex items-center gap-2 text-[10.5px] tabular-nums text-[var(--text-faint)]">
                    <span className="font-semibold text-[var(--accent)]">{i + 1}</span>
                    <span>{startOf(segment.at)}–{startOf(segment.at + segment.length)}</span>
                    <span className="truncate">{segment.name}</span>
                    <span className="ml-auto shrink-0">{fmtTime(segment.length)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                    {segment.speech || segment.text || t('batch.form.noContent')}
                  </p>
                  {segment.hits.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {segment.hits.map((word) => <span key={word} className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">{t('batch.form.hit')} {word}</span>)}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <div className="rounded-xl bg-[var(--fill-tsp)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          {preview.error ?? (
            <>
              {t('batch.form.duration')} {fmtTime(plan?.durationSeconds ?? 0)} · {plan?.shots ?? 0} {t('batch.common.pieces')}
              {voice ? <span className="ml-1 text-[var(--text-faint)]">（以旁白 {form.voiceSeconds}s 为准）</span> : null}
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1"><LayoutGrid size={12} />{t('batch.library.selected').replace('{n}', String(selectedCount || usable.length))}</span>
          <button type="button" onClick={onOpenLibrary} className="text-[var(--accent)] hover:underline">去选择</button>
        </div>
        <button type="button" disabled={!plan || !assets.length} onClick={onGenerate} className={`${BTN_PRIMARY} h-11 w-full text-[13px]`}>
          <Wand2 size={15} />{t('batch.form.generate').replace('{n}', String(form.count))}
        </button>
        <p className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">
          每条成片另开一个工程，渲染完可以在成片管理里预览、定位或进高级编辑。
        </p>
      </aside>
    </div>
  );
}

/** 标签的颜色按名字算，同一个标签在卡片、筛选条和弹层里都一样。 */
function tagColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 33 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 68% 58%)`;
}

function colorFor(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i += 1) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 62% 52%)`;
}

function TasksPane({ tasks, onCancel, onRetry, onAgain, onOpenEditor, onReveal, onOpen, onClearDone, onSeeOutputs }: {
  tasks: Task[];
  onCancel: (task: Task) => void;
  onRetry: (task: Task) => void;
  onAgain: (task: Task) => void;
  onOpenEditor: (projectId: string) => void;
  onReveal: (task: Task) => void;
  onOpen: (task: Task) => void;
  onClearDone: () => void;
  onSeeOutputs: () => void;
}) {
  const t = useT();
  const active = tasks.filter(taskIsActive).length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;

  if (!tasks.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-20 text-center">
        <ListChecks size={26} className="text-[var(--text-faint)]" />
        <p className="text-[13px] font-medium">{t('batch.tasks.empty')}</p>
        <p className="text-[11.5px] text-[var(--text-faint)]">{t('batch.tasks.subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--accent)]">{t('batch.tasks.active').replace('{n}', String(active))}</span>
        <span className="rounded-full bg-[var(--fill-tsp)] px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]">已完成 {done}</span>
        {failed ? <span className="rounded-full bg-[#b42318]/10 px-2.5 py-1 text-[11.5px] text-[#b42318]">失败 {failed}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onSeeOutputs} className={BTN_SOFT}><Film size={13} />{t('batch.nav.outputs')}</button>
          <button type="button" onClick={onClearDone} className={BTN_SOFT}><Trash2 size={13} />{t('batch.tasks.clearDone')}</button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {tasks.map((task) => {
          const live = taskIsActive(task);
          return (
            <div key={task.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${statusTone(task.status)}`}>{statusIcon(task.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-semibold">{task.name}</span>
                    <span className="shrink-0 text-[10.5px] text-[var(--text-faint)]">{statusLabel(task.status, t)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-faint)]">
                    <span>{task.message}</span>
                    {task.shots ? <span>· {t('batch.tasks.segments').replace('{n}', String(task.shots)).replace('{duration}', fmtTime(task.duration))}</span> : null}
                    {task.projectName ? <span>· {t('batch.tasks.project')} {task.projectName}</span> : null}
                    {task.etaMs != null && live ? <span>· {t('batch.tasks.eta').replace('{time}', fmtTime(task.etaMs / 1000))}</span> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {live ? (
                    <button type="button" onClick={() => onCancel(task)} className={BTN_SOFT}><Pause size={13} />{t('batch.tasks.cancel')}</button>
                  ) : task.status === 'done' ? (
                    <>
                      {task.output ? <button type="button" onClick={() => onOpen(task)} className={BTN_SOFT}><Play size={13} />{t('batch.tasks.open')}</button> : null}
                      {task.output ? <button type="button" onClick={() => onReveal(task)} className={BTN_SOFT}><FolderOpen size={13} />{t('batch.tasks.reveal')}</button> : null}
                      <button type="button" onClick={() => onAgain(task)} title={t('batch.tasks.againHint')} className={BTN_SOFT}><RefreshCw size={13} />{t('batch.tasks.again')}</button>
                      {task.projectId ? <button type="button" onClick={() => onOpenEditor(task.projectId!)} className={BTN_PRIMARY}><Clapperboard size={13} />{t('batch.tasks.edit')}</button> : null}
                    </>
                  ) : (
                    <button type="button" onClick={() => onRetry(task)} title={t('batch.tasks.retryHint')} className={BTN_SOFT}><RefreshCw size={13} />{t('batch.tasks.retry')}</button>
                  )}
                </div>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--fill-tsp)]">
                  <div className={`h-full rounded-full transition-all ${task.status === 'failed' ? 'bg-[#b42318]' : task.status === 'cancelled' ? 'bg-[var(--border-strong)]' : task.status === 'done' ? 'bg-[#12805c]' : 'bg-[var(--accent)]'}`}
                    style={{ width: `${Math.round((task.status === 'done' ? 1 : task.progress) * 100)}%` }} />
                </div>
                <span className="w-9 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--text-faint)]">{Math.round((task.status === 'done' ? 1 : task.progress) * 100)}%</span>
              </div>
              {task.error ? <p className="mt-1.5 rounded-lg bg-[#b42318]/8 px-2 py-1 text-[11px] text-[#b42318]">{task.error}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const statusLabel = (status: TaskStatus, t: (key: string) => string) => t(`batch.tasks.${status}`);
const statusTone = (status: TaskStatus) => {
  if (status === 'done') return 'bg-[#12805c]/12 text-[#12805c]';
  if (status === 'failed') return 'bg-[#b42318]/12 text-[#b42318]';
  if (status === 'cancelled') return 'bg-[var(--fill-tsp)] text-[var(--text-faint)]';
  if (status === 'waiting') return 'bg-[var(--fill-tsp)] text-[var(--text-muted)]';
  return 'bg-[var(--accent-soft)] text-[var(--accent)]';
};
const statusIcon = (status: TaskStatus) => {
  if (status === 'done') return <Check size={14} />;
  if (status === 'failed') return <X size={14} />;
  if (status === 'cancelled') return <Pause size={14} />;
  if (status === 'waiting') return <Clock size={14} />;
  return <Loader2 size={14} className="animate-spin" />;
};

function OutputsPane({ outputs, all, loading, onPreview, onReveal, onEdit, onDelete, onRefresh, notes, analyzing, onAnalyze, onAnalyzeAll, onRead, libraryId }: {
  outputs: BatchOutput[];
  all: BatchOutput[];
  loading: boolean;
  onPreview: (output: BatchOutput) => void;
  onReveal: (output: BatchOutput) => void;
  onEdit: (output: BatchOutput) => void;
  onDelete: (output: BatchOutput) => void;
  onRefresh: () => void;
  notes: Record<string, BatchNote>;
  analyzing: { done: number; total: number; name: string } | null;
  onAnalyze: (output: BatchOutput) => void;
  /** 把还没识别过的成片一次交给本机识别 */
  onAnalyzeAll: () => void;
  onRead: (output: BatchOutput) => void;
  /** 素材库工程 id：成片的识别结果也存在它的 .film/batch-notes.json 里 */
  libraryId: string;
}) {
  const t = useT();
  const toast = useToast();
  const [exporting, setExporting] = React.useState(false);
  const analyzed = React.useMemo(() => outputs.filter((output) => notes[output.path]), [outputs, notes]);
  const exportBoard = async () => {
    if (!analyzed.length || !libraryId) { toast.showError(t('batch.analyze.exportEmpty')); return; }
    setExporting(true);
    try {
      const list = await saveShotList(libraryId, analyzed.map((output) => output.path), `成片分镜表-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.show(t('batch.analyze.exported').replace('{n}', String(list.files.length)));
    } catch (e) { toast.showError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  if (!all.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-20 text-center">
        <Film size={26} className="text-[var(--text-faint)]" />
        <p className="text-[13px] font-medium">{t('batch.outputs.empty')}</p>
        <button type="button" onClick={onRefresh} className={BTN_SOFT}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{t('batch.outputs.refresh')}</button>
      </div>
    );
  }
  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-[var(--text-muted)]">{t('batch.outputs.count').replace('{n}', String(outputs.length))}</span>
        {loading ? <Loader2 size={12} className="animate-spin text-[var(--text-faint)]" /> : null}
        <button type="button" onClick={onAnalyzeAll} disabled={Boolean(analyzing)}
          title={t('batch.analyze.outputHint')}
          className={`${BTN_SOFT} ml-auto`}>
          {analyzing ? <Loader2 size={12} className="animate-spin" /> : <ScanLine size={12} />}
          {t('batch.analyze.allOutputs')}
        </button>
        <button type="button" onClick={() => void exportBoard()} disabled={!analyzed.length || exporting}
          title={t('batch.analyze.exportBoardHint')}
          className={BTN_SOFT}>
          {exporting ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}{t('batch.analyze.exportBoard')}
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(238px,1fr))] gap-3">
        {outputs.map((output) => {
          const note = notes[output.path];
          return (
            <div key={`${output.project}:${output.path}`} className="group overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] transition hover:border-[var(--border-strong)]">
              <button type="button" onClick={() => onPreview(output)} className="relative block aspect-video w-full bg-black">
                <video src={batchApi.outputFile(output.project, output.path, output.at)} muted preload="metadata" className="h-full w-full object-contain" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white/0 transition group-hover:bg-black/35 group-hover:text-white">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur"><Play size={17} /></span>
                </span>
                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{fmtBytes(output.bytes)}</span>
              </button>
              <div className="flex flex-col gap-1.5 px-3 py-2.5">
                <span className="truncate text-[12px] font-medium" title={output.name}>{output.name}</span>
                <span className="truncate text-[10.5px] text-[var(--text-faint)]">{output.projectName} · {output.label || '视频'}</span>
                <span className="text-[10.5px] text-[var(--text-faint)]">{new Date(output.at).toLocaleString()}</span>
                {note?.quality ? (() => {
                  const q = note.quality;
                  const bad = q.issues.filter((one) => one.level === 'error');
                  const warn = q.issues.filter((one) => one.level === 'warn');
                  return (
                    <div className={`flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] leading-snug ${bad.length ? 'bg-[#ef4444]/10 text-[#ef4444]' : warn.length ? 'bg-[#f59e0b]/10 text-[#b45309]' : 'bg-[#22c55e]/10 text-[#15803d]'}`}
                      title={q.issues.map((one) => one.text).join('\n') || '质检通过'}>
                      <ShieldCheck size={10} className="mt-0.5 shrink-0" />
                      <span className="line-clamp-2">{q.issues.length ? q.issues[0].text : '质检通过'}{q.issues.length > 1 ? ` 等 ${q.issues.length} 项` : ''}</span>
                    </div>
                  );
                })() : null}
                {note ? (
                  <button type="button" onClick={() => onRead(output)}
                    className="flex w-full items-start gap-1.5 rounded-md bg-[var(--fill-tsp)] px-1.5 py-1 text-left text-[10.5px] leading-snug text-[var(--text-muted)] hover:text-[var(--text)]"
                    title={t('batch.analyze.timeline')}>
                    <Clock size={10} className="mt-0.5 shrink-0" />
                    <span className="line-clamp-2">{note.segments[0]?.text}</span>
                  </button>
                ) : null}
                <div className="mt-1 flex items-center gap-1">
                  <button type="button" onClick={() => onPreview(output)} className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-[var(--fill-tsp)] text-[11px] hover:bg-[var(--bg-hover)]"><Play size={11} />{t('batch.outputs.preview')}</button>
                  <button type="button" onClick={() => onAnalyze(output)} title={t('batch.analyze.local')}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--accent)]">
                    {analyzing ? <Loader2 size={12} className="animate-spin" /> : <ScanLine size={12} />}
                  </button>
                  <button type="button" onClick={() => onReveal(output)} title={t('batch.outputs.reveal')} className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]"><FolderOpen size={12} /></button>
                  <button type="button" onClick={() => onEdit(output)} title={t('batch.outputs.edit')} className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[var(--text)]"><Clapperboard size={12} /></button>
                  <button type="button" onClick={() => onDelete(output)} title={t('batch.outputs.delete')} className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--fill-tsp)] text-[var(--text-muted)] hover:text-[#b42318]"><Trash2 size={12} /></button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!outputs.length ? <p className="py-8 text-center text-[12px] text-[var(--text-faint)]">没有匹配的成片</p> : null}
    </div>
  );
}

/**
 * 内容时间线弹层：0:00-1.28s 画面描述，台词：xxx。
 * 只显示本机识别结果，可以复制成文案或审核素材。
 */
function NoteDialog({ title, note, onClose }: { title: string; note: BatchNote | null; onClose: () => void }) {
  const [copied, setCopied] = React.useState<'board' | 'csv' | null>(null);
  /* 分镜表：序号 / 起止 / 时长 / 画面 / 台词 / 标签。可以直接贴进 Excel、飞书表格或给 agent。 */
  const board = React.useCallback(() => {
    const rows = note?.segments ?? [];
    const head = '序号\t起止\t时长\t画面\t台词\t标签';
    const body = rows.map((seg, i) => [i + 1, `${startOf(seg.start)}-${startOf(seg.end)}`, (seg.end - seg.start).toFixed(2) + 's', seg.text, seg.speech ?? '', seg.tags.join('/')].join('\t'));
    return [head, ...body].join('\n');
  }, [note]);
  const copyBoard = async () => {
    const text = board();
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setCopied('board'); setTimeout(() => setCopied(null), 1600);
  };
  const downloadCsv = () => {
    const rows = note?.segments ?? [];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [['序号', '开始', '结束', '时长秒', '画面', '台词', '标签'].map(esc).join(',')];
    rows.forEach((seg, i) => lines.push([String(i + 1), startOf(seg.start), startOf(seg.end), (seg.end - seg.start).toFixed(2), seg.text, seg.speech ?? '', seg.tags.join('/')].map(esc).join(',')));
    /* 带 BOM，Excel 打开中文不乱码 */
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/\.[^.]+$/, '')}-分镜表.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setCopied('csv'); setTimeout(() => setCopied(null), 1600);
  };
  const t = useT();
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/70 p-8" onClick={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <ScanLine size={14} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{title}</div>
            <div className="text-[11px] text-[var(--text-faint)]">
              {t('batch.analyze.timeline')}
              {note ? ` · ${fmtTime(note.duration)} · ${new Date(note.analyzedAt).toLocaleString()}` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X size={15} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!note ? (
            <p className="py-10 text-center text-[12px] text-[var(--text-faint)]">{t('batch.analyze.empty')}</p>
          ) : (
            <>
            {note.quality ? (
              <div className={`mb-3 rounded-xl border px-3 py-2 text-[11.5px] leading-relaxed ${note.quality.ok ? 'border-[#22c55e]/30 bg-[#22c55e]/8 text-[#15803d]' : 'border-[#ef4444]/30 bg-[#ef4444]/8 text-[#b42318]'}`}>
                <div className="flex items-center gap-1.5 font-medium">
                  <ShieldCheck size={12} />
                  {note.quality.ok ? '成片质检通过' : '成片质检没通过'}
                  <span className="ml-auto font-normal text-[var(--text-faint)] tabular-nums">
                    {note.quality.metrics.width}x{note.quality.metrics.height} · {note.quality.metrics.duration.toFixed(2)}s
                    {note.quality.metrics.meanVolumeDb != null ? ` · ${note.quality.metrics.meanVolumeDb.toFixed(0)} dB` : ''}
                  </span>
                </div>
                {note.quality.issues.length ? (
                  <ul className="mt-1 list-disc pl-4">
                    {note.quality.issues.map((one, i) => <li key={i}>{one.text}</li>)}
                  </ul>
                ) : <p className="mt-1 text-[var(--text-muted)]">没有黑帧、静音、抖动或分辨率问题。</p>}
              </div>
            ) : null}
            <ol className="flex flex-col gap-2">
              {note.segments.map((seg, i) => (
                <li key={`${seg.start}-${i}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 rounded bg-[var(--fill-tsp)] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-[var(--text-muted)]">
                      {startOf(seg.start)}-{stampOf(seg.end)}s
                    </span>
                    {seg.tags.length ? (
                      <span className="flex flex-wrap gap-1">
                        {seg.tags.map((name) => (
                          <span key={name} className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">{name}</span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text)]">{seg.text}</p>
                  {seg.speech ? (
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                      <span className="text-[var(--text-faint)]">台词：</span>{seg.speech}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-faint)]">{t('batch.analyze.hint')}</span>
          {note?.segments.length ? (
            <>
              <button type="button" onClick={() => void copyBoard()} className={BTN_SOFT} title={t('batch.analyze.copyBoardHint')}>
                {copied === 'board' ? <Check size={13} /> : <ListChecks size={13} />}{copied === 'board' ? t('batch.analyze.copied') : t('batch.analyze.copyBoard')}
              </button>
              <button type="button" onClick={downloadCsv} className={BTN_SOFT} title={t('batch.analyze.csvHint')}>
                {copied === 'csv' ? <Check size={13} /> : <Download size={13} />}{t('batch.analyze.csv')}
              </button>
            </>
          ) : null}
          <button type="button" onClick={onClose} className={BTN_SOFT}>{t('batch.analyze.close')}</button>
        </div>
      </div>
    </div>
  );
}

function TemplatesPane({ presets, assets, onUse }: { presets: typeof PRESETS; assets: Asset[]; onUse: (id: string) => void }) {
  const t = useT();
  return (
    <div className="flex min-h-full flex-col gap-4">
      <p className="text-[11.5px] text-[var(--text-faint)]">{t('batch.templates.note')} 当前素材 {assets.length} 个。</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {presets.map((preset) => (
          <div key={preset.id} className="flex flex-col gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold">{t(`batch.presets.${preset.id}`)}</span>
              <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[10.5px] text-[var(--text-muted)]">{preset.aspect}</span>
            </div>
            <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">{preset.note}</p>
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1"><Clock size={11} />{t('batch.templates.duration').replace('{n}', String(preset.seconds))}</span>
              <span className="inline-flex items-center gap-1"><ChevronRight size={11} />{preset.pace}</span>
            </div>
            <button type="button" onClick={() => onUse(preset.id)} className={`${BTN_PRIMARY} mt-1`}><Wand2 size={13} />{t('batch.templates.apply')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 打标弹层：给选中的素材加标签、去掉标签，也能新建一个标签。
 * 改一个就立刻写盘（页面先变），关掉时不需要再点保存。
 */
function TagDialog({ paths, names, tags, tagIndex, onApply, onClose }: {
  paths: string[];
  names: string[];
  tags: Record<string, string[]>;
  tagIndex: Array<{ name: string; n: number }>;
  onApply: (add: string[], remove: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState('');
  /* 这组素材共同有的标签：点一下就去掉；不是全都有的，显示成“部分” */
  const shared = React.useMemo(() => {
    if (!paths.length) return [];
    return (tags[paths[0]!] ?? []).filter((name) => paths.every((path) => (tags[path] ?? []).includes(name)));
  }, [paths, tags]);
  const partial = React.useMemo(() => {
    const all = new Set(paths.flatMap((path) => tags[path] ?? []));
    return [...all].filter((name) => !shared.includes(name));
  }, [paths, tags, shared]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = (name: string) => {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    onApply([clean], []);
    setDraft('');
  };

  return (
    <div className="fixed inset-0 z-[10045] flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div className="flex w-full max-w-[460px] flex-col overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Tag size={14} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{t('batch.tags.dialog')}</div>
            <div className="truncate text-[11px] text-[var(--text-faint)]">
              {paths.length === 1 ? names[0] : t('batch.tags.chosen').replace('{n}', String(paths.length))}
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X size={15} /></button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3.5">
          <form onSubmit={(e) => { e.preventDefault(); add(draft); }} className="flex gap-1.5">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={24}
              placeholder={t('batch.tags.newPlaceholder')} autoFocus className={INPUT} />
            <button type="submit" disabled={!draft.trim()} className={BTN_PRIMARY}><Plus size={13} />{t('batch.tags.add')}</button>
          </form>

          {shared.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-faint)]">{t('batch.tags.on')}</span>
              <div className="flex flex-wrap gap-1.5">
                {shared.map((name) => (
                  <button key={name} type="button" onClick={() => onApply([], [name])}
                    className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-white"
                    style={{ background: tagColor(name) }} title={t('batch.tags.remove')}>
                    {name}<X size={11} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {partial.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-faint)]">{t('batch.tags.partial')}</span>
              <div className="flex flex-wrap gap-1.5">
                {partial.map((name) => (
                  <button key={name} type="button" onClick={() => onApply([name], [])}
                    className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]" title={t('batch.tags.addAll')}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(name) }} />{name}<Plus size={10} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {tagIndex.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-faint)]">{t('batch.tags.existing')}</span>
              <div className="flex max-h-[132px] flex-wrap gap-1.5 overflow-y-auto">
                {tagIndex.filter(({ name }) => !shared.includes(name)).map(({ name, n }) => (
                  <button key={name} type="button" onClick={() => onApply([name], [])}
                    className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(name) }} />{name}
                    <span className="tabular-nums opacity-50">{n}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end border-t border-[var(--border)] px-4 py-3">
          <button type="button" onClick={onClose} className={BTN_PRIMARY}>{t('batch.common.confirm')}</button>
        </div>
      </div>
    </div>
  );
}


















