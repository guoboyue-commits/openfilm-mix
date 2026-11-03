// @ts-check
/**
 * 成片索引：Studio 每完成一次视频导出，就在本机记一条（~/.openfilm/export-history.json）。
 *
 * 只为混剪后台的“成片管理”服务：重启 Studio 后仍能看到、预览、识别以前导出的片子。
 * 只记路径和元数据，不复制文件；文件被删掉时读的时候自然过滤掉。不联网。
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { studioHome } from './projects.mjs';
import { writeAtomic } from './atomic.mjs';

const FILE = () => join(studioHome(), 'export-history.json');
/** 留最近 500 条，够用又不至于无限长。 */
const MAX = 500;

const listOf = (/** @type {unknown} */ value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x) : []);

/** 读出全部记录（新到旧）；文件不在或读坏了就是空。 */
export async function readHistory() {
  try {
    const raw = JSON.parse(await readFile(FILE(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((one) => {
      if (!one || typeof one !== 'object') return [];
      /** @type {Record<string, any>} */
      const r = one;
      const outputs = listOf(r.outputs).filter((f) => /\.(mp4|mov|webm)$/i.test(f));
      if (!outputs.length || typeof r.project !== 'string') return [];
      return [{
        id: String(r.id ?? ''),
        project: r.project,
        projectName: String(r.projectName ?? r.name ?? ''),
        label: String(r.label ?? ''),
        kind: 'video',
        outputs,
        bytes: Number.isFinite(Number(r.bytes)) ? Number(r.bytes) : null,
        at: Number.isFinite(Number(r.at)) ? Number(r.at) : Date.now(),
      }];
    });
  } catch {
    return [];
  }
}

/** 记一次完成的导出；同一个 id 再来就替换。 */
export async function recordExport(/** @type {{ id?: unknown, project?: unknown, name?: unknown, label?: unknown, outputs?: unknown, bytes?: unknown, finishedAt?: unknown, at?: unknown }} */ job) {
  const outputs = listOf(job.outputs).filter((f) => /\.(mp4|mov|webm)$/i.test(f) && existsSync(f));
  if (!outputs.length || typeof job.project !== 'string') return;
  const id = String(job.id ?? '');
  const entry = {
    id,
    project: job.project,
    projectName: String(job.name ?? ''),
    label: String(job.label ?? ''),
    kind: 'video',
    outputs,
    bytes: Number.isFinite(Number(job.bytes)) ? Number(job.bytes) : null,
    at: Number.isFinite(Number(job.finishedAt)) ? Number(job.finishedAt) : Number(job.at) || Date.now(),
  };
  const now = await readHistory();
  const kept = now.filter((one) => one.id !== id || !id);
  kept.unshift(entry);
  await mkdir(dirname(FILE()), { recursive: true });
  await writeAtomic(FILE(), JSON.stringify(kept.slice(0, MAX), null, 2) + '\n', 'utf8');
}

/** 这个文件是不是这条工程导出过的成片（重启前的记录也算）。 */
export async function knownFilm(/** @type {string} */ projectId, /** @type {string} */ file) {
  return (await readHistory()).some((one) => one.project === projectId && one.outputs.includes(file));
}

/** 成片被删掉：索引里也拿掉，别留一条指向空文件的记录。 */
export async function forgetFilm(/** @type {string} */ file) {
  const now = await readHistory();
  const kept = now.map((one) => ({ ...one, outputs: one.outputs.filter((f) => f !== file) })).filter((one) => one.outputs.length);
  if (kept.length === now.length && now.every((one, i) => one.outputs.length === kept[i]?.outputs.length)) return;
  await writeAtomic(FILE(), JSON.stringify(kept, null, 2) + '\n', 'utf8');
}

/** 成片管理页要的列表：本机记得的、文件还在的视频，新到旧。 */
export async function listHistory() {
  const out = [];
  for (const one of await readHistory()) {
    for (const file of one.outputs) {
      if (!existsSync(file)) continue;
      out.push({ project: one.project, projectName: one.projectName, job: one.id, path: file, name: file.split(/[\\/]/).pop(),
        bytes: one.bytes ?? statSync(file).size, at: one.at, label: one.label });
    }
  }
  return out;
}
