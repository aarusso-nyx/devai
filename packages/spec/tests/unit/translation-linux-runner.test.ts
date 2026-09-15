import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLinuxIsolated } from '../../src/translation-validation/index.js';

let root: string;
const marker = 'DEVAI_TRANSLATION_ISOLATION_STARTED\n';
const result = { status: 0, signal: null, stdout: marker + 'output', stderr: '' } as const;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-linux-runner-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function input() {
  return {
    repo_root: root,
    image: 'sha256:' + 'a'.repeat(64),
    argv: ['node', 'test.mjs', 'literal; argument'],
    timeout_ms: 12000,
  };
}

describe('Linux translation runner control contract', () => {
  it('passes literal argv with read-only workspace and disabled network and strips only its startup marker', async () => {
    const options = input();
    const calls: unknown[] = [];
    const actual = await runLinuxIsolated({
      ...options,
      spawn: (command, args, opts) => {
        calls.push([command, args, opts]);
        return result;
      },
    });
    expect(calls).toEqual([
      [
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=bind,src=${root},dst=/workspace,readonly`,
          '--workdir',
          '/workspace',
          options.image,
          'sh',
          '-c',
          'printf \'%s\\n\' DEVAI_TRANSLATION_ISOLATION_STARTED; exec "$@"',
          'devai-translation-isolation',
          ...options.argv,
        ],
        { encoding: 'utf8', timeout: 12000 },
      ],
    ]);
    expect(actual).toEqual({ exit_code: 0, stdout: 'output', stderr: '', isolation_applied: true });
  });

  it.each([
    '',
    'output\n' + marker,
    'DEVAI_TRANSLATION_ISOLATION_STARTED',
    'DEVAI_TRANSLATION_ISOLATION_STARTEDx\n',
  ])('does not claim startup from a missing or misplaced marker %j', async (stdout) => {
    const actual = await runLinuxIsolated({ ...input(), spawn: () => ({ ...result, stdout }) });
    expect(actual.isolation_applied).toBe(false);
    expect(actual.stdout).toBe(stdout);
  });

  it('decodes buffered streams and preserves explicit nonzero exit status', async () => {
    expect(
      await runLinuxIsolated({
        ...input(),
        spawn: () => ({
          status: 7,
          signal: null,
          stdout: Buffer.from(marker + 'failure\n'),
          stderr: Buffer.from('reason\n'),
        }),
      }),
    ).toEqual({ exit_code: 7, stdout: 'failure\n', stderr: 'reason\n', isolation_applied: true });
  });

  it.each([null, 'SIGTERM'] as const)(
    'reports a missing process status and signal %s as a failure',
    async (signal) => {
      expect(
        await runLinuxIsolated({
          ...input(),
          spawn: () => ({
            status: null,
            signal,
            stdout: null,
            stderr: null,
            error: new Error('spawn failed'),
          }),
        }),
      ).toEqual({
        exit_code: signal === null ? 1 : 128,
        stdout: '',
        stderr: 'spawn failed',
        isolation_applied: false,
      });
    },
  );

  it('requires both mount adapters before invoking Docker when shared dependencies need a mount point', async () => {
    const deps = join(root, 'deps');
    mkdirSync(join(deps, 'node_modules'), { recursive: true });
    let spawned = false;
    await expect(
      runLinuxIsolated({
        ...input(),
        dependencies_root: deps,
        spawn: () => {
          spawned = true;
          return result;
        },
      }),
    ).rejects.toThrow('LINUX_DEPENDENCY_MOUNT_ADAPTER_MISSING');
    expect(spawned).toBe(false);
  });

  it('prepares and removes only the created mount point around a shared-dependency run', async () => {
    const deps = join(root, 'deps');
    mkdirSync(join(deps, 'node_modules'), { recursive: true });
    const mount = join(root, 'node_modules');
    const calls: string[] = [];
    await runLinuxIsolated({
      ...input(),
      dependencies_root: deps,
      prepare_dependency_mount_point: (path) => {
        calls.push(`prepare:${path}`);
        mkdirSync(path);
      },
      remove_dependency_mount_point: (path) => {
        calls.push(`remove:${path}`);
        rmSync(path, { recursive: true });
      },
      spawn: (_command, args) => {
        calls.push('spawn');
        expect(existsSync(mount)).toBe(true);
        expect(args).toContain(
          `type=bind,src=${join(deps, 'node_modules')},dst=/workspace/node_modules,readonly`,
        );
        return result;
      },
    });
    expect(calls).toEqual([`prepare:${mount}`, 'spawn', `remove:${mount}`]);
    expect(existsSync(mount)).toBe(false);
  });

  it('does not remove an existing dependency directory', async () => {
    const deps = join(root, 'deps');
    mkdirSync(join(deps, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    await runLinuxIsolated({
      ...input(),
      dependencies_root: deps,
      spawn: () => result,
      remove_dependency_mount_point: () => {
        throw new Error('must not remove');
      },
    });
    expect(existsSync(join(root, 'node_modules'))).toBe(true);
  });

  it('preserves the original thrown process error after removing its temporary mount point', async () => {
    const deps = join(root, 'deps');
    mkdirSync(join(deps, 'node_modules'), { recursive: true });
    const failure = new Error('container start failed');
    await expect(
      runLinuxIsolated({
        ...input(),
        dependencies_root: deps,
        prepare_dependency_mount_point: (path) => mkdirSync(path),
        remove_dependency_mount_point: (path) => rmSync(path, { recursive: true }),
        spawn: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });
});
