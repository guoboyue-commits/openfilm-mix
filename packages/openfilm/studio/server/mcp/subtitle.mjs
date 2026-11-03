// @ts-check
/**
 * 本地字幕：把配音的逐句时间轴写成 ASS，再用本机 ffmpeg 烧进成片。
 * 不联网，不改工程，只产出新的 mp4。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** 秒 → ASS 时间戳 h:mm:ss.cc */
export function assTime(/** @type {number} */ seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs === 100 ? 99 : cs)}`;
}

/** 一条字幕太长就按字数折成两三行，别糊满屏幕 */
function wrap(/** @type {string} */ text, /** @type {number} */ perLine = 14) {
  const clean = String(text ?? '').replace(/\s+/g, '').trim();
  if (clean.length <= perLine) return clean;
  const lines = [];
  for (let i = 0; i < clean.length; i += perLine) lines.push(clean.slice(i, i + perLine));
  return lines.slice(0, 3).join('\\N');
}

/**
 * 生成 ASS 字幕文件内容。
 * @param {Array<{ text: string, start: number, end: number }>} cues
 * @param {{ width?: number, height?: number, fontSize?: number, color?: string, bottom?: number }} [style]
 */
export function cuesToAss(cues, style = {}) {
  const w = Number(style.width) > 0 ? Number(style.width) : 1080;
  const h = Number(style.height) > 0 ? Number(style.height) : 1920;
  const size = Number(style.fontSize) > 0 ? Number(style.fontSize) : Math.round(w / 26);
  const perLine = Math.max(8, Math.round(w / 72));
  /* 字幕贴底比例：默认 14%（抖音底部安全区附近）；素材底部自带文案时抬到 20% 左右，别压在一起 */
  const bottom = Number(style.bottom) > 0 && Number(style.bottom) < 0.6 ? Number(style.bottom) : 0.14;
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 12))},1,2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${Math.round(h * bottom)},134`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const rows = cues
    .filter((cue) => String(cue?.text ?? '').trim() && Number(cue.end) > Number(cue.start))
    .map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${wrap(cue.text, perLine)}`);
  return `${head.join('\n')}\n${rows.join('\n')}\n`;
}

/** 跑一次 ffmpeg，必要时把 stderr 一起带出来 */
function ffmpeg(/** @type {string[]} */ args, /** @type {string} */ cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { cwd, windowsHide: true });
    let err = '';
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (e) => reject(new Error(`ffmpeg 起不来：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`ffmpeg 退出码 ${code}：${err.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });
}

/**
 * 读源视频的编码参数：按码率和 CRF 大致对应关系选重编码质量。
 * 二次编码最怕比源还低：CRF 20 遇到 high/master 导出的片子，画质会掉一档。
 */
async function probeSource(/** @type {string} */ video) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,bit_rate', '-show_entries', 'format=bit_rate',
      '-of', 'json', video], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => resolve({}));
    child.on('close', () => {
      try {
        const said = JSON.parse(out);
        const stream = said?.streams?.[0] ?? {};
        resolve({
          width: Number(stream.width) || 0,
          height: Number(stream.height) || 0,
          /** bits per second */
          bps: Number(stream.bit_rate || said?.format?.bit_rate) || 0,
        });
      } catch { resolve({}); }
    });
  });
}

/** 源码率足够高就用更小的 CRF，避免字幕这步把画质压掉一档。 */
function crfFor(/** @type {{ width?: number, height?: number, bps?: number }} */ src) {
  const px = (Number(src.width) || 0) * (Number(src.height) || 0);
  const bps = Number(src.bps) || 0;
  if (!px || !bps) return 20;
  /* 每像素每帧多少 bit；和导出侧的 high=0.11 / master=0.2 同一条尺子 */
  const bpp = bps / (px * 30);
  if (bpp >= 0.16) return 14;
  if (bpp >= 0.09) return 18;
  return 20;
}

/**
 * 把字幕烧进成片，产物是旁边一个「… 字幕.mp4」。
 * @param {string} video 成片绝对路径
 * @param {Array<{ text: string, start: number, end: number }>} cues
 * @param {{ width?: number, height?: number, fontSize?: number, bottom?: number }} [style]
 */
export async function burnSubtitles(video, cues, style = {}) {
  if (!Array.isArray(cues) || !cues.length) throw new Error('没有字幕时间轴，先配音（make_voice 会带逐句时间）');
  const dir = await mkdtemp(join(tmpdir(), 'openfilm-subs-'));
  try {
    /* 用相对路径 + cwd，避开 Windows 上字幕滤镜的盘符转义坑 */
    await writeFile(join(dir, 'subs.ass'), cuesToAss(cues, style), 'utf8');
    const out = join(dirname(video), `${basename(video, extname(video))} 字幕.mp4`);
    /* 字幕要重编码视频；按源码率挑 CRF，别让烧字幕这一步把画质压低一档 */
    const src = await probeSource(video);
    const crf = crfFor(src);
    await ffmpeg([
      '-i', video,
      '-vf', 'ass=subs.ass',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', out,
    ], dir);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
