// The desktop app's native side (desktop/src-tauri): one folder on this computer, the vault, that the page can list,
// read, write and delete files in. In a browser none of it exists and `desktopBridge()` is null.
//
// There is no `@tauri-apps/api` package: the shell injects `window.__TAURI__` (`withGlobalTauri`), and the few
// calls the page makes are typed here. Which commands a page may call at all is decided by
// desktop/src-tauri/capabilities/default.json, not by this file.

import type { LocalFile } from './vaultPlan.ts';

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }): Promise<T>;
}

export interface DesktopBridge {
  /** The vault folder, or null when none is chosen. */
  root(): Promise<string | null>;
  /** Asks the person for a folder (a native dialog). Null if they cancel. */
  choose(): Promise<string | null>;
  /** Stops using the folder; its files stay. */
  forget(): Promise<void>;
  scan(): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Writes through a temporary file and a rename. Returns the new modification time in milliseconds. */
  write(path: string, bytes: Uint8Array): Promise<number>;
  remove(path: string): Promise<void>;
}

function tauriCore(): TauriCore | null {
  const found = (globalThis as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
  return found && typeof found.invoke === 'function' ? found : null;
}

/** The native side, or null when the page is running in a browser. */
export function desktopBridge(): DesktopBridge | null {
  const core = tauriCore();
  if (!core) return null;
  const bytes = (data: unknown): Uint8Array => (data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data as ArrayLike<number>));
  return {
    root: () => core.invoke<string | null>('vault_root'),
    choose: () => core.invoke<string | null>('vault_choose'),
    forget: () => core.invoke<void>('vault_forget'),
    scan: async () => (await core.invoke<{ path: string; size: number; mtimeMs: number }[]>('vault_scan')).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })),
    read: async (path) => bytes(await core.invoke<unknown>('vault_read', { path })),
    // The bytes are the body and the path rides in a header, percent-encoded because a header is ASCII.
    write: (path, data) => core.invoke<number>('vault_write', data as unknown as Record<string, unknown>, { headers: { path: encodeURIComponent(path).replace(/%2F/gi, '/') } }),
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
  const core = tauri?.core;
  const events = tauri?.event;
  if (!core || typeof core.invoke !== 'function' || !events) return null;
  return {
    set: (menus) => core.invoke<void>('set_native_menu', { menus }),
    onClick: (callback) => events.listen<string>('native-menu', (event) => callback(event.payload)),
  };
}

/** True inside the desktop app. */
export const isDesktopApp = (): boolean => tauriCore() !== null;
