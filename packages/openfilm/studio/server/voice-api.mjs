// @ts-check
/**
 * 云端配音：走设置里已连接的服务商（OpenAI / ElevenLabs / Google / Groq / Azure），产物和本地配音一样落在
 * 素材库 assets/voice/，返回同一形状（路径、真实时长、逐句 cues）。
 *
 * ElevenLabs 会返回逐字时间，直接用；其他服务不给时间时，按每句的字数把总时长分下去，
 * 字幕仍然逐句对齐，不会一整段糊在开头。
 */
import { extname } from 'node:path';
import { providerKey, readSettings } from './keys.mjs';
import { listProviders } from './providers/index.mjs';
import { readVoiceSettings } from './voice-mode.mjs';

/** 一句台词：去掉首尾空白，空句丢掉。 */
const clean = (/** @type {string} */ t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/**
 * 把一整段文字切成句子；保留句末标点，字幕读起来才完整。
 * 中英文都按 。！？；… 和 . ! ? ; 切，切不出来就整段当一句。
 * @param {string} text
 */
export function sentencesOf(/** @type {string} */ text) {
  const said = clean(text);
  if (!said) return [];
  /** @type {string[]} */
  const out = [];
  let buf = '';
  for (const ch of said) {
    buf += ch;
    if (/[\u3002\uff01\uff1f\uff1b\u2026.!?;]/.test(ch)) {
      const one = buf.trim();
      if (one) out.push(one);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.length ? out : [said];
}

/** 一句话的“念多久”权重：中日韩按字，拉丁按词。 */
function weightOf(/** @type {string} */ line) {
  let w = 0;
  for (const ch of line) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) w += 1;
    else if (/\s/.test(ch)) w += 0.25;
    else w += 0.5;
  }
  return Math.max(w, 1);
}

/**
 * 没有逐字时间时，按句子权重把总时长切开：既能当字幕，也能看出每句落在第几秒。
 * @param {string} text @param {number} seconds
 */
export function spreadCues(text, seconds) {
  const lines = sentencesOf(text);
  if (!lines.length || !(seconds > 0)) return null;
  const weights = lines.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  /** @type {Array<{ text: string, start: number, end: number }>} */
  const cues = [];
  let at = 0;
  lines.forEach((line, i) => {
    const span = i === lines.length - 1 ? seconds - at : Math.max(0.25, (weights[i] / total) * seconds);
    const end = i === lines.length - 1 ? seconds : Math.min(seconds, at + span);
    const start = Math.round(at * 100) / 100;
    cues.push({ text: line, start, end: Math.round(Math.max(end, start + 0.05) * 100) / 100 });
    at = end;
  });
  return cues;
}

/** 从服务商返回的逐字时间拼出句子级 cues：按原文顺序，时间取每句首尾字。 */
/** @param {Array<{ token?: string, start?: number, end?: number }>} words @param {string} text */
function cuesFromWords(words, text) {
  const lines = sentencesOf(text);
  if (!lines.length || !words.length) return null;
  /** @type {Array<{ text: string, start: number, end: number }>} */
  const cues = [];
  let wordAt = 0;
  for (const line of lines) {
    const letters = line.replace(/\s+/g, '').length;
    if (!letters) continue;
    let spanned = 0;
    const from = wordAt;
    let last = wordAt;
    while (wordAt < words.length && spanned < letters) {
      spanned += String(words[wordAt].token ?? '').replace(/\s+/g, '').length;
      last = wordAt;
      wordAt += 1;
    }
    if (from >= words.length) break;
    cues.push({
      text: line,
      start: Math.round(Number(words[from].start ?? 0) * 100) / 100,
      end: Math.round(Number(words[last].end ?? words[last].start ?? 0) * 100) / 100,
    });
  }
  return cues.length ? cues : null;
}

/**
 * 走云端服务商合成一条配音。
 * 返回 { bytes, ext, seconds, cues, provider, model, voice }，落盘由调用方做。
 * @param {{ text: string, name: string, voice?: string | null, provider?: string | null, model?: string | null, root: string, signal?: AbortSignal }} input
 */
export async function synthesizeWithProvider(input) {
  const saved = await readVoiceSettings();
  const settings = await readSettings();
  const providers = listProviders().filter((p) => p.verbs.includes('tts'));
  const wanted = input.provider || saved.provider;
  const provider = (wanted && providers.find((p) => p.id === wanted)) || null;
  if (!provider) throw new Error(wanted ? `没有叫 ${wanted} 的配音服务商` : '还没有选云端配音服务商');
  const key = providerKey(provider, settings);
  if (!key) throw new Error(`${provider.name} 还没连上：在设置 → 服务商里填 key，或者切回本地配音`);
  const models = provider.models?.tts ?? [];
  const model = (input.model && models.find((m) => m.id === input.model)?.id)
    || (saved.provider === provider.id && saved.model ? models.find((m) => m.id === saved.model)?.id : null)
    || models.find((m) => m.id === settings.model.tts)?.id
    || models[0]?.id;
  /* 没选音色时给它一个能直接用的：OpenAI 固定有一套；其他服务商的清单从它自己的接口取第一条 */
  let voice = clean(input.voice || (saved.provider === provider.id ? saved.voice || '' : ''));
  if (!voice && provider.id === 'openai') voice = 'marin';
  if (!voice) voice = (await providerVoices(provider.id))[0]?.id ?? '';
  if (!voice) throw new Error(`${provider.name} 需要指定音色 id：先在设置里选一个`);
  const out = String(input.name || 'voice').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 40) || 'voice';
  const result = await provider.run('tts', { out, text: input.text, voice }, {
    key: key.key,
    model,
    root: input.root,
    signal: input.signal ?? AbortSignal.timeout(10 * 60_000),
    say: () => {},
    read: async () => new Uint8Array(),
  });
  const file = result.files[0];
  if (!file || !file.bytes?.length) throw new Error(`${provider.name} 没有返回音频`);
  const ext = extname(file.path).replace('.', '') || 'wav';
  const row = /** @type {any} */ (result.index?.[0] ?? {});
  const seconds = Number(row.dur) > 0 ? Number(row.dur) : null;
  const words = Array.isArray(row.words) ? row.words : null;
  const cues = (words && cuesFromWords(words, input.text)) || (seconds ? spreadCues(input.text, seconds) : null);
  return { bytes: file.bytes, ext, seconds, cues, provider: provider.id, model: model ?? null, voice };
}

/**
 * 一个服务商的音色清单（走它的 voice verb，和 `openfilm get voice` 同一份结果）。
 * 连不上或没有 key 时返回空列表，不抛错，页面照常能切回本地。
 * @param {string} id
 */
export async function providerVoices(id) {
  const settings = await readSettings();
  const provider = listProviders().find((p) => p.id === id && p.verbs.includes('voice'));
  if (!provider) return [];
  const key = providerKey(provider, settings);
  if (!key) return [];
  try {
    const result = await provider.run('voice', { limit: 40 }, {
      key: key.key,
      model: provider.models?.tts?.[0]?.id,
      root: '',
      signal: AbortSignal.timeout(15_000),
      say: () => {},
      read: async () => new Uint8Array(),
    });
    const list = /** @type {any[]} */ (/** @type {any} */ (result.receipt)?.voices ?? []);
    return list.flatMap((one) => {
      const voiceId = String(one?.voiceId ?? one?.id ?? '');
      if (!voiceId) return [];
      return [{ id: voiceId, name: String(one?.name ?? voiceId), description: one?.description ? String(one.description) : null }];
    });
  } catch { return []; }
}
