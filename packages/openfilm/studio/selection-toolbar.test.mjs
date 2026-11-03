import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { filmHtml } from '../src/film-doc.mjs';
import { openProject } from './server/projects.mjs';
import { startStudio } from './server/server.mjs';

test('export covers the selection toolbar, keeps its menus usable, and leaves the range intact', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'of-selection-dialog-'));
  const names = ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS'];
  const saved = new Map(names.map((name) => [`OPENFILM_${name}`, process.env[`OPENFILM_${name}`]]));
  for (const name of names) process.env[`OPENFILM_${name}`] = join(scratch, name.toLowerCase());
  let studio, browser;
  try {
    const root = join(process.env.OPENFILM_LIBRARY, 'Selection');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#486b8e"/></svg>');
    await writeFile(join(root, 'film.html'), filmHtml({
      stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'card', src: 'assets/card.svg', time: [0, 4] }] }],
    }));
    const project = await openProject(root);
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    const clip = page.locator('[data-block-id]').first();
    await clip.waitFor({ state: 'visible' });
    await clip.click({ position: { x: 20, y: 10 } });
    const toolbar = page.locator('[data-selection-toolbar]');
    const more = toolbar.locator('[data-tool="more"]');
    await more.hover();
    await page.getByRole('tooltip').waitFor({ state: 'visible' });
    await more.click();
    const menu = page.getByRole('menu').first();
    await menu.waitFor({ state: 'visible' });
    const barBox = await toolbar.boundingBox(), menuBox = await menu.boundingBox();
    assert.ok(barBox && menuBox);
    const overlap = {
      left: Math.max(barBox.x, menuBox.x), top: Math.max(barBox.y, menuBox.y),
      right: Math.min(barBox.x + barBox.width, menuBox.x + menuBox.width),
      bottom: Math.min(barBox.y + barBox.height, menuBox.y + menuBox.height),
    };
    assert.ok(overlap.left < overlap.right && overlap.top < overlap.bottom);
    assert.equal(await menu.evaluate((el, point) => el.contains(document.elementFromPoint(point.x, point.y)), {
      x: (overlap.left + overlap.right) / 2, y: (overlap.top + overlap.bottom) / 2,
    }), true, 'the clip menu covers the toolbar where they overlap');
    await menu.getByRole('menuitem', { name: /^Copy attributes/ }).click();
    await page.getByText(/^Attributes copied:/).waitFor({ state: 'visible' });

    await page.locator('[data-film-select]').click();
    await toolbar.locator('[data-tool="mask"]').waitFor({ state: 'visible' });
    await toolbar.locator('[data-tool="more"]').click();
    await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await clip.click({ position: { x: 20, y: 10 } });
    const ruler = await page.locator('[data-timeline] [role="slider"]').first().boundingBox();
    assert.ok(ruler);
    await page.keyboard.down('Shift');
    await page.mouse.move(ruler.x + 80, ruler.y + ruler.height / 2);
    await page.mouse.down();
    await page.mouse.move(ruler.x + 300, ruler.y + ruler.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await clip.click({ position: { x: 20, y: 10 } });
    await toolbar.waitFor({ state: 'visible' });
    const hit = async () => {
      const box = await toolbar.boundingBox();
      assert.ok(box, 'the selected range keeps its toolbar');
      return page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return { toolbar: Boolean(element?.closest('[data-selection-toolbar]')), tag: element?.tagName, label: element?.getAttribute('aria-label') };
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    };
    assert.equal((await hit()).toolbar, true, 'the toolbar is reachable before opening export');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    await dialog.waitFor({ state: 'visible' });
    const coveredHit = await hit();
    // Capture one real pointer click without running whichever action is beneath it.
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        window.toolbarReceivedClick = Boolean(event.target.closest('[data-selection-toolbar]'));
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, once: true });
    });
    const coveredBox = await toolbar.boundingBox();
    assert.ok(coveredBox);
    await page.mouse.click(coveredBox.x + coveredBox.width / 2, coveredBox.y + coveredBox.height / 2);
    const toolbarReceivedClick = await page.evaluate(() => window.toolbarReceivedClick);

    // A dialog-layer fix must also leave its body-portaled MenuSelect above the dialog.
    const fps = dialog.getByRole('button', { name: 'Frame rate', exact: true });
    await fps.click();
    const list = page.getByRole('listbox', { name: 'Frame rate', exact: true });
    await list.waitFor({ state: 'visible' });
    const choice = list.getByRole('option', { selected: false }).first();
    const picked = await choice.textContent();
    await choice.click();
    await list.waitFor({ state: 'hidden' });
    assert.equal(await fps.textContent(), picked, 'a frame rate can still be picked with the pointer');

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await toolbar.waitFor({ state: 'visible' });
    await toolbar.locator('[data-tool="clear-range"]').waitFor({ state: 'visible' });
    assert.equal((await hit()).toolbar, true, 'the retained range toolbar is reachable again');
    assert.equal(coveredHit.toolbar, false, `export must cover the toolbar; hit ${JSON.stringify(coveredHit)}`);
    assert.equal(toolbarReceivedClick, false, 'a click over the covered toolbar reaches the dialog');
  } finally {
    await browser?.close();
    await studio?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
