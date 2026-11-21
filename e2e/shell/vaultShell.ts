// A stand-in desktop shell for the vault specs: `window.__TAURI__` answering the vault commands from a small vault held in
// memory (`window.__vault`, path to base64), plus golemdocs:// links (`__links`), the clipboard (`__copied`) and what Show in
// Finder was asked to show (`__revealed`).
//
// Each test signs in as an account of its own: the vault syncs its files into the account, and with the account every test
// shares, tests running at the same time would open the same documents, join one room and see each other come and go.

import type { Page } from '@playwright/test';
import { signInAs, uniqueEmail } from '../collab/helpers';

export const VAULT_ROOT = "/Users/someone/Bob's Vault";

declare global {
  interface Window {
    __vault: Record<string, string>;
    __links: string[];
    __copied: string[];
    __revealed: string[];
  }
}

/** Signs the page in as a new account and installs the shell before the page loads, with `files` (path to text) in the vault. Returns the account's email. */
export async function vaultShell(page: Page, files: Record<string, string>): Promise<string> {
  const email = uniqueEmail('vault');
  await signInAs(page.context(), email);
  await page.addInitScript(
    ({ root, files }) => {
      localStorage.setItem('word.vaultAsked', '1');
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      const enc = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
      window.__vault = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, enc(text)]));
      window.__links = [];
      window.__copied = [];
      window.__revealed = [];
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
          case 'vault_reveal_item':
            window.__revealed.push(path);
            return null;
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
    { root: VAULT_ROOT, files },
  );
  return email;
}
