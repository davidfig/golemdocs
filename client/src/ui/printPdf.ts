// Printing a document that has been made into a PDF: the app's File › Print and Print Preview (main.ts), and the Print button of the
// site's shared pages (viewer/page.ts). Each place makes the PDF its own way and says what happened in its own words.
//
// A phone or tablet can't print a PDF from a page: iOS prints only the first page of a PDF in a frame, Android shows none, and an app's
// web view has no tabs. There the PDF goes to the system share sheet, whose Print has every page (`saveFile`). The Mac app's web view
// ignores print() and opens no tabs, so it opens the PDF in Preview. Anywhere else it is printed from a hidden frame, or, for a
// preview, opened in a new tab.

import { isTouchDevice, macPrinter, ShellTooOldError } from '../desktop/bridge.ts';
import { FORMATS } from './formats.ts';
import { saveFile } from './saveFile.ts';

/**
 * What became of it: handed to the share sheet (`shared`), opened in Preview on a Mac (`preview`), saved because the Mac app is too
 * old to print (`saved`, or `cancelled` if the person didn't save it), opened in a tab (`opened`), refused a tab by the browser
 * (`blocked`), or sent to the browser's print dialog (`printing`).
 */
export type PrintOutcome = 'shared' | 'preview' | 'saved' | 'cancelled' | 'opened' | 'blocked' | 'printing';

/** Prints `bytes`, a PDF named `name`, or with `preview` opens it to look at first. Rejects if the Mac app can't open it. */
export async function printPdf(name: string, bytes: Uint8Array, preview = false): Promise<PrintOutcome> {
  if (isTouchDevice()) {
    await saveFile(name, bytes, FORMATS.pdf.mime);
    return 'shared';
  }
  // A shell without the command can still download.
  const printer = macPrinter();
  if (printer) {
    try {
      await printer.open(name, bytes);
      return 'preview';
    } catch (e) {
      if (!(e instanceof ShellTooOldError)) throw e;
      return (await saveFile(name, bytes, FORMATS.pdf.mime)) ? 'saved' : 'cancelled';
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMATS.pdf.mime }));
  if (preview) {
    const opened = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return opened ? 'opened' : 'blocked';
  }
  const frame = Object.assign(document.createElement('iframe'), { src: url });
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  frame.addEventListener('load', () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  });
  document.body.append(frame);
  return 'printing';
}
