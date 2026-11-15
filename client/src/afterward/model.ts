// How the readers reach the model (docs/afterward.md §6). One interface, so a call through the server can take the place of the
// direct one later without anything above it changing. The direct route calls Anthropic's Messages API from the page with the
// writer's own key: there is no server in between, and the key never leaves this device except to Anthropic.
//
// Hand-written over `fetch` (the app takes no SDK): one non-streaming request with structured output, so every answer is JSON
// in the shape asked for.

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

export interface ModelRequest {
  system: SystemBlock[];
  /** The task, as one user turn. */
  task: string;
  /** The JSON schema the answer must follow. */
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  maxTokens?: number;
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
      const body = JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: request.maxTokens ?? 16000,
        fallbacks: 'default',
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
              'anthropic-beta': 'server-side-fallback-2026-07-01',
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
        const answer = (await response.json().catch(() => null)) as AnthropicResponse | null;
        if (!response.ok) throw errorOf(response.status, answer);
        return answerOf(answer);
      }
    },
  };
}

interface AnthropicResponse {
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  error?: { type?: string; message?: string };
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
