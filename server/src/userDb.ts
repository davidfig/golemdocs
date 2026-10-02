// One D1 database per user.
//
// A Worker can only use D1 databases bound in wrangler.jsonc, and bindings are fixed at deploy time,
// so databases created at runtime are provisioned and queried through Cloudflare's REST API instead.
// The DIRECTORY binding (a normal D1 binding) records which database belongs to which user.
// Each query is an HTTP round trip to api.cloudflare.com, so keep it to catalogue-sized work.

import type { Env } from './cf.ts';
import { USER_MIGRATIONS } from './schema.ts';

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class CloudflareError extends Error {
  status: number;
  errors: { code: number; message: string }[];
  /** Seconds Cloudflare asked us to wait (a 429's Retry-After), when it said. */
  retryAfter?: number;
  constructor(status: number, errors: { code: number; message: string }[], retryAfter?: number) {
    super(`Cloudflare API ${status}: ${errors.map((e) => e.message).join('; ') || 'request failed'}`);
    this.status = status;
    this.errors = errors;
    this.retryAfter = retryAfter;
  }
}

async function api<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !envelope?.success) {
    const wait = Number(response.headers.get('retry-after'));
    throw new CloudflareError(response.status, envelope?.errors ?? [], Number.isFinite(wait) && wait > 0 ? wait : undefined);
  }
  return envelope.result;
}

/** Longest a cached list is trusted, in case an invalidation was lost. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** D1 rows are limited to 2 MB; a list bigger than this is just not cached. */
const CACHE_MAX_JSON = 900_000;

export class UserDb {
  private readonly env: Env;
  readonly databaseId: string;
  /** What this database's cached lists are filed under in the directory. */
  protected cacheKey: string;

  constructor(env: Env, databaseId: string) {
    this.env = env;
    this.databaseId = databaseId;
    this.cacheKey = databaseId;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [result] = await api<{ results: T[] }[]>(this.env, `/d1/database/${this.databaseId}/query`, { sql, params });
    return result?.results ?? [];
  }

  /** Every change goes through here (reads use `all` and `first`), so it is where cached lists are dropped. */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.all(sql, params);
    await this.invalidate();
  }

  /** Several changes in one request to Cloudflare, which D1 runs as a transaction (all or none), dropping the cached lists once. */
  async runAll(statements: { sql: string; params: unknown[] }[]): Promise<void> {
    if (!statements.length) return;
    await this.batch(statements);
    await this.invalidate();
  }

  protected async batch(statements: { sql: string; params: unknown[] }[]): Promise<void> {
    await api(this.env, `/d1/database/${this.databaseId}/query`, { batch: statements });
  }

  private async invalidate(): Promise<void> {
    try {
      await this.env.DIRECTORY.prepare(
        "INSERT INTO catalogue_cache (db_key, kind, json, cached_at) VALUES (?, '', '', ?) ON CONFLICT(db_key, kind) DO UPDATE SET cached_at = MAX(cached_at, excluded.cached_at)",
      )
        .bind(this.cacheKey, Date.now())
        .run();
    } catch {
      // No cache table yet (or the directory is down): lists are read afresh until the TTL passes.
    }
  }

  /**
   * A list from this database (`kind` names it), served from the directory's copy when that is
   * current. `load` reads it for real; it runs on a miss and its result is kept. The copy is dated
   * from before `load` started, so a change made while it ran leaves the copy out of date, never wrong.
   */
  /** The cached copy of a list if it is current, else null. */
  async peekList<T>(kind: string): Promise<T[] | null> {
    try {
      const { results } = await this.env.DIRECTORY.prepare('SELECT kind, json, cached_at FROM catalogue_cache WHERE db_key = ?')
        .bind(this.cacheKey)
        .all<{ kind: string; json: string; cached_at: number }>();
      const changedAt = results.find((r) => r.kind === '')?.cached_at ?? 0;
      const hit = results.find((r) => r.kind === kind);
      if (hit && hit.cached_at > changedAt && Date.now() - hit.cached_at < CACHE_TTL_MS) return JSON.parse(hit.json) as T[];
    } catch {
      // No cache: the caller reads the database itself.
    }
    return null;
  }

  async cachedList<T>(kind: string, load: () => Promise<T[]>): Promise<T[]> {
    const started = Date.now();
    const directory = this.env.DIRECTORY;
    const cached = await this.peekList<T>(kind);
    if (cached) return cached;
    const rows = await load();
    try {
      const json = JSON.stringify(rows);
      if (json.length <= CACHE_MAX_JSON) {
        await directory
          .prepare('INSERT INTO catalogue_cache (db_key, kind, json, cached_at) VALUES (?, ?, ?, ?) ON CONFLICT(db_key, kind) DO UPDATE SET json = excluded.json, cached_at = excluded.cached_at')
          .bind(this.cacheKey, kind, json, started)
          .run();
      }
    } catch {
      // Only a head start for the next listing.
    }
    return rows;
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }
}

/** Applies the migrations a database hasn't seen. Safe to repeat, and to run concurrently. */
async function migrate(db: UserDb): Promise<number> {
  await db.run('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)');
  const applied = new Set((await db.all<{ version: number }>('SELECT version FROM _migrations')).map((r) => r.version));
  for (const [index, statements] of USER_MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    for (const statement of statements) await db.run(statement);
    await db.run('INSERT OR IGNORE INTO _migrations (version) VALUES (?)', [version]);
  }
  return USER_MIGRATIONS.length;
}

/**
 * Local development (`ENVIRONMENT=local`): a user's catalogue lives in the simulated DIRECTORY
 * database instead of a database of their own, because Cloudflare's REST API for creating one
 * doesn't exist offline. The same SQL runs; the per-user tables just get a per-user name.
 */
class LocalUserDb extends UserDb {
  private readonly prefix: string;

  constructor(
    private readonly directory: Env['DIRECTORY'],
    userId: string,
    env: Env,
  ) {
    super(env, 'local');
    if (!/^[0-9a-f]+$/.test(userId)) throw new Error('unexpected user id');
    this.prefix = `local_${userId}_`;
    this.cacheKey = this.prefix;
  }

  protected override async batch(statements: { sql: string; params: unknown[] }[]): Promise<void> {
    for (const { sql, params } of statements) await this.all(sql, params);
  }

  override async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    // Table and index names are the only identifiers the per-user schema uses (see schema.ts).
    const rewritten = sql.replace(/\b(documents_updated|documents|folders|_migrations)\b/g, `${this.prefix}$1`);
    return (await this.directory.prepare(rewritten).bind(...params).all<T>()).results;
  }
}

/** Local users whose tables are known to be current, per simulated directory database. */
const migratedLocally = new WeakMap<object, Set<string>>();

async function createDatabase(env: Env, userId: string): Promise<string> {
  // Dev databases live in the same account but can never be mistaken for (or collide with) production's.
  const name = `${env.ENVIRONMENT === 'production' ? 'golemdocs-user-' : 'golemdocs-dev-user-'}${userId}`;
  try {
    return (await api<{ uuid: string }>(env, '/d1/database', { name })).uuid;
  } catch (error) {
    // A concurrent first request may have created it already; the name is deterministic.
    const existing = await api<{ uuid: string; name: string }[]>(env, `/d1/database?name=${encodeURIComponent(name)}`).catch(() => []);
    const found = existing.find((d) => d.name === name);
    if (found) return found.uuid;
    throw error;
  }
}

interface DirectoryRow {
  database_id: string;
  schema_version: number;
}

/** The user's database if they have one already; never creates one (people without sync get none). */
export async function existingUserDb(env: Env, userId: string): Promise<UserDb | null> {
  if (env.ENVIRONMENT !== 'local') {
    const row = await env.DIRECTORY.prepare('SELECT 1 AS found FROM users WHERE user_id = ?').bind(userId).first<{ found: number }>();
    if (!row) return null;
  }
  return userDb(env, userId);
}

/** The user's database, created and migrated on first use. */
export async function userDb(env: Env, userId: string): Promise<UserDb> {
  if (env.ENVIRONMENT === 'local') {
    const local = new LocalUserDb(env.DIRECTORY, userId, env);
    // Once per process: migrating on every request cost several queries (and dropped the cached lists each time).
    const done = migratedLocally.get(env.DIRECTORY) ?? new Set<string>();
    migratedLocally.set(env.DIRECTORY, done);
    if (!done.has(userId)) {
      await migrate(local);
      done.add(userId);
    }
    return local;
  }
  const lookup = () =>
    env.DIRECTORY.prepare('SELECT database_id, schema_version FROM users WHERE user_id = ?').bind(userId).first<DirectoryRow>();

  let row = await lookup();
  if (!row) {
    const databaseId = await createDatabase(env, userId);
    const version = await migrate(new UserDb(env, databaseId));
    await env.DIRECTORY.prepare(
      'INSERT INTO users (user_id, database_id, schema_version, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING',
    )
      .bind(userId, databaseId, version, Date.now())
      .run();
    row = await lookup();
    if (!row) throw new Error('failed to register user database');
  }

  const db = new UserDb(env, row.database_id);
  if (row.schema_version < USER_MIGRATIONS.length) {
    const version = await migrate(db);
    await env.DIRECTORY.prepare('UPDATE users SET schema_version = ? WHERE user_id = ?').bind(version, userId).run();
  }
  return db;
}
