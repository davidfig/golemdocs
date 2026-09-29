// Crawlers and checkers get the home page as plain readable HTML (`home-plain.html`, see client/seo.ts); everyone else gets
// the editor. The text is the same as the welcome document the editor opens with.

/** User agents that read pages without running the editor: search, Google's app and sign-in checks, link previews. */
const CRAWLER = /bot|crawl|spider|slurp|google|bing|duckduck|yandex|baidu|facebookexternalhit|twitter|linkedin|slack|whatsapp|telegram|discord|preview|headlesschrome|lighthouse/i;

export const isCrawler = (userAgent: string | null): boolean => !!userAgent && CRAWLER.test(userAgent);
