// Who may open a document. The owner always may; anyone else needs a row in `shares`. This is the
// one place that decides, for both the document API and the collaboration rooms.

import { pictureOf } from './accounts.ts';
import { randomToken } from './crypto.ts';
import type { Env } from './cf.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = 'editor' | 'viewer';

export interface Access {
  role: Role;
  ownerId: string;
}

export const canWrite = (role: Role): boolean => role === 'owner' || role === 'editor';

/** The user's access to a document, or null (also for documents that don't exist). */
export async function accessFor(env: Env, userId: string, docId: string): Promise<Access | null> {
  const owner = await env.DIRECTORY.prepare('SELECT owner_id FROM document_owners WHERE doc_id = ?').bind(docId).first<{ owner_id: string }>();
  if (!owner) return null;
  if (owner.owner_id === userId) return { role: 'owner', ownerId: userId };
  const share = await env.DIRECTORY.prepare('SELECT role FROM shares WHERE doc_id = ? AND grantee_id = ?')
    .bind(docId, userId)
    .first<{ role: ShareRole }>();
  return share ? { role: share.role, ownerId: owner.owner_id } : null;
}

/** Records who owns a document. Idempotent, so it also backfills documents from before sharing. */
export async function registerOwner(env: Env, docId: string, ownerId: string): Promise<void> {
  await env.DIRECTORY.prepare('INSERT INTO document_owners (doc_id, owner_id, created_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO NOTHING')
    .bind(docId, ownerId, Date.now())
    .run();
}

/** D1 runs a batch of statements in one round trip; this many to a batch keeps each one small. */
const DIRECTORY_BATCH = 50;

/** `registerOwner` for many documents, a batch at a time instead of a query each (a directory flooded with queries refuses them as overloaded). */
export async function registerOwners(env: Env, docIds: readonly string[], ownerId: string): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < docIds.length; i += DIRECTORY_BATCH) {
    await env.DIRECTORY.batch(
      docIds.slice(i, i + DIRECTORY_BATCH).map((id) => env.DIRECTORY.prepare('INSERT INTO document_owners (doc_id, owner_id, created_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO NOTHING').bind(id, ownerId, now)),
    );
  }
}

/** Forgets deleted documents' owners and everything shared from them, a batch at a time. */
export async function forgetDocuments(env: Env, docIds: readonly string[]): Promise<void> {
  for (let i = 0; i < docIds.length; i += DIRECTORY_BATCH) {
    await env.DIRECTORY.batch(
      docIds.slice(i, i + DIRECTORY_BATCH).flatMap((id) => [
        env.DIRECTORY.prepare('DELETE FROM shares WHERE doc_id = ?').bind(id),
        env.DIRECTORY.prepare('DELETE FROM public_links WHERE doc_id = ?').bind(id),
        env.DIRECTORY.prepare('DELETE FROM document_owners WHERE doc_id = ?').bind(id),
      ]),
    );
  }
}

export interface Person {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

/** A user's display name, email and picture, from their most recent sign-in. */
export async function person(env: Env, userId: string): Promise<Person> {
  const row = await env.DIRECTORY.prepare('SELECT name, email FROM identities WHERE user_id = ? ORDER BY last_login_at DESC LIMIT 1')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  return { userId, name: row?.name ?? null, email: row?.email ?? null, picture: await pictureOf(env, userId) };
}

/** The user who signed in with this verified email, if there is one. */
export async function userByEmail(env: Env, email: string): Promise<string | null> {
  const row = await env.DIRECTORY.prepare('SELECT user_id FROM identities WHERE email = ? AND email_verified = 1 ORDER BY last_login_at DESC LIMIT 1')
    .bind(email.trim().toLowerCase())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** A new view-only share's address for the viewer (`shares.view_token`): 24 random bytes, base64url, from nothing else. */
const newViewToken = (): string => randomToken(24);

/**
 * Shares a document, or changes the role. A view-only share gets a viewer address of its own (`view_token`), kept while it stays
 * view-only; becoming an editor drops it, and becoming a viewer again makes a new one.
 */
export async function shareWith(env: Env, docId: string, granteeId: string, role: ShareRole): Promise<void> {
  await env.DIRECTORY.prepare(
    `INSERT INTO shares (doc_id, grantee_id, role, created_at, view_token) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, grantee_id) DO UPDATE SET
       view_token = CASE WHEN excluded.role <> 'viewer' THEN NULL WHEN shares.role = 'viewer' AND shares.view_token IS NOT NULL THEN shares.view_token ELSE excluded.view_token END,
       role = excluded.role`,
  )
    .bind(docId, granteeId, role, Date.now(), role === 'viewer' ? newViewToken() : null)
    .run();
}

/** A view-only share's viewer address, made now for a share from before there were any. Null for an editor's share or none. */
export async function viewTokenFor(env: Env, docId: string, granteeId: string): Promise<string | null> {
  await env.DIRECTORY.prepare("UPDATE shares SET view_token = ? WHERE doc_id = ? AND grantee_id = ? AND role = 'viewer' AND view_token IS NULL")
    .bind(newViewToken(), docId, granteeId)
    .run();
  const row = await env.DIRECTORY.prepare("SELECT view_token FROM shares WHERE doc_id = ? AND grantee_id = ? AND role = 'viewer'").bind(docId, granteeId).first<{ view_token: string | null }>();
  return row?.view_token ?? null;
}

/**
 * The document a viewer address opens, for the person it was shared with and nobody else: null for an unknown or dropped token and
 * for one that is someone else's (both answered 404, so a token says nothing about whether it ever existed).
 */
export async function viewShare(env: Env, token: string, userId: string): Promise<{ docId: string; ownerId: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await env.DIRECTORY.prepare(
    "SELECT s.doc_id, s.grantee_id, o.owner_id FROM shares s JOIN document_owners o ON o.doc_id = s.doc_id WHERE s.view_token = ? AND s.role = 'viewer'",
  )
    .bind(token)
    .first<{ doc_id: string; grantee_id: string; owner_id: string }>();
  return row && row.grantee_id === userId ? { docId: row.doc_id, ownerId: row.owner_id } : null;
}

/** A document's public link (`public_links.token`), or null while it has none. */
export async function publicLinkOf(env: Env, docId: string): Promise<string | null> {
  const row = await env.DIRECTORY.prepare('SELECT token FROM public_links WHERE doc_id = ?').bind(docId).first<{ token: string }>();
  return row?.token ?? null;
}

/** Gives a document a public link, keeping the one it has unless `reset`, which replaces it so copies of the old one stop working. */
export async function makePublicLink(env: Env, docId: string, reset: boolean): Promise<string> {
  await env.DIRECTORY.prepare(
    `INSERT INTO public_links (doc_id, token, created_at) VALUES (?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET token = CASE WHEN ? THEN excluded.token ELSE public_links.token END, created_at = CASE WHEN ? THEN excluded.created_at ELSE public_links.created_at END`,
  )
    .bind(docId, newViewToken(), Date.now(), reset ? 1 : 0, reset ? 1 : 0)
    .run();
  return (await publicLinkOf(env, docId))!;
}

/** Turns a document's public link off: the address answers 404 from now on. */
export async function dropPublicLink(env: Env, docId: string): Promise<void> {
  await env.DIRECTORY.prepare('DELETE FROM public_links WHERE doc_id = ?').bind(docId).run();
}

/** The document a public link opens, for anyone: null for an unknown or dropped token. */
export async function publicShare(env: Env, token: string): Promise<{ docId: string; ownerId: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await env.DIRECTORY.prepare('SELECT p.doc_id, o.owner_id FROM public_links p JOIN document_owners o ON o.doc_id = p.doc_id WHERE p.token = ?')
    .bind(token)
    .first<{ doc_id: string; owner_id: string }>();
  return row ? { docId: row.doc_id, ownerId: row.owner_id } : null;
}

export async function unshare(env: Env, docId: string, granteeId: string): Promise<void> {
  await env.DIRECTORY.prepare('DELETE FROM shares WHERE doc_id = ? AND grantee_id = ?').bind(docId, granteeId).run();
}

export async function sharesOf(env: Env, docId: string): Promise<(Person & { role: ShareRole })[]> {
  const rows = (await env.DIRECTORY.prepare('SELECT grantee_id, role FROM shares WHERE doc_id = ? ORDER BY created_at').bind(docId).all<{ grantee_id: string; role: ShareRole }>()).results;
  return Promise.all(rows.map(async (r) => ({ ...(await person(env, r.grantee_id)), role: r.role })));
}

/** Documents shared with the user: [doc id, owner id, role]. */
export async function sharedWith(env: Env, userId: string): Promise<{ docId: string; ownerId: string; role: ShareRole }[]> {
  const rows = (
    await env.DIRECTORY.prepare(
      'SELECT s.doc_id, o.owner_id, s.role FROM shares s JOIN document_owners o ON o.doc_id = s.doc_id WHERE s.grantee_id = ? ORDER BY s.created_at DESC',
    )
      .bind(userId)
      .all<{ doc_id: string; owner_id: string; role: ShareRole }>()
  ).results;
  return rows.map((r) => ({ docId: r.doc_id, ownerId: r.owner_id, role: r.role }));
}
