import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planContentMix, planMix, planMixBatch } from './mix-plan.mjs';

const assets = [
  { path: 'assets/a.mp4', name: 'a.mp4', kind: 'video', durationMs: 8000, w: 1920, h: 1080 },
  { path: 'assets/b.mp4', name: 'b.mp4', kind: 'video', durationMs: 12000, w: 1920, h: 1080 },
  { path: 'assets/c.mp4', name: 'c.mp4', kind: 'video', durationMs: 6000, w: 1920, h: 1080 },
];
const options = { targetSeconds: 12, minShotSeconds: 1.2, maxShotSeconds: 3.6, pace: 'normal', avoidRepeat: 3, shuffle: true, seed: 42, stage: { w: 1080, h: 1920 }, fps: 30 };

test('同一个 seed 生成同一条时间线', () => {
  assert.deepEqual(planMix(assets, options), planMix(assets, options));
});

test('片段首尾相接，总时长接近目标', () => {
  const plan = planMix(assets, options);
  let at = 0;
  for (const segment of plan.segments) {
    assert.ok(Math.abs(segment.at - at) < 0.001, 'segments are contiguous');
    assert.ok(segment.length > 0);
    at = segment.at + segment.length;
  }
  assert.ok(Math.abs(plan.durationSeconds - 12) < 0.5);
});

test('批量生成条数正确且互不相同', () => {
  const batch = planMixBatch(assets, options, 3);
  assert.equal(batch.length, 3);
  assert.notDeepEqual(batch[0].segments, batch[1].segments);
});

const shots = [
  { src: 'assets/a.mp4', from: 1, to: 3, text: '开场，产品由远到近', speech: '', tags: ['开场'] },
  { src: 'assets/b.mp4', from: 2, to: 6, text: '产品解说，11公分底座压得住', speech: '底座压得住', tags: ['产品', '卖点'] },
  { src: 'assets/c.mp4', from: 0, to: 2.5, text: '金属特写', speech: '', tags: ['特写'] },
];

test('按分镜选段：时间段落在分镜给的起止点内', () => {
  const plan = planContentMix(assets, { ...options, shots, targetSeconds: 8 });
  assert.ok(plan.segments.length >= 2);
  for (const segment of plan.segments) {
    const source = shots.find((one) => one.src === segment.src);
    assert.ok(source);
    assert.ok(segment.from >= source.from - 1e-6 && segment.to <= source.to + 1e-6, 'segment stays inside its shot');
  }
  assert.ok(Math.abs(plan.durationSeconds - 8) < 0.5);
});

test('按分镜选段：关键词命中台词/标签的段排前面', () => {
  const plan = planContentMix(assets, { ...options, shots, query: ['底座'], targetSeconds: 4, avoidRepeat: 0 });
  assert.equal(plan.segments[0].src, 'assets/b.mp4');
  assert.equal(plan.segments[0].from, 2);
});

test('按分镜选段：shotSeconds 限制每段取多长', () => {
  const plan = planContentMix(assets, { ...options, shots, query: ['底座'], targetSeconds: 4, shotSeconds: 1, avoidRepeat: 0 });
  assert.ok(plan.segments.every((one) => one.length <= 1 + 1 / 30));
});

test('按分镜选段：没有 shot 时报清楚的错', () => {
  assert.throws(() => planContentMix(assets, { ...options, shots: [] }), /识别/);
});
