// The language model behind the assistant: the request we send Workers AI and how we read its
// answer. This is the only file that knows the model's wire format, so changing model (or moving
// to another provider) starts and ends here.

import type { AiBinding } from './cf.ts';

/** It reads pictures as well as text, so every request goes to it. */
export const MODEL = '@cf/zai-org/glm-5.3-flash';

/** Dollars per million tokens, which is also micro-dollars per token. Keep in step with Cloudflare's pricing page. */
export const PRICE = { input: 0.15, output: 0.5 };

/** Input tokens a picture is held at before the model has said what it cost (a picture is scaled to fit about this many). */
export const IMAGE_TOKENS = 2000;

/** The most the model may write in one answer (its reasoning counts). */
export const MAX_OUTPUT_TOKENS = 1500;

export interface ToolCall {
  id: string;
  name: string;
  /** JSON, as the model wrote it. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'user'; content: string; /** Pictures as `data:image/...;base64,` URIs. */ images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  /** Tokens billed, as the model reports them (null: it didn't say). */
  usage: { input: number; output: number } | null;
}

/** The cost of some tokens, in micro-dollars, rounded up. */
export const costMicro = (input: number, output: number): number => Math.ceil(input * PRICE.input + output * PRICE.output);

/** A rough token count for text, for holding money before the model has answered (an overestimate). */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/** The request body for Workers AI. */
export function buildRequest(system: string, messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) =>
        m.role === 'assistant' && m.tool_calls?.length
          ? { role: 'assistant', content: m.content, tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : m.role === 'user' && m.images?.length
            ? { role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
            : m,
      ),
    ],
    tools: tools.map((tool) => ({ type: 'function', function: tool })),
    max_tokens: MAX_OUTPUT_TOKENS,
    // It reasons by default at its highest effort, and reasoning counts toward the output limit.
    reasoning_effort: 'low',
    temperature: 0.3,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
const asCount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function toolCall(raw: unknown, index: number): ToolCall | null {
  if (!isObject(raw)) return null;
  const fn = isObject(raw.function) ? raw.function : raw;
  const name = asText(fn.name);
  if (!name) return null;
  const args = fn.arguments;
  return { id: asText(raw.id) || `call_${index}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
}

/**
 * Reads Workers AI's answer. It comes in the chat-completions shape (`choices[0].message`), in
 * the flat shape older models use (`response`, `tool_calls`), or as Responses-style `output`
 * items; all are accepted, since Cloudflare has used each of them for open models.
 */
export function parseCompletion(raw: unknown): Completion {
  const out: Completion = { content: '', toolCalls: [], usage: null };
  if (!isObject(raw)) return out;
  const choice = Array.isArray(raw.choices) && isObject(raw.choices[0]) ? raw.choices[0] : null;
  const message = choice && isObject(choice.message) ? choice.message : raw;
  const calls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  out.content = asText(message.content) || asText(raw.response);
  if (Array.isArray(raw.output)) {
    for (const item of raw.output) {
      if (!isObject(item)) continue;
      if (item.type === 'function_call') calls.push(item);
      else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) if (isObject(part) && part.type === 'output_text') out.content += asText(part.text);
      }
    }
  }
  out.toolCalls = calls.map(toolCall).filter((c): c is ToolCall => !!c);
  if (isObject(raw.usage)) {
    const input = asCount(raw.usage.prompt_tokens) ?? asCount(raw.usage.input_tokens);
    const output = asCount(raw.usage.completion_tokens) ?? asCount(raw.usage.output_tokens);
    if (input !== null && output !== null) out.usage = { input, output };
  }
  return out;
}

export async function complete(ai: AiBinding, system: string, messages: ChatMessage[], tools: ToolDefinition[]): Promise<Completion> {
  return parseCompletion(await ai.run(MODEL, buildRequest(system, messages, tools)));
}
