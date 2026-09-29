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
}

export interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

/** Bindings and variables (see wrangler.jsonc and .dev.vars). */
export interface Env {
  DIRECTORY: D1Database;
  FILES: R2Bucket;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** `production`, `dev` or `local` (see wrangler.jsonc). */
  ENVIRONMENT?: string;
  /** Comma-separated emails of admins (verified sign-in emails, or DEV_USER locally). Admins see the billing panel. */
  ADMIN_EMAILS?: string;
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

export interface ExportedHandler {
  fetch(request: Request, env: Env): Promise<Response> | Response;
}
