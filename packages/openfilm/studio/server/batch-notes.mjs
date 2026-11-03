import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

/**
 * 素材库的“内容识别”结果：每个素材的时间线（0:00-1.28s 画面描述，台词：xxx），
 * 以及识别出的标签。和 batch-tags.json 放在一起，跟着素材库文件夹走。
 *
 * 识别只在本机做：ffmpeg 取帧看镜头/画面特征，faster-whisper 本地转写台词。
 * 这里不联网，也不调用任何云端接口。
 */
const FILE = join('.film', 'batch-notes.json');
const MAX_SEGMENTS = 120;

const fileOf = (/** @type {string} */ folder) => join(folder, FILE);
const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/** 一条时间线：时间、画面描述、台词、标签。 */
function cleanSegments(/** @type {unknown} */ value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SEGMENTS).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const seg = /** @type {Record<string, unknown>} */ (raw);
    const start = Number(seg.start), end = Number(seg.end);
    const text = typeof seg.text === 'string' ? seg.text.trim().slice(0, 600) : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return [];
    const speech = typeof seg.speech === 'string' && seg.speech.trim() ? seg.speech.trim().slice(0, 600) : null;
    const tags = Array.isArray(seg.tags) ? seg.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 8) : [];
    return [{ start: round2(start), end: round2(end), text, speech, tags }];
  });
}

/** 读整份识别结果；文件不在或读坏了都当没识别过。 */
export async function readNotes(/** @type {string} */ folder) {
  try {
    const raw = JSON.parse(await readFile(fileOf(folder), 'utf8'));
    /** @type {Record<string, any>} */
    const notes = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return notes;
    for (const [path, value] of Object.entries(raw)) {
      if (typeof path !== 'string' || !path || !value || typeof value !== 'object') continue;
      const one = /** @type {Record<string, unknown>} */ (value);
      const segments = cleanSegments(one.segments);
      if (!segments.length) continue;
      notes[path] = {
        segments,
        tags: Array.isArray(one.tags) ? one.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 12) : [],
        duration: Number.isFinite(Number(one.duration)) ? round2(Number(one.duration)) : round2(segments[segments.length - 1].end),
        language: typeof one.language === 'string' ? one.language : null,
        hasSpeech: one.hasSpeech === true,
        analyzedAt: Number.isFinite(Number(one.analyzedAt)) ? Number(one.analyzedAt) : Date.now(),
        engine: typeof one.engine === 'string' ? one.engine : 'local',
        ...(one.quality && typeof one.quality === 'object' ? { quality: one.quality } : {}),
      };
    }
    return notes;
  } catch {
    return {};
  }
}

async function write(/** @type {string} */ folder, /** @type {Record<string, any>} */ notes) {
  await mkdir(join(folder, '.film'), { recursive: true });
  await writeAtomic(fileOf(folder), `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  return notes;
}

/** 把一次识别的结果并进素材库（同一路径再识别就替换）。 */
export async function saveNotes(/** @type {string} */ folder, /** @type {Array<{ path: string, segments: unknown, tags?: unknown, duration?: unknown, language?: unknown, hasSpeech?: unknown, engine?: unknown, quality?: unknown }>} */ items) {
  const notes = await readNotes(folder);
  for (const item of items) {
    if (!item || typeof item.path !== 'string' || !item.path) continue;
    const segments = cleanSegments(item.segments);
    if (!segments.length) continue;
    notes[item.path] = {
      segments,
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 12) : [],
      duration: Number.isFinite(Number(item.duration)) ? round2(Number(item.duration)) : round2(segments[segments.length - 1].end),
      language: typeof item.language === 'string' ? item.language : null,
      hasSpeech: item.hasSpeech === true,
      analyzedAt: Date.now(),
      engine: typeof item.engine === 'string' ? item.engine : 'local',
      ...(item.quality && typeof item.quality === 'object' ? { quality: item.quality } : {}),
    };
  }
  return write(folder, notes);
}

/** 素材或成片没了，识别结果也一起去掉。 */
export async function dropNotes(/** @type {string} */ folder, /** @type {unknown} */ paths) {
  const notes = await readNotes(folder);
  let changed = false;
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path === 'string' && path in notes) { delete notes[path]; changed = true; }
  }
  if (!changed || !existsSync(fileOf(folder))) return notes;
  return write(folder, notes);
}
