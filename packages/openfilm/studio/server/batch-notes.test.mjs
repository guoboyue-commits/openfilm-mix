import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropNotes, readNotes, saveNotes } from './batch-notes.mjs';
import { aggregateTags, stamp } from './batch-analyze.mjs';

test('a timeline is saved with its segments, tags and speech, and read back', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'of-batch-notes-'));
  const segs = [
    { start: 0, end: 1.28, text: '产品由远到近特写', speech: null, tags: ['特写'] },
    { start: 1.29, end: 5.24, text: '口播解说，画面较稳', speech: '这就是卖点', tags: ['口播', '稳定镜头'] },
  ];
  await saveNotes(folder, [{ path: 'assets/a.mp4', segments: segs, tags: ['特写', '口播'], duration: 5.24, language: 'zh', hasSpeech: true }]);
  const notes = await readNotes(folder);
  assert.deepEqual(notes['assets/a.mp4'].segments, segs);
  assert.deepEqual(notes['assets/a.mp4'].tags, ['特写', '口播']);
  assert.equal(notes['assets/a.mp4'].hasSpeech, true);
  assert.equal(notes['assets/a.mp4'].duration, 5.24);
});

test('bad segments are dropped instead of breaking the file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'of-batch-notes-'));
  await saveNotes(folder, [{ path: 'assets/a.mp4', segments: [
    { start: 3, end: 2, text: 'backwards' },
    { start: 0, end: 1, text: '   ' },
    { start: 0, end: 1.5, text: 'kept', tags: ['x'], speech: '' },
  ] }]);
  const notes = await readNotes(folder);
  assert.equal(notes['assets/a.mp4'].segments.length, 1);
  assert.equal(notes['assets/a.mp4'].segments[0].text, 'kept');
  assert.equal(notes['assets/a.mp4'].segments[0].speech, null);
});

test('deleting a clip takes its timeline with it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'of-batch-notes-'));
  const one = { start: 0, end: 1, text: 'a', speech: null, tags: [] };
  await saveNotes(folder, [{ path: 'assets/a.mp4', segments: [one] }, { path: 'assets/b.mp4', segments: [one] }]);
  await dropNotes(folder, ['assets/a.mp4']);
  const notes = await readNotes(folder);
  assert.equal(notes['assets/a.mp4'], undefined);
  assert.ok(notes['assets/b.mp4']);
});

test('tags of a whole clip are the ones its segments repeat most', () => {
  assert.deepEqual(aggregateTags([{ tags: ['口播', '稳定镜头'] }, { tags: ['稳定镜头'] }, { tags: ['特写'] }]), ['稳定镜头', '口播', '特写']);
  assert.deepEqual(aggregateTags([]), []);
});

test('a stamp is 0:00.00 with two hundredths of a second', () => {
  assert.equal(stamp(0), '0:00.00');
  assert.equal(stamp(1.28), '0:01.28');
  assert.equal(stamp(61.5), '1:01.50');
  assert.equal(stamp(-2), '0:00.00');
});
