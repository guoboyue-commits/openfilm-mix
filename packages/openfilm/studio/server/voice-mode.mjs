// @ts-check
/**
 * 配音的两个来源：本机 CosyVoice2，或自己 key 的云端服务商（OpenAI / ElevenLabs / Google / Groq / Azure）。
 * 模式存在 ~/.openfilm/voice.json，MCP、HTTP API 和页面共用这一份，换设备只需重新选一次。
 *
 * 两种来源产出同一种结果：assets/voice/ 里的一条音频 + 逐句 cues（字幕时间轴）+ 真实时长。
 * 云端没有逐字时间时，按句子长度把这条音频的时长分给每句，字幕仍然能对齐。
 */
import { studioHome } from './projects.mjs';
import { modelFor, providerKey, readSettings } from './keys.mjs';
import { listProviders } from './providers/index.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

export const VOICE_MODES = /** @type {const} */ (['local', 'api']);

/**
 * @typedef {{ mode: 'local' | 'api', provider: string | null, model: string | null, voice: string | null, localVoice?: string | null, apiVoice?: string | null }} VoiceSettings
 */

const file = () => join(studioHome(), 'voice.json');
const plain = (/** @type {unknown} */ v) => v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
const str = (/** @type {unknown} */ v) => typeof v === 'string' && v.trim() ? v.trim() : null;

/** 读保存的配音设置；文件不在就是本地模式。本地和 API 的音色分开记住，切换时互不冲掉。 */
export async function readVoiceSettings() {
  try {
    const raw = plain(JSON.parse(await readFile(file(), 'utf8')));
    const mode = raw.mode === 'api' ? 'api' : 'local';
    const localVoice = str(raw.localVoice) || (mode === 'local' ? str(raw.voice) : null) || 'n4';
    const apiVoice = str(raw.apiVoice) || (mode === 'api' ? str(raw.voice) : null);
    const activeVoice = mode === 'api' ? apiVoice : localVoice;
    return /** @type {VoiceSettings} */ ({
      mode,
      provider: str(raw.provider),
      model: str(raw.model),
      voice: activeVoice,
      localVoice,
      apiVoice,
    });
  } catch {
    return /** @type {VoiceSettings} */ ({ mode: 'local', provider: null, model: null, voice: 'n4', localVoice: 'n4', apiVoice: null });
  }
}

/** 改一部分设置并写回；只写认识的字段。 */
export async function saveVoiceSettings(/** @type {Partial<VoiceSettings>} */ patch) {
  const now = await readVoiceSettings();
  const mode = patch.mode === 'api' ? 'api' : patch.mode === 'local' ? 'local' : now.mode;
  let localVoice = patch.localVoice !== undefined ? (str(patch.localVoice) || 'n4') : (now.localVoice || 'n4');
  let apiVoice = patch.apiVoice !== undefined ? str(patch.apiVoice) : (now.apiVoice ?? null);
  if (patch.voice !== undefined) {
    if (mode === 'api') apiVoice = str(patch.voice);
    else localVoice = str(patch.voice) || 'n4';
  }
  const next = /** @type {VoiceSettings} */ ({
    mode,
    provider: patch.provider !== undefined ? str(patch.provider) : now.provider,
    model: patch.model !== undefined ? str(patch.model) : now.model,
    voice: mode === 'api' ? apiVoice : localVoice,
    localVoice,
    apiVoice,
  });
  await mkdir(studioHome(), { recursive: true });
  await writeAtomic(file(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 能配音的云端服务商：有 key 的排在前面，并带上已选的模型。 */
export async function apiVoiceProviders() {
  const settings = await readSettings();
  const saved = await readVoiceSettings();
  return {
    saved,
    providers: listProviders()
      .filter((p) => p.verbs.includes('tts'))
      .map((p) => ({
        id: p.id,
        name: p.name,
        connected: Boolean(providerKey(p, settings)),
        keysUrl: p.keysUrl,
        env: p.env,
        models: (p.models?.tts ?? []).map((m) => ({ id: m.id, name: m.name })),
        model: modelFor(settings, p, 'tts') ?? null,
      }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
  };
}
