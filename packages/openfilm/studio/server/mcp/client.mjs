// @ts-check
/**
 * 本地 HTTP API 的调用示例：node studio/server/mcp/client.mjs "用产品标签的素材生成 2 条 15 秒竖屏成片并导出"
 *
 * 从 ~/.openfilm/run.json 读 Studio 地址和 key，不联网。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function studioRun(/** @type {string} */ text) {
  const run = JSON.parse(await readFile(join(homedir(), '.openfilm', 'run.json'), 'utf8'));
  const res = await fetch(`${run.origin}/api/batch/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-key': run.key },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

if (process.argv[1] && process.argv[1].endsWith('client.mjs')) {
  const text = process.argv.slice(2).join(' ') || '看看素材库里有什么';
  const out = await studioRun(text);
  console.log(out.reply);
  for (const step of out.steps) {
    if (!step || step.tool === 'progress') continue;
    const detail = step.ok
      ? (step.tool === 'make_voice' && step.result ? ` ${step.result.seconds?.toFixed?.(2) ?? step.result.seconds}s` : '')
        + (step.tool === 'generate_mix' && step.result?.made?.[0] ? ` ${step.result.made[0].seconds}s` : '')
        + (step.tool === 'export_film' && step.result?.outputs?.[0] ? ` ${step.result.outputs[0]}` : '')
        + (step.tool === 'burn_subtitles' && step.result?.file ? ` ${step.result.file}` : '')
      : ` ${step.error ?? ''}`;
    console.log(`- ${step.tool} ${step.ok ? 'ok' : 'failed'}${detail}`);
  }
}
