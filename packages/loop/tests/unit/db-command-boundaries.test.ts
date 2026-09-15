// Unit command-protocol tests. These injected responses are not installed Docker/Postgres acceptance.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  execFileSync: seam.execute,
}));
import {
  clusterStatus,
  dropTask,
  provisionCluster,
  provisionTask,
  rebuildTemplate,
  startShared,
  stopShared,
} from '../../src/loop/db.js';
const url = 'postgresql://user:secret@127.0.0.1:5433/postgres';
beforeEach(() => {
  seam.execute.mockReset();
  seam.execute.mockReturnValue('');
});
function calls() {
  return seam.execute.mock.calls.map((call) => ({ executable: call[0], argv: call[1] }));
}
function fail(message: string): never {
  throw new Error(message);
}

describe('task database command protocol', () => {
  it('quotes default template and task identities so TASK hyphens remain one SQL identifier', () => {
    expect(rebuildTemplate({ databaseUrl: url })).toEqual({
      ok: true,
      action: 'rebuild-template',
      database: 'devai_template',
    });
    expect(provisionTask({ databaseUrl: url, taskId: 'TASK-9701' })).toEqual({
      ok: true,
      action: 'provision',
      database: 'devai_task_TASK-9701',
    });
    expect(calls()).toEqual([
      {
        executable: 'psql',
        argv: [url, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE IF EXISTS "devai_template"'],
      },
      {
        executable: 'psql',
        argv: [url, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE "devai_template"'],
      },
      {
        executable: 'psql',
        argv: [
          url,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          'CREATE DATABASE "devai_task_TASK-9701" TEMPLATE "devai_template"',
        ],
      },
    ]);
  });
  it('preserves case in caller-provided template and task prefix names', () => {
    expect(rebuildTemplate({ databaseUrl: url, templateName: 'Mixed_Template' })).toEqual({
      ok: true,
      action: 'rebuild-template',
      database: 'Mixed_Template',
    });
    expect(
      provisionTask({
        databaseUrl: url,
        templateName: 'Mixed_Template',
        taskDbPrefix: 'Mixed_',
        taskId: 'TASK-9701',
      }),
    ).toEqual({ ok: true, action: 'provision', database: 'Mixed_TASK-9701' });
    expect(calls().map((c) => c.argv)).toEqual([
      [url, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE IF EXISTS "Mixed_Template"'],
      [url, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE "Mixed_Template"'],
      [
        url,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'CREATE DATABASE "Mixed_TASK-9701" TEMPLATE "Mixed_Template"',
      ],
    ]);
  });
  it('terminates other connections before dropping the exact task database', () => {
    expect(dropTask({ databaseUrl: url, taskId: 'TASK-9701' })).toEqual({
      ok: true,
      action: 'drop',
      database: 'devai_task_TASK-9701',
    });
    expect(calls()).toEqual([
      {
        executable: 'psql',
        argv: [
          url,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='devai_task_TASK-9701' AND pid <> pg_backend_pid()",
        ],
      },
      {
        executable: 'psql',
        argv: [
          url,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          'DROP DATABASE IF EXISTS "devai_task_TASK-9701"',
        ],
      },
    ]);
  });
  it.each([
    'TASK-123',
    'TASK-1234;DROP DATABASE postgres',
    'xTASK-1234',
    'TASK-1234x',
    'TASK-abcd',
  ])('refuses malformed task %s without executing SQL', (taskId) => {
    for (const operation of [provisionTask, dropTask]) {
      const result = operation({ databaseUrl: url, taskId });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid task id ' + JSON.stringify(taskId));
    }
    expect(seam.execute).not.toHaveBeenCalled();
  });
  it.each(['', '1bad', 'bad-name', 'bad"name', 'bad;DROP'])(
    'refuses invalid SQL name %s before executing any command',
    (name) => {
      expect(rebuildTemplate({ databaseUrl: url, templateName: name })).toMatchObject({
        ok: false,
        action: 'rebuild-template',
        error: expect.stringContaining('invalid template name'),
      });
      expect(
        provisionTask({ databaseUrl: url, taskId: 'TASK-9701', templateName: name }),
      ).toMatchObject({
        ok: false,
        action: 'provision',
        error: expect.stringContaining('invalid template name'),
      });
      expect(
        provisionTask({ databaseUrl: url, taskId: 'TASK-9701', taskDbPrefix: name }),
      ).toMatchObject({
        ok: false,
        action: 'provision',
        error: expect.stringContaining('invalid task-db prefix'),
      });
      expect(dropTask({ databaseUrl: url, taskId: 'TASK-9701', taskDbPrefix: name })).toMatchObject(
        { ok: false, action: 'drop', error: expect.stringContaining('invalid task-db prefix') },
      );
      expect(seam.execute).not.toHaveBeenCalled();
    },
  );
  it('stops rebuilding when dropping the template fails and redacts every URL occurrence', () => {
    seam.execute.mockImplementationOnce(() => fail(`failed ${url}; retry ${url}`));
    expect(rebuildTemplate({ databaseUrl: url })).toEqual({
      ok: false,
      action: 'rebuild-template',
      database: 'devai_template',
      error: 'failed [REDACTED_DB_URL]; retry [REDACTED_DB_URL]',
    });
    expect(seam.execute).toHaveBeenCalledTimes(1);
  });
  it('reports a template creation failure after a successful drop', () => {
    seam.execute.mockReturnValueOnce('').mockImplementationOnce(() => fail('create denied'));
    expect(rebuildTemplate({ databaseUrl: url, templateName: 'fixture' })).toEqual({
      ok: false,
      action: 'rebuild-template',
      database: 'fixture',
      error: 'create denied',
    });
    expect(seam.execute).toHaveBeenCalledTimes(2);
  });
  it('reports non-Error failures without leaking the connection URL', () => {
    seam.execute.mockImplementationOnce(() => {
      throw `failed ${url}`;
    });
    expect(provisionTask({ databaseUrl: url, taskId: 'TASK-9701' })).toEqual({
      ok: false,
      action: 'provision',
      database: 'devai_task_TASK-9701',
      error: 'failed [REDACTED_DB_URL]',
    });
  });
  it('still attempts the task drop after a connection-termination failure', () => {
    seam.execute.mockImplementationOnce(() => fail('terminate denied')).mockReturnValueOnce('');
    expect(dropTask({ databaseUrl: url, taskDbPrefix: 'Isolated_', taskId: 'TASK-9701' })).toEqual({
      ok: true,
      action: 'drop',
      database: 'Isolated_TASK-9701',
    });
    expect(calls()[1]?.argv).toEqual([
      url,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP DATABASE IF EXISTS "Isolated_TASK-9701"',
    ]);
  });
  it('reports a failed drop with its exact database and redacted error', () => {
    seam.execute.mockReturnValueOnce('').mockImplementationOnce(() => fail(`drop failed ${url}`));
    expect(dropTask({ databaseUrl: url, taskId: 'TASK-9701' })).toEqual({
      ok: false,
      action: 'drop',
      database: 'devai_task_TASK-9701',
      error: 'drop failed [REDACTED_DB_URL]',
    });
  });
  it('explicitly refuses the deferred dedicated-cluster operation without effects', () => {
    expect(provisionCluster({ taskId: 'TASK-9701' })).toEqual({
      ok: false,
      action: 'provision-cluster',
      database: 'devai_cluster_TASK-9701',
      error:
        'Phase-5 MVP: dedicated-container isolation deferred; use the shared-cluster path (provision) instead.',
    });
    expect(seam.execute).not.toHaveBeenCalled();
  });
});

describe('shared database Docker command protocol', () => {
  it('reports an unavailable Docker engine before inspecting or creating containers', () => {
    seam.execute.mockImplementationOnce(() => fail('offline'));
    expect(startShared({ password: 'secret' })).toEqual({
      ok: false,
      action: 'start-shared',
      error:
        'docker CLI not available or daemon not running. Install Docker Desktop or set up Postgres manually and use --database-url to point at it.',
    });
    expect(calls()).toEqual([
      { executable: 'docker', argv: ['version', '--format', '{{.Server.Version}}'] },
    ]);
  });
  it('treats a matching running container as an exact no-op', () => {
    seam.execute.mockReturnValueOnce('29.5').mockReturnValueOnce(' devai-shared-pg\n');
    expect(startShared({ password: 'secret' })).toEqual({
      ok: true,
      action: 'start-shared',
      connection: {
        host: '127.0.0.1',
        port: 5433,
        user: 'postgres',
        database: 'postgres',
        redacted_url: 'postgresql://postgres:***@127.0.0.1:5433/postgres',
      },
    });
    expect(calls()).toEqual([
      { executable: 'docker', argv: ['version', '--format', '{{.Server.Version}}'] },
      {
        executable: 'docker',
        argv: ['ps', '--filter', 'name=^devai-shared-pg$', '--format', '{{.Names}}'],
      },
    ]);
  });
  it('starts a matching stopped container before considering creation', () => {
    seam.execute
      .mockReturnValueOnce('29.5')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('fixture\n')
      .mockReturnValueOnce('fixture');
    expect(
      startShared({ password: 'secret', containerName: 'fixture', port: 6543 }).connection,
    ).toEqual({
      host: '127.0.0.1',
      port: 6543,
      user: 'postgres',
      database: 'postgres',
      redacted_url: 'postgresql://postgres:***@127.0.0.1:6543/postgres',
    });
    expect(calls().slice(1)).toEqual([
      {
        executable: 'docker',
        argv: ['ps', '--filter', 'name=^fixture$', '--format', '{{.Names}}'],
      },
      {
        executable: 'docker',
        argv: ['ps', '-a', '--filter', 'name=^fixture$', '--format', '{{.Names}}'],
      },
      { executable: 'docker', argv: ['start', 'fixture'] },
    ]);
  });
  it('creates a missing container using an environment password rather than putting it in argv', () => {
    seam.execute
      .mockReturnValueOnce('29.5')
      .mockReturnValueOnce('unrelated')
      .mockReturnValueOnce('unrelated')
      .mockReturnValueOnce('newid');
    expect(
      startShared({
        password: 'secret',
        containerName: 'fixture',
        port: 6543,
        image: 'postgres:fixture',
      }).ok,
    ).toBe(true);
    const invocation = seam.execute.mock.calls[3];
    expect(invocation?.[0]).toBe('docker');
    expect(invocation?.[1]).toEqual([
      'run',
      '--rm',
      '-d',
      '--name',
      'fixture',
      '-p',
      '6543:5432',
      '-e',
      'POSTGRES_PASSWORD',
      'postgres:fixture',
    ]);
    expect(invocation?.[2]).toMatchObject({
      env: { POSTGRES_PASSWORD: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
  it('continues to fresh creation after inspection failures and uses the default image', () => {
    seam.execute
      .mockReturnValueOnce('29.5')
      .mockImplementationOnce(() => fail('ps failed'))
      .mockImplementationOnce(() => fail('all failed'))
      .mockReturnValueOnce('newid');
    expect(startShared({ password: 'secret' }).ok).toBe(true);
    expect(calls()[3]?.argv).toEqual([
      'run',
      '--rm',
      '-d',
      '--name',
      'devai-shared-pg',
      '-p',
      '5433:5432',
      '-e',
      'POSTGRES_PASSWORD',
      'postgres:15-alpine',
    ]);
  });
  it('redacts all password occurrences in a failed fresh creation', () => {
    seam.execute
      .mockReturnValueOnce('29.5')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => fail('secret creation secret'));
    expect(startShared({ password: 'secret' })).toEqual({
      ok: false,
      action: 'start-shared',
      error: '[REDACTED] creation [REDACTED]',
    });
  });
  it('stops only the requested shared container and reports failures', () => {
    expect(stopShared()).toEqual({ ok: true, action: 'stop-shared' });
    expect(calls()).toEqual([{ executable: 'docker', argv: ['stop', 'devai-shared-pg'] }]);
    seam.execute.mockImplementationOnce(() => fail('stop denied'));
    expect(stopShared({ containerName: 'fixture' })).toEqual({
      ok: false,
      action: 'stop-shared',
      error: 'stop denied',
    });
    expect(calls()[1]?.argv).toEqual(['stop', 'fixture']);
  });
  it('reports a running container and sorted SQL rows without empty entries', () => {
    seam.execute
      .mockReturnValueOnce('fixture\n')
      .mockReturnValueOnce(' devai_task_TASK-9701 \n\ndevai_task_TASK-9702\n');
    expect(clusterStatus({ containerName: 'fixture', databaseUrl: url })).toEqual({
      ok: true,
      container: { name: 'fixture', running: true },
      task_dbs: ['devai_task_TASK-9701', 'devai_task_TASK-9702'],
    });
    expect(calls()[1]).toEqual({
      executable: 'psql',
      argv: [
        url,
        '-t',
        '-A',
        '-c',
        "SELECT datname FROM pg_database WHERE datname LIKE 'devai_task_%' ORDER BY datname",
      ],
    });
  });
  it('does not query a database for a nonmatching or absent container', () => {
    seam.execute.mockReturnValueOnce('unrelated');
    expect(clusterStatus({ databaseUrl: url })).toEqual({
      ok: true,
      container: { name: 'devai-shared-pg', running: false },
      task_dbs: [],
    });
    expect(seam.execute).toHaveBeenCalledTimes(1);
  });
  it('does not query databases without a URL even when the container runs', () => {
    seam.execute.mockReturnValueOnce('devai-shared-pg');
    expect(clusterStatus({})).toEqual({
      ok: true,
      container: { name: 'devai-shared-pg', running: true },
      task_dbs: [],
    });
    expect(seam.execute).toHaveBeenCalledTimes(1);
  });
  it('reports Docker inspection failure and tolerates an unavailable database listing', () => {
    seam.execute.mockImplementationOnce(() => fail('unavailable'));
    expect(clusterStatus({})).toEqual({
      ok: false,
      container: { name: 'devai-shared-pg', running: false },
      task_dbs: [],
      error: 'docker CLI not available',
    });
    seam.execute
      .mockReturnValueOnce('fixture')
      .mockImplementationOnce(() => fail('db unavailable'));
    expect(clusterStatus({ containerName: 'fixture', databaseUrl: url })).toEqual({
      ok: true,
      container: { name: 'fixture', running: true },
      task_dbs: [],
    });
  });
});
