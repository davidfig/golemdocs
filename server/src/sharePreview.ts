// GET /view: the shared-document page (client/view/index.html), served through the Worker so that a public link's preview
// in a chat or a post (iMessage, Slack, social sites) names the document and shows its first page, rather than only
// "Golem Docs". Crawlers don't run the page's script, so the tags must be in the HTML itself.
//
// Only public links (`?p=` a document, `?pf=` a folder) are named: anyone may open them anyway. A share with one person
// (`?s=`, `?f=`) is opened signed in, which a crawler is not, so its page stays as it is. Anything that goes wrong
// leaves the page as it is too: a preview is never worth failing the page for.

import type { Env } from './cf.ts';
import { publicDocument } from './documents.ts';
import { folderPublicShare } from './folderShares.ts';
import { hasSync } from './subscriptions.ts';
import { existingUserDb } from './userDb.ts';

export interface Preview {
  title: string;
  description: string;
  /** The first page's picture, an absolute address. */
  image?: string;
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A file's name without its extension ("Summary.docx" → "Summary"); a name that is only an extension stays as it is. */
export const titleOf = (name: string): string => name.replace(/(.)\.[A-Za-z0-9]{1,8}$/, '$1');

/** The preview for a public link's page address, or null for any other page or a link that opens nothing. */
export async function previewFor(env: Env, url: URL): Promise<Preview | null> {
  const doc = url.searchParams.get('p');
  if (doc) {
    const found = await publicDocument(env, doc);
    if (!found || found.row.encrypted) return null;
    const { row } = found;
    const image = row.thumb_at == null ? undefined : `${url.origin}/api/public/${encodeURIComponent(doc)}/thumbnail?v=${row.thumb_at}`;
    return { title: titleOf(row.name), description: 'A document shared with Golem Docs', ...(image ? { image } : {}) };
  }
  const folder = url.searchParams.get('pf');
  if (folder) {
    const target = await folderPublicShare(env, folder);
    if (!target || !(await hasSync(env, target.ownerId))) return null;
    const db = await existingUserDb(env, target.ownerId);
    const row = db && (await db.first<{ name: string; encrypted: number | null }>('SELECT name, encrypted FROM folders WHERE id = ?', [target.folderId]));
    if (!row || row.encrypted) return null;
    // `&path=` names a file inside the folder: the preview names that file, in its folder.
    const file = url.searchParams.get('path')?.split('/').pop();
    return file ? { title: titleOf(file), description: `In the folder ${row.name}, shared with Golem Docs` } : { title: row.name, description: 'A folder shared with Golem Docs' };
  }
  return null;
}

/** The page's HTML with the preview's title and Open Graph tags in its head. */
export function withPreview(html: string, preview: Preview, pageUrl: string): string {
  const meta = (attribute: 'property' | 'name', key: string, value: string) => `<meta ${attribute}="${key}" content="${escape(value)}" />`;
  const tags = [
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', 'Golem Docs'),
    meta('property', 'og:title', preview.title),
    meta('property', 'og:description', preview.description),
    meta('property', 'og:url', pageUrl),
    meta('name', 'description', preview.description),
    // A first page is tall, so the small card (a square picture beside the text) suits it better than the wide one.
    meta('name', 'twitter:card', 'summary'),
    ...(preview.image ? [meta('property', 'og:image', preview.image), meta('property', 'og:image:alt', `The first page of ${preview.title}`)] : []),
  ];
  const titled = html.replace(/<title>[^<]*<\/title>/, `<title>${escape(preview.title)} - Golem Docs</title>`);
  return titled.replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
}

export async function sharePreview(request: Request, env: Env, url: URL): Promise<Response> {
  const page = await env.ASSETS!.fetch(request);
  if (request.method !== 'GET' || page.status !== 200 || !page.headers.get('content-type')?.includes('text/html')) return page;
  const preview = await previewFor(env, url).catch((error) => {
    console.error('link preview', error);
    return null;
  });
  if (!preview) return page;
  const headers = new Headers(page.headers);
  // The body is no longer the asset's: its length and etag would be wrong. A renamed document shows within a minute.
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('cache-control', 'public, max-age=60');
  return new Response(withPreview(await page.text(), preview, url.href), { status: 200, headers });
}
