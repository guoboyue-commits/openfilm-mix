// @ts-check
/**
 * 后台的本地 Agent：页面发一句话 → 这里用同一套 MCP 工具执行，并把每一步写进 agent-jobs.json。
 *
 * 规则模式不需要任何模型；模型模式连本机 OpenAI 兼容端点（Ollama / LM Studio），端点只允许 127.0.0.1。
 */
import { randomBytes } from 'node:crypto';
import { readAgentConfig, probeLocalModel, runAgent, planFromText } from './agent.mjs';
import { createCaller, toolTable, LIBRARY_NAME, listAssets, listOutputs } from './tools.mjs';
import { projectById } from '../projects.mjs';
import { analyzeStatus } from '../batch-analyze.mjs';
import { patchAgentJob, patchAgentJobs, readAgentJobs, saveAgentJob, clearAgentJobs } from './store.mjs';

/** @type {Map<string, AbortController & { steps: () => any[] }>} */
const running = new Map();

/** 页面要的上下文：素材、标签、成片数，以及 agent 能用的工具。 */
export async function agentContext(/** @type {string | undefined} */ projectId) {
  const listing = await listAssets(projectId || LIBRARY_NAME);
  /* 旧数据里可能残留拼接标签（“的素材生成”），页面和规划器都不再把它当标签 */
  const tags = [...new Set(listing.assets.flatMap((asset) => asset.tags))].filter((tag) => !/的素材|的镜头|的片段/.test(tag));
  const outputs = await listOutputs();
  const config = await readAgentConfig();
  return {
    libraryId: listing.project.id,
    libraryName: listing.project.name,
    assets: listing.assets.map((asset) => ({ path: asset.path, name: asset.name, kind: asset.kind, tags: asset.tags, analyzed: asset.analyzed })),
    tags,
    outputs: outputs.length,
    config,
  };
}

/** 本机识别引擎：python + faster-whisper 是否就绪（只读状态，不跑识别）。 */
async function analyzeReady() {
  try {
    const status = await analyzeStatus();
    return { ok: Boolean(status?.ok), python: status?.python ?? null, whisper: status?.whisper ?? null, ffmpeg: status?.ffmpeg ?? null, engine: 'ffmpeg + faster-whisper' };
  } catch (e) {
    return { ok: false, engine: 'ffmpeg + faster-whisper', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 外部 agent 最近调过哪些 MCP 工具。 */
async function recentMcpCalls() {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { studioHome } = await import('../projects.mjs');
    const raw = JSON.parse(await readFile(join(studioHome(), 'mcp-calls.json'), 'utf8'));
    return Array.isArray(raw) ? raw.slice(0, 8) : [];
  } catch { return []; }
}

export async function agentStatus() {
  const config = await readAgentConfig();
  const model = await probeLocalModel(config);
  const [analyze, calls] = await Promise.all([analyzeReady(), recentMcpCalls()]);
  return {
    analyze,
    mcp: { transport: 'stdio', calls },
    kind: config.kind,
    endpoint: config.endpoint,
    model: model.chosen ?? config.model,
    models: model.models,
    local: model.ok,
    error: model.ok ? null : model.error,
    tools: toolTable().map((tool) => ({ name: tool.name, description: tool.description })),
  };
}

/** 只规划不执行：页面上先让人看到 agent 打算做什么。 */
export async function previewAgent(/** @type {string} */ text, /** @type {string | undefined} */ projectId) {
  const context = await agentContext(projectId);
  if (context.config.kind === 'local') {
    return { mode: 'model', steps: [], reply: `交给本地模型 ${context.config.model} 规划；每一步调用会显示在这里。` };
  }
  const plan = planFromText(text, context);
  return { mode: 'rule', steps: plan.steps.map((step) => ({ tool: step.tool, args: step.args, why: step.why })), reply: plan.reply };
}

/**
 * 跑一个任务：立即返回 job（页面轮询/SSE 看步骤），后台继续执行。
 * @param {string} text @param {{ project?: string, render?: (args: any, signal?: AbortSignal) => Promise<any> }} options
 */
/**
 * 同步跑一个任务：HTTP API / 脚本要一次拿到结果，不等页面轮询。
 * 和后台任务走同一套规划器 + 同一套 MCP 工具。
 * @param {string} text @param {{ project?: string, render?: (args: any, signal?: AbortSignal) => Promise<any> }} options
 */
/** @type {(text: string, options?: { project?: string, render?: (args: any, signal?: AbortSignal) => Promise<any> }) => Promise<any>} */
export const runAgentNow = async (text, options = {}) => {
  const said = String(text ?? '').trim().slice(0, 600);
  if (!said) throw new Error('先说一句要做什么，例如：识别全部素材并打标签');
  const context = await agentContext(options.project);
  const controller = new AbortController();
  const call = createCaller({
    render: options.render ? (/** @type {any} */ args) => /** @type {(args: any, signal?: AbortSignal) => Promise<any>} */ (options.render)(args, controller.signal) : undefined,
  });
  /** @type {any[]} */
  const live = [];
  const result = await runAgent({
    text: said,
    context,
    tools: toolTable().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call,
    config: context.config,
    signal: controller.signal,
    onStep: (/** @type {any} */ step) => { if (step.tool === 'progress') live.push(step); },
  });
  return { text: said, mode: result.mode, reply: result.reply, ms: result.ms, progress: live.slice(-1)[0]?.result ?? null, steps: result.steps.map((/** @type {any} */ step) => ({ ...step, result: summarize(step.result) })) };
};

/** @type {(text: string, options?: { id?: string, project?: string, render?: (args: any, signal?: AbortSignal) => Promise<any>, onProgress?: (step: any) => void }) => Promise<any>} */
export const startAgentJob = async (text, options = {}) => {
  const said = String(text ?? '').trim().slice(0, 600);
  if (!said) throw new Error('先说一句要做什么，例如：识别全部素材并打标签');
  const context = await agentContext(options.project);
  const id = options.id ?? `a-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  /* 同一进程里 id 不能重复：否则 running 表会覆盖，旧任务被当成“重启残留” */
  if (running.has(id)) throw new Error(`任务 id 已在运行：${id}`);
  const job = {
    id, text: said, mode: /** @type {'rule' | 'model'} */ (context.config.kind === 'local' ? 'model' : 'rule'),
    status: /** @type {'running'} */ ('running'), reply: '', error: null, at: Date.now(), endedAt: null, ms: 0,
    steps: /** @type {any[]} */ ([]),
  };
  const controller = new AbortController();
  /** @type {any[]} */
  const liveSteps = [];
  /* 先占位再写盘：写盘是异步的，中间有 await 窗口，别让 listAgentJobs 把刚起的任务当成重启残留 */
  running.set(id, Object.assign(controller, { steps: () => liveSteps }));
  await saveAgentJob(job);
  const call = createCaller({
    render: options.render ? (/** @type {any} */ args) => /** @type {(args: any, signal?: AbortSignal) => Promise<any>} */ (options.render)(args, controller.signal) : undefined,
    onProgress: options.onProgress,
  });
  void runAgent({
    text: said,
    context,
    tools: toolTable().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call,
    config: context.config,
    signal: controller.signal,
    onStep: (/** @type {any} */ step) => {
      if (step.tool === 'progress') liveSteps.push(step);
      else job.steps.push(step);
      void patchAgentJob(id, { steps: [...job.steps] }).catch(() => {});
    },
  }).then(async (result) => {
    const done = { ...job, status: /** @type {'done'} */ ('done'), reply: result.reply, mode: /** @type {'rule' | 'model'} */ (result.mode), steps: result.steps, endedAt: Date.now(), ms: result.ms };
    await patchAgentJob(id, done);
  }, async (e) => {
    const stopped = controller.signal.aborted;
    await patchAgentJob(id, {
      status: stopped ? 'stopped' : 'failed',
      error: stopped ? '已停止' : e instanceof Error ? e.message : String(e),
      steps: [...job.steps], endedAt: Date.now(), ms: Date.now() - job.at,
    });
  }).finally(() => { running.delete(id); });
  return job;
};

/**
 * 把后台 agent 的 export_film 接到 Studio 的真实导出队列：一条一条导出，等每条 done/failed 再继续。
 * 返回 { outputs, projects, seconds }，outputs 是成片绝对路径。
 */
/** @param {{ start: Function, list: Function }} exports @param {{ onProgress?: (step: any) => void }} [options] */
export function createStudioRenderer(exports, { onProgress } = /** @type {{ onProgress?: (step: any) => void }} */ ({})) {
  const progress = (/** @type {any} */ step) => onProgress?.(step);
  return async (/** @type {any} */ args, /** @type {AbortSignal | undefined} */ signal) => {
    const ids = Array.isArray(args.projects) ? args.projects : [];
    const started = Date.now();
    const outputs = [];
    const done = [];
    for (const id of ids) {
      if (signal?.aborted) throw new Error('已停止');
      const project = await projectById(String(id));
      if (!project || project.missing) throw new Error(`工程不存在：${id}`);
      const job = exports.start(project, {
        kind: 'video', codec: 'h264', frame: 'native', fill: 'contain', shortEdge: 1080,
        fps: Number(args.fps) > 0 ? Number(args.fps) : 30,
        quality: 'high', audio: args.audio !== false, label: 'Agent',
      }, args.folder ? { folder: String(args.folder) } : {});
      const relay = /** @type {any} */ (args).onProgress;
      const emit = (/** @type {any} */ step) => { onProgress?.(step); relay?.(step); };
      emit({ project: project.id, name: project.name, status: 'queued', id: job.id, progress: 0 });
      const finished = await waitForExport(exports, project.id, job.id, signal, emit);
      if (finished.status !== 'done') throw new Error(`${project.name} 导出${finished.status === 'cancelled' ? '被取消' : '失败'}：${finished.error ?? '未知原因'}`);
      outputs.push(...finished.outputs);
      done.push({ project: project.id, name: project.name, outputs: finished.outputs });
      emit({ project: project.id, name: project.name, status: 'done', id: job.id, progress: 1, outputs: finished.outputs });
    }
    return { outputs, projects: done, seconds: Math.round((Date.now() - started) / 100) / 10 };
  };
}

/** @param {{ list: Function }} exports @param {string} projectId @param {string} jobId @param {AbortSignal | undefined} signal @param {((step: any) => void) | undefined} [onProgress] */
function waitForExport(exports, projectId, jobId, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) return reject(new Error('已停止'));
      const job = exports.list(projectId).find((/** @type {any} */ one) => one.id === jobId);
      if (!job) return reject(new Error('导出任务丢了'));
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return resolve(job);
      onProgress?.({ project: projectId, status: 'running', id: jobId, progress: Number(job.progress) || 0, phase: job.phase ?? null, etaMs: job.etaMs ?? null });
      setTimeout(tick, 500);
    };
    tick();
  });
}

/** 上次 Studio 退出时还在跑的任务：没有进程接手，标成已停止。 */
export function stopAgentJob(/** @type {string} */ id) {
  const controller = running.get(id);
  if (!controller) return false;
  controller.abort();
  running.delete(id);
  return true;
}

export async function listAgentJobs() {
  const jobs = await readAgentJobs();
  /** 这次要标成“重启残留”的，最后一次性写盘 */
  /** @type {string[]} */
  const stale = [];
  for (const job of jobs) {
    /* Studio 重启后，旧任务不会自己跑完：标成已停止，别让页面一直转 */
    if (job.status === 'running' && !running.has(job.id)) {
      job.status = 'stopped';
      job.error = job.error ?? 'Studio 重启，任务已停止';
      job.endedAt = job.endedAt ?? Date.now();
      stale.push(job.id);
    }
  }
  /* 一次写盘：并发轮询时不要每条都读改写，否则会互相覆盖 */
  if (stale.length) await patchAgentJobs(stale, { status: 'stopped', error: 'Studio 重启，任务已停止' });
  return jobs.map((job) => {
    const live = running.get(job.id);
    const steps = live ? live.steps() : job.steps;
    return { ...job, steps: steps.map((/** @type {any} */ step) => ({ ...step, result: summarize(step.result) })) };
  });
}

export async function clearDoneAgentJobs() {
  const now = await readAgentJobs();
  const kept = now.filter((job) => job.status === 'running');
  await clearAgentJobs();
  for (const job of kept.reverse()) await saveAgentJob(job);
  return kept;
}

/** 步骤结果给页面看的一份摘要：识别结果只留条数和标签，时间线另开接口读。 */
function summarize(/** @type {unknown} */ value) {
  if (!value || typeof value !== 'object') return value;
  const one = /** @type {Record<string, any>} */ (value);
  if (Array.isArray(one.results)) {
    return {
      ...one,
      results: one.results.map((r) => ({ path: r.path, ok: r.ok, tags: r.tags, segments: r.segments })),
      tags: one.tags && typeof one.tags === 'object' ? Object.fromEntries(Object.entries(one.tags).slice(0, 30)) : one.tags,
    };
  }
  if (Array.isArray(one.assets)) return { ...one, assets: one.assets.slice(0, 30) };
  return value;
}



