// @ts-check
/**
 * 本地 MCP server（stdio）：给 Codex / Claude Desktop / Cursor 这类本地 agent 用。
 *
 * 启动：node studio/server/mcp/server.mjs
 * 只在本机跑：不监听端口，不联网；工具见 mcp/tools.mjs。
 */
import { createMcpServer, serveStdio } from './protocol.mjs';
import { createCaller, LIBRARY_NAME, toolTable } from './tools.mjs';
import { readAgentJobs } from './store.mjs';
import { readAgentConfig, probeLocalModel } from './agent.mjs';
import { analyzeStatus } from '../batch-analyze.mjs';
import { studioHome } from '../projects.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const VERSION = '0.1.0';

/** 外部 agent 每次调工具都记一笔，页面上能看到“谁在用这个 MCP”。 */
async function noteMcpCall(name, ok, ms, error) {
  try {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const dir = studioHome();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp-calls.json');
    let calls = [];
    try { calls = JSON.parse(await readFile(file, 'utf8')); } catch { calls = []; }
    if (!Array.isArray(calls)) calls = [];
    calls = [{ tool: name, ok, ms, error: error ?? null, at: Date.now() }, ...calls].slice(0, 40);
    await writeFile(file, JSON.stringify(calls, null, 2));
  } catch { /* 只是记录，失败不影响工具 */ }
}

/**
 * 外部 agent 调 export_film 时，把工程交给正在运行的 Studio（本机 127.0.0.1）导出队列；
 * 没有 Studio 就明确报错，不在 MCP 进程里偷偷起一个渲染器。
 */
async function studioExport(args, { signal } = /** @type {{ signal?: AbortSignal }} */ ({})) {
  const { base, key } = await studioBase();
  const ids = Array.isArray(args.projects) && args.projects.length ? args.projects : [];
  if (!ids.length) throw new Error('projects: 先 generate_mix，或传工程 id');
  const res = await fetch(`${base}/api/batch/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': key },
    body: JSON.stringify({ text: `导出 ${ids.length} 个工程`, project: ids[0], export: ids }),
    signal: signal ?? AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) throw new Error('Studio 没在运行：先打开 OpenFilm Studio，再从 agent 里导出');
  if (!res.ok) throw new Error(`Studio 拒绝导出：${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

async function studioBase() {
  const { readFile } = await import('node:fs/promises');
  const file = join(studioHome(), 'run.json');
  try {
    const run = JSON.parse(await readFile(file, 'utf8'));
    const port = Number(run.port);
    const base = typeof run.origin === 'string' ? run.origin : port > 0 ? `http://127.0.0.1:${port}` : null;
    if (base && typeof run.key === 'string') return { base, key: run.key };
  } catch { /* 没在运行 */ }
  throw new Error('Studio 没在运行：先打开 OpenFilm Studio，再从 agent 里导出');
}

export function buildServer() {
  const call = createCaller();
  const tools = toolTable().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
      const at = Date.now();
      try {
        const out = tool.name === 'export_film' ? await studioExport(args, ctx) : await call(tool.name, args);
        await noteMcpCall(tool.name, true, Date.now() - at);
        return out;
      } catch (e) {
        await noteMcpCall(tool.name, false, Date.now() - at, e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
  }));
  return createMcpServer({
    name: 'openfilm-mix',
    version: VERSION,
    instructions: [
      '这是本机混剪后台（OpenFilm Studio）的 MCP。素材库默认叫“混剪素材库”。',
      '常见流程：list_assets 看素材 → analyze_assets 本地识别并出时间线/标签 → tag_assets 补标签 → generate_mix 生成混剪工程 → 在 Studio 里预览/导出。',
      '时间线格式：`0:00-1.28s 画面描述`，有台词时下一行 `台词：…`。',
      '所有识别都在本机（ffmpeg + faster-whisper），不要建议上传素材。',
    ].join('\n'),
    tools,
    resources: {
      list: () => [
        { uri: 'openfilm://status', name: '本机能力', description: '识别引擎、本地模型、素材库位置', mimeType: 'application/json' },
        { uri: 'openfilm://agent-jobs', name: '后台 Agent 任务', description: '最近在后台跑过的 agent 任务和每一步工具调用', mimeType: 'application/json' },
      ],
      read: async (/** @type {string} */ uri) => {
        if (uri === 'openfilm://status') {
          const config = await readAgentConfig();
          const model = await probeLocalModel(config);
          return { text: JSON.stringify({ analyze: await analyzeStatus(), agent: { kind: config.kind, endpoint: config.endpoint, model: config.model, available: model.ok, models: model.models }, home: studioHome(), library: LIBRARY_NAME }, null, 2) };
        }
        if (uri === 'openfilm://agent-jobs') return { text: JSON.stringify(await readAgentJobs(), null, 2) };
        throw new Error(`没有这个资源：${uri}`);
      },
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = buildServer();
  serveStdio(server, { input: process.stdin, output: process.stdout });
  process.stderr.write(`openfilm-mix MCP ready (${join(studioHome(), 'agent-jobs.json')})\n`);
}

