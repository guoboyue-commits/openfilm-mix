// @ts-check
/**
 * 混剪时间线（服务端）：和页面 lib/mix-plan.ts 同一套规则，但只用 Node 能直接跑的文件。
 *
 * 页面上的预览、后台的“一键成片”、本地 MCP 的 generate_mix 都走这里：
 * 同一份素材 + 同一个 seed，出同一条时间线。改规则时两边一起改。
 */

const PACE = { fast: 0.65, normal: 1, slow: 1.45 };
const STILL = /\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i;
const SOUND = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;

export const isStill = (/** @type {string} */ path) => STILL.test(path);
export const isSound = (/** @type {string} */ path) => SOUND.test(path);

/** 可进画面的素材：视频、图片。 */
export function mixableAssets(/** @type {Array<{ path: string, kind?: string }>} */ assets) {
  return [...assets].filter((asset) => !isSound(asset.path) && (asset.kind === 'video' || asset.kind === 'image' || /\.(mp4|mov|webm|m4v|mkv)$/i.test(asset.path)))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

export function seededRandom(/** @type {number} */ seed) {
  let a = (Math.floor(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sourceLength = (/** @type {{ durationMs?: number }} */ asset) => asset.durationMs && asset.durationMs > 0 ? asset.durationMs / 1000 : 4;

function shotLength(/** @type {{ durationMs?: number }} */ asset, /** @type {any} */ options, /** @type {number} */ remaining) {
  const pace = PACE[/** @type {keyof typeof PACE} */ (options.pace)] ?? 1;
  const base = Math.min(options.maxShotSeconds, Math.max(options.minShotSeconds, 2.6 * pace));
  return Math.max(0.05, Math.min(base, sourceLength(asset), remaining));
}

function pickStart(/** @type {{ durationMs?: number, path: string }} */ asset, /** @type {number} */ length, /** @type {() => number} */ random) {
  const own = sourceLength(/** @type {{ durationMs?: number }} */ (asset));
  if (isStill(asset.path) || own <= length + 0.05) return 0;
  const slack = own - length;
  const bias = random() < 0.5 ? 0.08 : 0.2 + random() * 0.6;
  return Math.min(slack, Math.round(slack * bias * 1000) / 1000);
}

function shuffled(/** @type {any[]} */ list, /** @type {() => number} */ random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 素材按画布居中放，不拉伸；形状一致就铺满。 */
export function fitBox(/** @type {{ w?: number, h?: number }} */ asset, /** @type {{ w: number, h: number }} */ stage) {
  if (!(asset.w && asset.h && asset.w > 0 && asset.h > 0)) return { x: 0, y: 0, w: stage.w, h: stage.h };
  const k = Math.min(stage.w / asset.w, stage.h / asset.h);
  const w = Math.min(stage.w, Math.round(asset.w * k));
  const h = Math.min(stage.h, Math.round(asset.h * k));
  if (stage.w - w <= 2 && stage.h - h <= 2) return { x: 0, y: 0, w: stage.w, h: stage.h };
  return { x: Math.round((stage.w - w) / 2), y: Math.round((stage.h - h) / 2), w, h };
}

/** 切点对齐到帧网格（30fps 时是 33.33ms 的整数倍）。 */
const snap = (/** @type {number} */ seconds, /** @type {number} */ fps) => Math.round(seconds * fps) / fps;

/**
 * 生成一条混剪：一条画面轨，片段首尾相接，不重叠、不留黑缝。
 * @param {Array<{ path: string, kind?: string, durationMs?: number, w?: number, h?: number }>} assets
 * @param {{ targetSeconds: number, minShotSeconds: number, maxShotSeconds: number, pace: 'fast'|'normal'|'slow',
 *   avoidRepeat: number, shuffle: boolean, voiceSeconds?: number, seed: number, stage?: { w: number, h: number }, fps?: number }} options
 */
export function planMix(assets, options) {
  const pictures = mixableAssets(assets);
  if (!pictures.length) throw new Error('素材库里没有可用的视频或图片');
  const random = seededRandom(options.seed);
  const fps = options.fps && options.fps > 0 ? options.fps : 30;
  const target = Math.max(1, options.voiceSeconds && options.voiceSeconds > 0 ? options.voiceSeconds : options.targetSeconds);
  const avoid = Math.max(0, Math.floor(options.avoidRepeat));
  const stage = options.stage ?? { w: 1080, h: 1920 };
  /** @type {Record<string, number>} */
  const used = {};
  const segments = [];
  const clips = [];
  /** @type {string[]} */
  const recent = [];
  let at = 0;
  let round = 0;
  let pool = options.shuffle ? shuffled(pictures, random) : [...pictures];
  while (at < target - 0.05 && round < 200) {
    if (!pool.length) {
      round += 1;
      pool = options.shuffle ? shuffled(pictures, random) : [...pictures];
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
    const end = isStill(asset.path) ? Math.min(sourceLength(asset), start + length) : start + length;
    const realLength = Math.max(0.05, Math.min(length, end - start));
    const atSec = snap(at, fps);
    const clip = {
      src: asset.path,
      at: atSec,
      time: isStill(asset.path) ? [Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000] : [0, Math.round(realLength * 1000) / 1000],
      box: fitBox(asset, stage),
    };
    clips.push(clip);
    segments.push({ src: asset.path, at: atSec, length: realLength, from: clip.time[0], to: clip.time[1] });
    used[asset.path] = (used[asset.path] ?? 0) + 1;
    recent.push(asset.path);
    if (avoid > 0 && recent.length > avoid) recent.shift();
    at = atSec + realLength;
  }
  return { options: { ...options, fps }, tracks: [{ role: 'mg', clips }], durationSeconds: Math.round(at * 1000) / 1000, shots: clips.length, used, segments };
}

/**
 * 按内容选段：和 planMix 的区别是「用哪一段」不是随机的，而是分镜表里识别出来的那一段。
 *
 * 每条 shots 是素材的一段：{ src, from, to, text?, speech?, tags? }，来自本地识别的时间线。
 * 有 query 时先按台词/画面/标签命中，命中的段排前面；不够就退回全部段，仍然排在未命中的前面。
 * 一条都不给就用整段素材（等价于原样保留）。
 */
/** @param {any[]} assets @param {any} options */
/** @param {Array<{ path: string, durationMs?: number, kind?: string }>} assets @param {any} options */
export function planContentMix(assets, options) {
  const pictures = mixableAssets(assets);
  if (!pictures.length) throw new Error('素材库里没有可用的视频或图片');
  /** @type {Map<string, { path: string, durationMs?: number, kind?: string, w?: number, h?: number }>} */
  const byPath = new Map(pictures.map((asset) => [asset.path, asset]));
  /** @type {any[]} */
  const picked = [];
  for (const shot of Array.isArray(options.shots) ? options.shots : []) {
    const asset = byPath.get(String(shot?.src ?? ''));
    if (!asset) continue;
    const own = sourceLength(asset);
    const from = Math.max(0, Number(shot.from) || 0);
    const to = Number(shot.to) > from ? Number(shot.to) : own;
    const length = Math.min(own - from, to - from, Math.max(0.05, Number(shot.seconds) || to - from));
    if (!(length > 0.05)) continue;
    picked.push({ asset, from, to: from + length, length, text: shot.text ?? '', speech: shot.speech ?? '', tags: Array.isArray(shot.tags) ? shot.tags : [] });
  }
  if (!picked.length) throw new Error('没有可用的分镜段落：先用 analyze_assets 识别，再把段落传给 planContentMix');
  const query = Array.isArray(options.query) ? options.query.map((/** @type {unknown} */ one) => String(one).toLowerCase()).filter(Boolean) : [];
  const score = (/** @type {any} */ one) => query.reduce((/** @type {number} */ n, /** @type {string} */ word) => n + (`${one.text}\n${one.speech}\n${one.tags.join(' ')}`.toLowerCase().includes(word) ? 1 : 0), 0);
  const random = seededRandom(options.seed);
  const fps = options.fps && options.fps > 0 ? options.fps : 30;
  const stage = options.stage ?? { w: 1080, h: 1920 };
  const target = Math.max(1, options.voiceSeconds && options.voiceSeconds > 0 ? options.voiceSeconds : options.targetSeconds);
  /* 命中多的排前面；同分按 seed 打散，同一份分镜表多跑几次不会完全一样 */
  const ordered = query.length
    ? [...picked].sort((a, b) => score(b) - score(a) || random() - 0.5)
    : shuffled(picked, random);
  const avoid = Math.max(0, Math.floor(options.avoidRepeat ?? 2));
  /** @type {any[]} */
  const recent = [];
  const clips = [];
  const segments = [];
  /** @type {Record<string, number>} */
  const used = {};
  /* 段落给的时长就是它的时长：需要更长就再取一段，而不是拉长这一段 */
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
    const atSec = snap(at, fps);
    clips.push({ src: shot.asset.path, at: atSec, time: [Math.round(shot.from * 1000) / 1000, Math.round(to * 1000) / 1000], box: fitBox(shot.asset, stage) });
    segments.push({ src: shot.asset.path, at: atSec, length: realLength, from: shot.from, to, text: shot.text, speech: shot.speech });
    used[shot.asset.path] = (used[shot.asset.path] ?? 0) + 1;
    recent.push(shot.asset.path);
    if (avoid > 0 && recent.length > avoid) recent.shift();
    at = atSec + realLength;
  }
  if (!clips.length) throw new Error('分镜段落太短，拼不出一条成片');
  return { options: { ...options, fps }, tracks: [{ role: 'mg', clips }], durationSeconds: Math.round(at * 1000) / 1000, shots: clips.length, used, segments };
}
/** 一条计划写成 Studio 的编辑操作：先定画布，再铺一条新轨道。 */
export function mixFreshOps(/** @type {ReturnType<typeof planMix>} */ plan) {
  const stage = plan.options.stage ?? { w: 1080, h: 1920 };
  const clips = plan.tracks[0]?.clips ?? [];
  const prefix = `mix-${Date.now().toString(36)}`;
  return [
    { op: 'stage', w: stage.w, h: stage.h },
    ...clips.map((clip, i) => ({
      op: 'insert',
      clip: { ...clip, id: `${prefix}-${i + 1}` },
      at: clip.at,
      ...(i === 0 ? { track: { insert: 0 } } : { after: `${prefix}-${i}` }),
    })),
  ];
}

/** 批量：同一批素材，不同 seed。 */
/** @param {any[]} assets @param {any} options @param {number} count */
export function planMixBatch(assets, options, count) {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const plans = [];
  for (let i = 0; i < n; i += 1) plans.push(planMix(assets, { ...options, seed: options.seed + i * 7919 }));
  return plans;
}

