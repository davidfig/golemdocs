// Giving a file to the person: a download on a computer, the system share sheet (Save to Files, AirDrop, Mail, Open in...) on a phone or tablet.
// A phone's web view has no download list to show a link's download in, so there the sheet is the way out.

import { isTouchDevice } from '../desktop/bridge.ts';

type ShareNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** True when the file should go through the share sheet: a touch device whose browser can share this file. */
export function shouldShare(file: File, nav: ShareNavigator = navigator): boolean {
  return isTouchDevice(nav) && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

/** Hands the file over. Resolves false when the person closed the share sheet without choosing anything. */
export async function saveFile(name: string, bytes: Uint8Array, type: string): Promise<boolean> {
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
