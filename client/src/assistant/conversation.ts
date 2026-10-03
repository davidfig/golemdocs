// A conversation with Clip, the assistant: the messages so far and the loop that answers one
// request. Each turn asks the server's model (one step at a time); when the model asks for tools,
// they run on the open document and their results go back, until it answers in words.
//
// No DOM and no network here (both are passed in), so this is what the tests exercise.

import { expandTool } from './toolGroups.ts';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON, as the model wrote it. */
  arguments: string;
}

export type Message =
  | { role: 'user'; content: string; /** Pictures as `data:image/...;base64,` URIs. */ images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** One answer from the server: the model's message, and the share of this month's credits left (0 to 100). */
export interface Reply {
  message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] };
  creditsLeft: number;
}

/** Why asking failed, in terms of what the person can do about it. */
export type FailureKind = 'signin' | 'subscription' | 'credits' | 'unavailable' | 'failed';

export class AssistantError extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind);
  }
}

/** What a tool answers: text, and any pictures it fetched for the model to look at. */
export type ToolResult = string | { text: string; images?: string[] };

/** What the person asks: their words, and the pictures they attached. */
export type Request = string | { text: string; images?: string[] };

export interface Deps {
  ask(messages: Message[], signal: AbortSignal): Promise<Reply>;
  /** Runs a tool on the open document; answers with what it did or found. */
  tool(name: string, args: string): Promise<ToolResult>;
}

export interface Progress {
  /** A tool is about to run. */
  tool?(name: string): void;
  creditsLeft?(percent: number): void;
}

export interface Outcome {
  /** The whole conversation, including this turn's tool traffic, to send with the next request. */
  messages: Message[];
  /** What the model said last. */
  answer: string;
  /** It stopped because it used all its steps, not because it was done. */
  stopped: boolean;
}

/** The most model turns one request may take. Each one costs money, and a stuck model would run all of them. */
export const MAX_STEPS = 10;
/** The server refuses conversations over 60,000 characters; stay well under. */
export const MAX_HISTORY_CHARS = 45_000;
const MAX_TOOL_RESULT_CHARS = 9_000;
/** The server's limits on pictures (server/src/assistant.ts): per message, and in the whole conversation. */
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGES = 6;
const FETCHED_PICTURES = 'The picture you asked to see is attached.';
const OMITTED_PICTURE = ' (a picture was attached here; it is no longer shown)';

/** The conversation without its pictures: they cost money on every turn, so they are shown once, with the request they belong to. */
export function withoutImages(messages: Message[]): Message[] {
  return messages.map((m) => (m.role === 'user' && m.images ? { role: 'user', content: m.content + OMITTED_PICTURE } : m));
}

const size = (m: Message): number => m.content.length + ('tool_calls' in m && m.tool_calls ? m.tool_calls.reduce((n, c) => n + c.arguments.length + c.name.length, 0) : 0);

/**
 * The most recent part of a conversation that fits, starting at one of the person's messages (a
 * tool result must follow the call that asked for it, so the history can't start in the middle of one).
 * The latest request and everything after it (this turn's tool traffic) are always kept.
 */
export function trimHistory(messages: Message[], limit = MAX_HISTORY_CHARS): Message[] {
  let total = messages.reduce((n, m) => n + size(m), 0);
  let lastUser = messages.length - 1;
  while (lastUser > 0 && messages[lastUser]!.role !== 'user') lastUser--;
  let start = 0;
  while (total > limit && start < lastUser) {
    total -= size(messages[start]!);
    start++;
    while (start < lastUser && messages[start]!.role !== 'user') {
      total -= size(messages[start]!);
      start++;
    }
  }
  return messages.slice(start);
}

/** Answers `request`, given the conversation so far. */
export async function converse(deps: Deps, history: Message[], request: Request, signal: AbortSignal, progress: Progress = {}, maxSteps = MAX_STEPS): Promise<Outcome> {
  const asked = typeof request === 'string' ? { text: request, images: undefined } : request;
  const pictures = asked.images?.slice(0, MAX_IMAGES_PER_MESSAGE);
  const messages: Message[] = [...withoutImages(history), pictures?.length ? { role: 'user', content: asked.text, images: pictures } : { role: 'user', content: asked.text }];
  let shown = pictures?.length ?? 0;
  let answer = '';
  for (let step = 0; step < maxSteps; step++) {
    const reply = await deps.ask(trimHistory(messages), signal);
    progress.creditsLeft?.(reply.creditsLeft);
    const { content, tool_calls } = reply.message;
    messages.push(tool_calls?.length ? { role: 'assistant', content, tool_calls } : { role: 'assistant', content });
    answer = content;
    if (!tool_calls?.length) return { messages: withoutImages(messages), answer, stopped: false };
    const fetched: string[] = [];
    for (const call of tool_calls) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const expanded = expandTool(call.name, call.arguments);
      if ('name' in expanded) progress.tool?.(expanded.name);
      const result = 'name' in expanded ? await deps.tool(expanded.name, expanded.arguments) : `Error: ${expanded.error}`;
      let text = typeof result === 'string' ? result : result.text;
      const images = typeof result === 'string' ? [] : (result.images ?? []);
      // The server takes only so many pictures: past that, say so instead of sending ones it would refuse.
      if (images.length && shown + fetched.length + images.length <= MAX_IMAGES && fetched.length + images.length <= MAX_IMAGES_PER_MESSAGE) fetched.push(...images);
      else if (images.length) text += ' (Not shown: too many pictures are already in this conversation.)';
      messages.push({ role: 'tool', tool_call_id: call.id, content: text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… (cut short)` : text });
    }
    // A tool can't hand the model a picture, so what it fetched arrives as a message of its own after the results.
    if (fetched.length) {
      shown += fetched.length;
      messages.push({ role: 'user', content: FETCHED_PICTURES, images: fetched });
    }
  }
  // Out of steps with the model still asking for tools: end on something the server accepts next time.
  messages.push({ role: 'assistant', content: answer });
  return { messages: withoutImages(messages), answer, stopped: true };
}
