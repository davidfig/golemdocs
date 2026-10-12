// The desktop app's installers, served to anyone (no sign-in): the repository is private, so a GitHub release
// can't be linked from the website. They live in the files bucket under `downloads/desktop/`, put there by
// `pnpm publish:desktop` (scripts/publish-desktop.ts), which writes `latest.json` last so a visitor never sees a
// version whose files are not all there yet.
//
//   GET /api/downloads            the latest release: { version, date, files: [{ name, platform, size }] }
//   GET /api/downloads/<file>     one installer, as an attachment

import type { Env } from './cf.ts';
import { HttpError } from './http.ts';

export const DOWNLOAD_PREFIX = 'downloads/desktop/';
export const MANIFEST_KEY = `${DOWNLOAD_PREFIX}latest.json`;

/** Names the build produces: letters, digits and `._+-` only, so a name can never climb out of the prefix. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$/;

const TYPES: Record<string, string> = {
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  appimage: 'application/octet-stream',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
};

export type Platform = 'mac' | 'windows' | 'linux';

export interface DesktopRelease {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  files: { name: string; platform: Platform; size: number }[];
}

/** Which platform an installer is for, or null for the other files a build leaves beside them (updater archives, signatures). */
export function installerPlatform(name: string): Platform | null {
  if (/\.sig$|\.tar\.gz$|\.zip$/i.test(name)) return null;
  if (/\.dmg$/i.test(name)) return 'mac';
  if (/\.(exe|msi)$/i.test(name)) return 'windows';
  if (/\.(appimage|deb|rpm)$/i.test(name)) return 'linux';
  return null;
}

export function handleDownloads(request: Request, env: Env, path: string): Promise<Response> | Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
  if (path === '/api/downloads') return manifest(env);
  let name: string;
  try {
    name = decodeURIComponent(path.slice('/api/downloads/'.length));
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!FILE.test(name) || name === 'latest.json') throw new HttpError(404, 'not found');
  return installer(env, name, request.method === 'HEAD');
}

async function manifest(env: Env): Promise<Response> {
  const object = await env.FILES.get(MANIFEST_KEY);
  if (!object) throw new HttpError(404, 'no release has been published yet');
  // Short, so a new release shows soon; the installers themselves never change under a name.
  return new Response(object.body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
}

async function installer(env: Env, name: string, headOnly: boolean): Promise<Response> {
  const key = DOWNLOAD_PREFIX + name;
  const object = await env.FILES.get(key);
  if (!object) throw new HttpError(404, 'not found');
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return new Response(headOnly ? null : object.body, {
    headers: {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  });
}

