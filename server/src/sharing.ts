// Who may open a document. The owner always may; anyone else needs a row in `shares`. This is the
// one place that decides, for both the document API and the collaboration rooms.

import { pictureOf } from './accounts.ts';
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

export async function shareWith(env: Env, docId: string, granteeId: string, role: ShareRole): Promise<void> {
  await env.DIRECTORY.prepare(
    'INSERT INTO shares (doc_id, grantee_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id, grantee_id) DO UPDATE SET role = excluded.role',
  )
    .bind(docId, granteeId, role, Date.now())
    .run();
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
