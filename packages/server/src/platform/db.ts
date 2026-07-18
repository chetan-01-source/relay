/**
 * Postgres access (PRD §4 Day 2 · playbook §5). SINGLETON — one connection pool per process
 * (system-design: bounded connections, no accidental pool-per-request). The runtime connects
 * as the RLS-bound relay_app role; every tenant query runs inside withTenant(), which opens a
 * transaction and sets app.current_org / app.is_platform_admin via set_config(..., local=true)
 * so RLS scopes the connection to exactly one tenant. Connections are NEVER shared across tenants.
 *
 * Boundary rule: callers receive only the `Queryable` interface and pass `SqlQuery` objects
 * ({ text, values }) built by *.queries.ts files — so all SQL is parametrized by construction
 * and no query text is ever assembled in a service or controller.
 */
import pg from 'pg';

/** A parametrized SQL statement. The ONLY shape repositories may execute. */
export interface SqlQuery {
  text: string;
  values: readonly unknown[];
}

/** Minimal execution surface handed to repositories (pool or in-transaction client). */
export interface Queryable {
  run<R extends pg.QueryResultRow = pg.QueryResultRow>(query: SqlQuery): Promise<R[]>;
}

export interface TenantScope {
  isPlatformAdmin?: boolean;
}

export interface Database extends Queryable {
  /** Run fn inside a tenant-scoped transaction. RLS enforces org isolation. */
  withTenant<T>(orgId: string, scope: TenantScope, fn: (tx: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

function toQueryable(exec: pg.Pool | pg.PoolClient): Queryable {
  return {
    async run<R extends pg.QueryResultRow>(query: SqlQuery): Promise<R[]> {
      const res = await exec.query<R>(query.text, query.values as unknown[]);
      return res.rows;
    },
  };
}

class PgDatabase implements Database {
  private static instance: PgDatabase | undefined;
  private readonly pool: pg.Pool;
  private readonly self: Queryable;

  private constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.self = toQueryable(this.pool);
  }

  /** Create the singleton once; subsequent calls return the same instance. */
  static init(connectionString: string): PgDatabase {
    PgDatabase.instance ??= new PgDatabase(connectionString);
    return PgDatabase.instance;
  }

  /** Access the initialized singleton. Throws if init() was not called first. */
  static get(): PgDatabase {
    if (!PgDatabase.instance) throw new Error('Database.get() before Database.init()');
    return PgDatabase.instance;
  }

  static reset(): void {
    PgDatabase.instance = undefined; // test-only hook
  }

  run<R extends pg.QueryResultRow>(query: SqlQuery): Promise<R[]> {
    return this.self.run<R>(query);
  }

  async withTenant<T>(
    orgId: string,
    scope: TenantScope,
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org', $1, true)`, [orgId]);
      await client.query(`SELECT set_config('app.is_platform_admin', $1, true)`, [
        scope.isPlatformAdmin ? 'true' : 'false',
      ]);
      const result = await fn(toQueryable(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export function initDb(connectionString: string): Database {
  return PgDatabase.init(connectionString);
}

export function getDb(): Database {
  return PgDatabase.get();
}

/** Test-only: drop the singleton so a fresh pool can be initialized. */
export function resetDb(): void {
  PgDatabase.reset();
}
