// Whether an HTML file is a page (docs/html-pages.md §2). On its own, small and always loaded: main.ts decides how an HTML file opens
// with it before page view's chunk (entry.ts) is fetched.

/** An HTML file that is a page rather than a document: it has a script, an embed, or a `golem-*` meta. */
export function isPageHtml(html: string): boolean {
  return /<script\b/i.test(html) || /<golem-embed\b/i.test(html) || /<meta\b[^>]*\bname\s*=\s*["']?golem-/i.test(html);
}
