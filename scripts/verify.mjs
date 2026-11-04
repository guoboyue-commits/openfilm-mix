// Runs the checks this fork cares about, from any working directory and without a lockfile install.
// CI calls this same file, so a green run locally means the same thing it means on a runner.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'openfilm');

const TESTS = [
  'studio/server/local-analyze/analyze.test.mjs',
  'studio/server/batch-notes.test.mjs',
  'studio/server/mix-plan.test.mjs',
  'studio/server/mcp/tools.test.mjs',
  'studio/server/mcp/protocol.test.mjs',
  'studio/server/mcp/agent.test.mjs',
];

const env = { ...process.env, CI: process.env.CI ?? '1' };

/** Run one step and say what it did. @param {string} label @param {string} cmd @param {string[]} args @param {string} cwd */
function step(label, cmd, args, cwd) {
  process.stdout.write(`\n${label}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.error) return { label, ok: false, why: String(r.error.message) };
  return { label, ok: r.status === 0, why: `exit ${r.status}` };
}

/** The first interpreter on this machine that can run the analysis test. */
function python() {
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'pass'], { stdio: 'ignore', shell: process.platform === 'win32' });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}

const results = [];
results.push(step('public audit (no secrets, CJK prose allowed)', 'node', ['scripts/audit-public.mjs', '--no-secrets', '--skip-cjk'], ROOT));

/* A module that names something it never imported throws here, before any test can hide it. */
results.push(step('workbench modules load', 'node', ['scripts/load-workbench.mjs'], ROOT));
/* tools.test.mjs reaches src/host.mjs through src/shared.mjs, and that file needs playwright-core even though it
   never launches a browser here. Say so plainly instead of letting a stack trace explain it. */
if (!existsSync(join(PKG, 'node_modules', 'playwright-core'))) {
  results.push({ label: 'workbench tests', ok: false, why: 'playwright-core missing: npm install --ignore-scripts --omit=dev --no-save playwright-core@1.61.1 (in packages/openfilm)' });
} else {
  results.push(step('workbench tests', 'node', ['--test', '--test-concurrency=1', '--test-timeout=300000', ...TESTS], PKG));
}

const py = python();
results.push(py
  ? step('shot detection and head trimming (analyze.py)', py, ['packages/openfilm/studio/server/local-analyze/analyze.test.py'], ROOT)
  : { label: 'shot detection and head trimming (analyze.py)', ok: false, why: 'no python3 or python on PATH' });

process.stdout.write('\n');
for (const r of results) process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.ok ? '' : ` — ${r.why}`}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
