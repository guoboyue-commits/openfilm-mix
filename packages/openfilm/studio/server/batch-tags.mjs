import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

const FILE = join('.film', 'batch-tags.json');
const MAX_TAGS = 12;
const MAX_TAG_LEN = 24;

/** @typedef {Record<string, string[]>} Tags */

const fileOf = (/** @type {string} */ folder) => join(folder, FILE);

/** 一份标签表只留合法的名字：字符串、去空白、限长、去重、最多 12 个。 */
function cleanNames(/** @type {unknown} */ value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim().slice(0, MAX_TAG_LEN)))].slice(0, MAX_TAGS);
}

/** 读一个素材库的标签；文件不在或读坏了都当没有标签。 */
export async function readTags(/** @type {string} */ folder) {
  try {
    const raw = JSON.parse(await readFile(fileOf(folder), 'utf8'));
    /** @type {Tags} */
    const tags = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return tags;
    for (const [path, value] of Object.entries(raw)) {
      if (typeof path !== 'string' || !path) continue;
      const names = cleanNames(value);
      if (names.length) tags[path] = names;
    }
    return tags;
  } catch {
    return {};
  }
}

async function write(/** @type {string} */ folder, /** @type {Tags} */ tags) {
  await mkdir(join(folder, '.film'), { recursive: true });
  await writeAtomic(fileOf(folder), `${JSON.stringify(tags, null, 2)}\n`, 'utf8');
  return tags;
}

/**
 * 改标签：
 * - \`all\` 是一整份标签表（素材库页面每次改动都带整份）：整份替换；
 * - 否则 \`paths\` + \`tags\`：把这组路径的标签换成 \`tags\`（空列表就是去掉）。
 */
export async function setTags(/** @type {string} */ folder, /** @type {unknown} */ body) {
  const input = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  if (input.all && typeof input.all === 'object' && !Array.isArray(input.all)) {
    /** @type {Tags} */
    const tags = {};
    for (const [path, value] of Object.entries(/** @type {Record<string, unknown>} */ (input.all))) {
      if (typeof path !== 'string' || !path) continue;
      const names = cleanNames(value);
      if (names.length) tags[path] = names;
    }
    return write(folder, tags);
  }
  const tags = await readTags(folder);
  const paths = Array.isArray(input.paths) ? input.paths.filter((path) => typeof path === 'string' && path) : [];
  const wanted = cleanNames(input.tags);
  for (const path of paths) {
    if (wanted.length) tags[path] = wanted;
    else delete tags[path];
  }
  return write(folder, tags);
}

/** 素材没了，标签也一起去掉（删除素材时调用）。 */
export async function dropTags(/** @type {string} */ folder, /** @type {unknown} */ paths) {
  const tags = await readTags(folder);
  let changed = false;
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path === 'string' && path in tags) { delete tags[path]; changed = true; }
  }
  if (!changed || !existsSync(fileOf(folder))) return tags;
  return write(folder, tags);
}
