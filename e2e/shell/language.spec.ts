import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose, menuRow, openMenu, stored } from './helpers';

/** Every language in client/src/i18n/locales.ts: id, its own name in the picker, the File and View menu titles (mnemonic marks removed). */
const LANGUAGES = [
  { id: 'en', name: 'English', file: 'File', view: 'View', browser: 'en-US' },
  { id: 'de', name: 'Deutsch', file: 'Datei', view: 'Ansicht', browser: 'de-DE' },
  { id: 'es', name: 'Español', file: 'Archivo', view: 'Ver', browser: 'es-MX' },
  { id: 'fr', name: 'Français', file: 'Fichier', view: 'Affichage', browser: 'fr-FR' },
  { id: 'it', name: 'Italiano', file: 'File', view: 'Visualizza', browser: 'it-IT' },
  { id: 'ja', name: '日本語', file: 'ファイル(F)', view: '表示(V)', browser: 'ja-JP' },
  { id: 'ko', name: '한국어', file: '파일(F)', view: '보기(V)', browser: 'ko-KR' },
  { id: 'pt-BR', name: 'Português (Brasil)', file: 'Arquivo', view: 'Exibir', browser: 'pt-BR' },
  { id: 'ru', name: 'Русский', file: 'Файл', view: 'Вид', browser: 'ru-RU' },
  { id: 'zh-Hans', name: '简体中文', file: '文件(F)', view: '视图(V)', browser: 'zh-CN' },
  { id: 'zh-Hant', name: '繁體中文', file: '檔案(F)', view: '檢視(V)', browser: 'zh-TW' },
] as const;

const titles = (page: Page) => page.locator('[role=menubar] .wm-title:not([hidden])');
const lang = (page: Page) => page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));

test.describe('the language follows the browser', () => {
  for (const language of LANGUAGES) {
    test.describe(`browser set to ${language.browser}`, () => {
      test.use({ locale: language.browser });
      test(`shows the ${language.name} interface`, async ({ app, page }) => {
        await app.goto('?doc=welcome');
        expect((await lang(page)).lang).toBe(language.id);
        await expect(titles(page).nth(0)).toHaveText(language.file);
        await expect(titles(page).nth(2)).toHaveText(language.view);
        expect(await stored(page, 'wm.locale')).toBe(language.id);
        await expect(app.menubar).toHaveAccessibleName(language.id === 'en' ? 'Menu' : /.+/);
      });
    });
  }

  for (const [browser, id] of [
    ['pt-PT', 'pt-BR'],
    ['pt', 'pt-BR'],
    ['zh-HK', 'zh-Hant'],
    ['zh', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['de-AT', 'de'],
    ['en-GB', 'en'],
  ] as const) {
    test.describe(`browser set to ${browser}`, () => {
      test.use({ locale: browser });
      test(`is served by ${id}`, async ({ app, page }) => {
        await app.goto('?doc=welcome');
        expect((await lang(page)).lang).toBe(id);
      });
    });
  }

  test.describe('an unsupported browser language', () => {
    test.use({ locale: 'nl-NL' });
    test('falls back to English', async ({ app, page }) => {
      await app.goto('?doc=welcome');
      expect((await lang(page)).lang).toBe('en');
      await expect(titles(page).nth(0)).toHaveText('File');
    });
  });
});

test.describe('Tools ▸ Language', () => {
  test('lists every language by its own name with the current one ticked', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'Tools');
    await menuRow(page, 'Language').hover();
    await expect(menuRow(page, 'Deutsch')).toBeVisible();
    const names = await page.locator('.wm-menu').last().locator('.wm-item span.label').allTextContents();
    expect([...names].sort()).toEqual(LANGUAGES.map((l) => l.name).sort());
    await expect(menuRow(page, 'English')).toHaveAttribute('aria-checked', 'true');
    await expect(menuRow(page, 'Deutsch')).toHaveAttribute('aria-checked', 'false');
  });

  test('choosing a language reloads the page in it and remembers the choice', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await Promise.all([page.waitForEvent('load'), choose(app, 'Tools', 'Language', 'Deutsch')]);
    await app.ready();
    expect((await lang(page)).lang).toBe('de');
    await expect(titles(page).nth(0)).toHaveText('Datei');
    await expect(titles(page).nth(2)).toHaveText('Ansicht');
    expect(await stored(page, 'wm.locale')).toBe('de');
    // Still German after another visit; the picker shows it ticked.
    await page.reload();
    await app.ready();
    await expect(titles(page).nth(0)).toHaveText('Datei');
    await titles(page).filter({ hasText: 'Extras' }).or(titles(page).nth(5)).first().click();
    await menuRow(page, 'Sprache').hover();
    await expect(menuRow(page, 'Deutsch')).toHaveAttribute('aria-checked', 'true');
  });

  test('other parts of the interface follow: dialogs, toolbar names and tooltips', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await Promise.all([page.waitForEvent('load'), choose(app, 'Tools', 'Language', 'Deutsch')]);
    await app.ready();
    await expect(page.getByRole('toolbar').first()).toHaveAccessibleName('Standard');
    await page.keyboard.press('F1');
    await expect(page.locator('dialog[open] .wm-dialog-title')).toContainText('Tastenkombinationen');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Befehlspalette' })).toBeVisible();
  });

  test('English can be chosen again from another language', async ({ app, page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('wm.locale', 'fr');
      }
    });
    await app.goto('?doc=welcome');
    await expect(titles(page).nth(0)).toHaveText('Fichier');
    await titles(page).nth(5).click(); // Outils
    await menuRow(page, 'Langue').hover();
    await Promise.all([page.waitForEvent('load'), menuRow(page, 'English').click()]);
    await app.ready();
    await expect(titles(page).nth(0)).toHaveText('File');
    expect(await stored(page, 'wm.locale')).toBe('en');
  });

  test('a saved choice beats the browser’s language', async ({ app, page }) => {
    await page.addInitScript(() => localStorage.setItem('wm.locale', 'en'));
    await page.goto('/?doc=welcome');
    await app.ready();
    expect((await lang(page)).lang).toBe('en');
  });
});

test.describe('language fallbacks', () => {
  test.use({ locale: 'de-DE' });

  test('an unknown saved language is ignored in favour of the browser’s', async ({ app, page }) => {
    await page.addInitScript(() => localStorage.setItem('wm.locale', 'tlh'));
    await app.goto('?doc=welcome');
    expect((await lang(page)).lang).toBe('de');
  });

  test('if a language file cannot be loaded the interface still works, in English', async ({ app, page }) => {
    await page.route(/\/i18n\/locales\/de\//, (route) => route.abort());
    await app.goto('?doc=welcome');
    await expect(titles(page).nth(0)).toHaveText('File');
    await expect(titles(page).nth(2)).toHaveText('View');
    await app.blank();
    await app.type('still works');
    expect(await app.text()).toBe('still works');
  });
});

test.describe('units follow the language', () => {
  test('Page Setup is in inches in English and in centimetres in other languages', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await choose(app, 'File', 'Page Setup…');
    const dialog = page.locator('dialog', { has: page.locator('.wm-page-unit') });
    await expect(dialog.locator('.wm-page-unit').first()).toHaveText('in');
    const inches = await dialog.locator('input[type=number]').evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)));
    await page.keyboard.press('Escape');

    await page.evaluate(() => localStorage.setItem('wm.locale', 'de'));
    await page.reload();
    await app.ready();
    await titles(page).nth(0).click();
    await page.locator('.wm-menu .wm-item').filter({ hasText: /Seite einrichten|Seitenr?einrichtung|Seite/ }).first().click();
    const metric = page.locator('dialog', { has: page.locator('.wm-page-unit') });
    await expect(metric.locator('.wm-page-unit').first()).toHaveText('cm');
    const cm = await metric.locator('input[type=number]').evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)));
    expect(cm).toHaveLength(inches.length);
    cm.forEach((value, i) => expect(value).toBeCloseTo(inches[i] * 2.54, 1));
  });
});
