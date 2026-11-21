// View › Markdown Source shows a Markdown document's file as text; editing it and switching back merges the edit
// into the document, keeping the formatting Markdown cannot hold (alignment here) wherever the edit did not reach.

import { expect, test } from '../fixtures';
import { convertTo } from '../files/helpers';

async function alignOf(app: { page: import('@playwright/test').Page; idle(): Promise<void> }, paragraph: number): Promise<string | undefined> {
  await app.page.evaluate((p) => window.golem.doc.select(p, 0), paragraph);
  await app.idle();
  return app.page.evaluate(() => (window.golem.state() as { format: { align?: string } }).format.align);
}

test.describe('Markdown source view', () => {
  test('edits in the source merge back as one undo step and keep the alignment', async ({ app }) => {
    // Centre the first paragraph while it is a Word document: Markdown has no way to say so, so only the merge can keep it.
    await app.blank();
    await app.type('First line');
    await app.press('Enter');
    await app.type('Second line');
    await app.idle();
    await app.page.evaluate(() => window.golem.doc.select(0, 0));
    await app.idle();
    expect(await app.run('format.align.center')).toBe(true);
    await app.idle();
    await convertTo(app, 'Markdown (.md)', 'Markdown');
    expect(await alignOf(app, 0)).toBe('center');

    await app.menu('View', 'Markdown Source');
    await expect.poll(() => app.inTextEditor()).toBe(true);
    await expect.poll(() => app.text()).toBe('First line\n\nSecond line\n');
    await app.focus();
    await app.press('ControlOrMeta+End');
    await app.type('\n## A heading\n');

    // ⌘/ (Ctrl+/) switches back.
    await app.press('ControlOrMeta+/');
    await expect.poll(() => app.inTextEditor()).toBe(false);
    await app.idle();
    const outline = await app.outline();
    expect(outline?.map((n) => [n.kind, n.text])).toEqual([
      ['paragraph', 'First line'],
      ['paragraph', 'Second line'],
      ['heading', 'A heading'],
    ]);
    expect(await alignOf(app, 0)).toBe('center');

    // The whole source edit is one undo step.
    await app.focus();
    await app.press('ControlOrMeta+z');
    await app.idle();
    expect((await app.outline())?.map((n) => n.text)).toEqual(['First line', 'Second line']);
    expect(await alignOf(app, 0)).toBe('center');
  });
});
