// @ts-check
/**
 * 后台自己的 Agent 任务记录：~/.openfilm/agent-jobs.json。
 *
 * 页面关掉、刷新、Studio 重启后，任务和每一步（调了哪个 MCP 工具、参数、结果、耗时）都还在，
 * 后台的 Agent 页读的就是这一份。只记本机，不联网。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { studioHome } from '../projects.mjs';
import { writeAtomic } from '../atomic.mjs';

const FILE = () => join(studioHome(), 'agent-jobs.json');
const MAX = 60;

/** @typedef {{ id: string, text: string, mode: 'rule' | 'model', status: 'running' | 'done' | 'failed' | 'stopped',
 *   reply: string, error: string | null, at: number, endedAt: number | null, ms: number,
 *   steps: Array<{ tool: string, args: Record<string, unknown>, why: string, ok: boolean, error?: string, result?: unknown, ms: number }> }} AgentJob */

export async function readAgentJobs() {
  try {
    const raw = JSON.parse(await readFile(FILE(), 'utf8'));
    return Array.isArray(raw) ? raw.filter((one) => one && typeof one === 'object' && typeof one.id === 'string') : [];
  } catch { return []; }
}

/** 读改写串行：并发的轮询/步骤写盘不能互相覆盖（否则任务会被回滚成 running） */
let queue = Promise.resolve();
function serial(/** @type {() => Promise<AgentJob[]>} */ run) {
  const next = queue.then(run, run);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

async function write(/** @type {AgentJob[]} */ jobs) {
  await mkdir(dirname(FILE()), { recursive: true });
  await writeAtomic(FILE(), `${JSON.stringify(jobs.slice(0, MAX), null, 2)}\n`, 'utf8');
  return jobs.slice(0, MAX);
}

/** 新建一条（放最前）；同一个 id 再来就替换。 */
export async function saveAgentJob(/** @type {AgentJob} */ job) {
  return serial(async () => {
    const now = await readAgentJobs();
    return write([job, ...now.filter((one) => one.id !== job.id)]);
  });
}

/** 只改一条的字段（每完成一步就写一次，刷新页面能看到进度）。 */
export async function patchAgentJob(/** @type {string} */ id, /** @type {Partial<AgentJob>} */ patch) {
  return serial(async () => {
    const now = await readAgentJobs();
    const at = now.findIndex((one) => one.id === id);
    if (at < 0) return now;
    now[at] = { ...now[at], ...patch };
    return write(now);
  });
}

/** 批量补字段：任务结束时一次写盘，别和“每完成一步”的写盘抢。 */
export async function patchAgentJobs(/** @type {string[]} */ ids, /** @type {Partial<AgentJob>} */ patch) {
  return serial(async () => {
    const now = await readAgentJobs();
    const wanted = new Set(ids);
    let touched = false;
    for (let i = 0; i < now.length; i += 1) {
      if (!wanted.has(now[i].id)) continue;
      now[i] = { ...now[i], ...patch };
      touched = true;
    }
    return touched ? write(now) : now;
  });
}

export async function clearAgentJobs() {
  return serial(async () => write([]));
}
