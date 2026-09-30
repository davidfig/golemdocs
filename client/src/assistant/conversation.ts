// A conversation with Clip, the assistant: the messages so far and the loop that answers one
// request. Each turn asks the server's model (one step at a time); when the model asks for tools,
// they run on the open document and their results go back, until it answers in words.
//
// No DOM and no network here (both are passed in), so this is what the tests exercise.

export interface ToolCall {
  id: string;
  name: string;
  /** JSON, as the model wrote it. */
  arguments: string;
}

export type Message =
  | { role: 'user'; content: string }
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

export interface Deps {
  ask(messages: Message[], signal: AbortSignal): Promise<Reply>;
  /** Runs a tool on the open document; answers with what it did or found. */
  tool(name: string, args: string): Promise<string>;
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

const size = (m: Message): number => m.content.length + ('tool_calls' in m && m.tool_calls ? m.tool_calls.reduce((n, c) => n + c.arguments.length + c.name.length, 0) : 0);

/**
 * The most recent part of a conversation that fits, starting at one of the person's messages (a
 * tool result must follow the call that asked for it, so the history can't start in the middle of one).
 */
export function trimHistory(messages: Message[], limit = MAX_HISTORY_CHARS): Message[] {
  let total = messages.reduce((n, m) => n + size(m), 0);
  let start = 0;
  while (total > limit && start < messages.length - 1) {
    total -= size(messages[start]!);
    start++;
    while (start < messages.length - 1 && messages[start]!.role !== 'user') {
      total -= size(messages[start]!);
      start++;
    }
  }
  return messages.slice(start);
}

/** Answers `request`, given the conversation so far. */
export async function converse(deps: Deps, history: Message[], request: string, signal: AbortSignal, progress: Progress = {}, maxSteps = MAX_STEPS): Promise<Outcome> {
  const messages: Message[] = [...history, { role: 'user', content: request }];
  let answer = '';
  for (let step = 0; step < maxSteps; step++) {
    const reply = await deps.ask(trimHistory(messages), signal);
    progress.creditsLeft?.(reply.creditsLeft);
    const { content, tool_calls } = reply.message;
    messages.push(tool_calls?.length ? { role: 'assistant', content, tool_calls } : { role: 'assistant', content });
    answer = content;
    if (!tool_calls?.length) return { messages, answer, stopped: false };
    for (const call of tool_calls) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      progress.tool?.(call.name);
      const result = await deps.tool(call.name, call.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.length > MAX_TOOL_RESULT_CHARS ? `${result.slice(0, MAX_TOOL_RESULT_CHARS)}… (cut short)` : result });
    }
  }
  // Out of steps with the model still asking for tools: end on something the server accepts next time.
  messages.push({ role: 'assistant', content: answer });
  return { messages, answer, stopped: true };
}
