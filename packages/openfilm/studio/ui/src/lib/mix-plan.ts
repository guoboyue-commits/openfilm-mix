/**
 * 混剪工作台的核心：把素材库里的视频、图片、声音变成一条可继续编辑的时间线。
 *
 * 这里只做纯计算（不碰 DOM、不碰网络），Studio 的素材库按钮和测试都走同一份规则：
 * - 按素材名自然排序，第一轮按原顺序铺，之后每一轮洗牌，避免每次出片顺序一模一样；
 * - 同一素材在最近几段里不重复（素材够的时候），素材不够时宁可重复也不留空；
 * - 每段先取素材最安静的一处，再按节奏收短；太短的素材整段使用；
 * - 有旁白时按旁白时长铺满，没有旁白时按目标时长铺满；
 * - 图片和网页按段落时长写成 `time`，视频写成 `time` 裁剪，全部落在帧网格上。
 *
 * 一条时间线 = 一个 EditModel 形状的轨道数组（同 lib/timeline-edit 的 EditTrack），
 * 这样 ProjectView 可以直接把它交给计划器，或者写成 film.html 的剪辑。
 */
import type { Op } from '../api.ts';
import type { FilmBox } from './film.ts';
import type { EditModel } from './timeline-edit.ts';
import { assetClipKindOf, assetFitBox, type StageSize } from './asset-timeline.ts';
import type { ResourceKind } from './resource-drag.ts';
import { snapToFrame, timecodeFps } from './timecode.ts';

/** 一段素材进入时间线时要用的信息：素材库里的文件，加上探测出的时长、尺寸。 */
export interface MixAsset {
  path: string;
  name?: string;
  kind: ResourceKind;
  durationMs?: number;
  w?: number;
  h?: number;
  /** 网页没有自己的时长（和图片一样，用剪辑的 time 表示长度） */
  endless?: boolean;
}

/** 分镜表里的一段：由本地识别（analyze）产出，src 是素材路径，from/to 是素材内时间。 */
export interface MixShot {
  src: string;
  from: number;
  to: number;
  text?: string;
  speech?: string | null;
  tags?: string[];
}

export interface MixOptions {
  /** 成片目标时长（秒）。有旁白时以旁白为准，这个值只用于显示和没有旁白的情况。 */
  targetSeconds: number;
  /** 每段最短、最长（秒）。 */
  minShotSeconds: number;
  maxShotSeconds: number;
  /** 节奏：快剪 / 标准 / 舒缓。只影响每段的目标长度，不改变素材本身。 */
  pace: 'fast' | 'normal' | 'slow';
  /** 同一素材至少隔开几段再出现。0 表示不限制。 */
  avoidRepeat: number;
  /** 是否重新洗牌（关闭时严格按素材库顺序循环）。 */
  shuffle: boolean;
  /** 旁白时长（秒），有旁白时时间线长度以它为准。 */
  voiceSeconds?: number;
  /** 随机种子：同一种子出同一条片子，方便复现和批量出不同版本。 */
  seed: number;
  /** 画布尺寸：视频/图片按它计算居中框。 */
  stage?: StageSize;
  /** 时间线帧率：所有切点对齐到这一帧网格，默认 30。 */
  fps?: number;
  /** 按分镜选段时给的段落列表；来自本地识别的分镜表。 */
  shots?: MixShot[];
  /** 选段关键词：命中台词/画面/标签的段优先（配合 shots）。 */
  query?: string[];
  /** 每段最多取多长（秒）；省略就按分镜段自己的时长。 */
  shotSeconds?: number;
}

/** 时间线上的一段（只保留混剪需要的字段，和 Studio 的剪辑形状一致）。 */
export interface MixClip {
  src: string;
  time?: [number, number];
  at: number;
  box?: FilmBox;
  speed?: number;
  volume?: number;
  /** 淡入淡出等按时间覆盖；服务端只认 overrides 里的 fade。 */
  overrides?: Array<{ fade?: [number, number] }>;
}

export interface MixTrack {
  role: 'mg' | 'video' | 'audio';
  clips: MixClip[];
}

export interface MixPlan {
  /** 生成它用的参数（含 seed 和 fps），方便回显与复现。 */
  options: MixOptions;
  tracks: MixTrack[];
  /** 实际成片时长（秒） */
  durationSeconds: number;
  /** 用到的素材段数 */
  shots: number;
  /** 计划里每个素材被用了几次（路径 → 次数） */
  used: Record<string, number>;
  /** 时间线里每个片段（按出现顺序） */
  segments: Array<{ src: string; at: number; length: number; from: number; to: number; text?: string; speech?: string; tags?: string[] }>;
}

const PACE: Record<MixOptions['pace'], number> = { fast: 0.65, normal: 1, slow: 1.45 };

/** 一个可复现的随机数（mulberry32）：同一 seed，同一序列。 */
export function seededRandom(seed: number): () => number {
  let a = (Math.floor(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 素材名的自然排序：A1-flow-15s 排在 A1-flow20s 前，中文名按系统语言排。 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const nameOf = (asset: MixAsset) => asset.name ?? asset.path.split('/').pop() ?? asset.path;
export const compareAssets = (a: MixAsset, b: MixAsset) => collator.compare(nameOf(a), nameOf(b));

/** 可进入画面的素材：视频、图片、网页；声音单独处理。 */
export function mixableAssets(assets: readonly MixAsset[]): MixAsset[] {
  return [...assets].filter((a) => {
    const kind = assetClipKindOf(a);
    return kind === 'video' || kind === 'mg';
  }).sort(compareAssets);
}

/** 声音素材：只取音乐/音效，旁白由用户自己放，不混进来。 */
export function mixSounds(assets: readonly MixAsset[]): MixAsset[] {
  return [...assets].filter((a) => assetClipKindOf(a) === 'audio').sort(compareAssets);
}

/** 视频/图片/网页在时间线上的类型。 */
const isPicture = (asset: MixAsset) => assetClipKindOf(asset) === 'video';

/** 素材在时间线上能用的长度（秒）；图片/网页没有时长时给一个保守值。 */
function sourceLength(asset: MixAsset): number {
  if (isPicture(asset) && asset.durationMs && asset.durationMs > 0) return asset.durationMs / 1000;
  if (asset.durationMs && asset.durationMs > 0) return asset.durationMs / 1000;
  return 4;
}

/** 一段的目标长度：受节奏、素材本身长度、剩余时长限制，并且至少 0.5 秒。 */
function shotLength(asset: MixAsset, options: MixOptions, remaining: number): number {
  const pace = PACE[options.pace] ?? 1;
  const base = Math.min(options.maxShotSeconds, Math.max(options.minShotSeconds, 2.6 * pace));
  const own = sourceLength(asset);
  const wanted = Math.min(base, own, remaining);
  /* 素材短于 0.5 秒也照用，但时间线会以帧为单位对齐 */
  return Math.max(0.05, Math.min(wanted, remaining));
}

/** 在素材里挑一个起点：优先安静处，其次均匀分布，最后留出整段。 */
function pickStart(asset: MixAsset, length: number, random: () => number): number {
  const own = sourceLength(asset);
  if (!isPicture(asset) || own <= length + 0.05) return 0;
  const slack = own - length;
  /* 素材开头通常有黑场/标题，第一段从 8% 处开始；后面的段随机一点 */
  const bias = random() < 0.5 ? 0.08 : 0.2 + random() * 0.6;
  return Math.min(slack, Math.round(slack * bias * 1000) / 1000);
}

/** 洗牌（Fisher–Yates），用可复现的随机数。 */
function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 生成一条混剪时间线。
 *
 * 返回的 `tracks` 是一条画面轨（网页/视频/图片）加（可选）一条音乐轨。所有时间都对齐到帧网格，
 * 相邻片段首尾相接，不会出现黑缝或重叠。
 */
export function planMix(assets: readonly MixAsset[], options: MixOptions): MixPlan {
  const pictures = mixableAssets(assets);
  if (!pictures.length) throw new Error('素材库里没有可用的视频、图片或网页');
  const random = seededRandom(options.seed);
  const fps = options.fps && options.fps > 0 ? options.fps : timecodeFps();
  const target = Math.max(1, options.voiceSeconds && options.voiceSeconds > 0 ? options.voiceSeconds : options.targetSeconds);
  const avoid = Math.max(0, Math.floor(options.avoidRepeat));
  const stage = options.stage ?? { w: 1080, h: 1920 };
  const used: Record<string, number> = {};
  const segments: MixPlan['segments'] = [];
  const clips: MixClip[] = [];
  const recent: string[] = [];
  let at = 0;
  let round = 0;
  let pool: MixAsset[] = options.shuffle ? shuffled(pictures, random) : [...pictures];

  /* 最多循环 200 轮，防止极端参数（比如所有素材都短于 0.5 秒）死循环 */
  while (at < target - 0.05 && round < 200) {
    if (!pool.length) {
      round += 1;
      pool = options.shuffle ? shuffled(pictures, random) : [...pictures];
      /* 新的一轮：如果所有素材都在最近窗口里，清空窗口，否则永远选不出来 */
      if (avoid > 0 && pool.every((asset) => recent.includes(asset.path))) recent.length = 0;
    }
    const remaining = target - at;
    let index = pool.findIndex((asset) => avoid === 0 || !recent.includes(asset.path));
    if (index < 0) index = 0;
    const [asset] = pool.splice(index, 1);
    if (!asset) break;
    const length = shotLength(asset, options, remaining);
    if (length <= 0.01) break;
    const start = pickStart(asset, length, random);
    const end = isPicture(asset) ? Math.min(sourceLength(asset), start + length) : start + length;
    const realLength = Math.max(0.05, Math.min(length, end - start));
    const atSec = snapToFrame(at * 1000, fps) / 1000;
    const clip: MixClip = {
      src: asset.path,
      at: atSec,
      ...(isPicture(asset) ? { time: [Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000] } : { time: [0, Math.round(realLength * 1000) / 1000] }),
    };
    /* 没有框（形状和画布一致，或尺寸未知）时写满画布：按画布 px 写，渲染器不接受 100% */
    clip.box = (isPicture(asset) ? assetFitBox(asset, stage) : null) ?? { x: 0, y: 0, w: stage.w, h: stage.h };
    /* 切点淡入淡出：服务端只认 overrides 里的 fade，顶层 fade 会被判为未知字段。 */
    const fade = Math.min(0.12, realLength / 4);
    if (fade >= 0.03) clip.overrides = [{ fade: [Math.round(fade * 1000) / 1000, Math.round(fade * 1000) / 1000] }];
    clips.push(clip);
    segments.push({ src: asset.path, at: atSec, length: realLength, from: clip.time![0], to: clip.time![1] });
    used[asset.path] = (used[asset.path] ?? 0) + 1;
    recent.push(asset.path);
    if (avoid > 0 && recent.length > avoid) recent.shift();
    at = atSec + realLength;
  }

  const durationSeconds = Math.round(at * 1000) / 1000;
  return {
    options: { ...options, fps },
    tracks: [{ role: 'mg', clips }],
    durationSeconds,
    shots: clips.length,
    used,
    segments,
  };
}

/**
 * 按分镜选段：和 planMix 的区别是「用哪一段」来自本地识别出的分镜表，而不是随机取画面。
 *
 * options.shots 每条是素材的一段 { src, from, to, text?, speech?, tags? }。
 * 有 query 时按台词/画面/标签命中数排序，命中多的段先上；同分用 seed 打散。
 * shotSeconds 可以限制每段取多长，省略就用分镜段自己的长度。
 */
export function planContentMix(assets: readonly MixAsset[], options: MixOptions): MixPlan {
  const pictures = mixableAssets(assets);
  if (!pictures.length) throw new Error('素材库里没有可用的视频或图片');
  const byPath = new Map(pictures.map((asset) => [asset.path, asset]));
  const picked: Array<{ asset: MixAsset; from: number; to: number; length: number; text: string; speech: string; tags: string[] }> = [];
  for (const shot of Array.isArray(options.shots) ? options.shots : []) {
    const asset = byPath.get(String(shot?.src ?? ''));
    if (!asset) continue;
    const own = sourceLength(asset);
    const from = Math.max(0, Number(shot.from) || 0);
    const to = Number(shot.to) > from ? Number(shot.to) : own;
    const length = Math.min(own - from, to - from, Math.max(0.05, Number((shot as MixShot & { seconds?: number }).seconds) || to - from));
    if (!(length > 0.05)) continue;
    picked.push({ asset, from, to: from + length, length, text: shot.text ?? '', speech: shot.speech ?? '', tags: Array.isArray(shot.tags) ? shot.tags : [] });
  }
  if (!picked.length) throw new Error('素材还没有识别结果：先点“识别素材”，再按分镜选段');
  const query = Array.isArray(options.query) ? options.query.map((one) => String(one).toLowerCase()).filter(Boolean) : [];
  const score = (one: typeof picked[number]) => query.reduce((n, word) => n + (`${one.text}\n${one.speech}\n${one.tags.join(' ')}`.toLowerCase().includes(word) ? 1 : 0), 0);
  const random = seededRandom(options.seed);
  const fps = options.fps && options.fps > 0 ? options.fps : timecodeFps();
  const stage = options.stage ?? { w: 1080, h: 1920 };
  const target = Math.max(1, options.voiceSeconds && options.voiceSeconds > 0 ? options.voiceSeconds : options.targetSeconds);
  const ordered = query.length ? [...picked].sort((a, b) => score(b) - score(a) || random() - 0.5) : shuffled(picked, random);
  const avoid = Math.max(0, Math.floor(options.avoidRepeat ?? 2));
  const recent: string[] = [];
  const clips: MixClip[] = [];
  const segments: MixPlan['segments'] = [];
  const used: Record<string, number> = {};
  const shotSeconds = Number(options.shotSeconds) > 0 ? Number(options.shotSeconds) : 0;
  let at = 0;
  let round = 0;
  let pool = [...ordered];
  while (at < target - 0.05 && round < 400) {
    if (!pool.length) {
      round += 1;
      pool = [...ordered];
      if (avoid > 0 && pool.length > avoid && pool.every((one) => recent.includes(one.asset.path))) recent.length = 0;
    }
    const remaining = target - at;
    let index = pool.findIndex((one) => avoid === 0 || !recent.includes(one.asset.path));
    if (index < 0) index = 0;
    const [shot] = pool.splice(index, 1);
    if (!shot) break;
    const want = Math.min(shotSeconds || shot.length, shot.length, remaining);
    if (want <= 0.05) break;
    const take = Math.round(want * fps) / fps;
    const to = Math.min(shot.to, shot.from + take);
    const realLength = Math.max(0.05, to - shot.from);
    const atSec = snapToFrame(at * 1000, fps) / 1000;
    const clip: MixClip = {
      src: shot.asset.path,
      at: atSec,
      time: [Math.round(shot.from * 1000) / 1000, Math.round(to * 1000) / 1000],
      box: assetFitBox(shot.asset, stage) ?? { x: 0, y: 0, w: stage.w, h: stage.h },
    };
    const fade = Math.min(0.12, realLength / 4);
    if (fade >= 0.03) clip.overrides = [{ fade: [Math.round(fade * 1000) / 1000, Math.round(fade * 1000) / 1000] }];
    clips.push(clip);
    segments.push({ src: shot.asset.path, at: atSec, length: realLength, from: shot.from, to, text: shot.text, speech: shot.speech, tags: shot.tags });
    used[shot.asset.path] = (used[shot.asset.path] ?? 0) + 1;
    recent.push(shot.asset.path);
    if (avoid > 0 && recent.length > avoid) recent.shift();
    at = atSec + realLength;
  }
  if (!clips.length) throw new Error('分镜段落太短，拼不出一条成片');
  return { options: { ...options, fps }, tracks: [{ role: 'mg', clips }], durationSeconds: Math.round(at * 1000) / 1000, shots: clips.length, used, segments };
}

/**
 * 把一条混剪计划写成 Studio 的编辑操作（默认插到最上面一条新轨道，不覆盖已有时间线）。
 * 第一段带上轨道，后面几段用 `after` 接在它后面：同一条新轨道，而不是每段各开一条。
 */
export function mixOps(plan: MixPlan, track: number | { insert: number } = { insert: 0 }): Op[] {
  const clips = plan.tracks[0]?.clips ?? [];
  if (!clips.length) return [];
  const prefix = `mix-${Date.now().toString(36)}`;
  /* 第一条带轨道，其余接在它后面；每条都带 id，after 才找得到 */
  return clips.map((clip, i) => ({
    op: 'insert',
    clip: { ...clip, id: `${prefix}-${i + 1}` } as never,
    at: clip.at,
    ...(i === 0 ? { track } : { after: `${prefix}-${i}` }),
  }));
}

/** 计划的最后一段结束时间（秒）。 */
export function planEndSeconds(plan: MixPlan): number {
  const last = plan.segments.at(-1);
  return last ? Math.round((last.at + last.length) * 1000) / 1000 : 0;
}

/** 一条计划从零开始写进新项目时要用的编辑操作：先定画布，再铺一条画面轨。 */
export function mixFreshOps(plan: MixPlan): Op[] {
  const stage = plan.options.stage ?? { w: 1080, h: 1920 };
  /* 空项目里先开一条轨，之后每段都接在这条轨上 */
  return [{ op: 'stage', w: stage.w, h: stage.h }, ...mixOps(plan, { insert: 0 })];
}

/** 批量出片：同一批素材，按 count 个不同 seed 生成 count 条互不相同的计划。 */
export function planMixBatch(assets: readonly MixAsset[], options: MixOptions, count: number): MixPlan[] {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const plans: MixPlan[] = [];
  for (let i = 0; i < n; i += 1) plans.push(planMix(assets, { ...options, seed: options.seed + i * 7919 }));
  return plans;
}

/** 把混剪计划变成 EditModel（只含画面轨），用于交给 Studio 的放置计划器。 */
export function mixEditModel(plan: MixPlan): EditModel {
  const clips = plan.tracks[0]?.clips ?? [];
  return [{
    index: 0,
    role: 'mg' as const,
    locked: false,
    clips: clips.map((clip, i) => ({
      id: `mix-${i + 1}`,
      startMs: Math.round(clip.at * 1000),
      endMs: Math.round((clip.at + (clip.time ? clip.time[1] - clip.time[0] : 0)) * 1000),
      inMs: Math.round((clip.time?.[0] ?? 0) * 1000),
      speed: 1,
      sourceMs: Math.round((clip.time?.[1] ?? 0) * 1000),
    })),
  }];
}

