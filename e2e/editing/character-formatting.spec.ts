import { test, expect, type App } from '../fixtures';
import { MOD, menuSub, IS_MAC, clickAt, downloadDocumentXml, lineGaps, propsFor, runsOf, selectBy, tool, typeAndSelect } from './helpers';

const STRIKE = IS_MAC ? 'Meta+Shift+x' : 'Alt+Shift+5';

const pressed = (app: App, name: string) => tool(app, name);

test.describe('toggling character marks', () => {
  for (const [name, key, prop] of [
    ['Bold', `${MOD}+b`, 'b'],
    ['Italic', `${MOD}+i`, 'i'],
    ['Underline', `${MOD}+u`, 'u:single'],
    ['Strikethrough', STRIKE, 'strike'],
  ] as const) {
    test(`${name}: the shortcut toggles it on and off, and the button shows the state`, async ({ app }) => {
      await app.blank();
      await typeAndSelect(app, 'sample');
      await expect(pressed(app, name)).toHaveAttribute('aria-pressed', 'false');
      await app.press(key);
      await expect(pressed(app, name)).toHaveAttribute('aria-pressed', 'true');
      expect(propsFor(runsOf(await downloadDocumentXml(app)), 'sample')).toContain(prop);
      await app.press(key);
      await expect(pressed(app, name)).toHaveAttribute('aria-pressed', 'false');
      expect(propsFor(runsOf(await downloadDocumentXml(app)), 'sample')).not.toContain(prop);
    });

    test(`${name}: the toolbar button toggles it`, async ({ app }) => {
      await app.blank();
      await typeAndSelect(app, 'sample');
      await tool(app, name).click();
      await expect(pressed(app, name)).toHaveAttribute('aria-pressed', 'true');
      await tool(app, name).click();
      await expect(pressed(app, name)).toHaveAttribute('aria-pressed', 'false');
    });
  }

  test('Format ▸ Character has every mark, and checks the ones that are on', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.menu('Format', 'Character');
    const item = (name: string) => app.page.getByRole('menu').getByRole('menuitemcheckbox', { name: new RegExp(`${name}(?![a-z])`) });
    for (const name of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Superscript', 'Subscript']) await expect(item(name)).toBeVisible();
    await expect(item('Grow Font').or(app.page.getByRole('menuitem', { name: /Grow Font/ })).first()).toBeVisible();
    await expect(item('Bold')).toHaveAttribute('aria-checked', 'true');
    await expect(item('Italic')).toHaveAttribute('aria-checked', 'false');
    await app.press('Escape');
  });

  test('Format ▸ Character ▸ each mark applies it', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await menuSub(app, 'Format', 'Character', 'Bold');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await menuSub(app, 'Format', 'Character', 'Italic');
    await expect(tool(app, 'Italic')).toHaveAttribute('aria-pressed', 'true');
    await menuSub(app, 'Format', 'Character', 'Underline');
    await expect(tool(app, 'Underline')).toHaveAttribute('aria-pressed', 'true');
    await menuSub(app, 'Format', 'Character', 'Strikethrough');
    await expect(tool(app, 'Strikethrough')).toHaveAttribute('aria-pressed', 'true');
    const props = propsFor(runsOf(await downloadDocumentXml(app)), 'sample');
    expect(props).toEqual(expect.arrayContaining(['b', 'i', 'u:single', 'strike']));
  });

  test('superscript and subscript: shortcut, menu, and the document markup', async ({ app }) => {
    await app.blank();
    await app.type('x2');
    await selectBy(app, 'Shift+ArrowLeft', 1, '2');
    await app.press(`${MOD}+.`);
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), '2')).toContain('vertAlign:superscript');
    await app.press(`${MOD}+.`);
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), '2')).not.toContain('vertAlign:superscript');
    await app.press(`${MOD},`.replace(',', '+,'));
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), '2')).toContain('vertAlign:subscript');
    await menuSub(app, 'Format', 'Character', 'Subscript');
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), '2')).not.toContain('vertAlign:subscript');
    await menuSub(app, 'Format', 'Character', 'Superscript');
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), '2')).toContain('vertAlign:superscript');
  });

  test('superscript and subscript replace each other', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'n');
    await app.press(`${MOD}+.`);
    await expect.poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), 'n')).toContain('vertAlign:superscript');
    await app.press(`${MOD}+,`);
    await expect
      .poll(async () => propsFor(runsOf(await downloadDocumentXml(app)), 'n').filter((p) => p.startsWith('vertAlign')))
      .toEqual(['vertAlign:subscript']);
  });

  test('marks can be combined on the same text', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'all three');
    await app.press(`${MOD}+b`);
    await app.press(`${MOD}+i`);
    await app.press(`${MOD}+u`);
    for (const name of ['Bold', 'Italic', 'Underline']) await expect(tool(app, name)).toHaveAttribute('aria-pressed', 'true');
    expect(propsFor(runsOf(await downloadDocumentXml(app)), 'all three')).toEqual(expect.arrayContaining(['b', 'i', 'u:single']));
  });
});

test.describe('marks on part of the text and at the caret', () => {
  test('only the selected word is formatted', async ({ app }) => {
    await app.blank();
    await app.type('plain bold plain');
    const gaps = await lineGaps(app, 16);
    await clickAt(app, { x: (gaps[6].x + gaps[10].x) / 2, y: gaps[0].y }, { clickCount: 2 });
    await expect.poll(async () => (await app.selectedText()).trim()).toBe('bold');
    await app.press(`${MOD}+b`);
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'bold')).toContain('b');
    expect(propsFor(runs, 'plain')).not.toContain('b');
    expect(runs.map((r) => r.text).join('')).toBe('plain bold plain');
  });

  test('the Bold button reflects the caret position', async ({ app }) => {
    await app.blank();
    await app.type('aa');
    await app.press('Shift+ArrowLeft', 2);
    await app.press(`${MOD}+b`);
    await app.press('ArrowRight');
    await app.type(' bb');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true'); // typing after bold continues it
    await app.press(`${MOD}+b`);
    await app.type('cc');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    await app.press('Home');
    await app.press('ArrowRight');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.press('End');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a selection that mixes bold and plain text shows Bold as off', async ({ app }) => {
    await app.blank();
    await app.type('aabb');
    await selectBy(app, 'Shift+ArrowLeft', 2, 'bb');
    await app.press(`${MOD}+b`);
    await app.press(`${MOD}+a`);
    await expect.poll(() => app.selectedText()).toBe('aabb');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    // Pressing Bold on a mixed selection makes all of it bold.
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    const runs = runsOf(await downloadDocumentXml(app));
    expect(runs.every((r) => r.props.includes('b'))).toBe(true);
  });

  test('turning Bold on at the caret formats what is typed next, not what came before', async ({ app }) => {
    await app.blank();
    await app.type('before ');
    await app.press(`${MOD}+b`);
    await app.type('bold');
    await app.press(`${MOD}+b`);
    await app.type(' after');
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'before')).not.toContain('b');
    expect(propsFor(runs, 'bold')).toContain('b');
    expect(propsFor(runs, 'after')).not.toContain('b');
  });

  test('a new paragraph carries the formatting of the one before', async ({ app }) => {
    await app.blank();
    await app.press(`${MOD}+i`);
    await app.type('first');
    await app.press('Enter');
    await app.type('second');
    await app.press(`${MOD}+a`);
    await expect(tool(app, 'Italic')).toHaveAttribute('aria-pressed', 'true');
  });

  test('formatting an empty selection at the caret and then clicking elsewhere drops the pending format', async ({ app }) => {
    await app.blank();
    await app.type('ab');
    await app.press(`${MOD}+b`);
    await app.press('ArrowLeft');
    await app.type('X');
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'X')).not.toContain('b');
  });
});

test.describe('Code mark in a Markdown document', () => {
  test('Format ▸ Character ▸ Code marks the selection as code', async ({ app }) => {
    await app.blank();
    // Switch the open document to Markdown with the format box, where the Code mark exists.
    const formatBox = app.page.getByRole('combobox', { name: 'Document format' });
    await formatBox.click();
    await app.page.getByRole('option', { name: 'Markdown' }).click();
    await expect(formatBox).toHaveValue('Markdown');
    await app.focus();
    await app.type('call fn now');
    await app.press('Shift+ArrowLeft', 6);
    await expect.poll(() => app.selectedText()).toBe('fn now');
    await menuSub(app, 'Format', 'Character', 'Code');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.text).toContain('`fn now`');
  });
});
