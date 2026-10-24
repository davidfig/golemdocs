// The marketing site under /home: its pages in every language (client/home, rendered by client/home/build.ts), and the guide
// and legal pages built from client/site/*.md and the legal documents (client/seo.ts). None of them loads the editor.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const FEATURES = [
  { name: 'convert', heading: 'Convert documents between formats' },
  { name: 'pdf', heading: 'Edit and mark up PDFs in your browser' },
  { name: 'images', heading: 'Edit pictures in your browser' },
  { name: 'documents', heading: 'Write and edit Word documents' },
  { name: 'collaborate', heading: 'Work on documents together, live' },
  { name: 'customize', heading: 'Make Golem Docs look and feel the way you want' },
  { name: 'import', heading: 'Import files, folders, and ZIP archives' },
  { name: 'obsidian', heading: 'Import an Obsidian vault' },
  { name: 'large-files', heading: 'Open huge text and log files' },
  { name: 'vector', heading: 'Edit vector drawings in your browser' },
] as const;

const LEGAL = [
  { name: 'privacy', heading: 'Golem Docs - Privacy Policy' },
  { name: 'terms', heading: 'Golem Docs - Terms of Service' },
] as const;

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const PAGES = [
  { path: '/home', menu: 'Home', heading: 'Your second brain, for every kind of document.' },
  { path: '/home/ai', menu: 'Your ai', heading: 'Ask your ai to help with your documents.' },
  { path: '/home/formats', menu: 'Formats', heading: 'If you can name it, you can probably open it.' },
  { path: '/home/pricing', menu: 'Pricing', heading: 'Free to use. Paying covers my server bills.' },
  { path: '/home/journal', menu: 'Journal', heading: 'What changed lately.' },
  { path: '/home/about', menu: 'About', heading: 'Why I built this.' },
  { path: '/home/developers', menu: 'Developers', heading: 'Plain files, and a sync you can reason about.' },
  { path: '/home/download', menu: 'Download', heading: 'Golem Docs on your computer.' },
] as const;

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('every page has its heading, marks itself in the menu, and loads without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const { path, menu, heading } of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(menu);
  }
  expect(errors).toEqual([]);
});

test('the menu bar goes from page to page', async ({ page }) => {
  await page.goto('/home');
  await nav(page).getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/\/home\/journal$/);
  await expect(page.locator('.entry').first()).toBeVisible();
  await nav(page).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test('the demo shows the chat app, and the pane\'s Terminal tab shows it in a terminal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/home');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await expect(demo.getByRole('tab', { name: 'Chat app' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chatSteps li')).toHaveCount(5);
  await expect(demo.getByText('Earlier versions: File › Version History')).toBeVisible();
  await demo.getByRole('tab', { name: 'Terminal' }).click();
  await expect(demo.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chat')).toBeHidden();
  await expect(page.locator('#term')).toContainText('3 files changed.');
});

test('the demo plays in the chat app, then again in the terminal', { tag: '@heavy' }, async ({ page }) => {
  await page.goto('/home');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(page.locator('#chatSteps li.last')).toBeVisible({ timeout: 15_000 });
  await expect(demo.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(page.locator('#term')).toContainText('Golem Docs $ ai');
});

test('the demo keeps its height while it plays and switches, so the page never moves', { tag: '@heavy' }, async ({ page }) => {
  await page.goto('/home');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const height = async () => (await demo.boundingBox())!.height;
  const first = await height();
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    expect(await height()).toBe(first);
  }
  await demo.getByRole('tab', { name: 'Terminal' }).click();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    expect(await height()).toBe(first);
  }
});

test('choosing a file in the editor picture shows a drawing, a PDF or a spreadsheet, each with its own toolbar', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // no stepping through on its own
  await page.goto('/home');
  const editor = page.locator('#editor');
  const shown = editor.locator('.ed-page:visible');
  await expect(shown).toContainText('Garden plan');
  await expect(page.locator('#edTabs')).toBeHidden(); // the sidebar does the choosing
  for (const [file, text] of [['Bed layout.svg', 'Tomatoes'], ['Seed order form.pdf', 'Spring seed order'], ['Seed order.csv', 'San Marzano']] as const) {
    const row = editor.getByRole('button', { name: file });
    await expect(row).toHaveCSS('cursor', 'pointer');
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText(text);
    await expect(editor.locator('.tb:visible')).toHaveCount(1);
  }
  await expect(page.locator('#filesHint')).toBeHidden();
  // The keyboard works too.
  await editor.getByRole('button', { name: 'Garden plan.docx' }).focus();
  await page.keyboard.press('Enter');
  await expect(shown).toContainText('Order seeds by March');
});

test('the editor picture steps through the files until one is chosen', async ({ page }) => {
  await page.goto('/home');
  const editor = page.locator('#editor');
  await editor.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(editor.locator('.ed-row.current')).toHaveText('Bed layout.svg', { timeout: 8000 });
  await editor.getByRole('button', { name: 'Seed order.csv' }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(4000);
  await expect(editor.locator('.ed-row.current')).toHaveText('Seed order.csv');
});

test('on a phone, where the sidebar is hidden, tabs choose the file', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/home');
  await page.getByRole('tab', { name: 'PDF' }).click();
  await expect(page.locator('#editor .ed-page:visible')).toContainText('Spring seed order');
});

test('the developers page copies its AGENTS.md', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/home/developers');
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# This folder is my second brain/);
});

test('no page scrolls sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const { path } of PAGES) {
    await page.goto(path);
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
});

test.describe('home page', () => {
  test('has description, canonical URL, alternates and social-card metadata', async ({ page }) => {
    await page.goto('/home');
    await expect(page).toHaveTitle('Golem Docs: your second brain, for every kind of document');
    await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /every kind of document|Word files, PDFs/);
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://golemdocs.com/home');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://golemdocs.com/home');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://golemdocs.com/og.png');
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    await expect(page.locator('link[rel=alternate][hreflang=de]')).toHaveAttribute('href', 'https://golemdocs.com/home/de');
  });

  test('is plain static content: no editor canvas is loaded', async ({ page }) => {
    await page.goto('/home');
    await expect(page.locator('#canvas')).toHaveCount(0);
    await expect(page.locator('#input')).toHaveCount(0);
  });

  test('"Open Golem Docs" takes you into the editor', async ({ page }) => {
    await page.goto('/home');
    await page.locator('header').getByRole('link', { name: 'Open Golem Docs' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.waitForFunction(() => (window as unknown as { loaded?: boolean }).loaded === true, null, { timeout: 30_000 });
    await expect(page.getByRole('menubar')).toBeVisible();
  });

  test('follows dark mode from the saved choice and from the system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/home');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.addInitScript(() => localStorage.setItem('golem.appearance', 'light'));
    await page.goto('/home');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test('every internal link on every page works', async ({ page, request }) => {
    const seen = new Set<string>();
    for (const { path } of PAGES) {
      await page.goto(path);
      for (const href of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')!))) seen.add(href.split('#')[0] || '/home');
    }
    expect(seen.size).toBeGreaterThan(15);
    for (const href of seen) expect((await request.get(href)).ok(), href).toBe(true);
  });
});

test.describe('languages', () => {
  test('a page in another language has its text, and the picker leads to the same page in each language', async ({ page }) => {
    await page.goto('/home/de/pricing');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('nav[aria-label] a[aria-current="page"]')).toHaveText(/Preise/);
    await page.locator('.langs summary').click();
    await expect(page.locator('.langs .pop a[lang="fr"]')).toHaveAttribute('href', '/home/fr/pricing');
    await expect(page.locator('.langs .pop a[lang="en"]')).toHaveAttribute('href', '/home/pricing');
  });

  test('an English page sends a visitor whose browser is in another language to theirs', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await page.goto('/home/ai');
    await expect(page).toHaveURL(/\/home\/fr\/ai$/);
    await context.close();
  });
});

  test.describe('download page', () => {
    const release = {
      version: '9.9.9',
      date: '2026-10-12',
      files: [
        { name: 'GolemDocs_9.9.9_universal.dmg', platform: 'mac', size: 4_000_000 },
        { name: 'GolemDocs_9.9.9_x64-setup.exe', platform: 'windows', size: 9_000_000 },
        { name: 'GolemDocs_9.9.9_amd64.AppImage', platform: 'linux', size: 80_000_000 },
      ],
    };

    test('says the app is not ready before a release is published', async ({ page }) => {
      await page.goto('/home/download');
      await expect(page.getByText('The desktop app is not ready to download yet.')).toBeVisible();
      await expect(page.locator('#dl')).toBeHidden();
    });

    test('offers the installer for this computer first and lists the others', async ({ browser }) => {
      const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
      const page = await context.newPage();
      await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
      await page.route('**/api/downloads', (route) => route.fulfill({ json: release }));
      await page.goto('/home/download');
      const button = page.getByRole('link', { name: 'Download for Mac' });
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('href', '/api/downloads/GolemDocs_9.9.9_universal.dmg');
      await expect(page.getByText('Version 9.9.9')).toBeVisible();
      await expect(page.locator('#dl-note')).toBeHidden(); // the SmartScreen note is for Windows only
      await page.getByText('Other downloads').click();
      await expect(page.locator('#dl-list li')).toHaveText([/^Mac: GolemDocs_9\.9\.9_universal\.dmg/, /^Windows: GolemDocs_9\.9\.9_x64-setup\.exe/, /^Linux: GolemDocs_9\.9\.9_amd64\.AppImage/]);
      await context.close();
    });

    test('a Windows visitor gets the Windows installer and the SmartScreen note', async ({ browser }) => {
      const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
      const page = await context.newPage();
      await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
      await page.route('**/api/downloads', (route) => route.fulfill({ json: release }));
      await page.goto('/home/download');
      await expect(page.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', '/api/downloads/GolemDocs_9.9.9_x64-setup.exe');
      await expect(page.locator('#dl-note')).toBeVisible();
      await context.close();
    });
  });

test.describe('feature pages', () => {
  for (const { name, heading } of FEATURES) {
    test(`/home/${name} has its title, heading, a way back and a way into the app`, async ({ page }) => {
      const response = await page.goto(`/home/${name}`);
      expect(response!.status()).toBe(200);
      await expect(page).toHaveTitle(`${heading} | Golem Docs`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `https://golemdocs.com/home/${name}`);
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', `${heading} | Golem Docs`);
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
      await expect(page.locator('main .try').getByRole('link', { name: 'Open Golem Docs' })).toHaveAttribute('href', '/');
      await expect(page.locator('#canvas')).toHaveCount(0);
    });
  }

  test('each page lists the other nine features and not itself', async ({ page }) => {
    await page.goto('/home/convert');
    const more = page.locator('.more');
    await expect(more.getByRole('heading', { name: 'More you can do' })).toBeVisible();
    const hrefs = await more.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // The other features, then the search guides.
    const guides = ['markdown-to-word', 'open-docx-online', 'pdf-to-word', 'redact-pdf'];
    expect(hrefs.sort()).toEqual([...FEATURES.filter((f) => f.name !== 'convert').map((f) => f.name), ...guides].map((name) => `/home/${name}`).sort());
  });

  test('the menu bar leads to the site\'s pages', async ({ page }) => {
    await page.goto('/home/pdf');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pricing' }).click();
    await expect(page).toHaveURL(/\/home\/pricing$/);
  });

  test('every internal link on every feature page works', async ({ page, request }) => {
    const seen = new Set<string>();
    for (const { name } of FEATURES) {
      await page.goto(`/home/${name}`);
      for (const href of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')!))) seen.add(href.split('#')[0] || '/home');
    }
    for (const href of seen) expect((await request.get(href)).ok(), href).toBe(true);
  });

  test('a feature page fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    for (const { name } of FEATURES) {
      await page.goto(`/home/${name}`);
      expect(await noHorizontalScroll(page), name).toBe(true);
    }
  });
});

test.describe('legal pages', () => {
  for (const { name, heading } of LEGAL) {
    test(`/home/${name} is a plain page of the document`, async ({ page }) => {
      await page.goto(`/home/${name}`);
      await expect(page).toHaveTitle(heading);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('article.doc')).toBeVisible();
      await expect(page.locator('main .try')).toHaveCount(0);
      await expect(page.locator('#canvas')).toHaveCount(0);
      expect(await page.locator('article.doc p').count()).toBeGreaterThan(3);
    });
  }

  test('the two legal pages link to each other inside the site', async ({ page }) => {
    await page.goto('/home/privacy');
    await expect(page.locator('main a[href="/home/terms"]').first()).toBeVisible();
    await page.goto('/home/terms');
    await expect(page.locator('main a[href="/home/privacy"]').first()).toBeVisible();
  });

  for (const name of ['privacy', 'terms']) {
    test(`the app's own /${name} address redirects to the plain page`, async ({ page }) => {
      await page.goto(`/${name}`);
      await expect(page).toHaveURL(new RegExp(`/home/${name}$`));
    });
  }
});
