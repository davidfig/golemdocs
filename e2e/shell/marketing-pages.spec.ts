// The static marketing site under /home (client/public/home/index.html) and the pages built from
// client/site/*.md and the legal documents (client/seo.ts). They never load the editor.

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

test.describe('home page', () => {
  test('has the headline, a main navigation and the sections it links to', async ({ page }) => {
    await page.goto('/home');
    await expect(page).toHaveTitle(/^Golem Docs: edit Word, PDF, Markdown, and more in your browser$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('I wanted one editor for everything.');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Features', 'Formats', 'Pricing', 'Privacy', 'Open Golem Docs']);
    for (const id of ['features', 'formats', 'pricing', 'privacy']) await expect(page.locator(`section#${id}`)).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toBeVisible();
  });

  test('has description, canonical URL and social-card metadata', async ({ page }) => {
    await page.goto('/home');
    await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /document editor that lives in your browser/);
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://golemdocs.com/home');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://golemdocs.com/home');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://golemdocs.com/og.png');
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  });

  test('is plain static content: no editor canvas is loaded', async ({ page }) => {
    await page.goto('/home');
    await expect(page.locator('#canvas')).toHaveCount(0);
    await expect(page.locator('#input')).toHaveCount(0);
  });

  test('links to every feature page and to the privacy policy and terms', async ({ page }) => {
    await page.goto('/home');
    const hrefs = await page.locator('a[href^="/home/"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))]);
    for (const { name } of [...FEATURES, ...LEGAL]) expect(hrefs).toContain(`/home/${name}`);
  });

  test('the nav anchors scroll to their sections', async ({ page }) => {
    await page.goto('/home');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pricing' }).click();
    await expect(page).toHaveURL(/#pricing$/);
    await expect(page.locator('section#pricing')).toBeInViewport();
  });

  test('"Open Golem Docs" takes you into the editor', async ({ page }) => {
    await page.goto('/home');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Open Golem Docs' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.waitForFunction(() => (window as unknown as { loaded?: boolean }).loaded === true, null, { timeout: 30_000 });
    await expect(page.getByRole('menubar')).toBeVisible();
  });

  test('every internal link on the page works', async ({ page, request }) => {
    await page.goto('/home');
    const hrefs = await page.locator('a[href]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')!))]);
    const internal = hrefs.filter((h) => h.startsWith('/'));
    expect(internal.length).toBeGreaterThan(8);
    for (const href of internal) {
      const response = await request.get(href);
      expect(response.ok(), href).toBe(true);
    }
    // In-page anchors point at real elements.
    for (const href of hrefs.filter((h) => h.startsWith('#'))) await expect(page.locator(href), href).toHaveCount(1);
  });

  test('follows dark mode from the saved choice and from the system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/home');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.addInitScript(() => localStorage.setItem('golem.appearance', 'light'));
    await page.goto('/home');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/home');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('the scripted AI demo opens, says it is not AI and answers', async ({ page }) => {
    await page.goto('/home');
    const button = page.getByRole('button', { name: /Chat with the AI assistant/ });
    await expect(button).toBeVisible();
    await button.click();
    const panel = page.getByRole('dialog', { name: /AI assistant/ });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('This is a scripted demo, not AI.');
    await panel.getByRole('textbox', { name: 'Message to the assistant' }).fill('hello');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.getByRole('log')).toContainText('hello');
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
      await expect(page.getByRole('link', { name: /Golem Docs/ }).filter({ hasText: '←' })).toHaveAttribute('href', '/home');
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

  test('the header anchors go back to the home page sections', async ({ page }) => {
    await page.goto('/home/pdf');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Features' })).toHaveAttribute('href', '/home#features');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pricing' }).click();
    await expect(page).toHaveURL(/\/home#pricing$/);
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
      await expect(page.locator('main.doc')).toBeVisible();
      await expect(page.locator('main .try')).toHaveCount(0);
      await expect(page.locator('#canvas')).toHaveCount(0);
      expect(await page.locator('main article p').count()).toBeGreaterThan(3);
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
