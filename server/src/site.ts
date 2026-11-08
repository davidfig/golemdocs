// GET /api/site: what the page needs to know about this server before anyone signs in: where its
// links go and whether it sells the subscription. golemdocs.com sets none of the links (the page's
// own defaults are golemdocs.com's); a self-hosted server sets the ones it wants to point elsewhere.
// See docs/self-hosting.md.

import type { Env } from './cf.ts';
import { json } from './http.ts';

export interface SiteLinks {
  /** The website (Help › Website, and the welcome document's link to it). */
  website?: string;
  /** The pricing page the welcome document links to. */
  pricing?: string;
  /** Where to write for help: a `mailto:` address or a web page. */
  support?: string;
  /** The privacy policy and the terms of service, instead of the built-in ones (Help menu). */
  privacy?: string;
  terms?: string;
}

export interface SiteInfo {
  links: SiteLinks;
  /** Whether this server sells the sync subscription (File › Subscribe…). */
  sells: boolean;
}

/** An http(s) or mailto address, or null; a bare email address becomes a `mailto:` one. */
export function linkValue(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text)) return `mailto:${text}`;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

export function siteInfo(env: Env): SiteInfo {
  const links: SiteLinks = {};
  const set = (key: keyof SiteLinks, value: string | undefined) => {
    const link = linkValue(value);
    if (link) links[key] = link;
  };
  set('website', env.LINK_WEBSITE);
  set('pricing', env.LINK_PRICING);
  set('support', env.LINK_SUPPORT);
  set('privacy', env.LINK_PRIVACY);
  set('terms', env.LINK_TERMS);
  // A server with no Polar product sells nothing (a self-hosted one); development shows the menu items regardless.
  const sells = env.ENVIRONMENT !== 'production' || (!!env.POLAR_ACCESS_TOKEN && !!env.POLAR_PRODUCT_ID);
  return { links, sells };
}

export function handleSite(env: Env): Response {
  return json(siteInfo(env), 200, { 'cache-control': 'public, max-age=300' });
}
