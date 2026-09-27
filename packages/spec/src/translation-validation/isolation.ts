import { spawnSync as nodeSpawnSync } from '@devai-nyx/authority';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function requireId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label.toUpperCase()}_INVALID`);
  return value;
}

interface ValidationLease {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly task_id: string;
  readonly worktree_id: string;
  readonly worktree_path: string;
  readonly database: string;
  readonly base_sha: string;
  readonly created_at: string;
}

function isValidationLease(value: unknown): value is ValidationLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<ValidationLease>;
  const suffix = typeof lease.id === 'string' ? lease.id.slice(4) : '';
  return (
    lease.schemaVersion === '1.0.0' &&
    typeof lease.id === 'string' &&
    /^TVL-[a-f0-9]{16}$/u.test(lease.id) &&
    typeof lease.task_id === 'string' &&
    /^TASK-[0-9]{4,}$/u.test(lease.task_id) &&
    lease.worktree_id === `WT-TV-${suffix}` &&
    lease.worktree_path === `.devai/worktrees/WT-TV-${suffix}` &&
    lease.database === `devai_task_TV_${suffix}` &&
    typeof lease.base_sha === 'string' &&
    /^[a-f0-9]{40}$/u.test(lease.base_sha) &&
    typeof lease.created_at === 'string' &&
    !Number.isNaN(Date.parse(lease.created_at))
  );
}

export async function recoverValidationLeases(input: {
  readonly leases: readonly unknown[];
  readonly host: {
    readonly remove_worktree: (path: string) => Promise<void>;
    readonly drop_database: (database: string) => Promise<void>;
  };
}): Promise<{
  readonly status: 'pass' | 'fail';
  readonly recovered: readonly string[];
  readonly findings: readonly string[];
}> {
  const recovered: string[] = [];
  const findings: string[] = [];
  for (const value of input.leases) {
    if (!isValidationLease(value)) {
      findings.push('LEASE_INVALID');
      continue;
    }
    try {
      await input.host.remove_worktree(value.worktree_path);
      await input.host.drop_database(value.database);
      recovered.push(value.id);
    } catch (error) {
      findings.push(
        `${value.id}: RECOVERY_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { status: findings.length === 0 ? 'pass' : 'fail', recovered, findings };
}

const LINUX_ISOLATION_STARTED = 'DEVAI_TRANSLATION_ISOLATION_STARTED';

export async function runLinuxIsolated(input: {
  readonly repo_root: string;
  readonly dependencies_root?: string;
  readonly image: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly prepare_dependency_mount_point?: (path: string) => void;
  readonly remove_dependency_mount_point?: (path: string) => void;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: Readonly<{ encoding: 'utf8'; timeout: number }>,
  ) => Readonly<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string | Buffer | null;
    stderr: string | Buffer | null;
    error?: Error;
  }>;
}): Promise<{
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolation_applied: boolean;
}> {
  const run = input.spawn ?? nodeSpawnSync;
  const dependencyRoot =
    input.dependencies_root === undefined
      ? undefined
      : resolve(input.dependencies_root, 'node_modules');
  const dependencyMountPoint = resolve(input.repo_root, 'node_modules');
  const usesSharedDependencies = dependencyRoot !== undefined && existsSync(dependencyRoot);
  const createdDependencyMountPoint = usesSharedDependencies && !existsSync(dependencyMountPoint);
  if (createdDependencyMountPoint) {
    if (
      input.prepare_dependency_mount_point === undefined ||
      input.remove_dependency_mount_point === undefined
    ) {
      throw new Error('LINUX_DEPENDENCY_MOUNT_ADAPTER_MISSING');
    }
    input.prepare_dependency_mount_point(dependencyMountPoint);
  }
  let result: ReturnType<typeof run> | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  try {
    result = run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=bind,src=${input.repo_root},dst=/workspace,readonly`,
        ...(usesSharedDependencies
          ? ['--mount', `type=bind,src=${dependencyRoot},dst=/workspace/node_modules,readonly`]
          : []),
        '--workdir',
        '/workspace',
        input.image,
        'sh',
        '-c',
        `printf '%s\\n' ${LINUX_ISOLATION_STARTED}; exec "$@"`,
        'devai-translation-isolation',
        ...input.argv,
      ],
      { encoding: 'utf8', timeout: input.timeout_ms },
    );
  } catch (error) {
    runError = error;
  } finally {
    if (createdDependencyMountPoint) {
      let removed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((done) => setTimeout(done, 100));
        try {
          input.remove_dependency_mount_point?.(dependencyMountPoint);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '')) {
            cleanupError = error;
            break;
          }
          continue;
        }
        await new Promise((done) => setTimeout(done, 100));
        if (!existsSync(dependencyMountPoint)) {
          removed = true;
          break;
        }
      }
      if (!removed && cleanupError === undefined) {
        cleanupError = new Error('LINUX_DEPENDENCY_MOUNT_CLEANUP_FAILED');
      }
    }
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error('LINUX_RUNNER_RESULT_MISSING');
  const stdout =
    typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString('utf8') ?? '');
  const marker = `${LINUX_ISOLATION_STARTED}\n`;
  const isolationApplied = stdout.startsWith(marker);
  return {
    exit_code: result.status ?? (result.signal === null ? 1 : 128),
    stdout: isolationApplied ? stdout.slice(marker.length) : stdout,
    stderr:
      typeof result.stderr === 'string'
        ? result.stderr
        : (result.stderr?.toString('utf8') ?? result.error?.message ?? ''),
    isolation_applied: isolationApplied,
  };
}

function validationDatabaseName(validationId: string): string {
  requireId(validationId, /^VR-[a-f0-9]{16}$/u, 'validation id');
  return `devai_task_TV_${validationId.slice(3)}`;
}

export async function provisionValidationDatabase(input: {
  readonly database_url: string;
  readonly validation_id: string;
}): Promise<{ readonly ok: boolean; readonly database?: string; readonly error?: string }> {
  let Client: (typeof import('pg'))['Client'];
  try {
    ({ Client } = await import('pg'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('OPTIONAL_DEPENDENCY_MISSING:pg');
    }
    throw error;
  }
  const database = validationDatabaseName(input.validation_id);
  const client = new Client({ connectionString: input.database_url });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    return { ok: true, database };
  } catch (error) {
    return { ok: false, database, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function dropValidationDatabase(input: {
  readonly database_url: string;
  readonly database: string;
}): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!/^devai_task_TV_[a-f0-9]{16}$/u.test(input.database)) {
    return { ok: false, error: 'VALIDATION_DATABASE_INVALID' };
  }
  let Client: (typeof import('pg'))['Client'];
  try {
    ({ Client } = await import('pg'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('OPTIONAL_DEPENDENCY_MISSING:pg');
    }
    throw error;
  }
  const client = new Client({ connectionString: input.database_url });
  try {
    await client.connect();
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [input.database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${input.database}"`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
