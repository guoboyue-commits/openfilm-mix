import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, PROTOCOL_VERSION } from './protocol.mjs';

const server = () => createMcpServer({
  name: 'test-mix',
  version: '0.0.1',
  instructions: 'local only',
  tools: [
    { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: (args) => ({ said: args.text }) },
    { name: 'boom', description: 'always fails', inputSchema: { type: 'object' }, handler: () => { throw new Error('bad input'); } },
  ],
  resources: {
    list: () => [{ uri: 'test://status', name: 'status', mimeType: 'application/json' }],
    read: (uri) => ({ text: JSON.stringify({ uri }) }),
  },
});

test('initialize answers the protocol version and capabilities', async () => {
  const answer = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } });
  assert.equal(answer.protocolVersion, PROTOCOL_VERSION);
  assert.equal(answer.serverInfo.name, 'test-mix');
  assert.ok(answer.capabilities.tools);
  assert.ok(answer.capabilities.resources);
});

test('tools/list hides handlers and keeps schemas', async () => {
  const answer = await server().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(answer.tools.map((tool) => tool.name), ['echo', 'boom']);
  assert.equal(answer.tools[0].handler, undefined);
  assert.equal(answer.tools[0].inputSchema.type, 'object');
});

test('tools/call returns structured content, and errors as isError', async () => {
  const ok = await server().handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.structuredContent, { said: 'hi' });
  assert.match(ok.content[0].text, /hi/);
  const bad = await server().handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /bad input/);
});

test('unknown tools and methods are JSON-RPC errors', async () => {
  await assert.rejects(server().handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }), /unknown tool/);
  await assert.rejects(server().handle({ jsonrpc: '2.0', id: 6, method: 'nope' }), /method not found/);
});

test('resources read through to the handler', async () => {
  const list = await server().handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(list.resources[0].uri, 'test://status');
  const read = await server().handle({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'test://status' } });
  assert.match(read.contents[0].text, /test:\/\/status/);
});
