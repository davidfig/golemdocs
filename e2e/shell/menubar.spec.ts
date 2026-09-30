import { expect, test } from '../fixtures';
import { isMac, menuRow, menuTitle, openMenu } from './helpers';

test.describe('menu bar with the mouse', () => {
  test('clicking a title opens its menu and clicking it again closes it', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await menuTitle(app, 'File').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(menuRow(page, 'New')).toBeVisible();
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'true');
    await menuTitle(app, 'File').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'false');
  });

  test('sliding across titles while a menu is open switches menus without clicking', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'File');
    await menuTitle(app, 'Edit').hover();
    await expect(menuTitle(app, 'Edit')).toHaveAttribute('aria-expanded', 'true');
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'false');
    await expect(menuRow(page, 'Select All')).toBeVisible();
    await expect(menuRow(page, 'New')).toHaveCount(0);
    await menuTitle(app, 'View').hover();
    await expect(menuRow(page, 'Print Layout')).toBeVisible();
    // Only one drop-down is ever open.
    await expect(page.getByRole('menu')).toHaveCount(1);
  });

  test('hovering a title does nothing until a menu is open', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await menuTitle(app, 'Edit').hover();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('hovering a row with a submenu opens it after a short delay', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    await menuRow(page, 'Zoom').hover();
    await expect(menuRow(page, 'Page Width')).toBeVisible();
    await expect(menuRow(page, 'Zoom')).toHaveAttribute('aria-expanded', 'true');
    // Moving to a plain row closes the submenu again.
    await menuRow(page, 'Ruler').hover();
    await expect(menuRow(page, 'Page Width')).toHaveCount(0);
  });

  test('Escape closes the menu and the editor keeps the keyboard', async ({ app, page }) => {
    await app.blank();
    await app.type('abc');
    await openMenu(app, 'Edit');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await page.keyboard.type('d');
    expect(await app.text()).toBe('abcd');
  });

  test('pressing outside the menu closes it', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'File');
    await page.mouse.click(640, 500);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('picking an item closes the menu and runs the command', async ({ app, page }) => {
    await app.blank();
    await app.type('hello');
    await openMenu(app, 'Edit');
    await menuRow(page, 'Select All').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => app.selectedText()).toBe('hello');
    await expect(app.editor).toBeFocused();
  });

  test('press on a title, drag to an item and release picks it', async ({ app, page }) => {
    await app.blank();
    await app.type('drag');
    const title = await menuTitle(app, 'Edit').boundingBox();
    await page.mouse.move(title!.x + title!.width / 2, title!.y + title!.height / 2);
    await page.mouse.down();
    await expect(menuRow(page, 'Select All')).toBeVisible();
    const row = await menuRow(page, 'Select All').boundingBox();
    await page.mouse.move(row!.x + 20, row!.y + row!.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => app.selectedText()).toBe('drag');
  });

  test('disabled items are marked aria-disabled and clicking them leaves the menu open', async ({ app, page }) => {
    await app.blank();
    await openMenu(app, 'Edit');
    const undo = menuRow(page, 'Undo');
    await expect(undo).toHaveAttribute('aria-disabled', 'true');
    await expect(menuRow(page, 'Cut')).toHaveAttribute('aria-disabled', 'true');
    await expect(menuRow(page, 'Select All')).toHaveAttribute('aria-disabled', 'false');
    await undo.click({ force: true });
    await expect(page.getByRole('menu')).toBeVisible();
  });

  test('items become enabled when they apply (Undo after typing, Cut with a selection)', async ({ app, page }) => {
    await app.blank();
    await app.type('xyz');
    await openMenu(app, 'Edit');
    await expect(menuRow(page, 'Undo')).toHaveAttribute('aria-disabled', 'false');
    await expect(menuRow(page, 'Cut')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await app.press('Shift+Home');
    await openMenu(app, 'Edit');
    await expect(menuRow(page, 'Cut')).toHaveAttribute('aria-disabled', 'false');
    await expect(menuRow(page, 'Copy')).toHaveAttribute('aria-disabled', 'false');
  });

  test('checkbox and radio items expose their state', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    await expect(menuRow(page, 'Print Layout')).toHaveAttribute('role', 'menuitemradio');
    await expect(menuRow(page, 'Print Layout')).toHaveAttribute('aria-checked', 'true');
    await expect(menuRow(page, 'Normal')).toHaveAttribute('role', 'menuitemradio');
    await expect(menuRow(page, 'Normal')).toHaveAttribute('aria-checked', 'false');
    await expect(menuRow(page, 'Formatting Marks')).toHaveAttribute('role', 'menuitemcheckbox');
    await expect(menuRow(page, 'Formatting Marks')).toHaveAttribute('aria-checked', 'false');
    await menuRow(page, 'Formatting Marks').click();
    await openMenu(app, 'View');
    await expect(menuRow(page, 'Formatting Marks')).toHaveAttribute('aria-checked', 'true');
  });

  test('items show their keyboard shortcuts', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'Edit');
    const mac = await isMac(page);
    await expect(menuRow(page, 'Select All').locator('.wm-shortcut')).toHaveText(mac ? '⌘A' : 'Ctrl+A');
  });

  test('the Picture menu is left out for a text document and Table stays', async ({ app }) => {
    await app.goto('?doc=welcome');
    await expect(menuTitle(app, 'Table')).toBeVisible();
    await expect(menuTitle(app, 'Picture')).toBeHidden();
  });

  test('the Admin menu offers no admin tools to people who are not admins', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'Admin');
    await expect(menuRow(page, 'Debug…')).toHaveCount(0);
    await expect(menuRow(page, 'Cloudflare Billing…')).toHaveCount(0);
    await expect(menuRow(page, 'Feedback…')).toHaveCount(0);
  });

  test.fixme('the whole Admin menu is left out for people who are not admins', async ({ app }) => {
    // Suspected bug: chrome.ts says "the whole menu is left out for everyone else", but the Open Sample
    // submenu (built on demand) counts as always available, so the empty-looking Admin title stays.
    await app.goto('?doc=welcome');
    await expect(menuTitle(app, 'Admin')).toBeHidden();
  });
});

test.describe('menu bar with the keyboard', () => {
  test('F10 puts the keyboard on the bar with mnemonic underlines, arrows move, Escape leaves', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await expect(app.menubar).toHaveClass(/cues/);
    await expect(menuTitle(app, 'File')).toHaveClass(/active/);
    await page.keyboard.press('ArrowRight');
    await expect(menuTitle(app, 'Edit')).toHaveClass(/active/);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    // Wraps to the last visible title (the hidden Picture one is skipped on the way).
    await expect(app.menubar.locator('.wm-title:not([hidden])').last()).toHaveClass(/active/);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(app.menubar).not.toHaveClass(/cues/);
    await expect(app.editor).toBeFocused();
  });

  test('mnemonic underlines are drawn on the titles while the keyboard is on the bar', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    const underline = menuTitle(app, 'File').locator('u');
    await expect(underline).toHaveText('F');
    await expect(underline).toHaveCSS('text-decoration-line', 'none');
    await page.keyboard.press('F10');
    await expect(underline).toHaveCSS('text-decoration-line', 'underline');
  });

  test('ArrowDown opens the menu on its first item; arrows, Home and End move and skip disabled items', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowRight'); // Edit
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu')).toBeVisible();
    // Undo, Redo, Cut, Copy are disabled on an empty document: the first enabled row is Paste.
    await expect(menuRow(page, 'Paste')).toHaveClass(/active/);
    await page.keyboard.press('ArrowDown');
    await expect(menuRow(page, 'Paste Special…')).toHaveClass(/active/);
    await page.keyboard.press('End');
    await expect(page.locator('.wm-menu .wm-item.active')).toHaveCount(1);
    await expect(menuRow(page, 'Go To…')).toHaveClass(/active/);
    await page.keyboard.press('ArrowDown'); // wraps
    await expect(menuRow(page, 'Paste')).toHaveClass(/active/);
    await page.keyboard.press('ArrowUp'); // wraps back
    await expect(menuRow(page, 'Go To…')).toHaveClass(/active/);
    await page.keyboard.press('Home');
    await expect(menuRow(page, 'Paste')).toHaveClass(/active/);
  });

  test('left and right arrows move between open menus', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowDown'); // File
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(menuTitle(app, 'Edit')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'true');
  });

  test('Enter runs the highlighted item and returns to the document', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await app.type('enter key');
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowRight'); // Edit
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // Select All is further down; walk to it
    await page.keyboard.press('End');
    // Go To… opens a dialog, which proves Enter ran a command (and the menu closed).
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('dialog').first()).toBeVisible();
  });

  test('a mnemonic letter opens a menu from the bar, and runs an item inside it', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await app.type('mnemonic');
    await page.keyboard.press('F10');
    await page.keyboard.press('e'); // &Edit
    await expect(menuTitle(app, 'Edit')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('l'); // Select A&ll
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => app.selectedText()).toBe('mnemonic');
  });

  test('a mnemonic that names a submenu opens it with the first item selected', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await page.keyboard.press('v'); // &View
    await page.keyboard.press('z'); // &Zoom
    await expect(menuRow(page, 'Page Width')).toBeVisible();
    await expect(menuRow(page, '500%')).toHaveClass(/active/);
  });

  test('Right opens a submenu, Left closes it, Escape steps back one level at a time', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // View
    await page.keyboard.press('ArrowDown'); // Normal
    await menuRow(page, 'Zoom').hover();
    await page.keyboard.press('ArrowRight');
    await expect(menuRow(page, 'Page Width')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(menuRow(page, 'Page Width')).toHaveCount(0);
    await expect(menuRow(page, 'Zoom')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(menuRow(page, 'Page Width')).toBeVisible();
    await page.keyboard.press('Escape'); // closes the submenu only
    await expect(menuRow(page, 'Page Width')).toHaveCount(0);
    await expect(menuRow(page, 'Zoom')).toBeVisible();
    await page.keyboard.press('Escape'); // back to the bar
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(app.menubar).toHaveClass(/cues/);
    await page.keyboard.press('Escape');
    await expect(app.menubar).not.toHaveClass(/cues/);
  });

  test('F10 again, or Tab, closes the menus', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('F10');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await page.keyboard.press('F10');
    await page.keyboard.press('Tab');
    await expect(app.menubar).not.toHaveClass(/cues/);
  });

  test('keys typed while a menu is open do not reach the document', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    await app.type('ab');
    await page.keyboard.press('F10');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('x'); // a mnemonic attempt, not text
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await app.text()).toBe('ab');
  });

  test('tapping Alone Alt toggles the menu bar on Windows and Linux', async ({ app, page }) => {
    await app.blank();
    await page.mouse.move(900, 600); // a parked pointer would hover rows under it and take the highlight
    test.skip(await isMac(page), 'Alt is the Option key on macOS and does not open the menus there');
    await page.keyboard.press('Alt');
    await expect(app.menubar).toHaveClass(/cues/);
    await page.keyboard.press('Alt');
    await expect(app.menubar).not.toHaveClass(/cues/);
    await page.keyboard.press('Alt+f');
    await expect(menuTitle(app, 'File')).toHaveAttribute('aria-expanded', 'true');
  });
});
