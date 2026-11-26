// Whether an HTML file is a page (docs/html-pages.md §2). On its own, small and always loaded: main.ts decides how an HTML file opens
// with it before page view's chunk (entry.ts) is fetched.

/**
 * How an HTML file opens, from how it was last shown on this device. A page opens as a page unless Source was chosen last: Document,
 * which shows nothing of it working, is offered from the View menu only and never sticks to a page (an earlier app remembered it).
 * A file that is no page opens as it was last shown, else as a document.
 */
export function openingView(html: string, remembered: 'page' | 'document' | 'source' | null): 'page' | 'document' | 'source' {
  if (isPageHtml(html)) return remembered === 'source' ? 'source' : 'page';
  return remembered ?? 'document';
}

/** An HTML file that is a page rather than a document: it has a script, an embed, or a `golem-*` meta. */
export function isPageHtml(html: string): boolean {
  return /<script\b/i.test(html) || /<golem-embed\b/i.test(html) || /<meta\b[^>]*\bname\s*=\s*["']?golem-/i.test(html);
}
