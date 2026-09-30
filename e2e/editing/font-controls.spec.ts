import { test, expect } from '../fixtures';
import { MOD, combo, downloadDocumentXml, paragraphProps, paragraphsOf, pickColor, propsFor, runsOf, setCombo, showStyleBox, tool, typeAndSelect, menuSub } from './helpers';

const runProps = async (app: import('../fixtures').App, text: string) => propsFor(runsOf(await downloadDocumentXml(app)), text);

test.describe('font and size boxes', () => {
  test('a new document shows its default font and size', async ({ app }) => {
    await app.blank();
    await expect(combo(app.page, 'Font')).toHaveValue('Calibri');
    await expect(combo(app.page, 'Font Size')).toHaveValue('11');
  });

  test('typing a font name in the Font box and pressing Enter applies it to the selection', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await setCombo(app.page, 'Font', 'Arial');
    await expect(combo(app.page, 'Font')).toHaveValue('Arial');
    expect(await runProps(app, 'sample')).toContain('rFonts:Arial');
    // The typing focus returns to the document.
    await expect(app.editor).toBeFocused();
  });

  test('picking a font from the Font list applies it', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font list' }).click();
    const list = app.page.getByRole('listbox', { name: 'Font' });
    await expect(list).toBeVisible();
    await list.getByRole('option', { name: 'Arial', exact: true }).click();
    await expect(combo(app.page, 'Font')).toHaveValue('Arial');
    expect(await runProps(app, 'sample')).toContain('rFonts:Arial');
  });

  test('the Font box follows the caret between differently-set fonts', async ({ app }) => {
    await app.blank();
    await app.type('aa bb');
    await app.press('Shift+ArrowLeft', 2);
    await setCombo(app.page, 'Font', 'Arial');
    await app.press('Home');
    await expect(combo(app.page, 'Font')).toHaveValue('Calibri');
    await app.press('End');
    await expect(combo(app.page, 'Font')).toHaveValue('Arial');
  });

  test('typing a size and pressing Enter applies it (half points are accepted)', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await setCombo(app.page, 'Font Size', '14');
    await expect(combo(app.page, 'Font Size')).toHaveValue('14');
    expect(await runProps(app, 'sample')).toContain('sz:28');
    await setCombo(app.page, 'Font Size', '10.5');
    await expect(combo(app.page, 'Font Size')).toHaveValue('10.5');
    expect(await runProps(app, 'sample')).toContain('sz:21');
  });

  test('picking a size from the list applies it', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Size list' }).click();
    await app.page.getByRole('listbox', { name: 'Font Size' }).getByRole('option', { name: '24', exact: true }).click();
    await expect(combo(app.page, 'Font Size')).toHaveValue('24');
    expect(await runProps(app, 'sample')).toContain('sz:48');
  });

  test('an invalid size is refused and the box reverts', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await setCombo(app.page, 'Font Size', 'huge');
    await expect(combo(app.page, 'Font Size')).toHaveValue('11');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { status: string }).status)).toMatch(/font size must be a number/i);
  });

  test('Escape in the size box leaves the size alone', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    const box = combo(app.page, 'Font Size');
    await box.click();
    await box.fill('30');
    await box.press('Escape');
    await expect(box).toHaveValue('11');
    await expect(app.editor).toBeFocused();
  });

  test('Grow Font and Shrink Font step through the size list', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.press(`${MOD}+]`);
    await expect(combo(app.page, 'Font Size')).toHaveValue('12');
    await app.press(`${MOD}+]`);
    await expect(combo(app.page, 'Font Size')).toHaveValue('14');
    await app.press(`${MOD}+[`);
    await expect(combo(app.page, 'Font Size')).toHaveValue('12');
    await app.press(`${MOD}+[`);
    await app.press(`${MOD}+[`);
    await expect(combo(app.page, 'Font Size')).toHaveValue('10.5');
  });

  test('Format ▸ Character ▸ Grow Font and Shrink Font work from the menu', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await menuSub(app, 'Format', 'Character', 'Grow Font');
    await expect(combo(app.page, 'Font Size')).toHaveValue('12');
    await menuSub(app, 'Format', 'Character', 'Shrink Font');
    await expect(combo(app.page, 'Font Size')).toHaveValue('11');
  });

  test('a size set with no selection applies to what is typed next', async ({ app }) => {
    await app.blank();
    await app.type('small ');
    await setCombo(app.page, 'Font Size', '20');
    await app.type('big');
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'big')).toContain('sz:40');
    expect(propsFor(runs, 'small')).not.toContain('sz:40');
  });
});

test.describe('colors', () => {
  test('Font Color: choosing a swatch colors the selection, and the main button reuses it', async ({ app }) => {
    await app.blank();
    await app.type('red blue');
    await app.press('Shift+ArrowLeft', 4);
    await pickColor(app.page, 'Font Color', '#FF0000');
    expect(await runProps(app, 'blue')).toContain('color:FF0000');
    await app.press('Home');
    await app.press('Shift+ArrowRight', 3);
    await expect.poll(() => app.selectedText()).toBe('red');
    await tool(app, 'Font Color').click();
    const runs = runsOf(await downloadDocumentXml(app));
    expect(propsFor(runs, 'red')).toContain('color:FF0000');
  });

  test('Font Color ▸ Automatic removes the color', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await pickColor(app.page, 'Font Color', '#0000FF');
    expect(await runProps(app, 'sample')).toContain('color:0000FF');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' }).click();
    await app.page.getByRole('dialog', { name: 'Font Color' }).getByRole('button', { name: 'Automatic' }).click();
    expect((await runProps(app, 'sample')).some((p) => p.startsWith('color:') && p !== 'color:auto')).toBe(false);
  });

  test('the palette offers the standard swatches and closes after a pick', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' }).click();
    const palette = app.page.getByRole('dialog', { name: 'Font Color' });
    await expect(palette.getByRole('button', { name: '#FF0000', exact: true })).toBeVisible();
    await expect(palette.getByRole('button', { name: 'More Colors…' })).toBeVisible();
    expect(await palette.locator('.wm-swatch').count()).toBeGreaterThanOrEqual(40);
    await palette.getByRole('button', { name: '#008000', exact: true }).click();
    await expect(palette).toBeHidden();
  });

  test('More Colors… applies a custom color, which then appears under Document Colors', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' }).click();
    const palette = app.page.getByRole('dialog', { name: 'Font Color' });
    // The native color dialog can't be driven, so set the hidden color input the button opens.
    await palette.locator('input[type=color]').evaluate((el: HTMLInputElement) => {
      el.value = '#123456';
      el.dispatchEvent(new Event('change'));
    });
    await expect.poll(() => runProps(app, 'sample')).toContain('color:123456');
    // The list of document colors is rescanned on the next selection change after a short delay.
    const button = app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' });
    const reopened = app.page.getByRole('dialog', { name: 'Font Color' });
    await expect
      .poll(async () => {
        await app.press(`${MOD}+a`);
        await button.click();
        const found = await reopened.getByRole('button', { name: '#123456', exact: true }).count();
        await app.press('Escape');
        return found;
      })
      .toBe(1);
    await button.click();
    await expect(reopened.getByText('Document Colors')).toBeVisible();
    await app.press('Escape');
  });

  test('Highlight: choosing a swatch highlights the selection; None removes it', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await pickColor(app.page, 'Highlight', '#00FF00');
    const xml = await downloadDocumentXml(app);
    expect(xml).toMatch(/w:highlight w:val="green"|w:shd [^>]*00FF00/i);
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Highlight options' }).click();
    await app.page.getByRole('dialog', { name: 'Highlight' }).getByRole('button', { name: 'None' }).click();
    const after = await downloadDocumentXml(app);
    expect(after).not.toMatch(/w:highlight w:val="green"|w:shd [^>]*00FF00/i);
  });

  test('the Highlight button applies the last color', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'sample');
    await tool(app, 'Highlight').click();
    expect(await downloadDocumentXml(app)).toMatch(/w:highlight w:val="yellow"|w:shd [^>]*FFFF00/i);
  });
});

test.describe('Change Case', () => {
  const cases: [string, string, string][] = [
    ['UPPERCASE', 'hello big world', 'HELLO BIG WORLD'],
    ['lowercase', 'Hello BIG World', 'hello big world'],
    ['Title Case', 'hello big world', 'Hello Big World'],
    ['Sentence case.', 'hELLO big world. next SENTENCE here', 'Hello big world. Next sentence here'],
    ['tOGGLE cASE', 'Hello World', 'hELLO wORLD'],
  ];
  for (const [item, before, after] of cases) {
    test(`${item}: "${before}" becomes "${after}"`, async ({ app }) => {
      await app.blank();
      await typeAndSelect(app, before);
      await app.menu('Format', 'Change Case', item);
      await expect.poll(() => app.text()).toBe(after);
    });
  }

  test('changing case only touches the selection, and keeps formatting', async ({ app }) => {
    await app.blank();
    await app.type('keep shout keep');
    await app.press('Home');
    await app.press('ArrowRight', 5);
    await app.press('Shift+ArrowRight', 5);
    await expect.poll(() => app.selectedText()).toBe('shout');
    await app.press(`${MOD}+b`);
    await app.menu('Format', 'Change Case', 'UPPERCASE');
    await expect.poll(() => app.text()).toBe('keep SHOUT keep');
    expect(await runProps(app, 'SHOUT')).toContain('b');
  });

  test('Change Case is one undo step', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'abc def');
    await app.menu('Format', 'Change Case', 'UPPERCASE');
    await expect.poll(() => app.text()).toBe('ABC DEF');
    await app.press(`${MOD}+z`);
    await expect.poll(() => app.text()).toBe('abc def');
  });
});

test.describe('Clear Formatting', () => {
  test('removes marks, size, font and color; keeps the text', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'styled');
    await app.press(`${MOD}+b`);
    await app.press(`${MOD}+i`);
    await setCombo(app.page, 'Font', 'Arial');
    await setCombo(app.page, 'Font Size', '20');
    await pickColor(app.page, 'Font Color', '#FF0000');
    await expect.poll(() => runProps(app, 'styled')).toEqual(expect.arrayContaining(['b', 'i', 'sz:40', 'color:FF0000']));
    await tool(app, 'Clear Formatting').click();
    await expect.poll(async () => (await runProps(app, 'styled')).length).toBe(0);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    await expect(combo(app.page, 'Font Size')).toHaveValue('11');
    await expect(combo(app.page, 'Font')).toHaveValue('Calibri');
    await expect.poll(() => app.text()).toBe('styled');
  });

  test('the shortcut and Format ▸ Clear Formatting do the same', async ({ app }) => {
    await app.blank();
    await typeAndSelect(app, 'styled');
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.press(`${MOD}+Space`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
    await app.press(`${MOD}+b`);
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'true');
    await app.menu('Format', 'Clear Formatting');
    await expect(tool(app, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  });

  test('leaves the paragraph style alone', async ({ app }) => {
    await showStyleBox(app.page);
    await app.blank();
    await typeAndSelect(app, 'Heading text');
    await setCombo(app.page, 'Style', 'Heading 1');
    await expect(combo(app.page, 'Style')).toHaveValue('Heading 1');
    await tool(app, 'Clear Formatting').click();
    await expect(combo(app.page, 'Style')).toHaveValue('Heading 1');
  });
});

test.describe('Style box', () => {
  test('is off by default', async ({ app }) => {
    await app.blank();
    await expect(combo(app.page, 'Style')).toHaveCount(0);
  });

  test('typing a style name applies it to the paragraph', async ({ app }) => {
    await showStyleBox(app.page);
    await app.blank();
    await app.type('Title text');
    await expect(combo(app.page, 'Style')).toHaveValue('Normal');
    await setCombo(app.page, 'Style', 'Heading 1');
    await expect(combo(app.page, 'Style')).toHaveValue('Heading 1');
    const para = paragraphsOf(await downloadDocumentXml(app))[0];
    expect(paragraphProps(para).tags.some((t) => /^pStyle:Heading1$/i.test(t.replace(/\s/g, '')))).toBe(true);
  });

  test('lists the styles and picking one applies it', async ({ app }) => {
    await showStyleBox(app.page);
    await app.blank();
    await app.type('Quote me');
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Style list' }).click();
    const list = app.page.getByRole('listbox', { name: 'Style' });
    for (const name of ['Normal', 'Title', 'Heading 1', 'Heading 2', 'Quote']) await expect(list.getByRole('option', { name, exact: true })).toBeVisible();
    await list.getByRole('option', { name: 'Quote', exact: true }).click();
    await expect(combo(app.page, 'Style')).toHaveValue('Quote');
  });

  test('an unknown style name is refused with a message', async ({ app }) => {
    await showStyleBox(app.page);
    await app.blank();
    await app.type('text');
    await setCombo(app.page, 'Style', 'Nonsense');
    await expect(combo(app.page, 'Style')).toHaveValue('Normal');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('no style named "Nonsense"');
  });

  test('the box shows the style of the paragraph the caret is in', async ({ app }) => {
    await showStyleBox(app.page);
    await app.blank();
    await app.type('Head');
    await setCombo(app.page, 'Style', 'Heading 1');
    await app.press('End');
    await app.press('Enter');
    await app.type('body');
    await expect(combo(app.page, 'Style')).not.toHaveValue('Heading 1');
    await app.press('ArrowUp');
    await expect(combo(app.page, 'Style')).toHaveValue('Heading 1');
  });
});
