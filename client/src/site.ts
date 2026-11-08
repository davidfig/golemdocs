// What this server says about itself (GET /api/site, server/src/site.ts): where its links go and
// whether it sells the sync subscription. golemdocs.com sets no links, so the defaults below are
// golemdocs.com's; a self-hosted server (docs/self-hosting.md) points them at its own pages.
// The answer is remembered here, so that the next visit (or one offline) starts with it.

export interface SiteLinks {
  /** The website (Help › Website, and the welcome document's link to it). */
  website?: string;
  /** The pricing page the welcome document links to. */
  pricing?: string;
  /** Where to write for help: a `mailto:` address or a web page. */
  support?: string;
  /** The privacy policy and the terms of service, instead of the built-in documents. */
  privacy?: string;
  terms?: string;
}

export interface Site {
  links: SiteLinks;
  /** Whether this server sells the sync subscription (File › Subscribe…). */
  sells: boolean;
}

/** golemdocs.com's own: no links of its own, and it sells the subscription. */
export const DEFAULT_SITE: Site = { links: {}, sells: true };

const KEY = 'golem.site';
const LINK_KEYS: (keyof SiteLinks)[] = ['website', 'pricing', 'support', 'privacy', 'terms'];

/** Only what a server could have sent: http(s) or mailto links, and a boolean. Anything else is the default. */
export function parseSite(value: unknown): Site {
  if (!value || typeof value !== 'object') return DEFAULT_SITE;
  const { links, sells } = value as { links?: unknown; sells?: unknown };
  const parsed: SiteLinks = {};
  if (links && typeof links === 'object') {
    for (const key of LINK_KEYS) {
      const link = (links as Record<string, unknown>)[key];
      if (typeof link === 'string' && /^(https?:\/\/|mailto:)/i.test(link)) parsed[key] = link;
    }
  }
  return { links: parsed, sells: typeof sells === 'boolean' ? sells : true };
}

function stored(): Site {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSite(JSON.parse(raw)) : DEFAULT_SITE;
  } catch {
    return DEFAULT_SITE;
  }
}

let current: Site | null = null;

/** This server's links and selling, as last heard (golemdocs.com's until `loadSite` hears otherwise). */
export function site(): Site {
  current ??= stored();
  return current;
}

/** golemdocs.com's own address: it sets no links, so nothing there waits to hear them. */
const GOLEMDOCS_HOST = 'golemdocs.com';

/**
 * Whether opening something with this server's links must first wait to hear them: only on another
 * server (a self-hosted one) that hasn't answered on an earlier visit. Elsewhere, what `site` says now is right.
 */
export function siteUnknown(hostname = location.hostname): boolean {
  if (hostname === GOLEMDOCS_HOST) return false;
  try {
    return localStorage.getItem(KEY) === null;
  } catch {
    return true;
  }
}

/**
 * Asks the server, once per page. Without one (the editor on its own, offline), keeps what was
 * remembered. Resolves with the site either way.
 */
let loading: Promise<Site> | null = null;
export function loadSite(): Promise<Site> {
  loading ??= (async () => {
    try {
      const response = await fetch('/api/site');
      if (!response.ok) return site();
      current = parseSite(await response.json());
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        // storage blocked: asked again next visit
      }
    } catch {
      // no server: what was remembered
    }
    return site();
  })();
  return loading;
}

/** The address a link goes to: this server's, else golemdocs.com's. */
export const siteLink = (key: keyof SiteLinks, fallback: string): string => site().links[key] ?? fallback;

/**
 * A built-in Markdown document (the welcome text) with golemdocs.com's links replaced by this
 * server's: the targets of the website and pricing links (their words stay), and the support
 * address, shown as well as linked.
 */
export function withSiteLinks(markdown: string, links: SiteLinks): string {
  let text = markdown;
  // The pricing link first: it starts with the website's address.
  if (links.pricing) text = text.replace(/\(https:\/\/golemdocs\.com\/home\/#pricing\)/g, () => `(${links.pricing})`);
  if (links.website) text = text.replace(/\(https:\/\/golemdocs\.com\/home\/?\)/g, () => `(${links.website})`);
  if (links.support) {
    const shown = links.support.replace(/^mailto:/i, '').replace(/[[\]\\]/g, '\\$&');
    text = text.replace(/\[david@golemdocs\.com\]\(mailto:david@golemdocs\.com\)/g, () => `[${shown}](${links.support})`);
  }
  return text;
}
