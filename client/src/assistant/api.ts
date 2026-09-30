// The assistant's server calls (server/src/assistant.ts).

import { AssistantError, type Message, type Reply } from './conversation.ts';

export interface Status {
  /** The server has the assistant switched on. */
  available: boolean;
  subscribed: boolean;
  /** Percent of this month's credits left. */
  creditsLeft: number;
}

/** Whether the assistant is on, and what this account may do with it. Null if signed out or unreachable. */
export async function fetchStatus(): Promise<Status | null> {
  try {
    const response = await fetch('/api/assistant');
    return response.ok ? ((await response.json()) as Status) : null;
  } catch {
    return null;
  }
}

/** One model turn. Throws an AssistantError saying what went wrong; an aborted request rejects with AbortError. */
export async function askServer(messages: Message[], signal: AbortSignal): Promise<Reply> {
  let response: Response;
  try {
    response = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AssistantError('failed');
  }
  if (response.ok) return (await response.json()) as Reply;
  if (response.status === 401) throw new AssistantError('signin');
  if (response.status === 402) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    throw new AssistantError(body?.code === 'credits' ? 'credits' : 'subscription');
  }
  throw new AssistantError(response.status === 503 ? 'unavailable' : 'failed');
}
