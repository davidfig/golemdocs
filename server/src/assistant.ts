// The assistant ("Clip"): a language model that edits the open document through tools the page
// runs. Subscribers only. Each user has a monthly budget of model spend; a request holds its
// worst case before the model runs and settles to the real cost after, so parallel requests can't
// overshoot the budget.
//
//   POST /api/assistant { messages }  ->  { message: { content, tool_calls? }, creditsLeft }
//   GET  /api/assistant               ->  { available, subscribed, creditsLeft }
//
// Every call is one model turn. When the model asks for tools, the page runs them and posts the
// results back with the conversation so far; the server keeps no conversation state.

import type { Env } from './cf.ts';
import { HttpError } from './http.ts';
import { MAX_OUTPUT_TOKENS, complete, costMicro, estimateTokens, type ChatMessage } from './model.ts';
import { SYSTEM_PROMPT, TOOLS } from './assistantTools.ts';
import { subscriptionFor } from './subscriptions.ts';

/** What one user may spend a month, in micro-dollars ($1.25). */
export const MONTHLY_BUDGET_MICRO = 1_250_000;

/** Limits on what the page may send. */
export const MAX_MESSAGES = 80;
export const MAX_CONVERSATION_CHARS = 60_000;

/** The month a spend belongs to. */
export const periodOf = (now = Date.now()): string => new Date(now).toISOString().slice(0, 7);

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Checks the conversation the page sent. Only the roles and shapes the model expects get through. */
export function parseMessages(body: unknown): ChatMessage[] {
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'expected { messages }');
  if (list.length > MAX_MESSAGES) throw new HttpError(413, 'the conversation is too long');
  const out: ChatMessage[] = [];
  let chars = 0;
  for (const raw of list) {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== 'object' || typeof m.content !== 'string') throw new HttpError(400, 'bad message');
    chars += m.content.length;
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') throw new HttpError(400, 'bad message');
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else if (m.role === 'assistant') {
      const calls = m.tool_calls;
      if (calls === undefined) out.push({ role: 'assistant', content: m.content });
      else {
        if (!Array.isArray(calls)) throw new HttpError(400, 'bad message');
        const tool_calls = calls.map((c: Record<string, unknown>) => {
          if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string' || !TOOL_NAMES.has(c.name)) throw new HttpError(400, 'bad tool call');
          chars += c.arguments.length;
          return { id: c.id, name: c.name, arguments: c.arguments };
        });
        out.push({ role: 'assistant', content: m.content, tool_calls });
      }
    } else throw new HttpError(400, 'bad message');
  }
  if (out[out.length - 1]!.role === 'assistant') throw new HttpError(400, 'the last message must be from the user or a tool');
  if (chars > MAX_CONVERSATION_CHARS) throw new HttpError(413, 'the conversation is too long');
  return out;
}

async function spentThisMonth(env: Env, userId: string, period: string): Promise<number> {
  const row = await env.DIRECTORY.prepare('SELECT spent_micro FROM assistant_usage WHERE user_id = ? AND period = ?')
    .bind(userId, period)
    .first<{ spent_micro: number }>();
  return row?.spent_micro ?? 0;
}

const creditsLeft = (spent: number): number => Math.max(0, Math.round((1 - spent / MONTHLY_BUDGET_MICRO) * 100));

/** Holds `hold` of the user's budget for a running request; false if there isn't that much left. */
async function reserve(env: Env, userId: string, period: string, hold: number): Promise<boolean> {
  await env.DIRECTORY.prepare('INSERT OR IGNORE INTO assistant_usage (user_id, period) VALUES (?, ?)').bind(userId, period).run();
  const result = await env.DIRECTORY.prepare(
    'UPDATE assistant_usage SET reserved_micro = reserved_micro + ? WHERE user_id = ? AND period = ? AND spent_micro + reserved_micro + ? <= ?',
  )
    .bind(hold, userId, period, hold, MONTHLY_BUDGET_MICRO)
    .run();
  return result.meta.changes === 1;
}

/** Ends a hold, charging what the request really cost (nothing, if it failed). */
async function settle(env: Env, userId: string, period: string, hold: number, cost: number): Promise<void> {
  await env.DIRECTORY.prepare('UPDATE assistant_usage SET reserved_micro = MAX(reserved_micro - ?, 0), spent_micro = spent_micro + ? WHERE user_id = ? AND period = ?')
    .bind(hold, cost, userId, period)
    .run();
}

export async function assistantStatus(env: Env, userId: string): Promise<{ available: boolean; subscribed: boolean; creditsLeft: number }> {
  const subscribed = !!(await subscriptionFor(env, userId))?.active;
  return { available: !!env.AI, subscribed, creditsLeft: creditsLeft(await spentThisMonth(env, userId, periodOf())) };
}

/** POST /api/assistant. `respond` shapes JSON replies. */
export async function handleAssistant(request: Request, env: Env, userId: string, respond: (data: unknown, status?: number) => Response): Promise<Response> {
  if (!env.AI) throw new HttpError(503, 'the assistant is not configured');
  if (!(await subscriptionFor(env, userId))?.active) return respond({ error: 'the assistant is for subscribers', code: 'subscription' }, 402);
  const messages = parseMessages(await request.json().catch(() => null));

  // Worst case: every character of the conversation and the prompt is input, and the model writes as much as it may.
  const promptChars = SYSTEM_PROMPT.length + JSON.stringify(TOOLS).length + messages.reduce((n, m) => n + m.content.length + ('tool_calls' in m ? JSON.stringify(m.tool_calls).length : 0), 0);
  const hold = costMicro(estimateTokens(promptChars), MAX_OUTPUT_TOKENS);
  const period = periodOf();
  if (!(await reserve(env, userId, period, hold))) return respond({ error: 'out of assistant credits for this month', code: 'credits', creditsLeft: 0 }, 402);

  let cost = 0;
  try {
    const completion = await complete(env.AI, SYSTEM_PROMPT, messages, TOOLS);
    // If the model doesn't report usage, charge the worst case rather than nothing.
    cost = completion.usage ? costMicro(completion.usage.input, completion.usage.output) : hold;
    return respond({
      message: { role: 'assistant', content: completion.content, ...(completion.toolCalls.length && { tool_calls: completion.toolCalls }) },
      creditsLeft: creditsLeft((await spentThisMonth(env, userId, period)) + cost),
    });
  } catch (e) {
    console.error('assistant model error', e);
    throw new HttpError(502, 'the assistant could not answer');
  } finally {
    await settle(env, userId, period, hold, cost);
  }
}
