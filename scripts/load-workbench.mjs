// Loads every workbench module the way the server does, so a name that was never imported fails here instead of
// at the first request. Importing is enough: nothing here starts a server or touches a project.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = join(import.meta.dirname, '..', 'packages', 'openfilm');

const MODULES = [
  'studio/server/batch-analyze.mjs',
  'studio/server/mix-plan.mjs',
  'studio/server/batch-notes.mjs',
  'studio/server/batch-tags.mjs',
  'studio/server/export-history.mjs',
  'studio/server/voice-mode.mjs',
  'studio/server/voice-api.mjs',
  'studio/server/mcp/tools.mjs',
  'studio/server/mcp/protocol.mjs',
  'studio/server/mcp/agent.mjs',
  'studio/server/mcp/subtitle.mjs',
];

let failed = 0;
for (const rel of MODULES) {
  try {
    await import(pathToFileURL(join(PKG, rel)).href);
    process.stdout.write(`  ok    ${rel}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`  FAIL  ${rel}\n        ${e instanceof Error ? e.message.split('\n')[0] : String(e)}\n`);
  }
}
process.stdout.write(`\n${MODULES.length - failed}/${MODULES.length} modules loaded\n`);
process.exit(failed ? 1 : 0);
