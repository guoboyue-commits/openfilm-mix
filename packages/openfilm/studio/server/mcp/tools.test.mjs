import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineText } from './tools.mjs';
import { cuesToAss } from './subtitle.mjs';
import { analyzeFiles, analyzeStatus, release, slot } from '../batch-analyze.mjs';

test('时间线起止用同一套 m:ss.cc，超过一分钟也不会混用纯秒数', () => {
  const note = { segments: [
    { start: 0, end: 1.28, text: '产品由远到近特写', speech: null },
    { start: 88.5, end: 92.3, text: '口播解说', speech: '这就是卖点' },
  ] };
  const lines = timelineText(note).split('\n');
  assert.equal(lines[0], '0:00.00-0:01.28s 产品由远到近特写');
  assert.equal(lines[1], '1:28.50-1:32.30s 口播解说');
  assert.equal(lines[2], '台词：这就是卖点');
});

test('没有台词的镜头只写一行', () => {
  const note = { segments: [{ start: 2, end: 3, text: '空镜', speech: null }] };
  assert.equal(timelineText(note), '0:02.00-0:03.00s 空镜');
});
test('字幕默认贴底 14%，往上抬时字号和左右边距不变', () => {
  const cues = [{ text: '三周调节，随手一转就到位。', start: 0, end: 3.238 }];
  const styleOf = (ass) => ass.split('\n').find((line) => line.startsWith('Style: Default,'));
  const low = styleOf(cuesToAss(cues));
  const high = styleOf(cuesToAss(cues, { bottom: 0.2 }));
  assert.ok(low.endsWith(',269,134'), 'default MarginV should be 14% of 1920');
  assert.ok(high.endsWith(',384,134'), 'bottom 0.2 should be 20% of 1920');
  assert.deepEqual(low.split(',').slice(0, 18), high.split(',').slice(0, 18));
  assert.equal(high.split(',').slice(-1)[0], '134');
});

test('越界的 bottom 退回默认值，不会把字幕顶到画面外', () => {
  const cues = [{ text: '一句话', start: 0, end: 1 }];
  for (const bad of [0, -1, 0.9, Number.NaN]) {
    const line = cuesToAss(cues, { bottom: bad }).split('\n').find((one) => one.startsWith('Style: Default,'));
    assert.ok(line.endsWith(',269,134'), 'bottom ' + String(bad) + ' should fall back to 11%');
  }
});

test('batch analyze: status probes and empty run do not reference missing identifiers', async () => {
  const status = await analyzeStatus();
  assert.equal(typeof status.ok, 'boolean');
  assert.ok(Array.isArray(status.models), 'status lists which models are on this machine');
  const empty = await analyzeFiles([]);
  assert.deepEqual(empty, { results: [] });
});

test('batch analyze: only one analysis runs at a time', async () => {
  await slot();
  let second = false;
  const queued = slot().then(() => { second = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(second, false, 'a second analysis waits for the first');
  release();
  await queued;
  assert.equal(second, true, 'and starts once the first is done');
  release();
});