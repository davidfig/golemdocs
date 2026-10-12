// The clipboard, for every editor: what is on it now, putting text on it, and what a copy or paste event carries.

export interface Clipboard {
  html?: string;
  text?: string;
}

/** What is on the clipboard now, or null if the browser won't let the page look. */
export async function readClipboard(): Promise<Clipboard | null> {
  try {
    if (navigator.clipboard.read) {
      const clip: Clipboard = {};
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) clip.html ??= await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) clip.text ??= await (await item.getType('text/plain')).text();
      }
      return clip;
    }
    return { text: await navigator.clipboard.readText() };
  } catch {
    return null;
  }
}

/** Puts text on the clipboard. */
export function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** Puts text on the clipboard with its formatted (HTML) form, which other apps paste with bold, italics and the rest; plain text alone if `html` is missing. */
export function writeClipboardRich(text: string, html?: string): Promise<void> {
  if (!html || typeof ClipboardItem === 'undefined') return writeClipboardText(text);
  const blob = (data: string, type: string) => new Blob([data], { type });
  return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob(text, 'text/plain'), 'text/html': blob(html, 'text/html') })]);
}

/** What a paste event carries. */
export function clipboardOf(e: ClipboardEvent): Clipboard {
  return { html: e.clipboardData?.getData('text/html') || undefined, text: e.clipboardData?.getData('text/plain') || undefined };
}
