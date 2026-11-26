// The key a page's `golem` read is kept under in its results (docs/html-pages.md §5): the app keeps answers by it, and the site's
// viewer answers a shared page's reads by it. On its own, so the viewer takes nothing else of page view's app side.

export const answerKey = (op: string, args: readonly unknown[]): string => `${op}:${JSON.stringify(args)}`;
