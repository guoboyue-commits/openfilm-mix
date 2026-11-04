// @ts-check
/**
 * 混剪后台的本地识别：把素材或成片交给本机的 Python 脚本（local-analyze/analyze.py）。
 *
 * 只用本机能力：
 * - ffmpeg / ffprobe 取帧、看镜头切换和画面特征（亮度、清晰度、色彩、运动量）；
 * - faster-whisper 本地模型转写台词（不联网，不调用云端 API）。
 *
 * 输出一条时间线，例如：
 *   0:00-4.00s 中等亮度，清晰，主体居中中部，画面较稳
 *   4.00-8.00s 明亮，细节锐利，主体居中中部，画面较稳，台词：xxx
 *
 * 没装 faster-whisper 时仍会做画面识别（skip-speech），并告诉页面缺什么。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'local-analyze', 'analyze.py');
const WORK = join(HERE, 'local-analyze', '.work');
/** 依次试这些解释器；OPENFILM_PYTHON 可以指定自己的。 */
/** @type {string[]} */
const PYTHONS = [
  ...(process.env.OPENFILM_PYTHON ? [process.env.OPENFILM_PYTHON] : []),
  'C:\\Program Files\\Python311\\python.exe',
  'C:\\Program Files\\Python312\\python.exe',
  'C:\\Program Files\\Python310\\python.exe',
  'python',
];

/** 一次识别最多几条：9 条素材约 20 秒；一次太多会让页面等太久。 */
export const MAX_FILES = 24;
const TIMEOUT_MS = 30 * 60_000;
/** 识别默认用 small：同一条中文口播，base 会把「拓展视野」听成「拖展事业」，small 不会。 */
export const DEFAULT_MODEL = process.env.OPENFILM_WHISPER_MODEL || 'small';

/**
 * 本机已经下好的 Whisper 档位：读 Hugging Face 缓存里 model.bin 的大小，不联网。
 * 下了一半的模型也在缓存里，但 model.bin 是 0 字节或明显偏小，所以按大小判断。
 */
async function localModels() {
  const cache = process.env.HF_HUB_CACHE || join(homedir(), '.cache', 'huggingface', 'hub');
  const dirs = await readdir(cache, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !dir.name.startsWith('models--Systran--faster-whisper-')) continue;
    const size = await modelSize(join(cache, dir.name));
    /* 最小的 tiny 也有几十 MB；小于 1 MB 的只能是没下完的占位文件 */
    if (size > 1_000_000) found.push({ name: dir.name.replace('models--Systran--faster-whisper-', ''), bytes: size });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** 一个模型缓存的 model.bin 有多大（0 = 没下载完或没有）。 */
async function modelSize(/** @type {string} */ dir) {
  const snaps = await readdir(join(dir, 'snapshots'), { withFileTypes: true }).catch(() => []);
  let best = 0;
  for (const snap of snaps) {
    if (!snap.isDirectory()) continue;
    const info = await stat(join(dir, 'snapshots', snap.name, 'model.bin')).catch(() => null);
    if (info && info.size > best) best = info.size;
  }
  return best;
}

/** 找一个能用的 Python（装了 faster-whisper 的优先）。 */
export async function findPython() {
  for (const candidate of PYTHONS) {
    const ok = await new Promise((resolve) => {
      const proc = spawn(candidate, ['-c', 'import sys;print(sys.version)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0 && /^3\./.test(out.trim())));
    });
    if (ok) return candidate;
  }
  return null;
}

/** @type {{ at: number, value: Awaited<ReturnType<typeof probeStatus>> } | null} */
let STATUS_CACHE = null;
const STATUS_MS = 10 * 60_000;

/** 本机识别能不能用：Python、脚本、ffmpeg、Whisper 模型各说一句（结果缓存：导入 Whisper 很慢）。 */
export async function analyzeStatus() {
  if (STATUS_CACHE && Date.now() - STATUS_CACHE.at < STATUS_MS) return STATUS_CACHE.value;
  const value = await probeStatus();
  STATUS_CACHE = { at: Date.now(), value };
  return value;
}

async function probeStatus() {
  const python = await findPython();
  if (!python) return { ok: false, python: null, whisper: false, ffmpeg: existsSync('ffmpeg'), script: existsSync(SCRIPT),
    error: '没找到 Python 3；装一个 Python 3.10+，或把路径写进 OPENFILM_PYTHON' };
  const probe = await new Promise((resolve) => {
    /* 不直接 import：ctranslate2 首次加载要几十秒，查一下装没装、版本号就够 */
    const proc = spawn(python, ['-c', "import importlib.util,importlib.metadata as m;print(m.version('faster-whisper') if importlib.util.find_spec('faster_whisper') else '')"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: err.trim().split('\n').pop() || `exit ${code}` }));
  });
  return {
    ok: Boolean(python) && existsSync(SCRIPT),
    python,
    script: existsSync(SCRIPT),
    ffmpeg: await which('ffmpeg'),
    whisper: probe.ok,
    whisperVersion: probe.ok ? probe.version : null,
    model: DEFAULT_MODEL,
    models: probe.ok ? await localModels() : [],
    error: probe.ok ? null : `faster-whisper 没装好：${probe.error ?? ''}。可以先只做画面识别，或 pip install faster-whisper`,
  };
}

function which(/** @type {string} */ name) {
  return new Promise((resolve) => {
    const proc = spawn(name, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * 常驻识别进程：Python 只启动一次，Whisper 模型只加载一次。
 * 一行一个请求/事件（JSON），同一时间只跑一批；进程挂了下一批自动重启。
 */
/**
 * @typedef {{ id?: string, type: string, path?: string, ok?: boolean, error?: string, result?: any }} AnalyzeEvent
 * @typedef {{ onProgress?: (one: AnalyzeEvent) => void, done: (r: { ok: boolean, result?: any, error?: string }) => void }} Waiting
 * @typedef {{ proc: import('node:child_process').ChildProcess, lines: import('node:readline').Interface, pending: Map<string, Waiting>, stderr: string, alive: boolean }} Resident
 */
/** @type {Resident | null} */
let RESIDENT = null;

function residentEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
}

/** 启动常驻进程（已经在跑就直接用）。 */
async function resident() {
  if (RESIDENT?.alive) return RESIDENT;
  const python = await findPython();
  if (!python) throw new Error('没找到 Python 3；装一个 Python 3.10+，或把路径写进 OPENFILM_PYTHON');
  if (!existsSync(SCRIPT)) throw new Error('本地识别脚本不在：studio/server/local-analyze/analyze.py');
  const proc = spawn(python, [SCRIPT, '--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: residentEnv() });
  /** @type {Resident} */
  const state = { proc, lines: createInterface({ input: proc.stdout }), pending: new Map(), stderr: '', alive: true };
  proc.stderr?.on('data', (d) => { state.stderr = (state.stderr + d).slice(-4000); });
  state.lines.on('line', (/** @type {string} */ line) => {
    /** @type {AnalyzeEvent} */
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event.id) return;
    const one = state.pending.get(event.id);
    if (!one) return;
    if (event.type === 'progress') one.onProgress?.(event);
    else if (event.type === 'done' || event.type === 'error') {
      state.pending.delete(event.id);
      one.done(event.type === 'done' ? { ok: true, result: event.result } : { ok: false, error: event.error });
    }
  });
  const fail = (/** @type {string} */ why) => {
    state.alive = false;
    if (RESIDENT === state) RESIDENT = null;
    for (const [id, one] of state.pending) {
      state.pending.delete(id);
      one.done({ ok: false, error: why });
    }
  };
  proc.on('error', (e) => fail(e.message));
  proc.on('close', (code) => fail(state.stderr.trim().split('\n').slice(-2).join(' ') || `本地识别进程退出（${code}）`));
  RESIDENT = state;
  return state;
}

/** Studio 关闭时把常驻进程一起结束。 */
export function stopAnalyzer() {
  const state = RESIDENT;
  RESIDENT = null;
  if (!state) return;
  state.alive = false;
  try { state.proc.stdin?.end(); state.proc.kill(); } catch { /* 已经没了 */ }
}

/**
 * 识别一组文件。`files`: [{ path: 绝对路径, rel: 页面上的路径 }]。
 * `onProgress(rel)` 每识别完一条就回调一次。
 * 返回 { results: [{ path, rel, ok, segments, tags, duration, speech }], error? }。
 */
export async function analyzeFiles(/** @type {Array<{ path: string, rel: string }>} */ files, /** @type {{ model?: string, language?: string, skipSpeech?: boolean, minShot?: number, quality?: boolean, onProgress?: (rel: string) => void }} */ options = {}) {
  if (!files.length) return { results: [] };
  await slot();
  try {
    const state = await resident();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const byPath = new Map(files.map((f) => [f.path, f.rel]));
    const answer = await new Promise((/** @type {(r: { ok: boolean, result?: any, error?: string }) => void} */ resolve) => {
      const timer = setTimeout(() => { state.pending.delete(id); resolve({ ok: false, error: '本地识别超时（30 分钟）' }); }, TIMEOUT_MS);
      state.pending.set(id, {
        onProgress: (event) => { const rel = event.path ? byPath.get(event.path) : null; if (rel) options.onProgress?.(rel); },
        done: (/** @type {{ ok: boolean, result?: any, error?: string }} */ r) => { clearTimeout(timer); resolve(r); },
      });
      const ask = { id, jobs: files.map((f) => ({ path: f.path })), language: options.language, model: options.model || DEFAULT_MODEL, skipSpeech: options.skipSpeech === true, ...(options.minShot ? { minShot: options.minShot } : {}), ...(options.quality === false ? { quality: false } : {}) };
      state.proc.stdin?.write(JSON.stringify(ask) + '\n');
    });
    if (!answer.ok) return { results: [], error: answer.error };
    const parsed = answer.result;
    if (!parsed?.ok) return { results: [], error: parsed?.error ?? '识别失败' };
    const results = (parsed.results ?? []).map((/** @type {any} */ one) => ({
      path: one.path,
      rel: byPath.get(one.path) ?? one.path,
      ok: one.ok !== false,
      error: one.error ?? null,
      segments: one.segments ?? [],
      tags: aggregateTags(one.segments ?? []),
      duration: one.duration ?? null,
      language: one.language ?? null,
      hasSpeech: one.hasSpeech === true || (Array.isArray(one.speech) && one.speech.length > 0),
      speech: one.speech ?? [],
      quality: one.quality ?? null,
    }));
    return { results };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
  }
}

/**
 * 只做台词：把一条配音（或任意音频）转成逐句 {text,start,end}，给字幕用。
 *
 * 旧版本生成的配音没有 wav 旁边的 .cues.json，烧字幕时会先调它现场对齐一次。
 * 走常驻识别进程，Whisper 模型只加载一次；只读音频、不抽帧。
 * @param {string} file 音频绝对路径
 * @param {{ language?: string, model?: string }} [options]
 */
export async function transcribeCues(/** @type {string} */ file, /** @type {{ language?: string, model?: string }} */ options = {}) {
  const python = await findPython();
  if (!python) throw new Error('没找到 Python 3；装一个 Python 3.10+，或把路径写进 OPENFILM_PYTHON');
  if (!existsSync(SCRIPT)) throw new Error('本地识别脚本不在：studio/server/local-analyze/analyze.py');
  const args = [SCRIPT, file, '--cues', '--language', options.language || 'zh', '--model', options.model || DEFAULT_MODEL];
  const out = await new Promise((/** @type {(r: { code: number | null, stdout: string, stderr: string }) => void} */ resolve) => {
    const proc = spawn(python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: residentEnv() });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (out.code !== 0) throw new Error(`本地转写失败：${out.stderr.trim().split('\\n').slice(-2).join(' ') || `exit ${out.code}`}`);
  /** @type {{ ok?: boolean, error?: string, cues?: Array<{ text: string, start: number, end: number }> }} */
  let parsed;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    throw new Error(`本地转写返回的不是 JSON：${out.stdout.slice(0, 200)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || '本地转写失败');
  return (parsed.cues ?? []).filter((/** @type {any} */ cue) => cue && typeof cue.text === 'string' && Number(cue.end) > Number(cue.start));
}
/** 从每段的小标签里汇总整条素材的标签（按出现次数，最多 6 个）。 */
export function aggregateTags(/** @type {Array<{ tags?: string[] }>} */ segments) {
  const count = new Map();
  for (const seg of segments) for (const name of seg.tags ?? []) count.set(name, (count.get(name) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([name]) => name).slice(0, 6);
}

/** `0:00-1.28s` 这样的时间戳，页面和导出都用它。 */
export function stamp(/** @type {number} */ seconds) {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

