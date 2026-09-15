import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const spawnSyncMock = vi.hoisted(() =>
  vi.fn((command: string, args: readonly string[] = []) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { status: 0, stdout: 'main\n', stderr: '', signal: null };
    }
    if (command === 'git') {
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', signal: null };
    }
    return { status: 0, stdout: 'test passed\n', stderr: '', signal: null };
  }),
);

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: spawnSyncMock,
}));

import { evidenceRecord } from '../../src/commands/evidence/facade.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-evidence-record-test-'));
  roots.push(value);
  return value;
}

async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  const cli = cac('devai-evidence-record-test');
  evidenceRecord.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

afterEach(() => {
  spawnSyncMock.mockClear();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('evidence record test-service boundaries', () => {
  it('preserves the facade refusal for an invalid test tier', async () => {
    const result = await invoke([
      'evidence-record',
      '--kind',
      'test',
      '--round',
      'R-0123',
      '--repo-root',
      root(),
      '--tier',
      'unknown',
      '--cmd',
      'node -e "process.exit(0)"',
    ]);

    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr:
        'devai evidence record: --tier must be one of: unit, api, db, e2e, mutation, perf, lint, typecheck, coverage\n',
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('preserves the facade refusal for a missing test command', async () => {
    const result = await invoke([
      'evidence-record',
      '--kind',
      'test',
      '--round',
      'R-0123',
      '--repo-root',
      root(),
      '--tier',
      'unit',
    ]);

    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence record: --cmd is required for --kind test\n',
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('forwards every test option and records the governed service result', async () => {
    const repo = root();
    const out = 'custom/test-result.json';
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const command = 'node -e "process.exit(0)"';
    mkdirSync(dirname(join(repo, out)), { recursive: true });

    const result = await invoke([
      'evidence-record',
      '--kind',
      'test',
      '--round',
      'R-0123',
      '--repo-root',
      repo,
      '--tier',
      'unit',
      '--cmd',
      command,
      '--scope',
      '@fixture/pkg',
      '--repo',
      'Fixture Repo',
      '--out',
      out,
      '--timestamp',
      timestamp,
    ]);

    expect(result).toMatchObject({ exit: 0, stderr: '' });
    const payload = JSON.parse(result.stdout) as {
      kind: string;
      round_id: string;
      result: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      kind: 'test',
      round_id: 'R-0123',
      result: {
        repo: 'fixture-repo',
        scope: '@fixture/pkg',
        tier: 'unit',
        timestamp,
        status: 'pass',
        command,
        exit_code: 0,
      },
    });
    expect(JSON.parse(readFileSync(join(repo, out), 'utf8'))).toEqual(payload.result);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'sh',
      ['-c', command],
      expect.objectContaining({ cwd: repo }),
    );
  });
});
