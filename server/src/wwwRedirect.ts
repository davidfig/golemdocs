// The tiny Worker behind www.golemdocs.com (wrangler.www.jsonc): sends every request to the same path on golemdocs.com.

import type { ExportedHandler } from './cf.ts';

export const APEX = 'golemdocs.com';

/** Where a request for www goes: the same path and query on the bare domain, always over https. */
export function apexUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.protocol = 'https:';
  url.host = APEX;
  return url.href;
}

const handler: ExportedHandler = {
  fetch(request) {
    // 308 keeps the method and body, so a POST that reaches www is not turned into a GET.
    return new Response(null, { status: 308, headers: { location: apexUrl(request.url) } });
  },
};

export default handler;
