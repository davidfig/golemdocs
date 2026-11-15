// The automation API (`window.golem`, client/src/automation.ts, docs/architecture/automation.md) that agents and tests drive the
// app through: commands run as their menu items would, the document read back through the layout worker, dialogs read by name.

import { expect, test } from '../fixtures';

test.describe('window.golem', () => {
  test('describes itself, and reads a document’s outline, text and Markdown', async ({ app }) => {
    await app.goto('?doc=welcome');
    await app.idle();
    const help = await app.page.evaluate(() => window.golem.help());
    expect(help).toContain('golem.commands.run(id)');
    const state = await app.page.evaluate(() => window.golem.state());
    expect(state.loaded).toBe(true);
    expect(state.kind).toBe('docx');

    const outline = (await app.outline())!;
    expect(outline.length).toBeGreaterThan(5);
    const heading = outline.find((n) => n.kind === 'heading')!;
    // A picture in the text reads as U+FFFC, as it does for a screen reader.
    const title = heading.text.replace(/\uFFFC/g, '').trim();
    expect(heading.level).toBeGreaterThanOrEqual(1);
    expect(outline.map((n) => n.paragraph)).toEqual(outline.map((_, i) => i));

    const text = await app.page.evaluate(() => window.golem.doc.text());
    expect(text).toContain(title);
    const markdown = await app.page.evaluate(() => window.golem.doc.markdown());
    expect(markdown).toMatch(new RegExp(`^#+ .*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  });

  test('selects text and runs a command on it, and lists the command as checked after', async ({ app }) => {
    await app.blank();
    await app.type('Hello world');
    await app.page.evaluate(() => window.golem.doc.select(0, 0, 5));
    expect(await app.page.evaluate(() => window.golem.selection().text)).toBe('Hello');
    expect(await app.page.evaluate(() => window.golem.state().hasSelection)).toBe(true);

    const before = await app.page.evaluate(() => window.golem.commands.list('format.bold'));
    expect(before).toEqual([expect.objectContaining({ id: 'format.bold', label: 'Bold', enabled: true, checked: false })]);
    expect(await app.run('format.bold')).toBe(true);
    await app.idle();
    await expect.poll(() => app.page.evaluate(() => window.golem.commands.list('format.bold')[0].checked)).toBe(true);
    expect(await app.page.evaluate(() => window.golem.state().canUndo)).toBe(true);

    const error = await app.page.evaluate(() => {
      try {
        window.golem.commands.run('format.bld');
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(error).toMatch(/unknown command "format\.bld".*format\.bold/);
  });

  test('reads the dialogs that are open, with their fields and buttons', async ({ app }) => {
    await app.blank();
    expect(await app.page.evaluate(() => window.golem.dialogs())).toEqual([]);
    await app.menu('Edit', 'Go To');
    await expect(app.page.locator('dialog[open]')).toHaveCount(1);
    const [dialog] = await app.page.evaluate(() => window.golem.dialogs());
    // Go To is a tab of Find and Replace, which stays open beside the document (it is not modal).
    expect(dialog.title).toBe('Find and Replace');
    expect(dialog.modal).toBe(false);
    expect(dialog.fields).toContainEqual(expect.objectContaining({ type: 'tab', label: 'Go To', checked: true }));
    expect(dialog.fields.every((f) => f.label.length > 0)).toBe(true);
    expect(dialog.buttons.map((b) => b.label)).toContain('Close');
    expect(dialog.buttons.every((b) => b.label.length > 0)).toBe(true);
    await app.press('Escape');
    await expect.poll(() => app.page.evaluate(() => window.golem.dialogs().length)).toBe(0);
  });

  test('opens a document and waits until it is laid out', async ({ app }) => {
    await app.blank();
    await app.page.evaluate(() => window.golem.doc.open('welcome'));
    const state = await app.page.evaluate(() => window.golem.state());
    expect(state.loaded).toBe(true);
    expect(state.document).not.toBe('');
    expect((await app.outline())!.length).toBeGreaterThan(5);
  });
});
