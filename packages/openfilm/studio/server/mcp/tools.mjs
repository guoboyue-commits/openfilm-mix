// @ts-check
/**
 * 混剪后台的本地 MCP 工具表：外部 agent（Codex / Claude Desktop / Cursor）和后台内置 agent 共用这一份。
 *
 * 工具只做本机的事：读素材库、本地识别（ffmpeg + faster-whisper）、打标签、生成混剪工程、导出成片。
 * 不联网，也不接受项目外的任意路径：素材必须是素材库工程里的相对路径，成片必须是 Studio 自己导出过的。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listProjects } from '../projects.mjs';
import { bringIn, listFiles, readable } from '../files.mjs';
import { probe } from '../derived.mjs';
import { analyzeFiles, analyzeStatus, transcribeCues, MAX_FILES } from '../batch-analyze.mjs';
import { readNotes, saveNotes } from '../batch-notes.mjs';
import { readTags, setTags } from '../batch-tags.mjs';
import { listHistory } from '../export-history.mjs';
import { planMix, planContentMix, planMixBatch, mixFreshOps } from '../mix-plan.mjs';
import { editProjectFilm, readProjectFilm } from '../film.mjs';
import { burnSubtitles } from './subtitle.mjs';
import * as voiceMode from '../voice-mode.mjs';
import { synthesizeWithProvider } from '../voice-api.mjs';

export const LIBRARY_NAME = '混剪素材库';
export const MIX_LIBRARY_NAME = '混剪成片';

const MEDIA = /\.(mp4|mov|webm|m4v|mkv|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac|flac)$/i;

/** 找工程：id 或名字；`create` 时没有就建一个。 */
export async function findProject(/** @type {string | undefined} */ which, { create = false, name = LIBRARY_NAME } = {}) {
  const projects = await listProjects();
  const found = which
    ? projects.find((p) => !p.missing && (p.id === which || p.name === which))
    : projects.find((p) => !p.missing && p.name === name);
  if (found) return found;
  if (!create) throw new Error(`没有找到工程：${which ?? name}`);
  const { createProject } = await import('../projects.mjs');
  return createProject(name);
}

/** 素材库里的素材（视频/图片/声音），带时长、尺寸、标签和是否识别过。 */
export async function listAssets(/** @type {string} */ projectId) {
  const project = await findProject(projectId);
  const listing = await listFiles(project.path);
  const tags = await readTags(project.path);
  const notes = await readNotes(project.path);
  const files = listing.files.filter((file) => MEDIA.test(file.path) && !file.path.startsWith('.'));
  const assets = [];
  for (const file of files) {
    /** @type {Record<string, any>} */
    let facts = {};
    try { facts = await probe(project.path, file.path); } catch { /* 读不了的素材也列出来 */ }
    assets.push({
      path: file.path,
      name: basename(file.path),
      kind: file.kind,
      bytes: file.size,
      mtime: file.mtime,
      seconds: facts.duration ?? null,
      width: facts.width ?? null,
      height: facts.height ?? null,
      fps: facts.fps ?? null,
      audio: facts.audio ?? false,
      tags: tags[file.path] ?? [],
      analyzed: Boolean(notes[file.path]),
      segments: notes[file.path]?.segments.length ?? 0,
      speech: notes[file.path]?.hasSpeech ?? false,
    });
  }
  return { project: { id: project.id, name: project.name, path: project.path }, assets };
}

/** 素材的识别时间线：`0:00-1.28s 画面描述` + `台词：…`。 */
export async function getTimeline(/** @type {string} */ projectId, /** @type {string[]} */ paths) {
  const project = await findProject(projectId);
  const notes = await readNotes(project.path);
  const wanted = paths?.length ? paths : Object.keys(notes);
  return wanted.map((path) => ({ path, note: notes[path] ?? null, text: notes[path] ? timelineText(notes[path]) : null }));
}

export function timelineText(/** @type {{ segments: Array<{ start: number, end: number, text: string, speech: string | null }> }} */ note) {
  return note.segments.map((seg) => {
    /* 起止用同一套 `m:ss.cc` 时间码：超过 60 秒时纯秒数会和分钟制混在一行，读不出是第几秒 */
    const line = `${clock(seg.start)}-${clock(seg.end)}s ${seg.text}`;
    return seg.speech ? `${line}\n台词：${seg.speech}` : line;
  }).join('\n');
}

/**
 * 分镜表：把识别结果排成表 —— 序号 / 起止 / 时长 / 画面 / 台词 / 标签。
 * md 给人看，csv 给 Excel 和飞书表格，tsv 直接喂给 agent。
 * 一份表可以跨多条素材，每条的段落各归各的，序号在条内从 1 开始。
 */
/** @param {string} projectId @param {string[]} paths @param {'md' | 'csv' | 'tsv'} [format] */
export async function shotList(projectId, paths, format = 'md') {
  const project = await findProject(projectId);
  const notes = await readNotes(project.path);
  const wanted = (paths?.length ? paths : Object.keys(notes)).filter((path) => notes[path]);
  const files = wanted.map((path) => ({
    path,
    name: path.split('/').pop() ?? path,
    duration: notes[path].duration ?? 0,
    analyzedAt: notes[path].analyzedAt ?? null,
    segments: notes[path].segments ?? [],
  }));
  const total = files.reduce((sum, file) => sum + (file.duration || 0), 0);
  const rows = files.flatMap((file) => file.segments.map((/** @type {{ start: number, end: number, text?: string, speech?: string | null, tags?: string[] }} */ seg, /** @type {number} */ index) => ({
    file: file.name,
    index: index + 1,
    start: clock(seg.start),
    end: clock(seg.end),
    seconds: (Math.max(0, seg.end - seg.start)).toFixed(2),
    text: seg.text ?? '',
    speech: seg.speech ?? '',
    tags: (seg.tags ?? []).join('/'),
  })));
  const text = format === 'csv' ? shotListCsv(rows)
    : format === 'tsv' ? shotListDelimited(rows, '\t')
    : shotListMarkdown(project, files, rows, total);
  return { project: { id: project.id, name: project.name }, files, rows, text, seconds: Number(total.toFixed(2)) };
}

/** 分镜表表格文本：csv 带 BOM，Excel 打开中文不乱码。 @param {ShotRow[]} rows */
function shotListCsv(rows) {
  return '\uFEFF' + shotListDelimited(rows, ',');
}

/**
 * @typedef {object} ShotRow 分镜表的一行
 * @property {string} file @property {number} index @property {string} start @property {string} end
 * @property {string} seconds @property {string} text @property {string} speech @property {string} tags
 */
/**
 * @typedef {object} ShotFile 分镜表里的一条素材
 * @property {string} path @property {string} name @property {number} duration
 * @property {number | null} analyzedAt
 * @property {Array<{ start: number, end: number, text?: string, speech?: string | null, tags?: string[] }>} segments
 */
const SHOT_HEAD = ['文件', '序号', '开始', '结束', '时长秒', '画面', '台词', '标签'];

/** @param {ShotRow[]} rows @param {string} sep */
function shotListDelimited(rows, sep) {
  const esc = (/** @type {unknown} */ value) => {
    const raw = String(value ?? '');
    return sep === ',' ? `"${raw.replace(/"/g, '""')}"` : raw.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  };
  const lines = [SHOT_HEAD.map(esc).join(sep)];
  for (const row of rows) {
    lines.push([row.file, row.index, row.start, row.end, row.seconds, row.text, row.speech, row.tags].map(esc).join(sep));
  }
  return lines.join('\r\n');
}

/** md 版：标题 + 一条素材一个小节一张表，可以直接贴进文档或 PR。 */
/** @param {{ name: string }} project @param {ShotFile[]} files @param {ShotRow[]} rows @param {number} total */
function shotListMarkdown(project, files, rows, total) {
  const cell = (/** @type {unknown} */ value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') || '—';
  const out = [];
  out.push(`# 分镜表 · ${project.name}`);
  out.push('');
  out.push(`${files.length} 个文件 · 总时长 ${clock(total)} · ${rows.length} 段`);
  for (const file of files) {
    out.push('');
    out.push(`## ${file.name}`);
    out.push('');
    out.push(`${clock(file.duration)} · ${file.segments.length} 段`);
    out.push('');
    out.push('| # | 起止 | 时长 | 画面 | 台词 | 标签 |');
    out.push('|---|---|---|---|---|---|');
    for (const row of rows.filter((one) => one.file === file.name)) {
      out.push(`| ${row.index} | ${row.start}-${row.end}s | ${row.seconds}s | ${cell(row.text)} | ${cell(row.speech)} | ${cell(row.tags)} |`);
    }
  }
  return out.join('\n');
}
/** 时间码：0:00.00 / 0:02.67 / 1:28.50（0.01 秒级，和成片质检的 bebug 时间一致）。 */
const clock = (/** @type {number} */ seconds) => {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const rest = Math.round((t - m * 60) * 100) / 100;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
};

/** 本地识别：结果写进素材库 .film/batch-notes.json，并把标签并进 batch-tags.json。 */
/** @param {string} projectId @param {string[]} paths @param {{ applyTags?: boolean, skipSpeech?: boolean, onProgress?: (rel: string) => void }} [options] */
export async function analyzeAssets(projectId, paths, { applyTags = true, skipSpeech = false, onProgress } = {}) {
  const project = await findProject(projectId);
  const listing = await listFiles(project.path);
  const known = new Set(listing.files.map((file) => file.path));
  const wanted = (paths?.length ? paths : listing.files.filter((file) => MEDIA.test(file.path)).map((file) => file.path))
    .filter((path) => known.has(path) && /\.(mp4|mov|webm|m4v|mkv|mp3|wav|m4a|aac|flac)$/i.test(path))
    .slice(0, MAX_FILES);
  if (!wanted.length) throw new Error('没有可识别的视频或声音；先 list_assets 看素材路径');
  const status = await analyzeStatus();
  const found = await analyzeFiles(wanted.map((rel) => ({ path: readable(project.path, rel), rel })), {
    skipSpeech: skipSpeech || !status.whisper,
    onProgress,
  });
  const good = found.results.filter((/** @type {any} */ one) => one.ok && one.segments.length);
  const saved = await saveNotes(project.path, good.map((/** @type {any} */ one) => ({
    path: one.rel, segments: one.segments, tags: one.tags, duration: one.duration, language: one.language, hasSpeech: one.hasSpeech, engine: 'local', quality: one.quality,
  })));
  let tags = await readTags(project.path);
  if (applyTags && good.length) {
    const next = { ...tags };
    for (const one of good) {
      const names = new Set(next[one.rel] ?? []);
      for (const name of one.tags) names.add(name);
      next[one.rel] = [...names].slice(0, 12);
    }
    tags = await setTags(project.path, { all: next });
  }
  return {
    project: project.id,
    analyzed: good.length,
    failed: found.results.filter((/** @type {any} */ one) => !one.ok).map((/** @type {any} */ one) => ({ path: one.rel, error: one.error })),
    speech: status.whisper,
    results: found.results.map((/** @type {any} */ one) => ({ path: one.rel, ok: one.ok, tags: one.tags, segments: one.segments.length, note: saved[one.rel] ?? null })),
    tags,
  };
}

/** 改标签：add / remove / set。 */
export async function tagAssets(/** @type {string} */ projectId, /** @type {string[]} */ paths, /** @type {string[]} */ names, mode = 'add') {
  const project = await findProject(projectId);
  const listing = await listFiles(project.path);
  const known = new Set(listing.files.map((file) => file.path));
  const wanted = (paths ?? []).filter((/** @type {string} */ path) => known.has(path));
  if (!wanted.length) throw new Error('没有这些素材；先 list_assets 看路径');
  /* 拼接出来的脏标签（含逗号/顿号 + 的素材）直接拒掉，别写进素材库 */
  const clean = (names ?? []).filter((name) => typeof name === 'string' && name.trim() && !/[、，,]\s*的素材/.test(name)).map((name) => name.trim().slice(0, 24));
  if (!clean.length) throw new Error('要打什么标签？');
  const tags = await readTags(project.path);
  for (const path of wanted) {
    const have = new Set(tags[path] ?? []);
    if (mode === 'set') have.clear();
    for (const name of clean) {
      if (mode === 'remove') have.delete(name); else have.add(name);
    }
    if (have.size) tags[path] = [...have].slice(0, 12); else delete tags[path];
  }
  const saved = await setTags(project.path, { all: tags });
  return { project: project.id, tagged: wanted.length, tags: saved };
}

/** 成片质检：黑帧、静音、时长、抖动、分辨率（ffmpeg 本地算，0.01 秒级定位）。 */
async function inspectOutput(/** @type {string} */ file) {
  const { spawn } = await import('node:child_process');
  const probe = await new Promise((/** @type {(v: any) => void} */ resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { windowsHide: true });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
  if (!probe) return null;
  const duration = Number(probe.format?.duration) || 0;
  const video = (probe.streams ?? []).find((/** @type {any} */ one) => one.codec_type === 'video') ?? {};
  const hasAudio = (probe.streams ?? []).some((/** @type {any} */ one) => one.codec_type === 'audio');
  const meanDb = hasAudio ? await meanVolume(file) : null;
  /** @type {Array<{ code: string, level: string, at?: number, span?: number, text: string }>} */
  const issues = [];
  if (!hasAudio) issues.push({ code: 'no-audio', level: 'warn', text: '这条成片没有音轨' });
  else if (meanDb !== null && meanDb < -50) issues.push({ code: 'silent', level: 'warn', text: `整条几乎没声音（平均 ${meanDb.toFixed(1)} dB）` });
  if (duration < 1) issues.push({ code: 'too-short', level: 'error', text: `只有 ${duration.toFixed(2)}s，太短` });
  if (video.width && video.height && Math.min(video.width, video.height) < 720) {
    issues.push({ code: 'low-res', level: 'warn', text: `分辨率偏低：${video.width}x${video.height}` });
  }
  return {
    ok: !issues.some((one) => one.level === 'error'),
    issues,
    metrics: { duration: Math.round(duration * 100) / 100, width: video.width ?? null, height: video.height ?? null, hasAudio, meanVolumeDb: meanDb },
  };
}

/** 整条音轨的平均音量（dB）。 */
function meanVolume(/** @type {string} */ file) {
  return new Promise((/** @type {(v: number | null) => void} */ resolve) => {
    void import('node:child_process').then(({ spawn }) => {
      const proc = spawn('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d; });
      proc.on('error', () => resolve(null));
      proc.on('close', () => {
        const hit = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
        resolve(hit ? Number(hit[1]) : null);
      });
    });
  });
}

/** 一条成片对应哪个工程（成片路径 → 工程 id）。 */
export async function ownerOfOutput(/** @type {string} */ file) {
  const outputs = await listHistory();
  const hit = outputs.find((one) => one.path === file);
  return hit ? { project: hit.project, projectName: hit.projectName, name: hit.name } : null;
}

/**
 * 成片的内容描述 + 质检：本机 ffmpeg 抽帧 + faster-whisper 转写，
 * 时间线精确到 0.01 秒（0:00.00-1.28s 画面描述 / 台词：…），并给出黑帧、静音、时长、抖动、分辨率。
 * 结果存进成片所属工程的 .film/batch-notes.json，和素材共用同一份时间线格式。
 */
export async function analyzeOutputs(/** @type {string[]} */ files, { skipSpeech = false, minShot = 0.6, limit = 0 } = {}) {
  let wanted = [...new Set((files ?? []).filter((/** @type {any} */ f) => typeof f === 'string' && f))];
  /* 没指定成片时默认看最近 3 条：识别很慢，不能一口气把历史成片全跑一遍 */
  if (!wanted.length) wanted = (await listHistory()).slice(0, 3).map((/** @type {any} */ one) => one.path);
  if (!wanted.length) throw new Error('analyze_outputs: 先 list_outputs，再传成片路径');
  if (Number(limit) > 0) wanted = wanted.slice(0, Number(limit));
  /** @type {Array<{ path: string, rel: string, project: string }>} */
  const jobs = [];
  for (const file of wanted) {
    if (!existsSync(file)) throw new Error(`成片不存在：${file}`);
    const owner = await ownerOfOutput(file);
    if (!owner) throw new Error(`这条不是 Studio 导出的成片：${file}`);
    jobs.push({ path: file, rel: file, project: owner.project });
  }
  const status = await analyzeStatus();
  /* 成片质检和“内容描述”分开跑：质检要整条音轨的平均音量，不能被剪短 */
  const found = await analyzeFiles(jobs.map((one) => ({ path: one.path, rel: one.rel })), { skipSpeech: skipSpeech || !status.whisper, minShot, quality: true });
  for (const one of found.results) {
    const quality = await inspectOutput(one.path);
    /* 黑帧可能不止一处：把整条片子扫出来的都带上，不只第一条 */
    const blacks = (one.quality?.issues ?? []).filter((/** @type {any} */ issue) => issue.code === 'black');
    if (quality && blacks.length) {
      for (const black of blacks) {
        if (quality.issues.some((/** @type {any} */ issue) => issue.code === 'black' && issue.at === black.at)) continue;
        quality.issues.push(black);
      }
      quality.issues.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.at ?? 0) - (b.at ?? 0));
      quality.ok = false;
    }
    if (quality && one.quality?.metrics) quality.metrics = { ...quality.metrics, ...one.quality.metrics, meanVolumeDb: quality.metrics.meanVolumeDb };
    one.quality = quality;
  }
  const good = found.results.filter((/** @type {any} */ one) => one.ok && one.segments.length);
  /** @type {Record<string, any>} */
  const notes = {};
  for (const one of good) {
    const job = jobs.find((j) => j.rel === one.rel);
    if (!job) continue;
    const project = await findProject(job.project);
    const saved = await saveNotes(project.path, [{
      path: one.rel, segments: one.segments, tags: one.tags, duration: one.duration,
      language: one.language, hasSpeech: one.hasSpeech, engine: 'local', quality: one.quality,
    }]);
    notes[one.rel] = saved[one.rel] ?? null;
  }
  return {
    analyzed: good.length,
    failed: found.results.filter((/** @type {any} */ one) => !one.ok).map((/** @type {any} */ one) => ({ path: one.rel, error: one.error })),
    results: found.results.map((/** @type {any} */ one) => ({
      path: one.rel,
      ok: one.ok,
      quality: one.quality ?? null,
      segments: one.segments.length,
      text: notes[one.rel] ? timelineText(notes[one.rel]) : null,
      note: notes[one.rel] ?? null,
    })),
  };
}

/** 成片：Studio 导出过的视频，新到旧。 */
export async function listOutputs() {
  const outputs = await listHistory();
  return outputs.map((one) => ({ project: one.project, projectName: one.projectName, path: one.path, name: one.name, bytes: one.bytes, at: one.at, label: one.label }));
}

const ASPECTS = { '9:16': { w: 1080, h: 1920 }, '16:9': { w: 1920, h: 1080 }, '1:1': { w: 1080, h: 1080 }, '4:3': { w: 1080, h: 1440 } };

/**
 * 生成混剪：素材库 → 每个成片一个工程（film.html 时间线），返回可继续导出/精修的工程。
 * 只写工程，不渲染视频；渲染由 Studio 的导出队列做（UI 或 export_film 工具）。
 */
/** @param {string} projectId @param {Record<string, any>} [options] */
export async function generateMix(projectId, options = {}) {
  const project = await findProject(projectId);
  const listing = await listFiles(project.path);
  const wanted = new Set((options.paths ?? []).filter((/** @type {any} */ path) => typeof path === 'string'));
  const files = listing.files.filter((file) => MEDIA.test(file.path) && (!wanted.size || wanted.has(file.path)));
  /** @type {Array<{ path: string, name: string, kind: string, durationMs?: number, w?: number, h?: number }>} */
  const assets = [];
  for (const file of files) {
    const facts = await probe(project.path, file.path).catch(() => ({}));
    assets.push({ path: file.path, name: basename(file.path), kind: file.kind, durationMs: facts.duration ? Math.round(facts.duration * 1000) : undefined, w: facts.width, h: facts.height });
  }
  if (!assets.some((asset) => asset.kind === 'video' || asset.kind === 'image')) throw new Error('素材库里没有可用的视频或图片');
  /* 给了配音但没给时长：自己量一下，画面按配音铺满，不用调用方再算 */
  const voicePath = typeof options.voice === 'string' ? options.voice.trim() : '';
  if (voicePath && options.voiceMatch === true && !(Number(options.voiceSeconds) > 0)) {
    const facts = await probe(project.path, voicePath).catch(() => null);
    if (facts && Number(facts.duration) > 0) options = { ...options, voiceSeconds: Number(facts.duration) };
  }
  const aspect = ASPECTS[/** @type {keyof typeof ASPECTS} */ (options.aspect ?? '9:16')] ?? ASPECTS['9:16'];
  const base = {
    targetSeconds: Number(options.seconds) > 0 ? Number(options.seconds) : 20,
    minShotSeconds: 1.2, maxShotSeconds: 3.6,
    pace: options.pace === 'fast' || options.pace === 'slow' ? options.pace : 'normal',
    avoidRepeat: 3, shuffle: true, seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : Date.now() % 900000,
    stage: aspect, fps: 30,
    /* 有配音时以配音时长为准，画面按它铺满 */
    ...(Number(options.voiceSeconds) > 0 ? { voiceSeconds: Number(options.voiceSeconds) } : {}),
  };
  const count = Math.max(1, Math.min(12, Math.floor(Number(options.count) || 1)));
  /* 按内容选段：把识别出的分镜段落当可选段落，而不是随机抽一段画面。
     query 是关键词数组（命中台词/画面/标签的段排前面），shotSeconds 限制每段取多长。 */
  let plans;
  let content = null;
  if (options.useTimeline === true) {
    const notes = await readNotes(project.path);
    /** @type {Array<{ src: string, from: number, to: number, text: string, speech: string, tags: string[] }>} */
    const shots = [];
    for (const asset of assets) {
      const note = notes[asset.path];
      if (!note?.segments?.length) continue;
      for (const seg of note.segments) {
        if (!(Number(seg.end) > Number(seg.start))) continue;
        shots.push({ src: asset.path, from: Number(seg.start), to: Number(seg.end), text: seg.text ?? '', speech: seg.speech ?? '', tags: Array.isArray(seg.tags) ? seg.tags : [] });
      }
    }
    if (!shots.length) throw new Error('素材还没有识别结果：先跑 analyze_assets（useTimeline 需要分镜时间线）');
    const contentBase = {
      ...base, shots, query: Array.isArray(options.query) ? options.query : [], avoidRepeat: 2,
      ...(Number(options.shotSeconds) > 0 ? { shotSeconds: Number(options.shotSeconds) } : {}),
    };
    content = { shots: shots.length, query: contentBase.query };
    plans = count === 1
      ? [planContentMix(assets, contentBase)]
      : Array.from({ length: count }, (_, i) => planContentMix(assets, { ...contentBase, seed: contentBase.seed + i * 7919 }));
  } else {
    plans = count === 1 ? [planMix(assets, base)] : planMixBatch(assets, base, count);
  }
  const { createProject } = await import('../projects.mjs');
  const stamp = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const prefix = String(options.name ?? '').trim() || `混剪 ${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const made = [];
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    const name = plans.length === 1 ? prefix : `${prefix}-${pad(i + 1)}`;
    const target = await createProject(name);
    /* 成片工程带上自己的一份素材：搬走、换电脑也完整；素材库删了也不影响成片 */
    await bringIn(target.path, 'assets', [...new Set(plan.segments.map((segment) => readable(project.path, segment.src)))], 'copy');
    /* 配音：素材库里的 wav 一起搬进成片工程，铺在画面轨下面，从 0 秒开始 */
    const voice = typeof options.voice === 'string' ? options.voice.trim() : '';
    let voiceLanded = '';
    if (voice && listing.files.some((file) => file.path === voice)) {
      const [copied] = await bringIn(target.path, 'assets', [readable(project.path, voice)], 'copy');
      voiceLanded = copied ? `assets/${basename(copied)}` : '';
    }
    const film = await readProjectFilm(target.path);
    const ops = /** @type {any[]} */ (mixFreshOps(plan));
    if (voiceLanded) ops.push({ op: 'insert', clip: { src: voiceLanded, at: 0 }, track: { insert: 1 } });
    await editProjectFilm(target.path, film.rev, ops);
    made.push({ project: target.id, name: target.name, seconds: plan.durationSeconds, shots: plan.shots, seed: plan.options.seed, used: plan.used, voice: voiceLanded || null });
  }
  return { library: project.id, made, exported: [], ...(content ? { content } : {}) };
}

/** 本地配音服务：CosyVoice2 常驻在 127.0.0.1:9880（本机 9880 端口），不联网。 */
const TTS_ORIGIN = (process.env.OPENFILM_TTS_URL || 'http://127.0.0.1:9880').replace(/\/+$/, '');

/** 本地配音服务活着没有、模型加载到哪了。 */
export async function ttsStatus() {
  try {
    const res = await fetch(`${TTS_ORIGIN}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, origin: TTS_ORIGIN, error: `HTTP ${res.status}` };
    const health = await res.json();
    const list = await ttsVoices();
    return { ok: true, origin: TTS_ORIGIN, ...health, defaultVoice: list.default || health.voice || null, voices: list.voices || [] };
  } catch (e) {
    return { ok: false, origin: TTS_ORIGIN, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 可选音色清单。服务没开时返回空列表，别让前端卡住。 */
export async function ttsVoices() {
  try {
    const res = await fetch(`${TTS_ORIGIN}/voices`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, origin: TTS_ORIGIN, default: null, voices: [] };
    return { ok: true, origin: TTS_ORIGIN, ...(await res.json()) };
  } catch (e) {
    return { ok: false, origin: TTS_ORIGIN, default: null, voices: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 配音：一段台词 → 素材库 assets/voice/ 里的一条音频，返回路径、真实时长和逐句 cues。
 * 两个来源共用这一套落盘与时长校验：
 *   local —— 本机 CosyVoice2（127.0.0.1:9880），带逐句时间轴；
 *   api   —— 设置里已连接的云端服务商（OpenAI / ElevenLabs / Google / Groq / Azure）。
 * 模式默认取 ~/.openfilm/voice.json；调用时传 mode 可以只对这一条生效，不改变保存的设置。
 */
export async function makeVoice(/** @type {string} */ projectId, /** @type {{ text?: string, name?: string, voice?: string, speed?: number, pause?: number, verify?: boolean, natural?: boolean, mode?: 'local' | 'api', provider?: string, model?: string }} */ options = {}) {
  const said = String(options.text ?? '').replace(/\s+/g, ' ').trim();
  if (!said) throw new Error('make_voice: 要说什么？传 text');
  if (said.length > 800) throw new Error(`make_voice: 一次最多 800 字，这段有 ${said.length} 字，拆成几段`);
  const project = await findProject(projectId);
  const at = Date.now();
  const saved = await voiceMode.readVoiceSettings();
  const mode = options.mode === 'api' ? 'api' : options.mode === 'local' ? 'local' : saved.mode;
  /** @type {{ bytes: Uint8Array, ext: string, seconds: number | null, cues: Array<{ text: string, start: number, end: number }> | null,
   *   engine: string, voice: string | null, model?: string | null, sentences: number | null, score: number | null,
   *   report: Array<{ text: string, score: number, tries: number }> | null, warnings: string[], natural?: boolean }} */
  let made;
  if (mode === 'api') {
    const api = await synthesizeWithProvider({
      text: said,
      name: options.name || 'voice',
      voice: options.voice ?? saved.voice,
      provider: options.provider ?? saved.provider,
      model: options.model ?? saved.model,
      root: project.path,
    });
    made = {
      bytes: api.bytes,
      ext: api.ext || 'wav',
      seconds: api.seconds,
      cues: api.cues,
      engine: `api:${api.provider}`,
      voice: api.voice,
      model: api.model,
      sentences: api.cues?.length ?? null,
      score: null,
      report: null,
      warnings: [],
    };
  } else {
    let res;
    let said_json;
    let bytes;
    try {
      /* 走 /tts-file：服务端直接落盘并回结构化结果，cues 不再挤在响应头里被 4000 字符截断 */
      res = await fetch(`${TTS_ORIGIN}/tts-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: said,
          natural: options.natural !== false,
          ...(options.voice ? { voice: String(options.voice) } : {}),
          ...(Number(options.speed) > 0 ? { speed: Number(options.speed) } : {}),
          ...(Number.isFinite(Number(options.pause)) ? { pause: Number(options.pause) } : {}),
          ...(options.verify === false ? { verify: false } : {}),
          ...(options.name ? { name: String(options.name) } : {}),
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (e) {
      throw new Error(`本地配音服务没开（${TTS_ORIGIN}）：${e instanceof Error ? e.message : String(e)}。先在本机启动 CosyVoice2 服务（见 mcp/README.md），或在配音页切到 API 模式`);
    }
    if (!res.ok) throw new Error(`本地配音失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    try { said_json = await res.json(); } catch { said_json = null; }
    const servedFile = typeof said_json?.file === 'string' ? said_json.file : '';
    if (!servedFile) throw new Error('本地配音没有返回文件路径');
    const { readFile } = await import('node:fs/promises');
    bytes = await readFile(servedFile).catch(() => null);
    if (!bytes || bytes.length < 1000) throw new Error('本地配音返回了空音频');
    const cues = Array.isArray(said_json?.cues) && said_json.cues.length ? said_json.cues : null;
    made = {
      bytes,
      ext: 'wav',
      seconds: Number(said_json?.duration) > 0 ? Number(said_json.duration) : null,
      cues,
      engine: 'cosyvoice2',
      voice: said_json?.voice || options.voice || null,
      model: null,
      sentences: Number(said_json?.sentences) || null,
      score: Number.isFinite(Number(said_json?.score)) ? Number(said_json.score) : null,
      report: Array.isArray(said_json?.report) && said_json.report.length ? said_json.report : null,
      warnings: [],
      natural: options.natural !== false,
    };
  }

  const { mkdtemp, writeFile, rm, rename } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'openfilm-tts-'));
  const temp = join(dir, `voice.${made.ext}`);
  await writeFile(temp, made.bytes);
  try {
    const base = String(options.name ?? '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || `配音 ${new Date(at).toISOString().slice(11, 19).replace(/:/g, '')}`;
    const landed = await bringIn(project.path, 'assets/voice', [temp], 'copy');
    const rel = landed[0];
    /* bringIn 用的是临时文件名，改成可读的名字 */
    const wanted = `${base}.${made.ext}`;
    let final = rel;
    if (rel !== `assets/voice/${wanted}`) {
      const dest = join(project.path, 'assets', 'voice', wanted);
      try { await rename(join(project.path, rel), dest); final = `assets/voice/${wanted}`; } catch { /* 重名就保留临时名 */ }
    }
    const facts = await probe(project.path, final).catch(() => ({}));
    /* 三处时长要对得上：服务报的、磁盘上音频的、cues 最后一句的结束点。
       对不上就会出现“字幕比画面早结束”这种很难查的问题，所以先比一次，超差就带在结果里。 */
    const saidSeconds = made.seconds;
    const diskSeconds = Number(facts.duration) > 0 ? Number(facts.duration) : null;
    const seconds = saidSeconds ?? diskSeconds;
    const warnings = [...made.warnings];
    if (saidSeconds && diskSeconds && Math.abs(saidSeconds - diskSeconds) > 0.05) {
      warnings.push('服务时长 ' + saidSeconds.toFixed(3) + 's 与磁盘音频 ' + diskSeconds.toFixed(3) + 's 不一致');
    }
    /* 逐句起止（含句间停顿），字幕直接用这条时间轴 */
    const cues = made.cues;
    if (cues && seconds) {
      const tail = Number(cues[cues.length - 1]?.end);
      if (Number.isFinite(tail) && Math.abs(tail - seconds) > 0.05) {
        warnings.push('时间轴末尾 ' + tail.toFixed(3) + 's 与音频时长 ' + seconds.toFixed(3) + 's 差 ' + Math.abs(tail - seconds).toFixed(3) + 's');
      }
    }
    /* 时间轴存在音频旁边，导出/烧字幕时不用再问配音服务 */
    if (Array.isArray(cues) && cues.length) {
      const { writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const { extname } = await import('node:path');
      const stem = basename(final, extname(final));
      await writeFile(join(project.path, dirname(final), `${stem}.cues.json`), JSON.stringify(cues, null, 1), 'utf8').catch(() => {});
    }
    return {
      project: project.id, path: final, seconds, bytes: made.bytes.length, text: said, engine: made.engine, at,
      voice: made.voice,
      model: made.model ?? null,
      mode,
      natural: made.natural !== false,
      cues: cues ?? null,
      sentences: made.sentences,
      score: made.score,
      report: made.report,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 素材库里最近一条配音的逐句时间轴（导出时没指定就用它）。 */
export async function latestCues(/** @type {string} */ projectRoot) {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const dir = join(projectRoot, 'assets', 'voice');
  /** @type {Array<{ file: string, at: number }>} */
  const found = [];
  try {
    for (const name of await readdir(dir)) {
      if (!name.toLowerCase().endsWith('.cues.json')) continue;
      const file = join(dir, name);
      found.push({ file, at: (await stat(file)).mtimeMs });
    }
  } catch { return []; }
  found.sort((a, b) => b.at - a.at);
  for (const one of found) {
    try {
      const raw = JSON.parse(await readFile(one.file, 'utf8'));
      const cues = Array.isArray(raw) ? raw.filter((/** @type {any} */ cue) => cue && typeof cue.text === 'string' && Number(cue.end) > Number(cue.start)) : [];
      if (cues.length) return cues;
    } catch { /* 坏文件跳过，继续找上一条 */ }
  }
  return [];
}

/** 读一条配音的逐句时间轴（make_voice 写在 wav 旁边的 .cues.json）。 */
export async function readCues(/** @type {string} */ projectRoot, /** @type {string} */ voicePath) {
  const rel = String(voicePath ?? '').replace(/\\/g, '/');
  const file = join(projectRoot, rel.replace(/\.[a-z0-9]{2,5}$/i, '.cues.json'));
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter((/** @type {any} */ cue) => cue && typeof cue.text === 'string' && Number(cue.end) > Number(cue.start)) : [];
  } catch { return []; }
}

/**
 * 拿一条配音的逐句时间轴：先用 wav 旁边的 .cues.json；旧配音没有 sidecar 时，
 * 用本机 Whisper 现场对齐一次，并把结果写成 sidecar（下次直接命中，不重复转写）。
 * 只读本地文件，不联网。
 * @param {string} projectRoot
 * @param {string} voicePath 库内相对路径
 * @returns {Promise<Array<{ text: string, start: number, end: number }>>}
 */
export async function ensureCues(/** @type {string} */ projectRoot, /** @type {string} */ voicePath) {
  const hit = await readCues(projectRoot, voicePath);
  if (hit.length) return hit;
  const rel = String(voicePath ?? '').replace(/\\/g, '/');
  if (!rel) return [];
  const audio = join(projectRoot, rel);
  if (!existsSync(audio)) return [];
  const cues = await transcribeCues(audio).catch(() => []);
  if (!cues.length) return [];
  const { writeFile } = await import('node:fs/promises');
  const sidecar = join(projectRoot, rel.replace(/\.[a-z0-9]{2,5}$/i, '.cues.json'));
  await writeFile(sidecar, JSON.stringify(cues, null, 2) + '\n', 'utf8').catch(() => {});
  return cues;
}
/** 最近生成的混剪工程，给“导出最近一批”兜底。 */
async function recentMixProjects() {
  const projects = await listProjects();
  return projects
    .filter((project) => !project.missing && /^混剪\s/.test(project.name))
    .sort((a, b) => Number(b.openedAt ?? 0) - Number(a.openedAt ?? 0))
    .slice(0, 12)
    .map((project) => project.id);
}

/** 工具表：name / description / inputSchema / handler。 */
/** @param {{ render?: (args: Record<string, any>) => Promise<unknown> }} [options] */
export function toolTable({ render } = {}) {
  /** @type {Array<{ name: string, description: string, inputSchema: Record<string, unknown>, handler: (args: any) => Promise<unknown> }>} */
  const tools = [
    {
      name: 'list_assets',
      description: '列出混剪素材库里的视频/图片/声音：路径、时长、尺寸、标签、是否已本地识别。project 省略时用“混剪素材库”。',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: '工程 id 或名字，默认 混剪素材库' } }, additionalProperties: false },
      handler: async (args) => listAssets(args.project || LIBRARY_NAME),
    },
    {
      name: 'analyze_assets',
      description: '本地识别素材（ffmpeg 看镜头 + faster-whisper 转写台词），写时间线（0:00-1.28s 画面描述 / 台词：…）并把标签并进素材标签。paths 省略时识别全部。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' }, description: '素材库里的相对路径，如 assets/a.mp4' },
          applyTags: { type: 'boolean', description: '把识别出的标签并进素材标签，默认 true' },
          skipSpeech: { type: 'boolean', description: '只听画面、不转写台词' },
        },
        additionalProperties: false,
      },
      handler: async (args) => analyzeAssets(args.project || LIBRARY_NAME, args.paths ?? [], { applyTags: args.applyTags !== false, skipSpeech: args.skipSpeech === true }),
    },
    {
      name: 'tag_assets',
      description: '给素材加/去/换标签（最多 12 个，每个 24 字）。mode: add（默认）/ remove / set。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['add', 'remove', 'set'] },
        },
        required: ['paths', 'tags'],
        additionalProperties: false,
      },
      handler: async (args) => tagAssets(args.project || LIBRARY_NAME, args.paths, args.tags, args.mode ?? 'add'),
    },
    {
      name: 'get_timeline',
      description: '读素材或成片已识别的时间线（含台词）。paths 省略时返回全部已识别的。',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      handler: async (args) => getTimeline(args.project || LIBRARY_NAME, args.paths ?? []),
    },
    {
      name: 'shot_list',
      description: '导出分镜表：每条素材/成片的逐段 序号 / 起止 / 时长 / 画面 / 台词 / 标签。md 给人看，csv 进 Excel/飞书，tsv 给 agent 做选段决策。paths 省略时导出全部已识别的。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' }, description: '素材库内相对路径；省略用全部已识别的' },
          format: { type: 'string', enum: ['md', 'csv', 'tsv'], description: '默认 md' },
        },
        additionalProperties: false,
      },
      handler: async (args) => shotList(args.project || LIBRARY_NAME, args.paths ?? [], args.format ?? 'md'),
    },
    {
      name: 'analyze_outputs',
      description: '本地看成片：时间线精确到 0.01 秒（0:00.00-1.28s 画面描述 / 台词：…）并做质检（黑帧、静音、时长、抖动、分辨率）。files 省略时看最近 3 条成片。',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: '成片绝对路径（list_outputs 返回的 path）；省略用最近 3 条' },
          skipSpeech: { type: 'boolean', description: '只听画面、不转写台词' },
          minShot: { type: 'number', description: '最短镜头（秒），默认 0.6；越小切得越细' },
          limit: { type: 'number', description: '最多看几条（默认 3）' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const files = Array.isArray(args.files) && args.files.length ? args.files : [];
        return analyzeOutputs(files, { skipSpeech: args.skipSpeech === true, ...(Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}), ...(Number(args.minShot) > 0 ? { minShot: Number(args.minShot) } : {}) });
      },
    },
    {
      name: 'tts_status',
      description: '配音状态：本机 CosyVoice2（127.0.0.1:9880）是否在线、模型加载了没有，以及当前保存的配音模式（local / api）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ttsStatus(),
    },
    {
      name: 'list_voices',
      description: '列出本机 CosyVoice2 可用音色（全部离线、真人参考音）。挑一个稳定不出错的再批量合成；API 模式的音色用 HTTP 接口 GET /api/batch/tts/voices?provider= 查。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ttsVoices(),
    },
    {
      name: 'make_voice',
      description: '配音：一段台词 → 素材库 assets/voice/ 里的一条音频，返回路径、真实时长和逐句 cues。默认用保存的模式：local（本机 CosyVoice2，不联网）或 api（自己 key 的云端服务商）。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '素材库工程 id 或名字，默认 混剪素材库' },
          text: { type: 'string', description: '要念的台词（一次最多 800 字）' },
          name: { type: 'string', description: '文件名，省略按时间生成' },
          voice: { type: 'string', description: '音色 id，取 list_voices 返回的列表；n1-n6 是真人参考音（默认 n4），a/b/c 系是旧参考音' },
          speed: { type: 'number', description: '语速 0.7–1.3，默认 1' },
          pause: { type: 'number', description: '句间停顿秒数 0–0.6，默认 0.16' },
          verify: { type: 'boolean', description: '是否用本地 whisper 回读校验（默认开）' },
          natural: { type: 'boolean', description: '整段合成（默认 true），句间更连贯；false 则逐句拼接；仅本地模式' },
          mode: { type: 'string', enum: ['local', 'api'], description: '这一条用哪个来源（不改保存的模式）；省略用 ~/.openfilm/voice.json 里的' },
          provider: { type: 'string', description: 'API 模式的服务商 id（openai / elevenlabs / google / groq / azure）；省略用保存的' },
          model: { type: 'string', description: 'API 模式的模型 id；省略用保存的或服务商默认' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      handler: async (args) => makeVoice(args.project || LIBRARY_NAME, {
        text: args.text, name: args.name, voice: args.voice, speed: args.speed, pause: args.pause, verify: args.verify, natural: args.natural,
        mode: args.mode, provider: args.provider, model: args.model,
      }),
    },
    {
      name: 'list_outputs',
      description: '列出本机 Studio 导出过的成片（新到旧）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ outputs: await listOutputs() }),
    },
    {
      name: 'generate_mix',
      description: '用素材库生成混剪工程：每个成片一个 project（含 film.html 时间线），可在 Studio 里继续精修或导出。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' }, description: '只用这些素材；省略用全部' },
          seconds: { type: 'number', description: '目标时长（秒），默认 20' },
          count: { type: 'number', description: '生成几条，默认 1，最多 12' },
          aspect: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:3'] },
          pace: { type: 'string', enum: ['fast', 'normal', 'slow'] },
          seed: { type: 'number' },
          name: { type: 'string' },
          tag: { type: 'string', description: '只用带这个标签的素材（paths 省略时生效）' },
          voice: { type: 'string', description: '配音文件的库内路径（如 assets/voice/x.wav，来自 make_voice），从 0 秒铺一条声音轨' },
          voiceSeconds: { type: 'number', description: '画面按配音时长铺满（秒），一般取 make_voice 返回的 seconds' },
          voiceMatch: { type: 'boolean', description: 'true 时自动探测配音时长，让画面正好铺满配音（优先于 seconds）' },
          useTimeline: { type: 'boolean', description: 'true 时按识别出的分镜选段（而不是随机取画面）；素材要先跑过 analyze_assets' },
          query: { type: 'array', items: { type: 'string' }, description: '关键词：命中台词/画面/标签的分镜段排前面（配合 useTimeline）' },
          shotSeconds: { type: 'number', description: '每段取多长（秒）；省略就按分镜段自己的时长' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = await findProject(args.project || LIBRARY_NAME);
        /** @type {string[]} */
        let paths = Array.isArray(args.paths) ? args.paths : [];
        if (!paths.length && typeof args.tag === 'string' && args.tag) {
          const listing = await listAssets(project.id);
          paths = listing.assets.filter((asset) => asset.tags.includes(args.tag)).map((asset) => asset.path);
          if (!paths.length) throw new Error(`没有带“${args.tag}”标签的素材`);
        }
        return generateMix(project.id, { ...args, paths });
      },
    },
    {
      name: 'burn_subtitles',
      description: '把字幕烧进已导出的成片（本机 ffmpeg + libass）。cues 省略时用 voice 那条配音的逐句时间轴。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '成片绝对路径，取 list_outputs 的 path' },
          cues: { type: 'array', items: { type: 'object' }, description: '字幕 [{text,start,end}]；省略则用 voice 的时间轴' },
          project: { type: 'string', description: '素材库工程，voice 在里面找；默认 混剪素材库' },
          voice: { type: 'string', description: '配音库内路径（assets/voice/x.wav）；cues 省略时按它的逐句时间轴烧字幕' },
          bottom: { type: 'number', description: '字幕离底边的高度，按画面高度比例（默认 0.11）；素材底部自带文案时用 0.2 左右避开' },
        },
        required: ['file'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const file = String(args.file ?? '').trim();
        if (!file || !existsSync(file)) throw new Error(`成片不存在：${file || '（空）'}`);
        /** @type {Array<{ text: string, start: number, end: number }>} */
        let cues = Array.isArray(args.cues) ? args.cues : [];
        if (!cues.length) {
          const project = await findProject(args.project || LIBRARY_NAME);
          const saved = args.voice ? await ensureCues(project.path, String(args.voice)) : await latestCues(project.path);
          if (!saved.length) {
            throw new Error(args.voice
              ? `这条配音没有可用的台词时间轴：${args.voice}。它可能是纯音乐/静音，或本地 Whisper 没装好`
              : '素材库里没有带时间轴的配音：先 make_voice 生成一条，或直接给 cues');
          }
          cues = saved;
        }
        const bottom = Number(args.bottom) > 0 && Number(args.bottom) < 0.6 ? Number(args.bottom) : undefined;
        const out = await burnSubtitles(file, cues, bottom ? { bottom } : {});
        return { file: out, cues: cues.length, source: file };
      },
    },
    {
      name: 'export_film',
      description: '把混剪工程渲染成 MP4（本机 ffmpeg）。projects 省略时导出最近生成的那一批；返回成片路径。',
      inputSchema: {
        type: 'object',
        properties: {
          projects: { type: 'array', items: { type: 'string' }, description: '工程 id 列表；省略用最近一批' },
          folder: { type: 'string', description: '导出目录（绝对路径），省略用 Studio 默认目录' },
          fps: { type: 'number' },
          audio: { type: 'boolean', description: '保留素材原声，默认 true' },
          subtitles: { type: 'array', items: { type: 'object' }, description: '字幕时间轴 [{text,start,end}]；给了就在导出后烧进画面（字体本机，不联网）' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!render) throw new Error('这个 MCP 进程不直接渲染：在 Studio 后台里让 Agent 出片，或在 Studio 里导出');
        const projects = Array.isArray(args.projects) && args.projects.length ? args.projects : await recentMixProjects();
        if (!projects.length) throw new Error('没有可导出的混剪工程；先 generate_mix');
        const out = /** @type {{ outputs?: string[] }} */ (await render({ ...args, projects, onProgress: args.onProgress }));
        /** @type {Array<{ text: string, start: number, end: number }>} */
        let cues = Array.isArray(args.subtitles) ? args.subtitles : [];
        if (!cues.length && args.subtitles === '@cues') {
          const project = await findProject(args.project || LIBRARY_NAME);
          cues = await latestCues(project.path);
        }
        if (cues.length && Array.isArray(out?.outputs) && out.outputs.length) {
          const burned = [];
          for (const file of out.outputs) burned.push(await burnSubtitles(file, cues).catch(() => null));
          return { ...out, outputs: burned.filter(Boolean), subtitled: burned.filter(Boolean).length, originals: out.outputs };
        }
        return out;
      },
    },
  ];
  return tools;
}
/** 给后台/测试用的执行器：按名字调工具，参数不合法时给一句人话。 */
/** @param {{ render?: (args: Record<string, any>) => Promise<unknown> }} [options] */
/** @param {{ render?: (args: Record<string, any>) => Promise<unknown>, onProgress?: (step: any) => void }} [options] */
export function createCaller(options = {}) {
  const { onProgress: _progress, ...rest } = /** @type {{ onProgress?: (step: any) => void, render?: (args: Record<string, any>) => Promise<unknown> }} */ (options);
  const table = new Map(toolTable(rest).map((tool) => [tool.name, tool]));
  return async (/** @type {string} */ name, /** @type {Record<string, any>} */ args) => {
    const tool = table.get(name);
    if (!tool) throw new Error(`没有这个工具：${name}`);
    return tool.handler(args && typeof args === 'object' ? args : {});
  };
}

/** 素材/成片文件还在不在（页面上用来过滤失效记录）。 */
export const present = (/** @type {string} */ path) => existsSync(path) && statSync(path).isFile();





