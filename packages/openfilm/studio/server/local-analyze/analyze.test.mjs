import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findPython } from '../batch-analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 本地识别的纯逻辑回归：黑帧的秒数与像素黑场判定。
 * 需要 Python 3；没装时跳过，不把整包测试拖红。
 */
test('local analyze: black frames are timed in seconds, and fade-in heads are trimmed', async (t) => {
  const python = await findPython();
  if (!python) { t.skip('no Python 3 on this machine'); return; }
  const script = join(HERE, 'analyze.test.py');
  const run = await new Promise((resolve) => {
    const proc = spawn(python, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /failures: 0/);
});
