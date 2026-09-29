// Feedback from Help > Send Feedback: anyone signed in may send it, admins read it.

import type { Env } from './cf.ts';

export const MAX_FEEDBACK_CHARS = 5000;

export interface FeedbackEntry {
  id: number;
  message: string;
  createdAt: number;
  /** When an admin resolved it; null while it is open. */
  resolvedAt: number | null;
  /** Who sent it (null if their identity is gone). */
  from: { name: string | null; email: string | null } | null;
}

export async function addFeedback(env: Env, userId: string, message: string): Promise<void> {
  await env.DIRECTORY.prepare('INSERT INTO feedback (user_id, message, created_at) VALUES (?, ?, ?)').bind(userId, message, Date.now()).run();
}

/** Every piece of feedback, newest first. */
export async function allFeedback(env: Env): Promise<FeedbackEntry[]> {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT f.id, f.message, f.created_at, f.resolved_at,
            (SELECT email FROM identities WHERE user_id = f.user_id ORDER BY last_login_at DESC LIMIT 1) AS email,
            (SELECT name FROM identities WHERE user_id = f.user_id ORDER BY last_login_at DESC LIMIT 1) AS name,
            EXISTS (SELECT 1 FROM identities WHERE user_id = f.user_id) AS known
       FROM feedback f ORDER BY f.created_at DESC, f.id DESC`,
  ).all<{ id: number; message: string; created_at: number; resolved_at: number | null; email: string | null; name: string | null; known: number }>();
  return results.map((r) => ({ id: r.id, message: r.message, createdAt: r.created_at, resolvedAt: r.resolved_at, from: r.known ? { name: r.name, email: r.email } : null }));
}

/** Marks feedback resolved (or open again). False if there is no such feedback. */
export async function resolveFeedback(env: Env, id: number, resolved: boolean): Promise<boolean> {
  const row = await env.DIRECTORY.prepare('SELECT id FROM feedback WHERE id = ?').bind(id).first();
  if (!row) return false;
  await env.DIRECTORY.prepare('UPDATE feedback SET resolved_at = ? WHERE id = ?').bind(resolved ? Date.now() : null, id).run();
  return true;
}

/** Deletes feedback. False if there is no such feedback. */
export async function deleteFeedback(env: Env, id: number): Promise<boolean> {
  const row = await env.DIRECTORY.prepare('SELECT id FROM feedback WHERE id = ?').bind(id).first();
  if (!row) return false;
  await env.DIRECTORY.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
  return true;
}
