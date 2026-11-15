// How the readers reach the model (docs/afterward.md §6). One interface, so a call through the server can take the place of the
// direct one later without anything above it changing. The direct route calls Anthropic's Messages API from the page with the
// writer's own key: there is no server in between, and the key never leaves this device except to Anthropic.
//
// Hand-written over `fetch` (the app takes no SDK): one request with structured output, so every answer is JSON in the shape
// asked for. A request can stream: the answer's text arrives as it is written (`onText`), so a reply starts showing at once.
// Each request names its model: a fast one reads along, the deepest answers what the writer asks. Another provider (an open
// model, a server) is another `ReaderModel`.

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

export interface ModelRequest {
  system: SystemBlock[];
  /** The task, as one user turn. */
  task: string;
  /** The JSON schema the answer must follow. */
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** The model to ask; DEFAULT_MODEL when left out. */
  model?: string;
  /** Streams the answer: called with the JSON text so far as it arrives. */
  onText?: (soFar: string) => void;
  /** Hears what the request used, once it is answered (Admin › Debug › Token use). */
  onUsage?: (usage: Usage) => void;
}

/** What one request used, in tokens. */
export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** List prices, dollars per million tokens (input, output, cache read, cache write for five minutes). */
const PRICES: Record<string, { input: number; output: number; read: number; write: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2, write: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
};

/** About what a request cost on the writer's key, at list price (0 for a model without a price here). */
export function costOf(usage: Usage): number {
  const price = PRICES[usage.model];
  if (!price) return 0;
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.read + usage.cacheWrite * price.write) / 1_000_000;
}

export interface ReaderModel {
  /** The answer, parsed (not yet checked against its shape). Rejects with a `ModelError`. */
  ask(request: ModelRequest, signal?: AbortSignal): Promise<unknown>;
}

export type ModelErrorKind = 'key' | 'permission' | 'model' | 'rate' | 'overloaded' | 'network' | 'refused' | 'tooLong' | 'shape' | 'stopped' | 'other';

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string = kind,
  ) {
    super(message);
  }
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** The fast model, for reading along while the writer writes. */
export const FAST_MODEL = 'claude-haiku-5-5';
const API = 'https://api.anthropic.com/v1/messages';

export interface DirectOptions {
  model?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** Waits `ms`, or rejects when `signal` aborts. For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How many times a failure that may pass is tried again (as Anthropic's own SDKs do: 2). */
  retries?: number;
}

/** The failures worth trying again: the connection, a timeout, a lock, rate limits, and the API's own errors and overload. */
export function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * How long to wait before try number `attempt` (1, 2…): what the API asks for (`retry-after-ms`, `retry-after` in seconds or
 * as a date) when it is under a minute, else half a second doubling each time up to 8, less up to a quarter at random so
 * several readers' requests don't all come back at once.
 */
export function retryDelay(attempt: number, headers?: Headers | null, random = Math.random): number {
  const ms = Number(headers?.get('retry-after-ms'));
  if (ms > 0 && ms < 60_000) return ms;
  const after = headers?.get('retry-after');
  if (after) {
    const seconds = Number(after);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
    if (wait > 0 && wait < 60_000) return wait;
  }
  return Math.min(500 * 2 ** (attempt - 1), 8000) * (1 - 0.25 * random());
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ModelError('stopped'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new ModelError('stopped'));
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** The Messages API called from this page with the writer's key, trying again (after a wait) when a failure may pass. */
export function directModel(key: string, options: DirectOptions = {}): ReaderModel {
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = options.sleep ?? wait;
  const retries = options.retries ?? 2;
  return {
    async ask(request, signal) {
      const model = request.model ?? options.model ?? DEFAULT_MODEL;
      // Haiku has no server-side fallback on a refusal.
      const fallback = !model.startsWith('claude-haiku');
      const body = JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 16000,
        ...(fallback && { fallbacks: 'default' }),
        ...(request.onText && { stream: true }),
        system: request.system,
        messages: [{ role: 'user', content: request.task }],
        output_config: { effort: request.effort, format: { type: 'json_schema', schema: request.schema } },
      });
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await fetchFn(API, {
            method: 'POST',
            signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              // A page may call the API only by saying so: the key is the writer's own, typed into this page.
              'anthropic-dangerous-direct-browser-access': 'true',
              // A refusal is tried again on a fallback model the API picks, rather than stopping the read.
              ...(fallback && { 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
            },
            body,
          });
        } catch (e) {
          if (signal?.aborted || (e as Error).name === 'AbortError') throw new ModelError('stopped');
          if (attempt < retries) {
            await sleep(retryDelay(attempt + 1), signal);
            continue;
          }
          throw new ModelError('network', (e as Error).message);
        }
        // The API can say outright whether to try again.
        const told = response.headers.get('x-should-retry');
        if (!response.ok && attempt < retries && (told === 'true' || (told !== 'false' && retryable(response.status)))) {
          await response.body?.cancel().catch(() => {});
          await sleep(retryDelay(attempt + 1, response.headers), signal);
          continue;
        }
        if (!response.ok) throw errorOf(response.status, (await response.json().catch(() => null)) as AnthropicResponse | null);
        const answer = request.onText ? await readStream(response, request.onText, signal) : ((await response.json().catch(() => null)) as AnthropicResponse | null);
        if (answer?.usage) request.onUsage?.(usageOf(model, answer.usage));
        return answerOf(answer);
      }
    },
  };
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  error?: { type?: string; message?: string };
  usage?: ApiUsage;
}

function usageOf(model: string, u: ApiUsage): Usage {
  return { model, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

/** The answer's JSON, from a response that succeeded. */
export function answerOf(body: AnthropicResponse | null): unknown {
  if (!body) throw new ModelError('other', 'empty response');
  if (body.stop_reason === 'refusal') throw new ModelError('refused');
  if (body.stop_reason === 'max_tokens') throw new ModelError('tooLong');
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError('shape', 'not JSON');
  }
}

/** A failed response, by its status, in the kinds the app explains. */
export function errorOf(status: number, body: AnthropicResponse | null): ModelError {
  const message = body?.error?.message ?? `HTTP ${status}`;
  if (status === 401) return new ModelError('key', message);
  if (status === 403) return new ModelError('permission', message);
  if (status === 404) return new ModelError('model', message);
  if (status === 429) return new ModelError('rate', message);
  if (status === 529 || status === 503) return new ModelError('overloaded', message);
  if (status === 413) return new ModelError('tooLong', message);
  return new ModelError('other', message);
}

/**
 * A streamed answer (server-sent events), put back together as the response a non-streaming request returns. `onText` hears the
 * text so far after each piece.
 */
export async function readStream(response: Response, onText: (soFar: string) => void, signal?: AbortSignal): Promise<AnthropicResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new ModelError('other', 'no stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stop: string | undefined;
  // The usage comes in two parts: what was read, when the message starts; what was written, as it ends.
  const usage: ApiUsage = {};
  const handle = (data: string) => {
    let event: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { type?: string; message?: string }; message?: { usage?: ApiUsage }; usage?: ApiUsage };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      text += event.delta.text;
      onText(text);
    } else if (event.type === 'message_start' && event.message?.usage) Object.assign(usage, event.message.usage);
    else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stop = event.delta.stop_reason;
      if (event.usage) Object.assign(usage, event.usage);
    }
    else if (event.type === 'error') throw event.error?.type === 'overloaded_error' ? new ModelError('overloaded', event.error.message) : new ModelError('other', event.error?.message ?? 'stream error');
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) handle(data);
      }
    }
  } catch (e) {
    if (signal?.aborted || (e as Error).name === 'AbortError') throw new ModelError('stopped');
    throw e;
  }
  return { stop_reason: stop, content: [{ type: 'text', text }], ...(Object.keys(usage).length && { usage }) };
}

/** A string field of a JSON object still being written (`{"reply":"So far…`): what has arrived of it, decoded; '' before it starts. */
export function partialField(json: string, field: string): string {
  const start = json.indexOf(`"${field}"`);
  if (start < 0) return '';
  const colon = json.indexOf(':', start + field.length + 2);
  const open = colon < 0 ? -1 : json.indexOf('"', colon);
  if (open < 0) return '';
  let out = '';
  for (let i = open + 1; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') return out;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = json[i + 1];
    if (next === undefined) return out;
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
      i += 1;
    }
  }
  return out;
}
