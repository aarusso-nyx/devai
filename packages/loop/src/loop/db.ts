import { execFileSync } from '@devai-nyx/authority';

/**
 * Phase-5 MVP. The full spec calls for managing a shared dev Postgres
 * cluster on a reserved port plus a TEMPLATE database that's cloned into
 * per-task DBs (D-15). The MVP here assumes the caller has Postgres
 * reachable (locally or via DEVAI_DB_URL) and exposes the operations
 * that compose on top:
 *
 *   - startShared(): no-op + status; documents that the user should run
 *     `docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=test
 *     postgres:15-alpine` (or equivalent) themselves.
 *   - rebuildTemplate(): drops devai_template, creates it empty.
 *   - provisionTask(taskId): CREATE DATABASE devai_task_<taskId>
 *     TEMPLATE devai_template.
 *   - dropTask(taskId): DROP DATABASE devai_task_<taskId>.
 *   - provisionCluster(taskId): documents the alternative (dedicated
 *     container) and returns a "not implemented in MVP" status.
 *
 * All operations are best-effort; on connection failure they return
 * { ok: false, error } rather than throwing.
 */

/**
 * R17.C.1 (D-131, audit finding 4): task ids and template names are
 * interpolated into DDL that Postgres cannot parameterize, so they are
 * validated structurally here — at the boundary that builds the SQL —
 * not only at CLI call sites. Shared with the CLI (`work task spawn`
 * validates against the same pattern).
 */
export const TASK_ID_PATTERN = /^TASK-[0-9]{4,}$/;

/** Conservative SQL-identifier shape for template names and task-DB prefixes. */
export const DB_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalidIdentifier(
  action: string,
  kind: 'task id' | 'template name' | 'task-db prefix',
  value: string,
): DbResult {
  return {
    ok: false,
    action,
    error: `invalid ${kind} ${JSON.stringify(value)}: must match ${
      kind === 'task id' ? String(TASK_ID_PATTERN) : String(DB_IDENTIFIER_PATTERN)
    }`,
  };
}

export interface DbResult {
  readonly ok: boolean;
  readonly action: string;
  readonly database?: string;
  readonly connection?: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
    readonly redacted_url: string;
  };
  readonly error?: string;
}

function psql(databaseUrl: string, sql: string): { ok: boolean; error?: string } {
  try {
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).replaceAll(
        databaseUrl,
        '[REDACTED_DB_URL]',
      ),
    };
  }
}

export interface StartSharedOptions {
  /** Port to bind on the host (default 5433). */
  readonly port?: number;
  /** Postgres image (default postgres:15-alpine). */
  readonly image?: string;
  /** Postgres password sourced by the CLI from DEVAI_DB_PASSWORD. */
  readonly password: string;
  /** Container name (default 'devai-shared-pg'). */
  readonly containerName?: string;
}

/**
 * Phase-9 Batch 9.G — start the shared Postgres cluster as a real
 * Docker container. Best-effort: requires `docker` on PATH. Returns
 * a structured DbResult on success/failure.
 *
 * If a container with the configured name is already running, this
 * is a no-op success. If a stopped container with that name exists,
 * it's started. Otherwise a new container is created with
 * --rm -d on the configured port + password.
 */
export function startShared(opts: StartSharedOptions): DbResult {
  const port = opts.port ?? 5433;
  const image = opts.image ?? 'postgres:15-alpine';
  const password = opts.password;
  const containerName = opts.containerName ?? 'devai-shared-pg';
  const connection = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'postgres',
    redacted_url: `postgresql://postgres:***@127.0.0.1:${String(port)}/postgres`,
  } as const;

  function dockerOk(): boolean {
    try {
      execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  if (!dockerOk()) {
    return {
      ok: false,
      action: 'start-shared',
      error:
        'docker CLI not available or daemon not running. Install Docker Desktop or set up Postgres manually and use --database-url to point at it.',
    };
  }

  // Already running?
  try {
    const psOut = execFileSync(
      'docker',
      ['ps', '--filter', `name=^${containerName}$`, '--format', '{{.Names}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (psOut === containerName) {
      return {
        ok: true,
        action: 'start-shared',
        connection,
      };
    }
  } catch {
    // ignore; fall through to start
  }

  // Exists but stopped?
  try {
    const allOut = execFileSync(
      'docker',
      ['ps', '-a', '--filter', `name=^${containerName}$`, '--format', '{{.Names}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (allOut === containerName) {
      execFileSync('docker', ['start', containerName], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return {
        ok: true,
        action: 'start-shared',
        connection,
      };
    }
  } catch {
    // ignore; create fresh
  }

  // Fresh run.
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-d',
        '--name',
        containerName,
        '-p',
        `${String(port)}:5432`,
        '-e',
        'POSTGRES_PASSWORD',
        image,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, POSTGRES_PASSWORD: password },
      },
    );
    return {
      ok: true,
      action: 'start-shared',
      connection,
    };
  } catch (err) {
    return {
      ok: false,
      action: 'start-shared',
      error: (err instanceof Error ? err.message : String(err)).replaceAll(password, '[REDACTED]'),
    };
  }
}

/**
 * Phase-9 Batch 9.G — stop the shared Postgres cluster.
 */
export function stopShared(opts: { containerName?: string } = {}): DbResult {
  const containerName = opts.containerName ?? 'devai-shared-pg';
  try {
    execFileSync('docker', ['stop', containerName], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, action: 'stop-shared' };
  } catch (err) {
    return {
      ok: false,
      action: 'stop-shared',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Report shared-cluster + per-task DB status. Best-effort.
 */
export function clusterStatus(opts: { containerName?: string; databaseUrl?: string }): {
  ok: boolean;
  container: { name: string; running: boolean };
  task_dbs: string[];
  error?: string;
} {
  const containerName = opts.containerName ?? 'devai-shared-pg';
  let running = false;
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--filter', `name=^${containerName}$`, '--format', '{{.Names}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    running = out === containerName;
  } catch {
    return {
      ok: false,
      container: { name: containerName, running: false },
      task_dbs: [],
      error: 'docker CLI not available',
    };
  }
  let task_dbs: string[] = [];
  if (opts.databaseUrl !== undefined && running) {
    try {
      const out = execFileSync(
        'psql',
        [
          opts.databaseUrl,
          '-t',
          '-A',
          '-c',
          "SELECT datname FROM pg_database WHERE datname LIKE 'devai_task_%' ORDER BY datname",
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      task_dbs = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      // ignore; task_dbs stays empty
    }
  }
  return { ok: true, container: { name: containerName, running }, task_dbs };
}

export interface DbOptions {
  /** Postgres URL pointing at an existing reachable cluster. */
  readonly databaseUrl: string;
  /** Template DB name (default: devai_template). */
  readonly templateName?: string;
  /** Task-DB prefix (default: devai_task_). */
  readonly taskDbPrefix?: string;
}

export function rebuildTemplate(opts: DbOptions): DbResult {
  const name = opts.templateName ?? 'devai_template';
  if (!DB_IDENTIFIER_PATTERN.test(name)) {
    return invalidIdentifier('rebuild-template', 'template name', name);
  }
  const dropRes = psql(opts.databaseUrl, `DROP DATABASE IF EXISTS ${name}`);
  if (!dropRes.ok) {
    return {
      ok: false,
      action: 'rebuild-template',
      database: name,
      ...(dropRes.error !== undefined && { error: dropRes.error }),
    };
  }
  const createRes = psql(opts.databaseUrl, `CREATE DATABASE ${name}`);
  if (!createRes.ok) {
    return {
      ok: false,
      action: 'rebuild-template',
      database: name,
      ...(createRes.error !== undefined && { error: createRes.error }),
    };
  }
  return { ok: true, action: 'rebuild-template', database: name };
}

export function provisionTask(opts: DbOptions & { taskId: string }): DbResult {
  if (!TASK_ID_PATTERN.test(opts.taskId)) {
    return invalidIdentifier('provision', 'task id', opts.taskId);
  }
  const template = opts.templateName ?? 'devai_template';
  if (!DB_IDENTIFIER_PATTERN.test(template)) {
    return invalidIdentifier('provision', 'template name', template);
  }
  const prefix = opts.taskDbPrefix ?? 'devai_task_';
  if (!DB_IDENTIFIER_PATTERN.test(prefix)) {
    return invalidIdentifier('provision', 'task-db prefix', prefix);
  }
  const dbName = `${prefix}${opts.taskId}`;
  const res = psql(opts.databaseUrl, `CREATE DATABASE ${dbName} TEMPLATE ${template}`);
  return {
    ok: res.ok,
    action: 'provision',
    database: dbName,
    ...(res.error !== undefined && { error: res.error }),
  };
}

export function dropTask(opts: DbOptions & { taskId: string }): DbResult {
  if (!TASK_ID_PATTERN.test(opts.taskId)) {
    return invalidIdentifier('drop', 'task id', opts.taskId);
  }
  const prefix = opts.taskDbPrefix ?? 'devai_task_';
  if (!DB_IDENTIFIER_PATTERN.test(prefix)) {
    return invalidIdentifier('drop', 'task-db prefix', prefix);
  }
  const dbName = `${prefix}${opts.taskId}`;
  // Terminate active connections first.
  const terminate = psql(
    opts.databaseUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid()`,
  );
  void terminate;
  const res = psql(opts.databaseUrl, `DROP DATABASE IF EXISTS ${dbName}`);
  return {
    ok: res.ok,
    action: 'drop',
    database: dbName,
    ...(res.error !== undefined && { error: res.error }),
  };
}

export function provisionCluster(opts: { taskId: string }): DbResult {
  return {
    ok: false,
    action: 'provision-cluster',
    database: `devai_cluster_${opts.taskId}`,
    error:
      'Phase-5 MVP: dedicated-container isolation deferred; use the shared-cluster path (provision) instead.',
  };
}
