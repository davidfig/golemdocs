import { test, expect, type App } from '../fixtures';
import { CLIENT_ORIGIN, CLIENT_PORT } from '../ports.ts';
import { MOD, IS_MAC, caretClient, clickAt, dialog, docxPart, lineGaps, propsFor, runsOf, selectBy, tool, typeAndSelect } from './helpers';

/** document.xml and the relationship targets of a downloaded copy. */
async function saved(app: App) {
  const file = await app.download(() => app.menu('File', 'Download'));
  const xml = docxPart(file.bytes, 'word/document.xml');
  let rels = '';
  try {
    rels = docxPart(file.bytes, 'word/_rels/document.xml.rels');
  } catch {
    // no relationships part: no links
  }
  const targets = [...rels.matchAll(/Target="([^"]*)"[^>]*TargetMode="External"|TargetMode="External"[^>]*Target="([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  return { xml, targets };
}

/**
 * Waits until a link to `url` is in the document (or, for null, until there is none). Reading the
 * text with Select All straight after the dialog closes can beat the link being applied, so the
 * tests look at a saved copy, which leaves the selection alone.
 */
async function linkApplied(app: App, url: string | null): Promise<void> {
  await expect.poll(async () => (await saved(app)).targets.includes(url ?? '\0') || (url === null && !(await saved(app)).xml.includes('<w:hyperlink'))).toBe(true);
}

const link = (page: import('@playwright/test').Page) => dialog(page, 'Insert Hyperlink');

async function openLinkDialog(app: App) {
  await app.press(`${MOD}+k`);
  const box = link(app.page);
  await expect(box).toBeVisible();
  return box;
}

test.describe('Insert Hyperlink dialog', () => {
  test('Ctrl/Cmd+K over selected text shows it in the dialog and links it', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'click here');
    const box = await openLinkDialog(app);
    await expect(box.getByRole('textbox', { name: 'Text to display' })).toHaveValue('click here');
    await expect(box.getByRole('textbox', { name: 'Address' })).toBeFocused();
    await expect(box.getByRole('button', { name: 'Remove Link' })).toBeDisabled();
    await box.getByRole('textbox', { name: 'Address' }).fill('https://example.com/page');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await expect.poll(() => app.text()).toBe('click here');
    const { xml, targets } = await saved(app);
    expect(xml).toContain('<w:hyperlink');
    expect(targets).toContain('https://example.com/page');
  });

  test('with nothing selected the text to display is asked for and inserted', async ({ app }) => {
    await app.blank();
    await app.type('see ');
    const box = await openLinkDialog(app);
    await expect(box.getByRole('textbox', { name: 'Text to display' })).toBeFocused();
    await box.getByRole('textbox', { name: 'Text to display' }).fill('the site');
    await box.getByRole('textbox', { name: 'Address' }).fill('example.org');
    await box.getByRole('textbox', { name: 'Address' }).press('Enter');
    await expect(box).toHaveCount(0);
    await linkApplied(app, 'https://example.org');
    await expect.poll(() => app.text()).toBe('see the site');
    const { targets } = await saved(app);
    expect(targets).toContain('https://example.org');
  });

  test('the toolbar button and Insert ▸ Hyperlink open the same dialog', async ({ app }) => {
    await app.blank();
    await app.type('x');
    await tool(app, 'Hyperlink').click();
    await expect(link(app.page)).toBeVisible();
    await link(app.page).getByRole('button', { name: 'Cancel' }).click();
    await expect(link(app.page)).toHaveCount(0);
    await app.menu('Insert', 'Hyperlink');
    await expect(link(app.page)).toBeVisible();
    await link(app.page).getByRole('button', { name: 'Close' }).click();
    await expect(link(app.page)).toHaveCount(0);
  });

  const schemes: [string, string][] = [
    ['example.com', 'https://example.com'],
    ['http://example.com/a', 'http://example.com/a'],
    ['HTTPS://Example.com', 'HTTPS://Example.com'],
    ['ada@example.com', 'mailto:ada@example.com'],
    ['mailto:ada@example.com', 'mailto:ada@example.com'],
    ['tel:+15551234567', 'tel:+15551234567'],
    ['ftp://files.example.com/x', 'ftp://files.example.com/x'],
  ];
  for (const [typed, stored] of schemes) {
    test(`the address "${typed}" is stored as ${stored}`, async ({ app }) => {
      await app.blank();
      await typeAndSelect(app, 'link');
      const box = await openLinkDialog(app);
      await box.getByRole('textbox', { name: 'Address' }).fill(typed);
      await box.getByRole('button', { name: 'OK' }).click();
      await expect(box).toHaveCount(0);
      const { targets } = await saved(app);
      expect(targets).toContain(stored);
    });
  }

  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'two words here', 'file:///etc/passwd']) {
    test(`"${bad}" is refused with a message`, async ({ app }) => {
      await app.blank();
      await typeAndSelect(app, 'link');
      const box = await openLinkDialog(app);
      await box.getByRole('textbox', { name: 'Address' }).fill(bad);
      await box.getByRole('button', { name: 'OK' }).click();
      await expect(box).toBeVisible();
      await expect(box.getByRole('alert')).toContainText('isn’t an address a link can open');
      await box.getByRole('button', { name: 'Cancel' }).click();
      expect((await saved(app)).xml).not.toContain('<w:hyperlink');
    });
  }

  test('an empty address asks for one', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'link');
    const box = await openLinkDialog(app);
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box.getByRole('alert')).toContainText('Enter an address.');
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Cancel and Escape leave the document alone', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'link');
    let box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('example.com');
    await box.getByRole('button', { name: 'Cancel' }).click();
    await expect(box).toHaveCount(0);
    box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('example.com');
    await app.page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect((await saved(app)).xml).not.toContain('<w:hyperlink');
  });

  test('linking keeps the text’s formatting', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'strong');
    await app.press(`${MOD}+b`);
    const box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('example.com');
    await box.getByRole('button', { name: 'OK' }).click();
    const { xml } = await saved(app);
    expect(propsFor(runsOf(xml), 'strong')).toContain('b');
  });

  test('typing resumes in the document after the dialog', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'abc');
    const box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('example.com');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await app.press(`${MOD}+End`);
    await expect(app.editor).toBeFocused();
  });
});

test.describe('editing and removing a link', () => {
  async function linked(app: App) {
    await app.blank();
    await app.type('before  after');
    await app.press('ArrowLeft', 6);
    await app.press(`${MOD}+k`);
    const box = link(app.page);
    await box.getByRole('textbox', { name: 'Text to display' }).fill('the link');
    await box.getByRole('textbox', { name: 'Address' }).fill('https://example.com/one');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, 'https://example.com/one');
    await expect.poll(() => app.text()).toBe('before the link after');
  }

  async function caretInLink(app: App) {
    const gaps = await lineGaps(app, 'before the link after'.length);
    await clickAt(app, gaps[11]); // inside "the link"
    return gaps;
  }

  test('with the caret in a link the dialog shows its text and address and offers Remove Link', async ({ app }) => {
    await linked(app);
    await caretInLink(app);
    const box = await openLinkDialog(app);
    await expect(box.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.com/one');
    await expect(box.getByRole('textbox', { name: 'Text to display' })).toHaveValue('the link');
    await expect(box.getByRole('button', { name: 'Remove Link' })).toBeEnabled();
    await box.getByRole('button', { name: 'Cancel' }).click();
  });

  test('changing the address retargets the link', async ({ app }) => {
    await linked(app);
    await caretInLink(app);
    const box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('https://example.com/two');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, 'https://example.com/two');
    const { targets, xml } = await saved(app);
    expect(targets).toContain('https://example.com/two');
    expect(xml.match(/<w:hyperlink/g)).toHaveLength(1);
    await expect.poll(() => app.text()).toBe('before the link after');
  });

  test('changing the text to display changes the link’s text', async ({ app }) => {
    await linked(app);
    await caretInLink(app);
    const box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Text to display' }).fill('renamed');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await expect.poll(async () => (await saved(app)).xml).toContain('renamed');
    await expect.poll(() => app.text()).toBe('before renamed after');
  });

  test('Remove Link takes the link off and keeps the text', async ({ app }) => {
    await linked(app);
    await caretInLink(app);
    const box = await openLinkDialog(app);
    await box.getByRole('button', { name: 'Remove Link' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, null);
    await expect.poll(() => app.text()).toBe('before the link after');
    expect((await saved(app)).xml).not.toContain('<w:hyperlink');
  });

  test('linking is undoable in one step', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'abc');
    const box = await openLinkDialog(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('example.com');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, 'https://example.com');
    await expect(app.editor).toBeFocused();
    await app.press(`${MOD}+z`);
    await expect.poll(async () => (await saved(app)).xml).not.toContain('<w:hyperlink');
    await expect.poll(() => app.text()).toBe('abc');
  });

  test.fixme('text typed right after the end of a link does not become part of the link (it does: the link grows)', async ({ app }) => {
    await app.blank();
    await app.type('the link');
    await app.press(`Shift+Home`);
    await app.press(`${MOD}+k`);
    const box = link(app.page);
    await box.getByRole('textbox', { name: 'Address' }).fill('https://example.com/one');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, 'https://example.com/one');
    await app.press(`${MOD}+End`);
    await app.type(' after');
    await expect.poll(() => app.text()).toBe('the link after');
    const gaps = await lineGaps(app, 'the link after'.length);
    await clickAt(app, gaps[11]);
    const again = await openLinkDialog(app);
    await expect(again.getByRole('textbox', { name: 'Text to display' })).toHaveValue('the link');
  });

  test('Ctrl/Cmd+click follows the link in a new tab; a plain click only places the caret', async ({ app }) => {
    await app.blank();
    await app.type('go ');
    await app.press(`${MOD}+k`);
    const box = link(app.page);
    await box.getByRole('textbox', { name: 'Text to display' }).fill('home');
    await box.getByRole('textbox', { name: 'Address' }).fill(`${CLIENT_ORIGIN}/?doc=welcome`);
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);
    await linkApplied(app, `${CLIENT_ORIGIN}/?doc=welcome`);
    await expect.poll(() => app.text()).toBe('go home');
    const gaps = await lineGaps(app, 'go home'.length);
    const inside = { x: (gaps[3].x + gaps[7].x) / 2, y: gaps[0].y };

    // A plain click opens nothing.
    let opened = 0;
    app.page.context().on('page', () => opened++);
    await clickAt(app, inside);
    await app.page.waitForTimeout(300);
    expect(opened).toBe(0);

    const popup = app.page.context().waitForEvent('page');
    await clickAt(app, inside, { modifiers: [IS_MAC ? 'Meta' : 'Control'] });
    const tab = await popup;
    await expect.poll(() => tab.url()).toContain(`localhost:${CLIENT_PORT}`);
    await tab.close();
  });

  void caretClient;
  void selectBy;
});
