import { test, expect, type App } from '../fixtures';
import { DOC, menuLast, MOD, IS_MAC, clickAt, downloadDocumentXml, lineGaps, paragraphProps, paragraphsOf, pickColor, propsFor, runsOf, tool, typeAndSelect } from './helpers';

const paragraphs = async (app: App) => (await downloadDocumentXml(app)) && paragraphsOf(await downloadDocumentXml(app));
const pPr = async (app: App, index = 0) => paragraphProps((await paragraphs(app))[index]).raw;

test.describe('alignment', () => {
  for (const [name, key, val] of [
    ['Center', `${MOD}+e`, 'center'],
    ['Align Right', `${MOD}+r`, 'right'],
    ['Justify', `${MOD}+j`, 'both'],
  ] as const) {
    test(`${name}: shortcut and toolbar button align the paragraph`, async ({ app }) => {
      await app.blank();
      await app.type('some text');
      await expect(tool(app, 'Align Left')).toHaveAttribute('aria-pressed', 'true');
      await app.press(key);
      await expect(tool(app, name)).toHaveAttribute('aria-pressed', 'true');
      await expect(tool(app, 'Align Left')).toHaveAttribute('aria-pressed', 'false');
      expect(await pPr(app)).toContain(`w:jc w:val="${val}"`);
      await app.press(`${MOD}+l`);
      await expect(tool(app, 'Align Left')).toHaveAttribute('aria-pressed', 'true');
      expect(await pPr(app)).not.toContain('w:jc w:val="' + val);
      await tool(app, name).click();
      await expect(tool(app, name)).toHaveAttribute('aria-pressed', 'true');
    });
  }

  test('Format ▸ Align ▸ each choice aligns the paragraph', async ({ app }) => {
    await app.blank();
    await app.type('text');
    for (const [item, button] of [['Center', 'Center'], ['Align Right', 'Align Right'], ['Justify', 'Justify'], ['Align Left', 'Align Left']] as const) {
      await app.menu('Format', 'Align', item);
      await expect(tool(app, button)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('alignment applies to every selected paragraph and only to them', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await app.press('Enter');
    await app.type('three');
    await app.press('ArrowUp');
    await app.press('Shift+ArrowUp');
    await expect.poll(() => app.selectedText()).toContain('\n');
    await app.press(`${MOD}+e`);
    await expect.poll(async () => (await pPr(app, 0)).includes('center')).toBe(true);
    expect(await pPr(app, 1)).toContain('center');
    expect(await pPr(app, 2)).not.toContain('center');
  });

  test('the button state follows the caret from paragraph to paragraph', async ({ app }) => {
    await app.blank();
    await app.type('left');
    await app.press('Enter');
    await app.press(`${MOD}+r`);
    await app.type('right');
    await expect(tool(app, 'Align Right')).toHaveAttribute('aria-pressed', 'true');
    await app.press('ArrowUp');
    await expect(tool(app, 'Align Left')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a new paragraph keeps the alignment', async ({ app }) => {
    await app.blank();
    await app.press(`${MOD}+e`);
    await app.type('mid');
    await app.press('Enter');
    await expect(tool(app, 'Center')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('line spacing', () => {
  for (const [item, line] of [['1.5', '360'], ['2.', '480'], ['1.15', '276'], ['2.5', '600'], ['3.', '720']] as const) {
    test(`Format ▸ Line Spacing ▸ ${item} sets w:line=${line}`, async ({ app }) => {
      await app.blank();
      await app.type('spaced');
      await app.menu('Format', 'Line Spacing', item);
      await expect.poll(async () => pPr(app)).toMatch(new RegExp(`w:spacing[^>]*w:line="${line}"`));
    });
  }

  test('double spacing makes the paragraph taller (more pages)', async ({ app }) => {
    await app.blank();
    await app.editor.focus();
    await app.page.keyboard.insertText('alpha '.repeat(700));
    const pageCount = () => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length);
    await expect.poll(pageCount).toBeGreaterThanOrEqual(1);
    const before = await pageCount();
    await app.press(`${DOC}+a`);
    await app.menu('Format', 'Line Spacing', '2.');
    await expect.poll(pageCount).toBeGreaterThan(before);
  });
});

test.describe('bullets and numbering', () => {
  test('the Bullets button makes a bulleted paragraph and toggles off again', async ({ app }) => {
    await app.blank();
    await app.type('item');
    await tool(app, 'Bullets').click();
    await expect(tool(app, 'Bullets')).toHaveAttribute('aria-pressed', 'true');
    await expect(tool(app, 'Numbering')).toHaveAttribute('aria-pressed', 'false');
    expect(await pPr(app)).toContain('w:numPr');
    await tool(app, 'Bullets').click();
    await expect(tool(app, 'Bullets')).toHaveAttribute('aria-pressed', 'false');
    expect(await pPr(app)).not.toContain('w:numPr');
    await expect.poll(() => app.text()).toBe('item');
  });

  test('the Numbering button makes a numbered paragraph; Bullets switches it', async ({ app }) => {
    await app.blank();
    await app.type('item');
    await tool(app, 'Numbering').click();
    await expect(tool(app, 'Numbering')).toHaveAttribute('aria-pressed', 'true');
    await tool(app, 'Bullets').click();
    await expect(tool(app, 'Bullets')).toHaveAttribute('aria-pressed', 'true');
    await expect(tool(app, 'Numbering')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the Format menu dialogs that are not built yet say so and change nothing', async ({ app }) => {
    await app.blank();
    await app.type('item');
    for (const item of ['Font', 'Bullets and Numbering', 'Borders and Shading', 'Tabs', 'Styles']) {
      await app.menu('Format', item);
      await expect.poll(() => app.page.evaluate(() => (window as unknown as { status: string }).status), { message: item }).toBe(`${item} isn’t available yet`);
    }
    await expect.poll(() => app.text()).toBe('item');
  });

  test('Enter in a list continues it; the list text stays separate paragraphs', async ({ app }) => {
    await app.blank();
    await tool(app, 'Numbering').click();
    await app.type('one');
    await app.press('Enter');
    await app.type('two');
    await app.press('Enter');
    await app.type('three');
    await expect.poll(() => app.text()).toBe('one\ntwo\nthree');
    const xml = await downloadDocumentXml(app);
    expect(xml.match(/<w:numPr>/g)).toHaveLength(3);
    await expect(tool(app, 'Numbering')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Enter on an empty list item ends the list', async ({ app }) => {
    await app.blank();
    await tool(app, 'Bullets').click();
    await app.type('one');
    await app.press('Enter');
    await app.press('Enter');
    await expect(tool(app, 'Bullets')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a list applies to every selected paragraph', async ({ app }) => {
    await app.blank();
    await app.type('a');
    await app.press('Enter');
    await app.type('b');
    await app.press(`${MOD}+a`);
    await tool(app, 'Bullets').click();
    const xml = await downloadDocumentXml(app);
    expect(xml.match(/<w:numPr>/g)).toHaveLength(2);
  });
});

test.describe('indent', () => {
  test('Increase Indent and Decrease Indent step the left indent', async ({ app }) => {
    await app.blank();
    await app.type('indent me');
    await tool(app, 'Increase Indent').click();
    await expect.poll(async () => pPr(app)).toMatch(/w:ind [^>]*w:left="720"/);
    await tool(app, 'Increase Indent').click();
    await expect.poll(async () => pPr(app)).toMatch(/w:ind [^>]*w:left="1440"/);
    await tool(app, 'Decrease Indent').click();
    await expect.poll(async () => pPr(app)).toMatch(/w:ind [^>]*w:left="720"/);
    await tool(app, 'Decrease Indent').click();
    await expect.poll(async () => pPr(app)).not.toMatch(/w:left="[1-9]/);
  });

  test('Decrease Indent at the margin does nothing', async ({ app }) => {
    await app.blank();
    await app.type('flush');
    await tool(app, 'Decrease Indent').click();
    await expect.poll(() => app.text()).toBe('flush');
    expect(await pPr(app)).not.toMatch(/w:left="[1-9]/);
  });

  test('the indent shortcuts work where the platform defines them', async ({ app }) => {
    test.skip(IS_MAC, 'Ctrl+M / Ctrl+Shift+M are the shortcuts on Windows and Linux only');
    await app.blank();
    await app.type('x');
    await app.press(`${MOD}+m`);
    await expect.poll(async () => pPr(app)).toMatch(/w:left="720"/);
    await app.press(`${MOD}+Shift+m`);
    await expect.poll(async () => pPr(app)).not.toMatch(/w:left="[1-9]/);
  });
});

test.describe('Format Painter', () => {
  async function styledLine(app: App) {
    await app.blank();
    await app.type('fancy plain');
    const gaps = await lineGaps(app, 11);
    await clickAt(app, { x: (gaps[0].x + gaps[5].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('fancy');
    await app.press(`${MOD}+b`);
    await app.press(`${MOD}+i`);
    await pickColor(app.page, 'Font Color', '#FF0000');
    return gaps;
  }

  test('copies the look of the selection onto the next mouse selection, once', async ({ app }) => {
    const gaps = await styledLine(app);
    await tool(app, 'Format Painter').click();
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'true');
    await app.page.waitForTimeout(0);
    await clickAt(app, { x: (gaps[6].x + gaps[11].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'false');
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'plain')).toEqual(expect.arrayContaining(['b', 'i', 'color:FF0000']));
    expect(runs.map((r) => r.text).join('')).toBe('fancy plain');
  });

  test('is used up after one paint: the next selection is not painted', async ({ app }) => {
    const gaps = await styledLine(app);
    await tool(app, 'Format Painter').click();
    await clickAt(app, { x: (gaps[6].x + gaps[11].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'false');
    // Clear the painted word, then select it again: nothing is painted any more.
    await app.press(`${MOD}+Space`);
    await clickAt(app, gaps[1]); // a click elsewhere, so the next double click is not counted with the last
    await clickAt(app, { x: (gaps[6].x + gaps[11].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('plain');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape cancels it', async ({ app }) => {
    const gaps = await styledLine(app);
    await tool(app, 'Format Painter').click();
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'true');
    await app.press('Escape');
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'false');
    await clickAt(app, { x: (gaps[6].x + gaps[11].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('plain');
    expect(propsFor(runsOf(await downloadDocumentXml(app)), 'plain')).not.toContain('b');
  });

  test('clicking the button again cancels it', async ({ app }) => {
    await styledLine(app);
    await tool(app, 'Format Painter').click();
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'true');
    await tool(app, 'Format Painter').click();
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Format ▸ Format Painter starts it as well', async ({ app }) => {
    await styledLine(app);
    await app.menu('Format', 'Format Painter');
    await expect(tool(app, 'Format Painter')).toHaveAttribute('aria-pressed', 'true');
    await app.press('Escape');
  });
});
