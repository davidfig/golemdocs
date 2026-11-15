// golemdocs:// links into the vault (a stand-in shell here, holding a small vault in memory): the shell keeps the links the app
// was opened with (`link_pending`) and nudges the page (`golem-link`); the page opens the note at the heading or line the link
// names, or says why it can't. File › Copy Link to Note copies a link through the shell. docs/architecture/desktop.md.

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const ROOT = "/Users/someone/Bob's Vault";
const FILE = "Bob's notes/Plan, v2.md";
const NOTE = '# Plan\n\nIntro.\n\n## Next steps\n\nDo the thing.\n\n## Later\n\nMaybe.\n';

declare global {
  interface Window {
    __vault: Record<string, string>;
    __links: string[];
    __copied: string[];
  }
}

async function vaultShell(page: Page): Promise<void> {
  await page.addInitScript(
    ({ root, file, note }) => {
      localStorage.setItem('word.vaultAsked', '1');
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      const enc = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
      window.__vault = { [file]: enc(note) };
      window.__links = [];
      window.__copied = [];
      const times: Record<string, number> = {};
      const now = () => Date.now();
      const folders = () => [...new Set(Object.keys(window.__vault).filter((p) => !p.startsWith('.')).flatMap((p) => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))];
      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        const path = args.path as string;
        switch (command) {
          case 'vault_root':
            return root;
          case 'vault_scan':
            return Object.keys(window.__vault)
              .filter((p) => !p.startsWith('.'))
              .map((p) => ({ path: p, size: atob(window.__vault[p]).length, mtimeMs: (times[p] ??= now()) }));
          case 'vault_folders':
            return folders();
          case 'vault_read_base64':
            if (!(path in window.__vault)) throw 'No such file';
            return window.__vault[path];
          case 'vault_write_base64':
            window.__vault[path] = args.data as string;
            return (times[path] = now());
          case 'vault_set_times':
            return (times[path] ??= now());
          case 'vault_remove':
            delete window.__vault[path];
            return null;
          case 'link_pending':
            return window.__links.splice(0);
          case 'clipboard_write_text':
            window.__copied.push(args.text as string);
            return null;
          case 'incoming_pending':
            return [];
          default:
            return null; // vault_check, vault_make_folder, the menu...
        }
      };
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    },
    { root: ROOT, file: FILE, note: NOTE },
  );
}

/** Starts the app with the vault synced (its note is a document now). */
async function start(page: Page, app: { goto(query?: string): Promise<void> }): Promise<void> {
  await vaultShell(page);
  await app.goto('?doc=welcome');
  await expect.poll(() => page.evaluate(() => '.golemdocs/state.json' in window.__vault), { timeout: 30_000 }).toBe(true);
}

const follow = (page: Page, link: string) =>
  page.evaluate((l) => {
    window.__links.push(l);
    dispatchEvent(new Event('golem-link'));
  }, link);
const status = (page: Page) => page.evaluate(() => (window as unknown as { status: string }).status);
const caretParagraph = (page: Page) => page.evaluate(() => (window as unknown as { selectionState: { at: { focus: [number, number] } | null } }).selectionState.at?.focus[0] ?? null);
const enc = (text: string) => encodeURIComponent(text).replace(/'/g, '%27');

test('a link opens the note at its heading, and another moves to a line', async ({ page, app }) => {
  await start(page, app);
  await follow(page, `golemdocs://open?vault=${enc("Bob's Vault")}&file=${enc(FILE)}&heading=later`);
  await expect.poll(() => status(page)).toContain('Plan, v2.md');
  await expect.poll(() => caretParagraph(page)).toBe(4);
  // Already open: the caret moves, by the line's text ("Do the thing." is line 7, the 4th paragraph).
  await follow(page, `golemdocs://open?file=${enc(FILE)}&line=7`);
  await expect.poll(() => caretParagraph(page)).toBe(3);
  expect(await app.text()).toContain('Do the thing.');
});

test('a link to another vault, or to a file the vault does not have, says so', async ({ page, app }) => {
  await start(page, app);
  await follow(page, `golemdocs://open?vault=Work&file=${enc(FILE)}`);
  await expect.poll(() => status(page)).toBe('That link is for the vault “Work”, but this app keeps “Bob\'s Vault”.');
  await follow(page, 'golemdocs://open?file=Missing.md');
  await expect.poll(() => status(page)).toBe('“Missing.md” isn’t in the vault folder.');
  await follow(page, `golemdocs://open?file=${enc(FILE)}&heading=Nowhere`);
  await expect.poll(() => status(page)).toBe('The note is open, but the place the link points to wasn’t found.');
});

test('File › Copy Link to Note copies a link to the heading the caret is under', async ({ page, app }) => {
  await start(page, app);
  await follow(page, `golemdocs://open?file=${enc(FILE)}&heading=next-steps`);
  await expect.poll(() => caretParagraph(page)).toBe(2);
  await app.press('ArrowDown');
  await app.menu('File', 'Copy Link to Note');
  await expect.poll(() => page.evaluate(() => window.__copied)).toEqual([`golemdocs://open?vault=Bob%27s%20Vault&file=Bob%27s%20notes%2FPlan%2C%20v2.md&heading=Next%20steps`]);
  await expect.poll(() => status(page)).toBe('Link to “Next steps” copied.');
});
