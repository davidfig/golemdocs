// The desktop app's native side (desktop/src-tauri): one folder on this computer, the vault, that the page can list,
// read, write and delete files in. In a browser none of it exists and `desktopBridge()` is null.
//
// There is no `@tauri-apps/api` package: the shell injects `window.__TAURI__` (`withGlobalTauri`), and the few
// calls the page makes are typed here. Which commands a page may call at all is decided by
// desktop/src-tauri/capabilities/default.json, not by this file.

import { t } from '../i18n/index.ts';
import type { LocalFile } from './vaultPlan.ts';

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }): Promise<T>;
}

export interface DesktopBridge {
  /** The folder is fixed (iCloud Drive on a phone): there is nothing to choose or stop. */
  readonly fixed: boolean;
  /** The vault folder, or null when none is chosen. */
  root(): Promise<string | null>;
  /** Asks the person for a folder (a native dialog). Null if they cancel. */
  choose(): Promise<string | null>;
  /** Stops using the folder; its files stay. */
  forget(): Promise<void>;
  /** Shows the vault folder in Finder (Explorer, the file manager). */
  reveal(): Promise<void>;
  /** Whether the app may read and write in the folder; rejects with the reason. The first call on a protected folder makes macOS ask the person. */
  check(): Promise<void>;
  /** Opens the system's privacy settings for files and folders (macOS). */
  openPrivacy(): Promise<void>;
  scan(): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Writes through a temporary file and a rename. Returns the new modification time in milliseconds. */
  write(path: string, bytes: Uint8Array): Promise<number>;
  remove(path: string): Promise<void>;
}

/**
 * True when the shell rejected a call because it has no such command, or does not allow the page that command: the page is
 * the live website, so it can be newer than the installed shell. Tauri rejects with a string ("Command x not found",
 * "x not allowed by ACL"). A page must keep working against the previous shell: see docs/architecture/desktop-release.md.
 */
export function isMissingCommand(error: unknown): boolean {
  return /^Command \S+ not found|\bnot allowed by ACL\b|\bnot allowed\. Command not found\b/i.test(error instanceof Error ? error.message : String(error));
}

/** A command only a newer shell has; the message says to update the app. */
export class ShellTooOldError extends Error {
  constructor() {
    super(t('vault.shellTooOld'));
    this.name = 'ShellTooOldError';
  }
}

/** Calls a command that a shell older than this page may not have, and throws `ShellTooOldError` when it doesn't. */
async function needsNewerShell<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw isMissingCommand(error) ? new ShellTooOldError() : error;
  }
}

function shellCore(): TauriCore | null {
  const found = (globalThis as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
  return found && typeof found.invoke === 'function' ? found : null;
}

const BASE64_PIECE = 0x8000;

/** Bytes as base64 text, a piece at a time (one call with millions of arguments overflows the stack). */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_PIECE) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_PIECE));
  return btoa(binary);
}

/** The bytes base64 text stands for. */
export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (typeof native === 'function') return native(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** True on a phone or tablet (iOS, Android, and an iPad that reports itself as a Mac). */
export function isTouchDevice(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean {
  return /iPhone|iPad|iPod|Android/i.test(nav.userAgent) || (/Mac/.test(nav.platform) && nav.maxTouchPoints > 1);
}

/** True inside the iOS or Android app: the same shell as the desktop app, with none of its native commands. */
export const isMobileApp = (): boolean => shellCore() !== null && isTouchDevice();

/** True in the iOS app (an iPhone or iPad running the shell). */
export const isIosApp = (nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean => shellCore() !== null && isTouchDevice(nav) && !/Android/i.test(nav.userAgent);

// The menu bar and the updater are desktop only (desktop/src-tauri/src/lib.rs).
function tauriCore(): TauriCore | null {
  return isTouchDevice() ? null : shellCore();
}

/** The native side, or null when the page is running in a browser. */
export function desktopBridge(): DesktopBridge | null {
  // The vault is on desktop and in the iOS app (its folder is in iCloud Drive and cannot be chosen).
  const core = isIosApp() ? shellCore() : tauriCore();
  if (!core) return null;
  const bytes = (data: unknown): Uint8Array => (data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data as ArrayLike<number>));
  // Files go as base64 text, which crosses as one string however the web view carries it (raw bytes become a JSON array of
  // numbers when it falls back to postMessage: far too slow for a large file). A shell without those commands takes the raw form.
  let base64 = true;
  return {
    fixed: isIosApp(),
    root: () => core.invoke<string | null>('vault_root'),
    choose: () => core.invoke<string | null>('vault_choose'),
    forget: () => core.invoke<void>('vault_forget'),
    reveal: () => needsNewerShell(() => core.invoke<void>('vault_reveal')),
    // Only there to make macOS ask for access: an older shell has no such step, and its sync fails with its own error if it can't read the folder.
    check: () => core.invoke<void>('vault_check').catch((error: unknown) => {
      if (!isMissingCommand(error)) throw error;
    }),
    openPrivacy: () => needsNewerShell(() => core.invoke<void>('vault_open_privacy')),
    scan: async () => (await core.invoke<{ path: string; size: number; mtimeMs: number }[]>('vault_scan')).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })),
    async read(path) {
      if (base64) {
        try {
          return fromBase64(await core.invoke<string>('vault_read_base64', { path }));
        } catch (error) {
          if (!isMissingCommand(error)) throw error;
          base64 = false;
        }
      }
      return bytes(await core.invoke<unknown>('vault_read', { path }));
    },
    async write(path, data) {
      if (base64) {
        try {
          return await core.invoke<number>('vault_write_base64', { path, data: toBase64(data) });
        } catch (error) {
          if (!isMissingCommand(error)) throw error;
          base64 = false;
        }
      }
      // The bytes are the body and the path rides in a header, percent-encoded because a header is ASCII.
      return core.invoke<number>('vault_write', data as unknown as Record<string, unknown>, { headers: { path: encodeURIComponent(path).replace(/%2F/gi, '/') } });
    },
    remove: (path) => core.invoke<void>('vault_remove', { path }),
  };
}

/** Updating the app's shell (the page is the website and updates itself). The endpoint and the key that signatures are checked against are in tauri.conf.json. */
export interface DesktopUpdater {
  /** The update on offer, or null when this version is the latest. Rejects when the update server can't be reached. */
  check(): Promise<{ version: string; notes: string | null } | null>;
  /** Downloads, verifies and installs the update, then restarts the app (so it only returns by rejecting). */
  install(): Promise<void>;
}

export function desktopUpdater(): DesktopUpdater | null {
  const core = tauriCore();
  if (!core) return null;
  return {
    check: () => core.invoke<{ version: string; notes: string | null } | null>('update_check'),
    install: () => core.invoke<void>('update_install'),
  };
}

/** The native menu bar (macOS): the page sends its menus, a click comes back as the item's id. */
export interface DesktopMenu {
  set(menus: unknown): Promise<void>;
  /** Calls `callback` with the id of each item chosen. Returns a function that stops listening. */
  onClick(callback: (id: string) => void): Promise<() => void>;
}

interface TauriEvents {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

export function desktopMenu(): DesktopMenu | null {
  const tauri = (globalThis as { __TAURI__?: { core?: TauriCore; event?: TauriEvents } }).__TAURI__;
  const core = isTouchDevice() ? undefined : tauri?.core;
  const events = tauri?.event;
  if (!core || typeof core.invoke !== 'function' || !events) return null;
  return {
    set: (menus) => core.invoke<void>('set_native_menu', { menus }),
    onClick: (callback) => events.listen<string>('native-menu', (event) => callback(event.payload)),
  };
}

/** True inside the desktop app. */
export const isDesktopApp = (): boolean => tauriCore() !== null;
