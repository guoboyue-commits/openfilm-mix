// @ts-check
/**
 * 混剪后台的本地 Agent：把一句自然语言变成对 MCP 工具的一次次调用。
 *
 * 两种"大脑"，都由本机驱动，不联网：
 * 1. 规则规划器（默认）：中文/英文关键词 → 工具序列。听懂"识别/打标/出片/看看有哪些素材"这类后台动作，
 *    并把上一步的结果（例如识别出的标签）带进下一步。
 * 2. 本地模型（可选）：任何 OpenAI 兼容的本地端点，例如 Ollama 的 http://127.0.0.1:11434/v1、
 *    LM Studio 的 http://127.0.0.1:1234/v1。模型自己决定调哪个工具，后台只做循环和校验。
 *
 * 这里不直接碰文件：所有动作都走 mcp/tools.mjs 里同一套工具，和外部 agent（Codex / Claude Desktop / Cursor）
 * 调 MCP 时走的是同一段代码。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** @typedef {{ name: string, description: string, inputSchema: Record<string, unknown> }} Tool */
/** @typedef {(args: Record<string, any>) => Promise<unknown>} Call */

export const DEFAULT_MODEL = { kind: 'none', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' };

/** 规划器能看懂的工程上下文；由调用方从素材库读出。 */
const projectOf = (/** @type {any} */ context) => context.libraryId ?? context.project ?? '混剪素材库';

/** 本机 agent 的配置：~/.openfilm/agent.json，或环境变量 OPENFILM_AGENT_ENDPOINT / OPENFILM_AGENT_MODEL。 */
export async function readAgentConfig() {
  /** @type {{ kind: 'none' | 'local', endpoint: string, model: string, apiKey?: string }} */
  const config = /** @type {{ kind: 'none' | 'local', endpoint: string, model: string, apiKey?: string }} */ ({ ...DEFAULT_MODEL });
  try {
    const raw = JSON.parse(await readFile(join(homedir(), '.openfilm', 'agent.json'), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.kind === 'local' || raw.kind === 'none') config.kind = raw.kind;
      if (typeof raw.endpoint === 'string' && raw.endpoint) config.endpoint = raw.endpoint.replace(/\/+$/, '');
      if (typeof raw.model === 'string' && raw.model) config.model = raw.model;
      if (typeof raw.apiKey === 'string' && raw.apiKey) config.apiKey = raw.apiKey;
    }
  } catch { /* 没配置：规则规划器 */ }
  if (process.env.OPENFILM_AGENT_ENDPOINT) { config.kind = 'local'; config.endpoint = process.env.OPENFILM_AGENT_ENDPOINT.replace(/\/+$/, ''); }
  if (process.env.OPENFILM_AGENT_MODEL) config.model = process.env.OPENFILM_AGENT_MODEL;
  return config;
}

/** 问本地端点有没有在跑、有哪些模型（只连 127.0.0.1 / localhost）。 */
export async function probeLocalModel(/** @type {{ endpoint: string, model: string }} */ config, timeout = 1500) {
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(`${config.endpoint}/`);
  if (!local) return { ok: false, models: [], error: '只允许本机地址（127.0.0.1 / localhost）' };
  try {
    const res = await fetch(`${config.endpoint}/models`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    const models = Array.isArray(body?.data) ? body.data.map((/** @type {any} */ one) => String(one?.id ?? '')).filter(Boolean) : [];
    return { ok: true, models, error: null, chosen: models.includes(config.model) ? config.model : models[0] ?? null };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const clean = (/** @type {string} */ text) => text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** 从一句话里找素材名：英文/数字文件名，或带扩展名的名字。 */
function namedFiles(/** @type {string} */ text, /** @type {Array<{ path: string, name: string }>} */ assets) {
  const lower = text.toLowerCase();
  return assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    return lower.includes(name) || lower.includes(name.replace(/\.[a-z0-9]+$/, ''));
  }).map((asset) => asset.path);
}

/** 一句话里提到的已有标签（只认素材上真实存在的标签）。 */
function knownTagsIn(/** @type {string} */ text, /** @type {string[]} */ known) {
  /* 之前误打出来的拼接标签（如“产品、的素材生成”）不能再被当成有效标签 */
  return known.filter((tag) => tag.length >= 2 && tag.length <= 8 && text.includes(tag) && !/[、，,]\s*的/.test(tag));
}

/** 带任一指定标签的素材。 */
function assetsWithTags(/** @type {Array<{ path: string, tags?: string[] }>} */ assets, /** @type {string[]} */ tags) {
  return assets.filter((asset) => (asset.tags ?? []).some((tag) => tags.includes(tag))).map((asset) => asset.path);
}

/** 从一句话里找标签：先把"打上 xx 标签"里的词拆出来，再和已有标签对上。 */
function namedTags(/** @type {string} */ text, /** @type {string[]} */ known) {
  const removing = /去掉|删除|移除|remove/i.test(text);
  /** @type {string[]} */
  let found = [];
  if (removing) {
    /* “去掉高光标签”：只认去掉/删除后面那一段里的已有标签 */
    const after = text.slice(0, text.search(/去掉|删除|移除|remove/i)).replace(/标签/g, '');
    found = known.filter((tag) => tag.length <= 6 && after.includes(tag));
  } else {
    /* “把产品镜头标成卖点”：产品是在筛素材，只有“标成/打上”后面才是新标签 */
    const afterVerb = text.search(/标成|标记为|打上|加上|标签(?:是|为)/);
    const target = afterVerb >= 0 ? text.slice(afterVerb) : text;
    found = known.filter((tag) => tag.length <= 6 && target.includes(tag));
    const asked = /(?:打上|加上|标记为|标成|标签(?:是|为)?|tag(?:ged)?(?: as| with)?)\s*[：:]?\s*[“\"']?([^\s，。,.；;、”\"']+)/i.exec(text);
    if (asked?.[1]) found.push(...asked[1].split(/[、/／|]/).map((one) => clean(one).replace(/标签$/, '')).filter(Boolean));
  }
  return [...new Set(found)].slice(0, 12);
}


/** 从一句话里读数量和时长："3 条"、"三条"、"20 秒"、"15s"。 */
function numbers(/** @type {string} */ text) {
  const zh = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const count = /(\d+)\s*(?:条|个视频|版|支)/.exec(text)?.[1]
    ?? /([一二两三四五六七八九十])\s*(?:条|个视频|版|支)/.exec(text)?.[1];
  const seconds = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(text)?.[1];
  return {
    count: count ? Math.max(1, Math.min(12, Number(zh[/** @type {keyof typeof zh} */ (count)] ?? count))) : null,
    seconds: seconds ? Math.max(3, Math.min(300, Number(seconds))) : null,
  };
}

/** 配音触发词：一句话里出现这些，后面那一段就是台词。 */
const VOICE_TRIGGER = /(?:配音|旁白|口播|朗读|配音稿|tts|念一?段|说一?段|读一?下|念一?下)/i;

/**
 * 把一句话拆成“台词”和“剩下要干的事”。
 * 台词边界：引号优先；没引号就在“然后/接着/再/并 + 生成|出片|混剪|导出|加字幕…”处截断。
 * 返回 null 表示这句里没有要念的内容。
 * @param {string} said
 * @returns {{ line: string, start: number, end: number, voiceId?: string } | null}
 */
function spokenPart(said) {
  const hit = VOICE_TRIGGER.exec(said);
  if (!hit) return null;
  const tail = said.slice(hit.index + hit[0].length);
  /** @type {string} */
  let line = '';
  let start = -1;
  let end = -1;
  const quote = /["“「『]([^"”」』]{1,800})["”」』]/.exec(tail);
  if (quote) {
    line = quote[1].trim();
    start = hit.index + hit[0].length + quote.index;
    end = start + quote[0].length;
  } else {
    /* 跳过“：”“这段”“一句”这类引导词 */
    /* 只跳过真正的引导词；单独的“这”是指示代词（“这款支架…”），不能吃 */
    const lead = /^[：:\s，,]*(?:(?:这?段|一?句|下面|如下|的内容)[：:\s，,]*)?/.exec(tail);
    const from = hit.index + hit[0].length + (lead ? lead[0].length : 0);
    const body = said.slice(from);
    /* 台词到此为止：后面接的是下一步动作，不是要念的字 */
    const cut = /(?:[，,；;。]\s*)?(?:然后|接着|之后|再|并|同时)\s*(?:生成|出片|混剪|导出|渲染|加字幕|烧字幕|配字幕|做一?条|剪一?条|来一?条)|(?:[，,；;。]\s*)(?:生成|出片|混剪|导出|渲染|加字幕|烧字幕|配字幕)/.exec(body);
    /* 只去掉句末的逗号/分号/顿号：句号、问号、叹号要留给 TTS，收尾语调靠它 */
    line = (cut ? body.slice(0, cut.index) : body).replace(/[，,；;、]+$/, '').trim();
    start = from;
    end = cut ? from + cut.index : said.length;
  }
  /* 引号里的短句也算（“稳”就是一个字的口播） */
  if (line.length < (quote ? 1 : 2)) return null;
  /* 音色：音色 c2 / 用 c2 的声音 / voice: a3 */
  const voiceId = /(?:音色|声音|voice)\s*[:：]?\s*([a-z]\d{1,2})/i.exec(said)?.[1]
    ?? /\b([a-z]\d{1,2})\s*(?:音色|的声音)/i.exec(said)?.[1];
  return { line, start, end, ...(voiceId ? { voiceId: voiceId.toLowerCase() } : {}) };
}

/**
 * 规则规划：把一句话拆成工具调用。返回 { steps: [{ tool, args, why }], reply }。
 * `context`：素材列表、已有标签、最近一次识别的标签、成片数量。
 */
/** @typedef {{ libraryId?: string, project?: string, assets: Array<{ path: string, name: string, kind?: string, tags?: string[] }>, tags: string[], outputs: number }} AgentContext */

/** @param {string} text @param {AgentContext} context */
export function planFromText(text, context) {
  /** @type {Array<{ tool: string, args: Record<string, any>, why: string }>} */
  const steps = [];
  /* 先摘台词：台词里也可能出现“生成/导出”，摘掉之后再判断后面要做什么 */
  let said = clean(text);
  const voice = spokenPart(said);
  if (voice) {
    steps.push({ tool: 'make_voice', args: { project: projectOf(context), text: voice.line, ...(voice.voiceId ? { voice: voice.voiceId } : {}) }, why: `本地配音 ${voice.line.length} 字 → 一条 wav` });
    said = `${said.slice(0, voice.start)} ${said.slice(voice.end)}`.replace(/\s+/g, ' ').trim();
  }
  const lower = said.toLowerCase();
  const { count, seconds } = numbers(said);
  /** 用户点名了某个标签（“用产品素材”“只要口播镜头”） */
  /* 只认素材上真实挂着的标签；之前误打出来的拼接标签（“的素材生成”）不算 */
  const assetTags = [...new Set(/** @type {Array<{ tags?: string[] }>} */ (context.assets).flatMap((asset) => asset.tags ?? []))].filter((tag) => !/的素材|的镜头|的片段/.test(tag));
  const byTag = knownTagsIn(said, assetTags);
  const wants = {
    analyze: /识别|分析|看看内容|看懂|转写|字幕|时间线|analy[sz]e|transcri/i.test(said) && !/加字幕|烧字幕|配字幕|字幕烧|打上字幕|带字幕/i.test(said),
    /* “只用产品标签的素材”是在筛素材，不是在改标签 */
    tag: /打标|标签|标成|标记|tag/i.test(said) && !/只用|只要|仅用|仅要|筛选|挑出|带.{0,6}标签的素材|标签的素材/i.test(said),
    outputs: /成片|导出|output|film/i.test(said),
    /* 看/检查/质检成片内容，而不是生成 */
    inspect: /质检|检查|体检|看看成片|看成片|分析成片|成片内容|黑帧|静音|inspect|quality/i.test(said),
    list: /有哪些|素材|库存|列表|多少|library|asset/i.test(said),
    /* “看成片/质检成片”不是生成 */
    /* “给这条成片加字幕”只是在加字幕，不是要重新出片：除非句子里有生成类动词 */
    mix: /混剪|成片|出片|生成|剪一|做一|mix|render|generate/i.test(said)
      && !/质检|检查|体检|看看成片|看成片|分析成片|成片内容|黑帧|静音|inspect|quality/i.test(said)
      && !(/加字幕|烧字幕|配字幕|字幕烧|打上字幕|带字幕/i.test(said) && !/生成|混剪|出片|剪一|做一|来一?条|make|render/i.test(said)),
    /* 烧字幕：把字幕压进画面 */
    subtitles: /加字幕|烧字幕|配字幕|字幕烧|打上字幕|带字幕|出海字幕|subtitles?/i.test(said),
  };
  const paths = namedFiles(said, context.assets);
  const tags = namedTags(said, context.tags).filter((tag) => !/的素材|的镜头|的片段/.test(tag));

  /* 只说“打标/去掉标签”时不重跑识别：识别很慢，人已经识别过 */
  if (wants.analyze && context.assets.length) {
    const target = paths.length ? paths : context.assets.map((/** @type {{ path: string }} */ a) => a.path);
    steps.push({ tool: 'analyze_assets', args: { project: projectOf(context), paths: target, applyTags: true }, why: `本地识别 ${target.length} 个素材，写时间线和标签` });
    if (tags.length) {
      const remove = /去掉|删除|移除|remove/i.test(said);
    const loose = clean(said.replace(/^.*?(?:去掉|删除|移除|打上|加上|标记为|标成|标签(?:是|为)?)\s*/i, '').replace(/标签$/, ''));
    /* 只认已有标签，或“打上/标成 xx”后面那个短词；不要把整句当标签 */
    const names = tags.length ? tags : loose && loose.length <= 12 && !/[，。,.\s]/.test(loose) ? [loose] : [];
    steps.push({ tool: 'tag_assets', args: { project: projectOf(context), paths: target, tags: names, mode: remove ? 'remove' : 'add' }, why: names.length ? `给这些素材${remove ? '去掉' : '加上'} ${names.join('、')}` : '给这些素材改标签' });
    }
    return { steps, reply: tags.length ? `识别素材并打上 ${tags.join('、')}` : '识别素材内容，写入时间线和标签' };
  }
  /* “标成卖点，看看成片”= 先打标，再列出成片 */
  const thenOutputs = /看看成片|看成片|列出成片|有哪些成片|list outputs/i.test(said);
  if (wants.tag) {
    const tagged = byTag.length ? assetsWithTags(context.assets, byTag) : [];
    const target = paths.length ? paths : tagged.length ? tagged : context.assets.map((/** @type {{ path: string }} */ a) => a.path);
    steps.push({ tool: 'tag_assets', args: { project: projectOf(context), paths: target, tags, mode: /去掉|删除|移除|remove/i.test(said) ? 'remove' : 'add' }, why: `给 ${target.length} 个素材改标签` });
    if (thenOutputs) steps.push({ tool: 'list_outputs', args: {}, why: '打完标签后看看本机成片' });
    return { steps, reply: `${/去掉|删除|移除|remove/i.test(said) ? '去掉' : '打上'} ${tags.join('、')} 标签${thenOutputs ? '，再列成片' : ''}` };
  }
  /* 成片质检：先列成片，再本地看成片内容 */
  if (wants.inspect && !wants.mix) {
    steps.push({ tool: 'list_outputs', args: {}, why: '先看本机有哪些成片' });
    steps.push({ tool: 'analyze_outputs', args: count ? { limit: count } : {}, why: `本地看成片内容：0.01 秒级时间线 + 黑帧/静音/时长/抖动/分辨率${count ? `（${count} 条）` : '（默认最近 3 条）'}` });
    return { steps, reply: '看成片内容并质检' };
  }
  /* 只加字幕：把最近一条成片烧上字幕，不用重新生成 */
  if (wants.subtitles && !wants.mix) {
    steps.push({ tool: 'list_outputs', args: {}, why: '先找最近导出的成片' });
    steps.push({ tool: 'burn_subtitles', args: { file: '@lastOutput', project: projectOf(context) }, why: '用本机 ffmpeg 把字幕压进画面（取素材库最近一条配音的逐句时间轴）' });
    return { steps, reply: '给最近一条成片加字幕' };
  }
  if (wants.mix) {
    const tagged = byTag.length ? assetsWithTags(context.assets, byTag) : [];
    /* 出片只用画面：素材库里的 wav（包括刚生成的配音）不是镜头 */
    const pictures = context.assets.filter((/** @type {{ kind?: string }} */ a) => a.kind !== 'audio').map((/** @type {{ path: string }} */ a) => a.path);
    const picked = paths.filter((/** @type {string} */ one) => pictures.includes(one));
    const target = picked.length ? picked : tagged.length ? tagged : pictures;
    /* 先配音再出片：画面时长跟配音走 */
    const withVoice = steps.some((step) => step.tool === 'make_voice');
    steps.push({
      tool: 'generate_mix',
      args: {
        project: projectOf(context), paths: target,
        /* 有配音时画面按配音时长铺满，用户没说秒数就不强塞 20 秒 */
        seconds: seconds ?? (withVoice ? undefined : 20),
        count: count ?? 1,
        aspect: /横屏|16:9/.test(said) ? '16:9' : '9:16',
        pace: /快|fast/.test(lower) ? 'fast' : /慢|缓|slow/.test(lower) ? 'slow' : 'normal',
        name: /叫|命名|name/.test(said) ? said.replace(/^.*?(?:叫|命名)\s*/, '').slice(0, 40) : undefined,
        ...(withVoice ? (seconds ? { voice: '@voice' } : { voice: '@voice', voiceMatch: true }) : {}),
      },
      why: `用 ${target.length} 个素材${byTag.length ? `（标签 ${byTag.join('、')}）` : ''}生成 ${count ?? 1} 条${withVoice ? '跟配音等长' : ` ${seconds ?? 20} 秒`}成片`,
    });
    /* 说了“加字幕”但没配音：也要导出一次，好把字幕压进去 */
    const exporting = /导出|渲染|出片|export|render/i.test(said) || wants.subtitles;
    /* 说了“加字幕”，或者这条成片本来就有配音：直接把逐句字幕烧进去 */
    const wantSubs = wants.subtitles || withVoice;
    if (exporting) steps.push({
      tool: 'export_film',
      args: {
        projects: 'last',
        folder: /导出到/.test(said) ? said.replace(/^.*?导出到\s*/, '').trim() : undefined,
        ...(wantSubs ? { subtitles: '@cues' } : {}),
      },
      why: wantSubs ? '导出并烧上逐句字幕' : '把刚生成的工程渲染成 MP4',
    });
    return { steps, reply: `${withVoice ? '配音 + ' : ''}${exporting ? '生成并导出' : '生成'} ${count ?? 1} 条混剪${exporting ? '成片' : '工程'}` };
  }
  if (wants.outputs) {
    steps.push({ tool: 'list_outputs', args: {}, why: '看看本机有哪些成片' });
    return { steps, reply: '列出成片' };
  }
  /* 只说了配音：出完这条就收尾，别再去列素材 */
  if (voice) {
    return { steps, reply: `本地配音：${voice.line.slice(0, 24)}${voice.line.length > 24 ? '…' : ''}` };
  }
  steps.push({ tool: 'list_assets', args: { project: projectOf(context) }, why: '看看素材库里有什么' });
  return { steps, reply: `素材库有 ${context.assets.length} 个素材、${context.tags.length} 个标签、${context.outputs} 条成片` };
}

/**
 * 让本地模型决定下一步。返回 { tool, args } 或 { done, reply }。
 * 模型只看到工具名/说明/参数，不接触文件系统。
 */
export async function askModel(/** @type {{ endpoint: string, model: string, apiKey?: string }} */ config, /** @type {string} */ text, /** @type {Array<Tool>} */ tools, /** @type {Array<{ role: string, content: string }>} */ history, /** @type {AbortSignal | undefined} */ signal) {
  const system = [
    '你是本地混剪后台的 agent。只能调用给定的工具，不要编造素材名。',
    '流程：先 list_assets 看素材，再按用户要求 analyze_assets / tag_assets / generate_mix / list_outputs。',
    '一次只调用一个工具。参数必须来自工具 schema 和已有素材路径。',
    '任务完成后不再调用工具，用中文简短汇报。',
  ].join('\n');
  const body = {
    model: config.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: text },
    ],
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    tool_choice: 'auto',
  };
  const res = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`本地模型回答 ${res.status}：${(await res.text()).slice(0, 300)}`);
  const answer = await res.json();
  const message = answer?.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];
  /** @type {{ tool?: string, args?: Record<string, any>, done?: boolean, reply?: string, raw?: unknown }} */
  let next = {};
  if (call?.function?.name) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
    next = { tool: String(call.function.name), args, raw: message };
  } else {
    next = { done: true, reply: String(message?.content ?? '').trim() || '完成', raw: message };
  }
  return next;
}

/**
 * 跑一次 agent 任务：模型模式自己循环（最多 8 步），规则模式按计划顺序执行。
 * `onStep` 每完成一步回调；`call` 是 MCP 工具的执行函数。
 */
/** @param {{ text: string, context: AgentContext, tools: Array<Tool>, call: (name: string, args: Record<string, any>) => Promise<unknown>, config: { kind: 'none' | 'local', endpoint: string, model: string, apiKey?: string }, onStep?: (step: any) => void, signal?: AbortSignal }} input */
export async function runAgent({ text, context, tools, call, config, onStep = () => {}, signal }) {
  const started = Date.now();
  /** @type {Array<{ tool: string, args: Record<string, any>, why: string, ok: boolean, result?: unknown, error?: string, ms: number }>} */
  const steps = [];
  /** @type {{ made: string[], voice: string | null, voiceSeconds: number | null, cues: Array<{ text: string, start: number, end: number }> | null, lastOutput: string | null }} */
  const state = { made: [], voice: null, voiceSeconds: null, cues: null, lastOutput: null };
  if (config.kind === 'local') {
    const history = [];
    for (let i = 0; i < 8; i += 1) {
      if (signal?.aborted) throw new Error('已停止');
      const at = Date.now();
      const next = await askModel(config, i === 0 ? text : '继续下一步；完成时直接汇报。', tools, history, signal);
      if (!next.tool) return { mode: 'model', reply: next.reply ?? '完成', steps, ms: Date.now() - started };
      const toolName = next.tool;
      const toolArgs = next.args ?? {};
      if (toolName === 'export_film' && !toolArgs.projects && state.made.length) toolArgs.projects = state.made;
      let result, error;
      try { result = await call(toolName, toolArgs); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      const out = /** @type {{ made?: Array<{ project: string }> }} */ (result);
      if (!error && toolName === 'generate_mix' && Array.isArray(out.made)) state.made = out.made.map((one) => one.project);
      const step = { tool: toolName, args: toolArgs, why: '本地模型决定', ok: !error, ...(error ? { error } : { result }), ms: Date.now() - at };
      steps.push(step);
      onStep(step);
      history.push({ role: 'assistant', content: JSON.stringify({ tool: toolName, args: toolArgs }) });
      history.push({ role: 'user', content: `工具结果：${JSON.stringify(error ? { error } : result).slice(0, 4000)}` });
    }
    return { mode: 'model', reply: '达到 8 步上限，先停在这里。', steps, ms: Date.now() - started };
  }
  const plan = planFromText(text, context);
  let reply = plan.reply;
  /** 生成/导出过程中的细粒度进度（页面和 HTTP 轮询用） */
  let lastProgress = '';
  const progress = (/** @type {any} */ step) => {
    /* 每 500ms 一次心跳，进度没变就不重复推 */
    const key = `${step?.project ?? ''}:${step?.status ?? ''}:${Math.round((Number(step?.progress) || 0) * 100)}`;
    if (key === lastProgress) return;
    lastProgress = key;
    onStep({ tool: 'progress', args: {}, why: step?.name ? `${step.name} · ${step.status}` : String(step?.status ?? ''), ok: true, result: step, ms: 0 });
  };
  for (const step of plan.steps) {
    if (signal?.aborted) throw new Error('已停止');
    const at = Date.now();
    const args = resolveStepArgs(step, state);
    let result, error;
    try { result = await call(step.tool, { ...args, ...(step.tool === 'export_film' || step.tool === 'generate_mix' ? { onProgress: progress } : {}) }); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    if (!error) {
      const out = /** @type {{ made?: Array<{ project: string }>, outputs?: string[], file?: string }} */ (result);
      if (step.tool === 'generate_mix' && Array.isArray(out.made)) state.made = out.made.map((one) => one.project);
      if (Array.isArray(out.outputs) && out.outputs.length && (step.tool === 'export_film' || step.tool === 'burn_subtitles')) state.lastOutput = out.outputs?.[0] ?? out.file ?? null;
      if (step.tool === 'export_film' && Array.isArray(out.outputs)) {
        const voiceBit = state.voiceSeconds ? `（配音 ${state.voiceSeconds.toFixed(2)}s）` : '';
        reply = `已导出 ${out.outputs.length} 个文件${voiceBit}`;
      }
      if (step.tool === 'analyze_outputs') reply = qualityReply(/** @type {any} */ (out));
      if (step.tool === 'list_outputs') {
        const rows = /** @type {Array<string | { path?: string }>} */ (/** @type {any} */ (out)?.outputs ?? []);
        const newest = rows[0];
        state.lastOutput = typeof newest === 'string' ? newest : (newest?.path ?? null);
      }
      if (step.tool === 'make_voice') {
        const voice = /** @type {{ path?: string, seconds?: number | null, score?: number | null, cues?: Array<{ text: string, start: number, end: number }> | null }} */ (out);
        state.voice = typeof voice.path === 'string' ? voice.path : null;
        state.voiceSeconds = Number(voice.seconds) > 0 ? Number(voice.seconds) : null;
        state.cues = Array.isArray(voice.cues) && voice.cues.length ? voice.cues : null;
        /* 后面还有出片/导出时，别让这句把最终结论盖掉 */
        if (plan.steps.length === 1) reply = `配音已生成：${voice.path ?? ''}${voice.seconds ? `（${voice.seconds.toFixed(2)}s）` : ''}`;
      }
    }
    const done = { ...step, args, ok: !error, ...(error ? { error } : { result }), ms: Date.now() - at };
    steps.push(done);
    onStep(done);
    /* 配音是这条片子的前提：念不出来就别接着出无声音的片子 */
    if (error && step.tool === 'make_voice') {
      throw new Error(`配音失败，已停下：${error}`);
    }
  }
  return { mode: 'rule', reply, steps: steps.filter((/** @type {any} */ one) => one.tool !== 'progress'), ms: Date.now() - started };
}

/** 成片质检的一句话结论：几条通过、几条要修，问题列出来。 */
function qualityReply(/** @type {{ results?: Array<{ ok: boolean, quality?: { ok?: boolean, issues?: Array<{ level: string, text: string }> } | null }> }} */ out) {
  const rows = Array.isArray(out?.results) ? out.results : [];
  if (!rows.length) return '没有看成片';
  const bad = rows.filter((one) => one.quality && one.quality.ok === false);
  const issues = rows.flatMap((one) => (one.quality?.issues ?? []).filter((issue) => issue.level !== 'info').map((issue) => issue.text));
  const head = `看了 ${rows.length} 条成片：${rows.length - bad.length} 条通过${bad.length ? `，${bad.length} 条要修` : ''}`;
  return issues.length ? `${head}。${issues.slice(0, 4).join('；')}` : head;
}

/** “最近一批”在规则模式下就是上一步 generate_mix 生成的工程。 */
/** @param {{ tool: string, args: Record<string, any> }} step @param {{ made: string[], voice: string | null, voiceSeconds: number | null, cues: Array<{ text: string, start: number, end: number }> | null, lastOutput: string | null }} state */
function resolveStepArgs(step, state) {
  /** @type {Record<string, any>} */
  const args = { ...(step.args ?? {}) };
  /* 配音占位：上一步 make_voice 的真实路径和时长 */
  for (const [key, value] of Object.entries(args)) {
    if (value === '@voice') {
      if (state.voice) args[key] = state.voice;
      else delete args[key];
    } else if (value === '@voiceSeconds') {
      if (state.voiceSeconds) args[key] = state.voiceSeconds;
      else delete args[key];
    } else if (value === '@cues') {
      if (Array.isArray(state.cues) && state.cues.length) args[key] = state.cues;
      else delete args[key];
    } else if (value === '@lastOutput') {
      if (state.lastOutput) args[key] = state.lastOutput;
      else delete args[key];
    }
  }
  if (step.tool !== 'export_film' || args.projects !== 'last') return args;
  const { projects: _last, ...rest } = args;
  return state.made.length ? { ...rest, projects: state.made } : rest;
}
