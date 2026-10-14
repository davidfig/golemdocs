// Files the system hands to the phone app: "Open in GolemDocs" from Files or Mail, or Share to it from another app. The native
// side (Android: IncomingFiles.kt and OpenBridge.kt; iOS: desktop/src-tauri/src/incoming.rs) copies each into the app's cache and
// keeps a list; the page asks for it when it starts, when the app comes to the front and when the shell says there is more, reads
// each file, tells the shell it has it, and opens them the way dropped files open.

export interface IncomingFile {
  id: string;
  name: string;
  /** The MIME type the sender gave (may be empty or generic). */
  type: string;
  size: number;
}

export interface IncomingBridge {
  pending(): Promise<IncomingFile[]>;
  /** The whole file. */
  read(id: string): Promise<Uint8Array>;
  /** The page has the file: the shell deletes its copy. */
  done(id: string): Promise<void>;
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** The calls the Android shell adds to the page (OpenBridge.kt): a JSON list, and a file's bytes as base64 pieces. */
interface AndroidOpen {
  pending(): string;
  readChunk(id: string, index: number): string;
  done(id: string): void;
}

const bytesOf = (data: unknown): Uint8Array => (data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data as ArrayLike<number>));

/** The base64 pieces of a file, put back together. A piece that comes back empty is the end. */
export async function joinChunks(chunk: (index: number) => string | Promise<string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let index = 0; ; index++) {
    const text = await chunk(index);
    if (!text) break;
    parts.push(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  }
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The shell's list of incoming files, or null when this is not a phone app (or the shell has none to give). */
export function incomingBridge(): IncomingBridge | null {
  const g = globalThis as { GolemOpen?: AndroidOpen; __TAURI__?: { core?: TauriCore } };
  if (g.GolemOpen) {
    const android = g.GolemOpen;
    return {
      pending: async () => JSON.parse(android.pending()) as IncomingFile[],
      read: (id) => joinChunks((index) => android.readChunk(id, index)),
      done: async (id) => android.done(id),
    };
  }
  const core = g.__TAURI__?.core;
  if (core && typeof core.invoke === 'function' && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    return {
      pending: () => core.invoke<IncomingFile[]>('incoming_pending'),
      read: async (id) => bytesOf(await core.invoke<unknown>('incoming_read', { id })),
      done: (id) => core.invoke<void>('incoming_done', { id }),
    };
  }
  return null;
}

/** Takes every file waiting in the shell as `File`s (each file's copy in the shell is deleted once it is read). */
export async function takeIncoming(bridge: IncomingBridge): Promise<File[]> {
  const files: File[] = [];
  for (const item of await bridge.pending()) {
    try {
      files.push(new File([(await bridge.read(item.id)) as Uint8Array<ArrayBuffer>], item.name, { type: item.type }));
      await bridge.done(item.id);
    } catch {
      // Unreadable: it stays in the shell's list for the next look.
    }
  }
  return files;
}

/** Looks for incoming files now, when the app comes to the front, and when the shell says there are some; `open` gets each batch. Returns what stops it. */
export function watchIncoming(bridge: IncomingBridge, open: (files: File[]) => void): () => void {
  let looking = false;
  const look = async (): Promise<void> => {
    if (looking) return;
    looking = true;
    try {
      const files = await takeIncoming(bridge);
      if (files.length) open(files);
    } finally {
      looking = false;
    }
  };
  const onShown = (): void => {
    if (document.visibilityState === 'visible') void look();
  };
  addEventListener('golem-incoming', look);
  addEventListener('visibilitychange', onShown);
  void look();
  return () => {
    removeEventListener('golem-incoming', look);
    removeEventListener('visibilitychange', onShown);
  };
}
