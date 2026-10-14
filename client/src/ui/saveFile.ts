// Giving a file to the person: a download on a computer, the system share sheet (Save to Files, AirDrop, Mail, Open in...) on a phone or tablet.
// A phone's web view has no download list to show a link's download in, so there the sheet is the way out. On iOS the page
// asks for it (navigator.share); Android's web view has no such call, so the app's shell lends the page one (`GolemShare`,
// desktop/src-tauri/gen/android/.../ShareBridge.kt) that takes the file in chunks.

import { isTouchDevice } from '../desktop/bridge.ts';

type ShareNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** True when the file should go through the share sheet: a touch device whose browser can share this file. */
export function shouldShare(file: File, nav: ShareNavigator = navigator): boolean {
  return isTouchDevice(nav) && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

/** The calls the Android shell adds to the page (ShareBridge.kt). */
interface AndroidShare {
  begin(name: string, type: string): void;
  chunk(base64: string): void;
  finish(): void;
  cancel(): void;
}

const androidShare = (): AndroidShare | null => (globalThis as { GolemShare?: AndroidShare }).GolemShare ?? null;

/** About 768 KiB of a file at a time (a multiple of 3, so every chunk but the last is whole base64). */
const CHUNK_BYTES = 786_432;
/** String.fromCharCode takes its arguments on the stack, so it is fed this many at a time. */
const CHAR_BATCH = 8192;

/** The bytes as base64 text, `size` bytes at a time. */
export function* base64Chunks(bytes: Uint8Array, size = CHUNK_BYTES): Generator<string> {
  for (let at = 0; at < bytes.length; at += size) {
    const part = bytes.subarray(at, at + size);
    let binary = '';
    for (let i = 0; i < part.length; i += CHAR_BATCH) binary += String.fromCharCode(...part.subarray(i, i + CHAR_BATCH));
    yield btoa(binary);
  }
}

/** Hands the file over. Resolves false when the person closed the share sheet without choosing anything. */
export async function saveFile(name: string, bytes: Uint8Array, type: string): Promise<boolean> {
  const android = androidShare();
  if (android) {
    try {
      android.begin(name, type);
      for (const chunk of base64Chunks(bytes)) android.chunk(chunk);
      android.finish();
      return true;
    } catch (e) {
      android.cancel();
      throw e;
    }
  }
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
  if (shouldShare(file)) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // Not allowed (the sheet needs a tap just before it, and the export took longer) or another failure: fall through to a download.
    }
  }
  const url = URL.createObjectURL(file);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
