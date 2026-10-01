import type { Page } from '@playwright/test';
import { expect, MOD, test, type App } from '../fixtures';
import { blankReady, camera, choose, stored } from './helpers';

async function threePages(app: App): Promise<void> {
  await app.blank();
  await app.type('one');
  await app.press(`${MOD}+Enter`);
  await app.type('two');
  await app.press(`${MOD}+Enter`);
  await app.type('three');
  await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: unknown[] }).pages.length)).toBe(3);
}

const signedOut = (page: Page) => page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: null } }));

test.describe('scrolling', () => {
  test('PageDown and PageUp scroll by nearly a window height', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', '100%');
    const view = await page.evaluate(() => document.getElementById('canvas')!.clientHeight / ((96 / 72) * (window as unknown as { camera: { zoom: number } }).camera.zoom));
    await app.focus();
    const start = (await camera(page)).y;
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await camera(page)).y).toBeGreaterThan(start + view * 0.5);
    const down = (await camera(page)).y;
    expect(down - start).toBeCloseTo(view * 0.9, 0);
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await camera(page)).y).toBeCloseTo(start, 0);
  });

  test('a sideways wheel moves the view sideways when zoomed in past the page width', async ({ app, page }) => {
    await blankReady(app);
    await choose(app, 'View', 'Zoom', '500%');
    await page.mouse.move(640, 400);
    const before = await camera(page);
    await page.mouse.wheel(200, 0);
    await expect.poll(async () => (await camera(page)).x).toBeGreaterThan(before.x + 10);
  });

  test('Whole Page puts the page back in view after scrolling away', async ({ app, page }) => {
    await threePages(app);
    await choose(app, 'View', 'Zoom', '100%');
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 3000);
    await expect.poll(async () => (await camera(page)).y).toBeGreaterThan(1000);
    await choose(app, 'View', 'Zoom', 'All Pages');
    await expect.poll(async () => (await camera(page)).y).toBeLessThan(200);
  });
});

test.describe('focus', () => {
  test('clicking the document focuses the hidden text input', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await page.mouse.click(640, 400);
    await expect(app.editor).toBeFocused();
  });

  test('toolbar buttons and the zoom box leave the keyboard in the document', async ({ app, page }) => {
    await app.blank();
    await app.toolbarButton('Bold').click();
    await expect(app.editor).toBeFocused();
    await page.keyboard.type('bold');
    const box = page.getByRole('toolbar').getByRole('combobox', { name: 'Zoom' });
    await box.fill('50');
    await box.press('Enter');
    await expect(app.editor).toBeFocused();
    await page.keyboard.type('er');
    expect(await app.text()).toBe('bolder');
  });

  test('opening a menu and choosing a command that opens nothing returns to the document', async ({ app }) => {
    await app.blank();
    await choose(app, 'Edit', 'Select All');
    await expect(app.editor).toBeFocused();
  });

  test('a dialog takes the keyboard and gives it back when it closes', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Edit', 'Find…');
    await expect(page.getByLabel('Find what')).toBeVisible();
    await expect(page.getByLabel('Find what')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.editor).toBeFocused();
  });

  test('the text input is for the document only: it has an accessible name and no autocorrect', async ({ app }) => {
    await app.goto('?doc=welcome');
    await expect(app.editor).toHaveAccessibleName('Document');
    await expect(app.editor).toHaveAttribute('autocomplete', 'off');
    await expect(app.editor).toHaveAttribute('autocapitalize', 'off');
  });
});

test.describe('accessibility basics', () => {
  test('the page has header and main landmarks, a menu bar and labelled toolbars', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(app.menubar).toHaveAccessibleName('Menu');
    await expect(page.getByRole('toolbar')).toHaveCount(2);
    await expect(page.getByRole('toolbar', { name: 'Standard' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('menu titles announce that they open menus', async ({ app }) => {
    await app.goto('?doc=welcome');
    for (const title of await app.menubar.locator('.wm-title:not([hidden])').all()) {
      await expect(title).toHaveAttribute('aria-haspopup', 'menu');
      await expect(title).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('every visible button, combobox and menu title has an accessible name', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    const unnamed = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('#chrome button, #chrome [role=combobox], #chrome [role=menuitem]')) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue; // hidden
        const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent?.trim() || el.getAttribute('title') || el.getAttribute('data-tip');
        if (!name) bad.push(el.outerHTML.slice(0, 120));
      }
      return bad;
    });
    expect(unnamed).toEqual([]);
  });

  test('toggle buttons expose their state with aria-pressed', async ({ app }) => {
    await app.blank();
    const marks = app.toolbarButton('Formatting Marks');
    await expect(marks).toHaveAttribute('aria-pressed', 'false');
    await marks.click();
    await expect(marks).toHaveAttribute('aria-pressed', 'true');
    const bold = app.toolbarButton('Bold');
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await app.type('x');
    await app.press('Shift+Home');
    await app.press(`${MOD}+b`);
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
  });

  test('disabled toolbar buttons are really disabled', async ({ app }) => {
    await app.blank();
    await expect(app.toolbarButton('Undo')).toBeDisabled();
    await expect(app.toolbarButton(/^Cut$/)).toBeDisabled();
    await app.type('typed');
    await expect(app.toolbarButton('Undo')).toBeEnabled();
  });

  test('dialogs are real modal <dialog> elements that trap Escape', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    await expect(page.getByRole('dialog').first()).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll('dialog[open]').length)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });
});

test.describe('search-engine text and metadata', () => {
  test('the #seo article holds the welcome text for crawlers, off screen but in the page', async ({ app, page }) => {
    await page.goto('/');
    await app.ready();
    const seo = page.locator('#seo');
    await expect(seo).toHaveCount(1);
    await expect(seo.locator('h1')).toHaveText('Welcome to Golem Docs');
    const css = await seo.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, width: s.width, display: s.display, visibility: s.visibility };
    });
    expect(css).toEqual({ position: 'absolute', width: '1px', display: 'block', visibility: 'visible' });
  });

  test('the home page has a title, description, canonical link, Open Graph tags and JSON-LD', async ({ page, app }) => {
    await page.goto('/');
    await app.ready();
    await expect(page).toHaveTitle(/Golem Docs/);
    await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /Golem Docs is a document editor/);
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://golemdocs.com/');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Golem Docs/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /icon-512\.png$/);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(ld).toMatchObject({ '@type': 'SoftwareApplication', name: 'Golem Docs' });
  });

  test('documents opened with a query string are kept out of search engines; the bare address is not', async ({ page, app }) => {
    await page.goto('/?doc=welcome');
    await app.ready();
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
    await page.goto('/');
    await app.ready();
    await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  });

  test('the favicon and touch icon are served', async ({ page, request }) => {
    await page.goto('/?doc=welcome');
    for (const path of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
      const response = await request.get(path);
      expect(response.ok(), path).toBe(true);
    }
  });
});

test.describe('loading screen', () => {
  test('covers the editor with the file name while an imported file opens, and is gone when it is ready', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await page.evaluate(() => {
      const w = window as unknown as { __loading: string[] };
      w.__loading = [];
      new MutationObserver(() => {
        const el = document.querySelector<HTMLElement>('.wm-loading');
        if (el && !el.hidden) w.__loading.push(`${el.getAttribute('role')}|${el.querySelector('.wm-loading-name')?.textContent}|${el.querySelector('.wm-loading-detail')?.textContent}`);
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const chooser = page.waitForEvent('filechooser');
    await choose(app, 'File', 'Import…');
    await (await chooser).setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported\n\nBody text.') });
    await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Body text.');
    const seen = await page.evaluate(() => (window as unknown as { __loading: string[] }).__loading);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatch(/^status\|notes\.md\|/);
    expect(seen.some((line) => line.includes('Loading notes.md'))).toBe(true);
    await expect(page.locator('.wm-loading')).toBeHidden();
  });
});

test.describe('shared-computer notice', () => {
  test('signed out, a document other than the welcome one shows it, and dismissing is remembered', async ({ app, page }) => {
    await signedOut(page);
    await app.blank();
    const notice = page.getByRole('complementary', { name: 'Shared computer' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Your documents are saved in this browser');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toBeHidden();
    expect(await stored(page, 'golem.sharedDeviceNotice.dismissed')).toBe('1');
    await page.reload();
    await app.ready();
    await expect(notice).toBeHidden();
  });

  test('it is not shown on the welcome document, or to someone signed in', async ({ app, page }) => {
    await signedOut(page);
    await app.goto('?doc=welcome');
    await expect(page.getByRole('complementary', { name: 'Shared computer' })).toBeHidden();
  });

  test('a signed-in person never sees it', async ({ app, page }) => {
    await app.blank();
    await expect(page.getByRole('complementary', { name: 'Shared computer' })).toBeHidden();
  });

  test('Clear Local Data… asks before deleting anything, and Cancel leaves the documents alone', async ({ app, page }) => {
    await signedOut(page);
    await app.blank();
    await app.type('precious');
    await page.getByRole('complementary', { name: 'Shared computer' }).getByRole('button', { name: 'Clear Local Data…' }).click();
    const confirm = page.locator('dialog[open]');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).last().click();
    await expect(confirm).toHaveCount(0);
    expect(await app.text()).toBe('precious');
  });
});

test.describe('toast messages', () => {
  const badFile = { name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('this is not a zip file at all') };

  test('a failure appears as an alert at the bottom of the window, and a click dismisses it', async ({ app, page }) => {
    await app.blank();
    const chooser = page.waitForEvent('filechooser');
    await choose(app, 'File', 'Import…');
    await (await chooser).setFiles(badFile);
    const toast = page.locator('.wm-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(toast).not.toHaveText('');
    const box = (await toast.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 120);
    await toast.click();
    await expect(toast).toBeHidden();
  });

  test('a toast goes away by itself after a few seconds', async ({ app, page }) => {
    test.setTimeout(45_000);
    await app.blank();
    const chooser = page.waitForEvent('filechooser');
    await choose(app, 'File', 'Import…');
    await (await chooser).setFiles(badFile);
    await expect(page.locator('.wm-toast')).toBeVisible();
    await expect(page.locator('.wm-toast')).toBeHidden({ timeout: 15_000 });
  });
});
