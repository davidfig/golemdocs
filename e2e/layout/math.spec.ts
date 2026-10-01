import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { caretOf, convertedText, count, dialog, docx, importFile } from './helpers';

const LATEX = 'Equation in LaTeX';

/** Opens Insert ▸ Equation… and returns its dialog. */
async function openEquation(app: App, title = 'Insert Equation') {
  await app.menu('Insert', 'Equation…');
  const dlg = dialog(app, title);
  await dlg.waitFor(); // the dialog's code is fetched when first asked for
  return dlg;
}

/** Inserts an equation through the dialog, and waits until the saved document has it (the worker finishes after the dialog closes). */
async function insertEquation(app: App, latex: string, display = false): Promise<void> {
  const before = count((await docx(app)).xml, 'm:oMath');
  const dlg = await openEquation(app);
  await dlg.getByRole('textbox', { name: LATEX }).fill(latex);
  if (display) await dlg.getByRole('checkbox', { name: /Show on its own line/ }).check();
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await dlg.waitFor({ state: 'detached' });
  await expect.poll(async () => count((await docx(app)).xml, 'm:oMath')).toBe(before + 1);
  await app.focus();
}

/** With the caret just after an equation, selects it (Shift+Left) and waits for the selection to be the equation. */
async function selectEquation(app: App): Promise<void> {
  await app.press('Shift+ArrowLeft');
  await expect.poll(() => caretOf(app.page)).toBeNull();
}

test.describe('Insert ▸ Equation', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('opens from the Insert menu and from the toolbar button, empty, with the Structures keys showing', async ({ app }) => {
    const dlg = await openEquation(app);
    await expect(dlg.getByRole('textbox', { name: LATEX })).toHaveValue('');
    await expect(dlg.getByRole('tab', { name: 'Structures' })).toHaveAttribute('aria-selected', 'true');
    await expect(dlg.getByRole('button', { name: '\\frac', exact: true })).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    await app.toolbarButton('Equation').click();
    await expect(dialog(app, 'Insert Equation')).toBeVisible();
    await dialog(app, 'Insert Equation').getByRole('button', { name: 'Close' }).click();
  });

  test('Insert with nothing typed asks for an equation and stays open', async ({ app }) => {
    const dlg = await openEquation(app);
    await dlg.getByRole('button', { name: 'Insert' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Enter an equation.');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(count((await docx(app)).xml, 'm:oMath')).toBe(0);
  });

  test('the preview shows the equation as it is typed', async ({ app }) => {
    const dlg = await openEquation(app);
    const preview = dlg.locator('.wm-math-preview');
    await expect(preview.locator('math')).toHaveCount(0);
    await dlg.getByRole('textbox', { name: LATEX }).fill('\\frac{a}{b} + \\sqrt{x}');
    await expect(preview.locator('math mfrac')).toHaveCount(1);
    await expect(preview.locator('math msqrt')).toHaveCount(1);
    await dlg.getByRole('textbox', { name: LATEX }).fill('x^2');
    await expect(preview.locator('math msup')).toHaveCount(1);
    await expect(preview.locator('math mfrac')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('an inline equation goes into the paragraph, after the text, as a Word equation', async ({ app }) => {
    await app.type('Area is ');
    await insertEquation(app, '\\pi r^2');
    await app.type(' done');
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMath')).toBe(1);
    expect(count(xml, 'm:oMathPara')).toBe(0);
    expect(count(xml, 'w:p')).toBe(1);
    expect(xml).toContain('<m:sSup>');
    expect(xml).toContain('π');
    expect(xml.indexOf('Area is')).toBeLessThan(xml.indexOf('<m:oMath>'));
    expect(xml.indexOf('<m:oMath>')).toBeLessThan(xml.indexOf('done'));
    await expect.poll(() => app.text()).toContain('Area is');
  });

  test('"Show on its own line" makes a display equation', async ({ app }) => {
    await app.type('Before');
    await insertEquation(app, '\\sum_{i=1}^{n} i', true);
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMathPara')).toBe(1);
    expect(xml).toContain('<m:nary>');
  });

  test('Cancel and the close button insert nothing', async ({ app }) => {
    let dlg = await openEquation(app);
    await dlg.getByRole('textbox', { name: LATEX }).fill('x^2');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    dlg = await openEquation(app);
    await dlg.getByRole('textbox', { name: LATEX }).fill('y^2');
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(dlg).toHaveCount(0);
    expect(count((await docx(app)).xml, 'm:oMath')).toBe(0);
  });

  test('inserting an equation is one undo step', async ({ app }) => {
    await app.type('text');
    await insertEquation(app, 'a+b');
    await expect.poll(async () => count((await docx(app)).xml, 'm:oMath')).toBe(1);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => count((await docx(app)).xml, 'm:oMath')).toBe(0);
    await expect.poll(() => app.text()).toBe('text');
  });

  test('what the parser can not read is reported, kept as typed, and can still be inserted', async ({ app }) => {
    const dlg = await openEquation(app);
    await dlg.getByRole('textbox', { name: LATEX }).fill('\\notacommand{x} + 1');
    await expect(dlg.getByRole('alert')).toContainText('Not understood, kept as typed');
    await dlg.getByRole('button', { name: 'Insert' }).click();
    await dlg.waitFor({ state: 'detached' });
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMath')).toBe(1);
    expect(xml).toContain('notacommand');
  });
});

test.describe('the equation keys', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('a structure key inserts its LaTeX and leaves the caret inside it', async ({ app }) => {
    const dlg = await openEquation(app);
    const box = dlg.getByRole('textbox', { name: LATEX });
    await dlg.getByRole('button', { name: '\\frac', exact: true }).click();
    await expect(box).toHaveValue('\\frac{}{}');
    await expect(box).toBeFocused();
    await app.page.keyboard.type('a');
    await expect(box).toHaveValue('\\frac{a}{}');
    await dlg.getByRole('button', { name: '\\sqrt', exact: true }).click();
    await expect(box).toHaveValue('\\frac{a\\sqrt{}}{}');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a structure key wraps the selected text', async ({ app }) => {
    const dlg = await openEquation(app);
    const box = dlg.getByRole('textbox', { name: LATEX });
    await box.fill('x+1');
    await box.selectText();
    await dlg.getByRole('button', { name: '\\sqrt', exact: true }).click();
    await expect(box).toHaveValue('\\sqrt{x+1}');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the Greek, Operators, Relations and Arrows tabs insert symbols', async ({ app }) => {
    const dlg = await openEquation(app);
    const box = dlg.getByRole('textbox', { name: LATEX });
    for (const [tab, key] of [['Greek', '\\alpha'], ['Operators', '\\pm'], ['Relations', '\\leq'], ['Arrows', '\\rightarrow']] as const) {
      await dlg.getByRole('tab', { name: tab }).click();
      await expect(dlg.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await dlg.getByRole('button', { name: key, exact: true }).click();
    }
    await expect(box).toHaveValue('\\alpha \\pm \\leq \\rightarrow ');
    await expect(dlg.locator('.wm-math-preview math')).toContainText('α');
    await dlg.getByRole('button', { name: 'Insert' }).click();
    await dlg.waitFor({ state: 'detached' });
    const { xml } = await docx(app);
    for (const ch of ['α', '±', '≤', '→']) expect(xml).toContain(ch);
  });

  test('every tab offers a full set of keys', async ({ app }) => {
    const dlg = await openEquation(app);
    const keys = dlg.getByRole('group').getByRole('button');
    expect(await keys.count()).toBeGreaterThanOrEqual(20);
    await dlg.getByRole('tab', { name: 'Greek' }).click();
    expect(await keys.count()).toBeGreaterThanOrEqual(30);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('editing an existing equation', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await app.type('E = ');
    await insertEquation(app, 'mc^2');
  });

  test('with the equation selected, Insert ▸ Equation edits it (Update) instead of adding another', async ({ app }) => {
    await selectEquation(app);
    const dlg = await openEquation(app, 'Edit Equation');
    const box = dlg.getByRole('textbox', { name: LATEX });
    await expect(box).toHaveValue('mc^2');
    await expect(dlg.getByRole('button', { name: 'Update' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Insert', exact: true })).toHaveCount(0);
    await box.fill('E_0 + \\frac{1}{2}');
    await dlg.getByRole('button', { name: 'Update' }).click();
    await dlg.waitFor({ state: 'detached' });
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMath')).toBe(1);
    expect(xml).toContain('<m:f>');
    expect(xml).not.toContain('>mc<');
    await expect.poll(() => app.text()).toContain('E = ');
  });

  test('editing can turn an inline equation into a display one', async ({ app }) => {
    await selectEquation(app);
    const dlg = await openEquation(app, 'Edit Equation');
    await expect(dlg.getByRole('checkbox', { name: /Show on its own line/ })).not.toBeChecked();
    await dlg.getByRole('checkbox', { name: /Show on its own line/ }).check();
    await dlg.getByRole('button', { name: 'Update' }).click();
    await dlg.waitFor({ state: 'detached' });
    expect(count((await docx(app)).xml, 'm:oMathPara')).toBe(1);
  });

  test('Cancel leaves the equation as it was', async ({ app }) => {
    await selectEquation(app);
    const dlg = await openEquation(app, 'Edit Equation');
    await dlg.getByRole('textbox', { name: LATEX }).fill('zzz');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    const { xml } = await docx(app);
    expect(xml).not.toContain('zzz');
    expect(xml).toContain('<m:sSup>');
  });
});

test.describe('equations in saved files', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await app.type('See ');
  });

  test('a Word file with an equation opens again with the equation in it', async ({ app }) => {
    await insertEquation(app, '\\frac{a}{b}');
    const file = await app.download(() => app.menu('File', 'Download'));
    expect(file.name).toMatch(/\.docx$/);
    await app.menu('File', 'New');
    await importFile(app, { name: 'equation.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file.bytes });
    await expect.poll(() => app.text()).toContain('See');
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMath')).toBe(1);
    expect(xml).toContain('<m:f>');
  });

  test('Markdown keeps an inline equation as $…$ and a display one as $$…$$', async ({ app }) => {
    await insertEquation(app, '\\frac{a}{b}');
    await app.press('Enter');
    await insertEquation(app, 'x^2', true);
    const md = await convertedText(app, 'Markdown');
    expect(md).toMatch(/See \$\\frac\{a\}\{b\}\$/);
    expect(md).toMatch(/\$\$\s*x\^2\s*\$\$/);
  });

  test('Web Page keeps the equation as MathML', async ({ app }) => {
    await insertEquation(app, '\\sqrt{x}');
    const html = await convertedText(app, 'Web Page');
    expect(html).toContain('<math');
    expect(html).toContain('<msqrt>');
  });

  test('a Word file\'s equation survives Markdown and back', async ({ app }) => {
    await insertEquation(app, '\\alpha + \\beta');
    const md = await convertedText(app, 'Markdown');
    await app.menu('File', 'New');
    await importFile(app, { name: 'eq.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
    await expect.poll(() => app.text()).toContain('See');
    await app.menu('File', 'Convert To', 'Word Document');
    const { xml } = await docx(app);
    expect(count(xml, 'm:oMath')).toBe(1);
    expect(xml).toContain('α');
  });
});
