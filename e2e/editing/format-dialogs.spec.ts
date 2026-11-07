// The Format and Insert dialogs that set what a document stores: Font, Borders and Shading, Tabs, Bullets and Numbering, Styles, Page Numbers
// and Bookmark. Each is driven as a person would, and what it did is read back from the .docx the document downloads as.

import { test, expect, MOD, pickChoice, type App } from '../fixtures';
import { readZip } from '../files/helpers';
import type { Locator } from '@playwright/test';

const shots = process.env.SHOT_DIR;
const shot = async (box: Locator, name: string) => {
  if (!shots) return;
  await box.page().waitForTimeout(250);
  await box.screenshot({ path: `${shots}/${name}.png` });
};

const dialog = (app: App, name: string) => app.page.getByRole('dialog', { name, exact: true });

/** The downloaded .docx: its parts, as text. */
async function parts(app: App): Promise<Map<string, string>> {
  const file = await app.download(() => app.menu('File', 'Download'));
  return new Map(readZip(file.bytes).map(({ name, bytes }) => [name, bytes.toString('utf8')]));
}
const documentXml = async (app: App) => (await parts(app)).get('word/document.xml') ?? '';
const stylesXml = async (app: App) => (await parts(app)).get('word/styles.xml') ?? '';

/** Picks from one of the dialogs' drop-down lists. */
async function pick(box: Locator, list: string, option: string): Promise<void> {
  await box.getByRole('button', { name: list, exact: true }).click();
  await box.page().getByRole('option', { name: option, exact: true }).click();
}

async function start(app: App, text = 'some words'): Promise<void> {
  await app.blank();
  await app.type(text);
  await app.page.keyboard.press(`${MOD}+a`);
}

test.describe('Format › Font', () => {
  test('sets what was changed on the selection, and only that', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Font');
    const box = dialog(app, 'Font');
    await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'Style' })).toContainText('Regular');
    await shot(box, 'font');
    await pick(box, 'Style', 'Bold Italic');
    await box.getByRole('spinbutton', { name: 'Size' }).fill('18');
    await pick(box, 'Underline', 'Double');
    await box.getByRole('checkbox', { name: 'Small caps' }).check();
    await box.getByRole('tab', { name: 'Character Spacing' }).click();
    await pick(box, 'Spacing', 'Expanded');
    await box.getByRole('spinbutton', { name: 'By' }).first().fill('2');
    await shot(box, 'font-spacing');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();

    const xml = await documentXml(app);
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toMatch(/<w:i\/>/);
    expect(xml).toContain('<w:sz w:val="36"/>');
    expect(xml).toMatch(/<w:u w:val="double"\/>/);
    expect(xml).toMatch(/<w:smallCaps\/>/);
    expect(xml).toContain('<w:spacing w:val="40"/>');
    expect(xml).not.toContain('w:strike');
  });

  test('opens from its shortcut, shows what is there, and Cancel changes nothing', async ({ app }) => {
    await start(app);
    await app.page.keyboard.press(`${MOD}+b`);
    await app.page.keyboard.press(`${MOD}+d`);
    const box = dialog(app, 'Font');
    await expect(box.getByRole('button', { name: 'Style' })).toContainText('Bold');
    await pick(box, 'Style', 'Italic');
    await box.getByRole('button', { name: 'Cancel' }).click();
    const xml = await documentXml(app);
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).not.toMatch(/<w:i\/>/);
  });

  test('a selection of mixed colors keeps them when only the size is changed', async ({ app }) => {
    await app.blank();
    await app.type('red blue');
    await app.page.keyboard.press('Home');
    await app.page.keyboard.press('Shift+ArrowRight');
    await app.page.keyboard.press('Shift+ArrowRight');
    await app.page.keyboard.press('Shift+ArrowRight');
    await app.toolbarButton('Font Color options').click();
    await app.page.getByRole('button', { name: '#FF0000', exact: true }).click();
    await app.focus();
    await app.page.keyboard.press(`${MOD}+a`);
    await app.menu('Format', 'Font');
    const box = dialog(app, 'Font');
    await box.getByRole('spinbutton', { name: 'Size' }).fill('14');
    await box.getByRole('button', { name: 'OK' }).click();
    const xml = await documentXml(app);
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).not.toContain('w:val="auto"');
  });

  test('superscript and subscript are one or the other', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Font');
    const box = dialog(app, 'Font');
    await box.getByRole('checkbox', { name: 'Superscript' }).check();
    await box.getByRole('checkbox', { name: 'Subscript' }).check();
    await expect(box.getByRole('checkbox', { name: 'Superscript' })).not.toBeChecked();
    await box.getByRole('button', { name: 'OK' }).click();
    expect(await documentXml(app)).toContain('<w:vertAlign w:val="subscript"/>');
  });
});

test.describe('Format › Borders and Shading', () => {
  test('a box and a fill on the paragraph, then back to none', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Borders and Shading');
    const box = dialog(app, 'Borders and Shading');
    await expect(box).toBeVisible();
    await box.getByRole('group', { name: 'Setting' }).getByRole('button', { name: 'Box' }).click();
    await pick(box, 'Style', 'Double line');
    await expect(box.getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    await box.getByRole('button', { name: 'Right' }).click();
    await expect(box.getByRole('group', { name: 'Setting' }).getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    await shot(box, 'borders');
    await box.getByRole('tab', { name: 'Shading' }).click();
    await box.getByRole('button', { name: 'Fill' }).click();
    await app.page.getByRole('button', { name: '#FFFF99', exact: true }).click();
    await box.getByRole('button', { name: 'OK' }).click();

    let xml = await documentXml(app);
    expect(xml).toMatch(/<w:top w:val="double"/);
    expect(xml).toMatch(/<w:left w:val="double"/);
    expect(xml).not.toMatch(/<w:right w:val/);
    expect(xml).toContain('w:fill="FFFF99"');

    await app.menu('Format', 'Borders and Shading');
    await box.getByRole('group', { name: 'Setting' }).getByRole('button', { name: 'None' }).click();
    await box.getByRole('tab', { name: 'Shading' }).click();
    await box.getByRole('button', { name: 'Fill' }).click();
    await app.page.getByRole('button', { name: 'No color', exact: true }).click();
    await box.getByRole('button', { name: 'OK' }).click();
    xml = await documentXml(app);
    expect(xml).not.toContain('w:pBdr');
    expect(xml).not.toContain('w:shd');
  });
});

test('a box on several paragraphs is one box', async ({ app, page }) => {
  await app.blank();
  await app.type('First paragraph in the box');
  await page.keyboard.press('Enter');
  await app.type('Second paragraph in the box');
  await page.keyboard.press('Enter');
  await app.type('Third paragraph in the box');
  await page.keyboard.press(`${MOD}+a`);
  await app.menu('Format', 'Borders and Shading');
  const box = dialog(app, 'Borders and Shading');
  await box.getByRole('group', { name: 'Setting' }).getByRole('button', { name: 'Box' }).click();
  await box.getByRole('tab', { name: 'Shading' }).click();
  await box.getByRole('button', { name: 'Fill' }).click();
  await page.getByRole('button', { name: '#FFFF99', exact: true }).click();
  await box.getByRole('button', { name: 'OK' }).click();
  await expect(box).toBeHidden();
  await app.focus();
  await page.keyboard.press(`${MOD}+End`);
  if (shots) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${shots}/joined.png` });
  }
  expect((await documentXml(app)).match(/<w:pBdr>/g)).toHaveLength(3);
});

test.describe('Format › Tabs', () => {
  test('sets, shows and clears stops', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Tabs');
    const box = dialog(app, 'Tabs');
    await box.getByRole('spinbutton', { name: 'Position' }).fill('2');
    await pick(box, 'Alignment', 'Right');
    await pick(box, 'Leader', 'Dots ......');
    await box.getByRole('button', { name: 'Set', exact: true }).click();
    await box.getByRole('spinbutton', { name: 'Position' }).fill('1');
    await box.getByRole('button', { name: 'Set', exact: true }).click();
    const stops = box.getByRole('listbox', { name: 'Tab stops' }).getByRole('option');
    await expect(stops).toHaveText(['1 in', '2 in']);
    await shot(box, 'tabs');
    await stops.first().click();
    await box.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(stops).toHaveText(['2 in']);
    await box.getByRole('button', { name: 'OK' }).click();
    const xml = await documentXml(app);
    expect(xml).toMatch(/<w:tab w:val="right" w:pos="2880" w:leader="dot"\/>|<w:tab w:val="right" w:leader="dot" w:pos="2880"\/>/);
    expect(xml).not.toContain('w:pos="1440"');

    await app.menu('Format', 'Tabs');
    await expect(stops).toHaveText(['2 in']);
    await box.getByRole('button', { name: 'Clear All' }).click();
    await box.getByRole('button', { name: 'OK' }).click();
    expect(await documentXml(app)).not.toContain('w:tabs');
  });

  test('a position that is not a number says so and stays open', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Tabs');
    const box = dialog(app, 'Tabs');
    await box.getByRole('spinbutton', { name: 'Position' }).fill('-3');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box.getByRole('alert')).not.toHaveText('');
    await expect(box).toBeVisible();
  });
});

test.describe('Format › Bullets and Numbering', () => {
  test('picks a bullet, then numbers starting at 5, then none', async ({ app }) => {
    await app.blank();
    await app.type('one');
    await app.page.keyboard.press('Enter');
    await app.type('two');
    await app.page.keyboard.press(`${MOD}+a`);
    await app.menu('Format', 'Bullets and Numbering');
    const box = dialog(app, 'Bullets and Numbering');
    await box.getByRole('radio', { name: 'Bullet ■' }).click();
    await expect(box.getByRole('textbox', { name: 'Character' })).toHaveValue('■');
    await shot(box, 'list-bullets');
    await box.getByRole('button', { name: 'OK' }).click();
    let files = await parts(app);
    expect(files.get('word/numbering.xml')).toContain('w:lvlText w:val="■"');
    expect(files.get('word/document.xml')).toContain('w:numPr');

    await app.menu('Format', 'Bullets and Numbering');
    await box.getByRole('tab', { name: 'Numbered' }).click();
    await box.getByRole('radio', { name: 'a) b) c)' }).click();
    await box.getByRole('spinbutton', { name: 'Start at' }).fill('5');
    await shot(box, 'list-numbers');
    await box.getByRole('button', { name: 'OK' }).click();
    files = await parts(app);
    expect(files.get('word/numbering.xml')).toContain('w:lvlText w:val="%1)"');
    expect(files.get('word/numbering.xml')).toContain('w:numFmt w:val="lowerLetter"');
    expect(files.get('word/numbering.xml')).toContain('w:start w:val="5"');

    await app.menu('Format', 'Bullets and Numbering');
    await box.getByRole('tabpanel').getByRole('radio', { name: 'None' }).click();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => (await documentXml(app)).includes('w:numId w:val="0"') || !(await documentXml(app)).includes('w:numPr')).toBe(true);
  });

  test('a label without its number is refused', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Bullets and Numbering');
    const box = dialog(app, 'Bullets and Numbering');
    await box.getByRole('tab', { name: 'Numbered' }).click();
    await box.getByRole('radio', { name: '1. 2. 3.' }).click();
    await box.getByRole('textbox', { name: 'Label' }).fill('Item');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box.getByRole('alert')).toContainText('%1');
  });
});

test.describe('Format › Styles', () => {
  test('applies a style, makes one and modifies it, deletes it, and undo brings it back', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Styles');
    const box = dialog(app, 'Styles');
    const list = box.getByRole('listbox', { name: 'Styles' });
    await list.getByRole('option', { name: 'Heading 1', exact: true }).click();
    await shot(box, 'styles');
    await box.getByRole('button', { name: 'Apply' }).click();
    await expect(box).toBeHidden();
    expect(await documentXml(app)).toContain('w:pStyle w:val="Heading1"');

    await app.menu('Format', 'Styles');
    await box.getByRole('button', { name: 'New…' }).click();
    const editor = dialog(app, 'New Style');
    await editor.getByRole('button', { name: 'OK' }).click();
    await expect(editor.getByRole('alert')).toContainText('name');
    await editor.getByRole('textbox', { name: 'Name' }).fill('Heading 1');
    await editor.getByRole('button', { name: 'OK' }).click();
    await expect(editor.getByRole('alert')).toContainText('already');
    await editor.getByRole('textbox', { name: 'Name' }).fill('Fine Print');
    await editor.getByRole('button', { name: 'Font…' }).click();
    const font = dialog(app, 'Font');
    await font.getByRole('spinbutton', { name: 'Size' }).fill('8');
    await font.getByRole('button', { name: 'OK' }).click();
    await shot(editor, 'style-new');
    await editor.getByRole('button', { name: 'OK' }).click();
    await expect(list.getByRole('option', { name: 'Fine Print', exact: true })).toHaveAttribute('aria-selected', 'true');
    await box.getByRole('button', { name: 'Apply' }).click();

    let xml = await parts(app);
    expect(xml.get('word/styles.xml')).toContain('w:name w:val="Fine Print"');
    expect(xml.get('word/styles.xml')).toContain('<w:sz w:val="16"/>');
    expect(xml.get('word/document.xml')).toContain('w:pStyle w:val="FinePrint"');

    await app.menu('Format', 'Styles');
    await list.getByRole('option', { name: 'Fine Print', exact: true }).click();
    await box.getByRole('button', { name: 'Modify…' }).click();
    const modify = dialog(app, 'Modify Style');
    await modify.getByRole('button', { name: 'Paragraph…' }).click();
    const paragraph = dialog(app, 'Paragraph');
    await pickChoice(paragraph.getByRole('button', { name: 'Alignment' }), 'Center');
    await paragraph.getByRole('button', { name: 'OK' }).click();
    await modify.getByRole('button', { name: 'OK' }).click();
    await expect(modify).toBeHidden();

    await box.getByRole('button', { name: 'Delete' }).click();
    await app.page.getByRole('dialog', { name: 'Delete Style' }).getByRole('button', { name: 'Delete' }).click();
    await expect(list.getByRole('option', { name: 'Fine Print', exact: true })).toHaveCount(0);
    await box.locator('.wm-find-buttons').getByRole('button', { name: 'Close' }).click();
    xml = await parts(app);
    expect(xml.get('word/styles.xml')).not.toContain('Fine Print');
    expect(xml.get('word/document.xml')).not.toContain('FinePrint');

    await app.page.keyboard.press(`${MOD}+z`);
    expect(await documentXml(app)).toContain('w:pStyle w:val="FinePrint"');
  });

  test('Word’s own styles can be changed but not deleted', async ({ app }) => {
    await start(app);
    await app.menu('Format', 'Styles');
    const box = dialog(app, 'Styles');
    await box.getByRole('listbox', { name: 'Styles' }).getByRole('option', { name: 'Normal', exact: true }).click();
    await expect(box.getByRole('button', { name: 'Modify…' })).toBeEnabled();
    await expect(box.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});

test.describe('Insert › Page Numbers', () => {
  test('puts numbers in a footer every page shows, moves them, and removes them', async ({ app }) => {
    await start(app);
    await app.menu('Insert', 'Page Numbers');
    const box = dialog(app, 'Page Numbers');
    await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'Remove Numbers' })).toHaveCount(0);
    await pick(box, 'Alignment', 'Center');
    await pick(box, 'Number format', 'i, ii, iii');
    await shot(box, 'page-numbers');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();

    let files = await parts(app);
    const footer = () => [...files].find(([name]) => /word\/footer.*\.xml$/.test(name))?.[1] ?? '';
    expect(footer()).toContain('PAGE');
    expect(footer()).toContain('w:jc w:val="center"');
    expect(files.get('word/document.xml')).toContain('w:footerReference');
    expect(files.get('word/document.xml')).toContain('w:fmt="lowerRoman"');
    expect(files.get('[Content_Types].xml')).toMatch(/footer/);

    await app.menu('Insert', 'Page Numbers');
    await expect(box.getByRole('button', { name: 'Alignment' })).toContainText('Center');
    await pick(box, 'Position', 'Top of page');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();
    files = await parts(app);
    expect([...files].find(([name]) => /word\/header.*\.xml$/.test(name))?.[1]).toContain('PAGE');
    expect(footer()).not.toContain('PAGE');

    await app.menu('Insert', 'Page Numbers');
    await box.getByRole('button', { name: 'Remove Numbers' }).click();
    await expect(box).toBeHidden();
    files = await parts(app);
    expect([...files].filter(([name]) => /word\/(header|footer).*\.xml$/.test(name)).some(([, xml]) => xml.includes('PAGE'))).toBe(false);
  });

  test('can leave the number off the first page, and undo takes the numbers away', async ({ app }) => {
    await start(app);
    await app.menu('Insert', 'Page Numbers');
    const box = dialog(app, 'Page Numbers');
    await box.getByRole('checkbox', { name: 'Show number on first page' }).uncheck();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();
    expect(await documentXml(app)).toContain('w:titlePg');
    await app.focus();
    await app.page.keyboard.press(`${MOD}+z`);
    const xml = await documentXml(app);
    expect(xml).not.toContain('w:titlePg');
    expect(xml).not.toContain('w:footerReference');
  });
});

test.describe('Insert › Bookmark', () => {
  test('adds one over the selection, lists it, goes to it and deletes it', async ({ app }) => {
    await start(app, 'marked here');
    await app.menu('Insert', 'Bookmark');
    const box = dialog(app, 'Bookmark');
    await expect(box.getByRole('button', { name: 'Go To' })).toBeDisabled();
    await box.getByRole('textbox', { name: 'Bookmark name' }).fill('not valid!');
    await box.getByRole('button', { name: 'Add' }).click();
    await expect(box.getByRole('alert')).toContainText('letter');
    await box.getByRole('textbox', { name: 'Bookmark name' }).fill('Chapter_1');
    await shot(box, 'bookmark');
    await box.getByRole('button', { name: 'Add' }).click();
    await expect(box).toBeHidden();
    expect(await documentXml(app)).toMatch(/w:bookmarkStart[^>]*w:name="Chapter_1"/);
    expect(await app.text()).toBe('marked here');

    await app.focus();
    await app.page.keyboard.press(`${MOD}+End`);
    await app.menu('Insert', 'Bookmark');
    await expect(box.getByRole('listbox', { name: 'Bookmarks' }).getByRole('option', { name: 'Chapter_1' })).toBeVisible();
    await box.getByRole('button', { name: 'Go To' }).click();
    await expect(box).toBeHidden();
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { selectionState: { text: string } }).selectionState.text)).toBe('marked here');

    await app.menu('Insert', 'Bookmark');
    await box.getByRole('button', { name: 'Delete' }).click();
    await expect(box.getByRole('button', { name: 'Go To' })).toBeDisabled();
    await box.locator('.wm-find-buttons').getByRole('button', { name: 'Close' }).click();
    const xml = await documentXml(app);
    expect(xml).not.toContain('w:bookmarkStart');
    expect(await app.text()).toBe('marked here');
  });
});
