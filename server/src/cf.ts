// The slice of the Cloudflare runtime API this server uses, declared by hand so the server needs
// no @cloudflare/workers-types dependency. Extend as needed.

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Several statements in one round trip, run in order as a transaction. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  /** The same value `head` calls its etag (httpEtag is that in quotes, for the HTTP header). */
  etag: string;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  /** The object's metadata without its body; null if there is none. */
  head(key: string): Promise<{ etag: string; size: number; customMetadata?: Record<string, string> } | null>;
  /** With `onlyIf`, answers null (and writes nothing) unless the object's etag still matches. */
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  /** The keys that start with `prefix`, up to 1000 at a time (`cursor` continues a truncated listing). */
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export interface DurableObjectStorage {
  sql: SqlStorage;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** Deletes everything the object stores, SQL tables included (but not its alarm). */
  deleteAll(): Promise<void>;
  transactionSync<T>(closure: () => T): T;
}

/** A server-side WebSocket, using the hibernation API (the object can be evicted while sockets stay open). */
export interface WebSocketHandle {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  getWebSockets(): WebSocketHandle[];
  acceptWebSocket(socket: WebSocketHandle): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/** Bindings and variables (see wrangler.jsonc and .dev.vars). */
export interface Env {
  DIRECTORY: D1Database;
  FILES: R2Bucket;
  /** One collaboration room per cloud document (see room.ts). */
  ROOMS: DurableObjectNamespace;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** `production`, `dev` or `local` (see wrangler.jsonc). */
  ENVIRONMENT?: string;
  /** Comma-separated emails of admins (verified sign-in emails, or DEV_USER locally). Admins see the billing panel. */
  ADMIN_EMAILS?: string;
  /**
   * `true` requires a subscription (or being an admin) for cloud documents, sharing and rooms.
   * Anything else leaves them free for every signed-in user.
   */
  REQUIRE_SUBSCRIPTION?: string;
  /** Polar's webhook secret (Polar dashboard > Webhooks). Without it, /api/webhooks/polar answers 503. */
  POLAR_WEBHOOK_SECRET?: string;
  /** An organization access token with the checkouts:write and customer_sessions:write scopes. */
  POLAR_ACCESS_TOKEN?: string;
  /** The id of the monthly sync product in Polar. */
  POLAR_PRODUCT_ID?: string;
  /** Polar's API, when not the production one (`https://sandbox-api.polar.sh` for its sandbox). */
  POLAR_API_URL?: string;
  /** Local development only: treated as the signed-in user. */
  DEV_USER?: string;

  // Sign-in providers. A provider is offered only when all of its values are set (see AUTH.md).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** `common` (work, school and personal accounts), `organizations`, `consumers`, or a tenant id. */
  MICROSOFT_TENANT?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The Services ID. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Contents of the .p8 key file. */
  APPLE_PRIVATE_KEY?: string;
}

export interface ExecutionContext {
  /** Keeps the Worker running until this settles, after the response has been sent. */
  waitUntil(promise: Promise<unknown>): void;
}

export interface ExportedHandler {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> | Response;
}
