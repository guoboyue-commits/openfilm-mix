import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixableAssets, mixFreshOps, mixOps, planEndSeconds, planMix, planMixBatch, seededRandom, type MixAsset } from './mix-plan.ts';
import { applyOps } from '../../../server/ops.mjs';

const asset = (name: string, seconds: number, kind: MixAsset['kind'] = 'video'): MixAsset => ({
  path: `assets/${name}`, name, kind, durationMs: Math.round(seconds * 1000), w: 540, h: 960,
});

const library = [
  asset('A1-launch-20s.mp4', 20.125),
  asset('A1-ad-32s.mp4', 32),
  asset('A1-flow-15s.mp4', 15.083),
  asset('A1-hl-22s.mp4', 22.125),
  asset('A1-multi-20s.mp4', 20.125),
  asset('A1-actions-19s.mp4', 19),
  asset('A1-flow20s.mp4', 20.125),
  asset('A1-multi-32s.mp4', 32),
  asset('cover.png', 0, 'image'),
];

const base = {
  targetSeconds: 20, minShotSeconds: 1.2, maxShotSeconds: 3.6, pace: 'normal' as const,
  avoidRepeat: 3, shuffle: true, seed: 7, stage: { w: 540, h: 960 }, fps: 30,
};

test('同一 seed 出同一条片子，不同 seed 顺序不同', () => {
  const a = planMix(library, base);
  const b = planMix(library, base);
  assert.deepEqual(a.segments, b.segments);
  const c = planMix(library, { ...base, seed: 99 });
  assert.notDeepEqual(a.segments.map((s) => s.src), c.segments.map((s) => s.src));
  assert.equal(a.durationSeconds, 20);
});

test('素材够时，最近 avoidRepeat 段不重复', () => {
  const plan = planMix(library, { ...base, targetSeconds: 24, avoidRepeat: 4 });
  const names = plan.segments.map((s) => s.src);
  for (let i = 0; i < names.length; i += 1) {
    const window = names.slice(Math.max(0, i - 4), i);
    assert.ok(!window.includes(names[i]), `第 ${i} 段重复了窗口内的素材`);
  }
});

test('旁白时长优先，片段首尾相接且落在帧网格', () => {
  const plan = planMix(library, { ...base, targetSeconds: 60, voiceSeconds: 12.5 });
  assert.ok(Math.abs(plan.durationSeconds - 12.5) < 0.05);
  for (let i = 1; i < plan.segments.length; i += 1) {
    const prev = plan.segments[i - 1]!;
    const now = plan.segments[i]!;
    assert.ok(Math.abs(prev.at + prev.length - now.at) < 0.002);
  }
  for (const clip of plan.tracks[0]!.clips) {
    assert.ok(clip.time && clip.time[1] > clip.time[0]);
  }
});

test('图片也能进画面，且不会被裁到文件外', () => {
  const plan = planMix([library.at(-1)!], { ...base, targetSeconds: 6 });
  assert.equal(plan.tracks[0]!.clips[0]!.src, 'assets/cover.png');
  for (const s of plan.segments) assert.ok(s.to <= 4.001);
  assert.equal(plan.durationSeconds, 6);
});

test('素材不够长时宁可重复也不留空', () => {
  const plan = planMix([asset('only.mp4', 1.2)], { ...base, targetSeconds: 5, avoidRepeat: 5 });
  assert.ok(Math.abs(plan.durationSeconds - 5) < 0.05);
  assert.ok(plan.shots >= 4);
});

test('关闭洗牌时严格按素材库顺序', () => {
  const plan = planMix(library, { ...base, targetSeconds: 9, shuffle: false, avoidRepeat: 0 });
  assert.deepEqual(plan.segments.slice(0, 3).map((s) => s.src), [
    'assets/A1-actions-19s.mp4', 'assets/A1-ad-32s.mp4', 'assets/A1-flow-15s.mp4',
  ]);
});

test('没有可用素材时报错，声音不混进画面', () => {
  assert.throws(() => planMix([asset('bgm.mp3', 30, 'audio')], base), /没有可用的视频/);
  assert.deepEqual(mixableAssets([asset('bgm.mp3', 30, 'audio'), ...library]).length, library.length);
});

test('随机数可复现且在 [0,1)', () => {
  const a = seededRandom(3);
  const b = seededRandom(3);
  for (let i = 0; i < 20; i += 1) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('批量出片：每个 seed 一条，顺序不同，且都铺满目标时长', () => {
  const plans = planMixBatch(library, { ...base, targetSeconds: 12 }, 3);
  assert.equal(plans.length, 3);
  assert.equal(new Set(plans.map((p) => p.segments.map((s) => s.src).join('|'))).size, 3);
  for (const plan of plans) {
    assert.ok(Math.abs(planEndSeconds(plan) - 12) < 0.05);
    assert.equal(plan.options.fps, 30);
  }
});

test('混剪操作默认插入一条新轨道：第一段带轨道，其余接在它后面', () => {
  const plan = planMix(library, { ...base, targetSeconds: 6 });
  const ops = mixOps(plan);
  assert.equal(ops.length, plan.shots);
  const [head, ...rest] = ops;
  assert.ok(head?.op === 'insert' && head.track && typeof head.track === 'object' && 'insert' in head.track);
  const placed = head.op === 'insert' ? (head.clip as { id?: string }).id : undefined;
  assert.ok(placed);
  const ids = new Set([placed, ...rest.map((op) => (op.op === 'insert' ? (op.clip as { id?: string }).id : undefined))]);
  assert.equal(ids.size, ops.length);
  for (const op of rest) {
    assert.ok(op.op === 'insert' && typeof op.after === 'string' && ids.has(op.after) && op.track == null);
  }
  const onTrack = mixOps(plan, 2);
  assert.ok(onTrack[0]?.op === 'insert' && onTrack[0].track === 2);
  assert.ok(onTrack.slice(1).every((op) => op.op === 'insert' && op.after != null && op.track == null));
});

test('混剪操作落到 film.html 里是同一条轨道，不是每段一条', () => {
  const plan = planMix(library, { ...base, targetSeconds: 8 });
  const value = { stage: { w: 540, h: 960 }, tracks: [] as Array<{ clips: Array<{ src: string; at?: number }> }> };
  applyOps(value, mixOps(plan));
  assert.equal(value.tracks.length, 1);
  assert.equal(value.tracks[0]!.clips.length, plan.shots);
  const onTop = { stage: { w: 540, h: 960 }, tracks: [{ clips: [{ src: 'assets/cover.png' }] }] };
  applyOps(onTop, mixOps(plan));
  assert.equal(onTop.tracks.length, 2);
  assert.equal(onTop.tracks[0]!.clips.length, plan.shots);
  assert.equal(onTop.tracks[1]!.clips.length, 1);
});

test('fps 决定切点网格，不会出现半帧', () => {
  const plan = planMix(library, { ...base, targetSeconds: 8, fps: 24 });
  for (const clip of plan.tracks[0]!.clips) {
    const frames = (clip.at * 24) / 1;
    assert.ok(Math.abs(frames - Math.round(frames)) < 0.02, `at ${clip.at} 不在 24fps 网格上`);
  }
});
test('从零写进新项目：先定画布，再铺一条画面轨', () => {
  const plan = planMix(library, base);
  const ops = mixFreshOps(plan);
  assert.deepEqual(ops[0], { op: 'stage', w: 540, h: 960 });
  const film = { stage: { w: 1920, h: 1080 }, tracks: [] as Array<{ clips: Array<{ src: string }> }> };
  applyOps(film, ops);
  assert.deepEqual(film.stage, { w: 540, h: 960 });
  assert.equal(film.tracks[0]!.clips.length, plan.shots);
});
