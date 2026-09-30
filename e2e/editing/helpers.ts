// Helpers shared by the text-editing specs: caret and mouse geometry on the canvas, the clipboard,
// reading a downloaded .docx, and small wrappers for the dialogs.

import { inflateRawSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import { expect, MOD, type App } from '../fixtures';

export { MOD };

export interface Caret {
  page: number;
  x: number;
  y: number;
  height: number;
}

/** The caret as the editor reports it (page-relative points), or null. */
export async function caret(app: App): Promise<Caret | null> {
  return app.page.evaluate(() => (window as unknown as { selectionState: { caret: Caret | null } }).selectionState.caret);
}

/** The caret's middle, in window (client) pixels. */
export async function caretClient(app: App): Promise<{ x: number; y: number }> {
  return app.page.evaluate(() => {
    const w = window as unknown as {
      selectionState: { caret: { page: number; x: number; y: number; height: number } | null };
      pages: { id: number; x: number; y: number }[];
      camera: { x: number; y: number; zoom: number };
    };
    const c = w.selectionState.caret!;
    const page = w.pages.find((p) => p.id === c.page)!;
    const rect = document.getElementById('canvas')!.getBoundingClientRect();
    const k = w.camera.zoom * (96 / 72);
    return { x: rect.left + (page.x + c.x - w.camera.x) * k, y: rect.top + (page.y + c.y + c.height / 2 - w.camera.y) * k };
  });
}

/**
 * Window coordinates of the gaps between the characters of the caret's line: entry `i` is where
 * the caret sits after `i` characters from the line start. Walks the line with the arrow keys,
 * so the document must fit on one line. Leaves the caret at the line end.
 */
export async function lineGaps(app: App, length: number): Promise<{ x: number; y: number }[]> {
  await app.press('Home');
  await waitCaretSettled(app);
  const gaps = [await caretClient(app)];
  for (let i = 0; i < length; i++) {
    const before = (await caret(app))!.x;
    await app.press('ArrowRight');
    await expect.poll(async () => (await caret(app))!.x).not.toBe(before);
    gaps.push(await caretClient(app));
  }
  return gaps;
}

/** Waits until the caret stops moving between two animation frames. */
export async function waitCaretSettled(app: App): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      await app.settle();
      const now = JSON.stringify(await caret(app));
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
}

export interface ClickOptions {
  clickCount?: number;
  modifiers?: ('Shift' | 'Control' | 'Meta' | 'Alt' | 'ControlOrMeta')[];
  button?: 'left' | 'right';
}

export async function clickAt(app: App, at: { x: number; y: number }, options: ClickOptions = {}): Promise<void> {
  // A mouse press keeps the editor focused (the canvas handler refocuses it).
  await app.page.mouse.move(at.x, at.y);
  for (const m of options.modifiers ?? []) await app.page.keyboard.down(m);
  await app.page.mouse.click(at.x, at.y, { clickCount: options.clickCount ?? 1, button: options.button ?? 'left', delay: 10 });
  for (const m of [...(options.modifiers ?? [])].reverse()) await app.page.keyboard.up(m);
  await app.settle();
}

/** Put text on the system clipboard (plain, and optionally HTML), as another app would. */
export async function setClipboard(page: Page, content: { text?: string; html?: string }): Promise<void> {
  await page.evaluate(async ({ text, html }) => {
    const items: Record<string, Blob> = {};
    if (text !== undefined) items['text/plain'] = new Blob([text], { type: 'text/plain' });
    if (html !== undefined) items['text/html'] = new Blob([html], { type: 'text/html' });
    await navigator.clipboard.write([new ClipboardItem(items)]);
  }, content);
}

export async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// --- Reading a downloaded .docx -------------------------------------------------------------

/** The text of one part of a .docx (a zip), e.g. `word/document.xml`. */
export function docxPart(bytes: Buffer, name: string): string {
  // Find the end of central directory record, then walk the central directory.
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(p + 10);
    const compressed = bytes.readUInt32LE(p + 20);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const entry = bytes.toString('utf8', p + 46, p + 46 + nameLength);
    if (entry === name) {
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + compressed);
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`no ${name} in the zip`);
}

/** File ▸ Download, read as the document.xml of the .docx it saves. */
export async function downloadDocumentXml(app: App): Promise<string> {
  const file = await app.download(() => app.menu('File', 'Download'));
  return docxPart(file.bytes, 'word/document.xml');
}

// --- Dialogs and controls ---------------------------------------------------------------------

export function dialog(page: Page, name: string | RegExp): Locator {
  return page.getByRole('dialog', { name });
}

/** The text of the Nth paragraph's runs in document.xml is easier read as a flat list of `<w:p>` blocks. */
export function paragraphsOf(xml: string): string[] {
  return xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
}

/** The toolbar's combo box with this label (Font, Font Size, Style, Zoom). */
export function combo(page: Page, label: string): Locator {
  return page.getByRole('toolbar').getByRole('combobox', { name: label, exact: true });
}

/** Types into a toolbar combo box and presses Enter. */
export async function setCombo(page: Page, label: string, value: string): Promise<void> {
  const box = combo(page, label);
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

/** Pick (or unpick) a swatch from a toolbar split colour button's palette. */
export async function pickColor(page: Page, label: 'Font Color' | 'Highlight', swatch: string): Promise<void> {
  await page.getByRole('toolbar').getByRole('button', { name: `${label} options` }).click();
  await page.getByRole('dialog', { name: label }).getByRole('button', { name: swatch, exact: true }).click();
}

/** Type a line and select all of it (caret ends after the last character; selection is the whole line). */
export async function typeAndSelect(app: App, text: string): Promise<void> {
  await app.type(text);
  await app.press(`${MOD}+a`);
  await expect.poll(() => app.selectedText()).toBe(text);
}

// --- Platform keys ----------------------------------------------------------------------------

/** The app reads the browser's platform: macOS maps word and line movement to Option and Command. */
export const IS_MAC = process.platform === 'darwin';
/** Held with an arrow key to move or select by word. */
export const WORD = IS_MAC ? 'Alt' : 'Control';
/** Ctrl/Cmd+Home and +End go to the document's start and end on every platform. */
export const DOC = 'ControlOrMeta';

// --- Menus --------------------------------------------------------------------------------------

/** Opens a top-level menu and returns the locator of an item in the open menu(s). */
export async function openMenuItem(app: App, title: string, ...path: string[]): Promise<Locator> {
  await app.menubar.getByRole('menuitem', { name: new RegExp(`^${title}$`) }).click();
  const menus = app.page.getByRole('menu');
  for (const [i, name] of path.entries()) {
    const match = { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(…|\\.\\.\\.)?(\\s|$)`) };
    const item = menus.getByRole('menuitem', match).or(menus.getByRole('menuitemcheckbox', match)).or(menus.getByRole('menuitemradio', match)).first();
    if (i < path.length - 1) await item.click();
    else return item;
  }
  throw new Error('openMenuItem needs an item');
}

/** A toolbar button by its exact name ("Cut" must not match "Keyboard Shortcuts"). */
export function tool(app: App, name: string): Locator {
  return app.page.getByRole('toolbar').getByRole('button', { name, exact: true });
}

/** Selects with Shift+arrows (or another selection key) and waits until the editor reports `text` selected. */
export async function selectBy(app: App, key: string, times: number, text: string): Promise<void> {
  await app.press(key, times);
  await expect.poll(() => app.selectedText()).toBe(text);
}

// --- Reading runs and paragraphs out of document.xml ------------------------------------------

export interface Run {
  text: string;
  /** Run properties as `name` or `name:value`, e.g. `b`, `u:single`, `sz:28`, `color:FF0000`. */
  props: string[];
}

function propsOf(xml: string | undefined): string[] {
  return [...(xml ?? '').matchAll(/<w:(\w+)((?:\s+[\w:]+="[^"]*")*)\s*\/>/g)].map((m) => {
    const value = /w:val="([^"]*)"/.exec(m[2]) ?? /w:ascii="([^"]*)"/.exec(m[2]);
    return value ? `${m[1]}:${value[1]}` : m[1];
  });
}

/** The text runs of a paragraph's XML (or of the whole document), in order. */
export function runsOf(xml: string): Run[] {
  const runs: Run[] = [];
  for (const m of xml.matchAll(/<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?([\s\S]*?)<\/w:r>/g)) {
    const text = [...m[2].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((t) => (t[1] === undefined ? '\t' : t[1])).join('');
    runs.push({ text, props: propsOf(m[1]) });
  }
  return runs;
}

/** The properties of the paragraph (`<w:pPr>`), e.g. `jc:center`, `ind left=720`. */
export function paragraphProps(paragraphXml: string): { tags: string[]; raw: string } {
  const raw = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1] ?? '';
  return { tags: propsOf(raw), raw };
}

/** The properties of the run holding `text` (first run whose text contains it). */
export function propsFor(runs: Run[], text: string): string[] {
  const run = runs.find((r) => r.text.includes(text));
  if (!run) throw new Error(`no run with "${text}" in ${JSON.stringify(runs)}`);
  return run.props;
}

/**
 * Clicks an item of a submenu whose rows start with an icon glyph ("BBold⌘B"), so the name is not
 * at the start of the accessible name: `menuSub(app, 'Format', 'Character', 'Bold')`.
 */
export async function menuSub(app: App, top: string, sub: string, item: string): Promise<void> {
  await app.menu(top, sub);
  const menus = app.page.getByRole('menu');
  const match = { name: new RegExp(`${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`) };
  await menus
    .getByRole('menuitem', match)
    .or(menus.getByRole('menuitemcheckbox', match))
    .or(menus.getByRole('menuitemradio', match))
    .last()
    .click();
}

/** Adds the Style box to the Formatting toolbar (it is off by default) before the app loads. */
export async function showStyleBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const items = ['control.style', 'control.font', 'control.size', '|', 'format.bold', 'format.italic', 'format.underline', 'format.strikethrough', '|', 'format.align.left', 'format.align.center', 'format.align.right', 'format.align.justify', '|', 'format.numbering', 'format.bullets', 'format.outdent', 'format.indent', '|', 'format.clear', 'control.highlight', 'control.fontColor'];
    localStorage.setItem('word.toolbars.v1', JSON.stringify([{ name: 'Formatting', visible: true, items }]));
  });
}

/** Clicks a top-level menu item whose row starts with an icon glyph ("•Bullets"): `menuLast(app, 'Format', 'Bullets')`. */
export async function menuLast(app: App, top: string, item: string): Promise<void> {
  await app.menubar.getByRole('menuitem', { name: new RegExp(`^${top}$`) }).click();
  const menus = app.page.getByRole('menu');
  const match = { name: new RegExp(`${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`) };
  await menus.getByRole('menuitem', match).or(menus.getByRole('menuitemcheckbox', match)).or(menus.getByRole('menuitemradio', match)).first().click();
}
