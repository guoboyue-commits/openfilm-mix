// @ts-check
/**
 * 本地 MCP 的协议层：JSON-RPC over stdio（一行一条消息），不依赖任何 npm 包。
 *
 * 只认本机：stdio 由启动它的 agent 持有，不监听端口，也不联网。
 * 支持 initialize / tools/list / tools/call / ping，以及 resources/list、resources/read。
 */

export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/** @typedef {{ name: string, description: string, inputSchema: Record<string, unknown> }} Tool */
/** @typedef {{ uri: string, name: string, description?: string, mimeType?: string }} Resource */
/** @typedef {(args: Record<string, any>, ctx: { signal: AbortSignal }) => Promise<unknown> | unknown} Handler */

/**
 * 一个 MCP server 的核心：工具表、资源表和 JSON-RPC 分发。传输层（stdio / 测试）只管收发。
 * @param {{ name: string, version: string, instructions?: string, tools: Array<Tool & { handler: Handler }>,
 *   resources?: { list: () => Promise<Resource[]> | Resource[], read: (uri: string) => Promise<{ text: string, mimeType?: string }> | { text: string, mimeType?: string } } }} options
 */
export function createMcpServer(options) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  /** @type {Set<AbortController>} */
  const running = new Set();

  /** @param {string} name @param {Record<string, any>} args */
  async function callTool(name, args) {
    const tool = tools.get(name);
    if (!tool) throw new McpError(-32602, `unknown tool: ${name}`);
    const controller = new AbortController();
    running.add(controller);
    try {
      const value = await tool.handler(args && typeof args === 'object' ? args : {}, { signal: controller.signal });
      return { content: [{ type: 'text', text: textOf(value) }], structuredContent: value && typeof value === 'object' ? value : { value }, isError: false };
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
    } finally {
      running.delete(controller);
    }
  }

  /** @param {any} message */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new McpError(-32600, 'invalid request');
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === 'initialize') {
        const asked = String(params?.protocolVersion ?? PROTOCOL_VERSION);
        return {
          protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            ...(options.resources ? { resources: { subscribe: false, listChanged: false } } : {}),
          },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        };
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
      if (method === 'ping') return {};
      if (method === 'tools/list') {
        return { tools: [...tools.values()].map(({ handler: _handler, ...tool }) => tool) };
      }
      if (method === 'tools/call') {
        if (typeof params?.name !== 'string') throw new McpError(-32602, 'tools/call needs a name');
        return await callTool(params.name, params.arguments ?? {});
      }
      if (method === 'resources/list' && options.resources) return { resources: await options.resources.list() };
      if (method === 'resources/read' && options.resources) {
        const uri = String(params?.uri ?? '');
        const read = await options.resources.read(uri);
        return { contents: [{ uri, mimeType: read.mimeType ?? 'application/json', text: read.text }] };
      }
      if (method === 'shutdown') return {};
      throw new McpError(-32601, `method not found: ${method}`);
    } catch (e) {
      if (!isRequest) return undefined;
      throw e;
    }
  }

  return {
    handle,
    /** 关掉正在跑的工具（agent 断开）。 */
    abort() { for (const one of running) one.abort(); running.clear(); },
    tools: () => [...tools.keys()],
  };
}

export class McpError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

const textOf = (/** @type {unknown} */ value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * 把 MCP server 接到一对流上（stdio 或测试里的 PassThrough）：一行一条 JSON-RPC。
 * @param {ReturnType<typeof createMcpServer>} server
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} io
 */
export function serveStdio(server, io) {
  let buffer = '';
  const write = (/** @type {any} */ message) => { io.output.write(`${JSON.stringify(message)}\n`); };
  io.input.setEncoding?.('utf8');
  io.input.on('data', (/** @type {string} */ chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      /** @type {any} */
      let message;
      try { message = JSON.parse(line); }
      catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      void server.handle(message).then((result) => {
        if (message.id === undefined || message.id === null) return;
        write(result === undefined ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, result });
      }, (e) => {
        if (message.id === undefined || message.id === null) return;
        write({ jsonrpc: '2.0', id: message.id, error: { code: e instanceof McpError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } });
      });
    }
  });
  io.input.on('end', () => server.abort());
  return () => server.abort();
}
