import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromText, runAgent } from './agent.mjs';

const context = {
  libraryId: 'lib',
  assets: [
    { path: 'assets/a.mp4', name: 'a.mp4', tags: ['产品'] },
    { path: 'assets/b.mp4', name: 'b.mp4', tags: ['开场'] },
  ],
  tags: ['产品', '开场'],
  outputs: 2,
};

test('识别并打标：先 analyze_assets，再 tag_assets', () => {
  const plan = planFromText('识别全部素材并打上产品标签', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['analyze_assets', 'tag_assets']);
  assert.deepEqual(plan.steps[1].args.tags, ['产品']);
});

test('去掉标签用 remove 模式', () => {
  const plan = planFromText('把素材上的产品标签去掉', context);
  assert.equal(plan.steps[0].tool, 'tag_assets');
  assert.equal(plan.steps[0].args.mode, 'remove');
  assert.ok(plan.steps[0].args.tags.length > 0);
});

test('生成多条竖屏成片，带时长和条数', () => {
  const plan = planFromText('用全部素材生成 3 条 20 秒竖屏成片', context);
  assert.equal(plan.steps[0].tool, 'generate_mix');
  assert.equal(plan.steps[0].args.count, 3);
  assert.equal(plan.steps[0].args.seconds, 20);
  assert.equal(plan.steps[0].args.aspect, '9:16');
});

test('生成并导出：export_film 用上一步的工程', async () => {
  const plan = planFromText('生成 2 条 15 秒竖屏成片并导出', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['generate_mix', 'export_film']);
  assert.equal(plan.steps[1].args.projects, 'last');
  const calls = [];
  const result = await runAgent({
    text: '生成 2 条 15 秒竖屏成片并导出',
    context,
    tools: [],
    config: { kind: 'none', endpoint: '', model: '' },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'generate_mix') return { made: [{ project: 'p1' }, { project: 'p2' }] };
      return { outputs: ['C:/out/1.mp4', 'C:/out/2.mp4'] };
    },
  });
  assert.deepEqual(calls[1].args.projects, ['p1', 'p2']);
  assert.match(result.reply, /已导出 2/);
});

test('质检成片：列出成片再本地质检，条数跟着说', async () => {
  const plan = planFromText('质检一下最近两条成片', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['list_outputs', 'analyze_outputs']);
  assert.equal(plan.steps[1].args.limit, 2);
  const result = await runAgent({
    text: '质检一下最近两条成片',
    context,
    tools: [],
    config: { kind: 'none', endpoint: '', model: '' },
    call: async (name) => {
      if (name === 'list_outputs') return { outputs: [{ path: 'C:/out/1.mp4' }] };
      return {
        results: [
          { ok: true, quality: { ok: false, issues: [{ level: 'error', text: '0:02.67 起有 0.83s 黑帧' }] } },
          { ok: true, quality: { ok: true, issues: [] } },
        ],
      };
    },
  });
  assert.match(result.reply, /1 条通过/);
  assert.match(result.reply, /黑帧/);
});

test('本地配音：一句话里的台词交给 make_voice', () => {
  const plan = planFromText('配一段旁白：三周调节，随手一转就到位。', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['make_voice']);
  assert.equal(plan.steps[0].args.text, '三周调节，随手一转就到位。');
});

test('本地配音：引号里的台词也认', () => {
  const plan = planFromText('配音：“这款产品真的很好用”', context);
  assert.equal(plan.steps[0].tool, 'make_voice');
  assert.equal(plan.steps[0].args.text, '这款产品真的很好用');
});

test('只看素材时列出素材库', async () => {
  const plan = planFromText('素材库里有什么', context);
  assert.equal(plan.steps[0].tool, 'list_assets');
});

test('按标签选素材：只剪带产品标签的镜头', () => {
  const plan = planFromText('用产品素材生成 2 条 10 秒竖屏成片', context);
  assert.equal(plan.steps[0].tool, 'generate_mix');
  assert.deepEqual(plan.steps[0].args.paths, ['assets/a.mp4']);
  assert.equal(plan.steps[0].args.count, 2);
  assert.match(plan.steps[0].why, /标签 产品/);
});

test('按标签打标：只改带开场标签的素材', () => {
  const plan = planFromText('给开场镜头打上高光标签', context);
  assert.equal(plan.steps[0].tool, 'tag_assets');
  assert.deepEqual(plan.steps[0].args.paths, ['assets/b.mp4']);
});

test('“只用产品标签的素材生成…”是筛选素材，不是打标签', () => {
  const plan = planFromText('只用产品标签的素材生成 2 条 15 秒竖屏成片', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['generate_mix']);
  assert.deepEqual(plan.steps[0].args.paths, ['assets/a.mp4']);
});

test('打标签时只取“标成 xx”里的短词，不把整句当标签', () => {
  const plan = planFromText('把产品镜头标成卖点，看看成片', context);
  assert.equal(plan.steps[0].tool, 'tag_assets');
  assert.deepEqual(plan.steps[0].args.tags, ['卖点']);
});

test('“只用产品标签的素材”不产生“产品、的素材生成”这种脏标签', () => {
  const plan = planFromText('只用产品标签的素材生成 2 条 15 秒竖屏成片', context);
  assert.deepEqual(plan.steps[0].args.paths, ['assets/a.mp4']);
  assert.match(plan.steps[0].why, /标签 产品）/);
});

test('“标成卖点，看看成片”会接着列成片', () => {
  const plan = planFromText('把产品镜头标成卖点，看看成片', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['tag_assets', 'list_outputs']);
});

test('生成并导出时把渲染进度转给 onStep，但不混进步骤列表', async () => {
  const seen = [];
  const result = await runAgent({
    text: '生成 1 条 10 秒竖屏成片并导出',
    context,
    tools: [],
    config: { kind: 'none', endpoint: '', model: '' },
    onStep: (step) => seen.push(step),
    call: async (name, args) => {
      if (name === 'generate_mix') return { made: [{ project: 'p1' }] };
      args.onProgress?.({ project: 'p1', status: 'running', progress: 0.5, phase: 'rendering' });
      return { outputs: ['C:/out/1.mp4'] };
    },
  });
  assert.ok(seen.some((step) => step.tool === 'progress' && step.result.progress === 0.5));
  assert.deepEqual(result.steps.map((step) => step.tool), ['generate_mix', 'export_film']);
});

test('“质检成片”先列成片，再本地看成片内容', () => {
  const plan = planFromText('帮我质检一下最近的成片', context);
  assert.deepEqual(plan.steps.map((step) => step.tool), ['list_outputs', 'analyze_outputs']);
});
