import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const actionOutputBoundary = vi.hoisted(() => ({ forceExit: false }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: spawnSyncMock,
}));

vi.mock('../../src/action-output.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/action-output.js')>();
  return {
    ...original,
    isActionOutputExit: (error: unknown) =>
      actionOutputBoundary.forceExit || original.isActionOutputExit(error),
  };
});

import type { CommandDefinition } from '../../src/define-command.js';
import { invokeCommandService } from '../../src/commands/evidence/direct-command.js';
import { recordRun } from '../../src/commands/record/run.js';

type RecordOptions = {
  readonly tier?: string;
  readonly cmd?: string;
  readonly scope?: string;
  readonly repo?: string;
  readonly out?: string;
  readonly repoRoot: string;
  readonly human?: boolean;
  readonly timestamp?: string;
};

type Capture = {
  command(): Capture;
  option(): Capture;
  action(callback: (options: RecordOptions) => Promise<void>): Capture;
};

const roots: string[] = [];
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalCi = process.env['CI'];
let invokeRecord: (options: RecordOptions) => Promise<void>;
let registrationCommand: readonly [string, string] | undefined;
let registrationOptions: Array<readonly [string, string]> = [];

beforeAll(() => {
  const chain: Capture = {
    command: () => chain,
    option: () => chain,
    action: (callback) => {
      invokeRecord = callback;
      return chain;
    },
  };
  const cli = {
    command(name: string, description: string): Capture {
      registrationCommand = [name, description];
      registrationOptions = [];
      const capture: Capture = {
        command: () => capture,
        option(flag?: string, description?: string) {
          registrationOptions.push([flag ?? '', description ?? '']);
          return capture;
        },
        action(callback) {
          invokeRecord = callback;
          return capture;
        },
      };
      return capture;
    },
  };
  recordRun.register(cli as unknown as CAC);
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  actionOutputBoundary.forceExit = false;
  process.env['CI'] = originalCi;
});

afterEach(() => {
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  if (originalCi === undefined) delete process.env['CI'];
  else process.env['CI'] = originalCi;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-s07-record-'));
  roots.push(root);
  return root;
}

function successfulSpawn(command: string, args?: readonly string[]) {
  if (command === 'git' && args?.[1] === '--abbrev-ref')
    return { status: 0, stdout: 'release/v1.5\n', stderr: '', signal: null };
  if (command === 'git')
    return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '', signal: null };
  return { status: 0, stdout: 'child-out\n', stderr: 'child-err\n', signal: null };
}

async function captureRecord(options: RecordOptions) {
  let stdout = '';
  let stderr = '';
  let exit: number | undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number | string | null) => {
    exit = Number(code ?? 0);
    process.exitCode = exit;
    return undefined as never;
  }) as typeof process.exit;
  process.exitCode = undefined;
  await withAuthorityHostTestScope(() => invokeRecord(options));
  return { stdout, stderr, exit };
}

function definition(name: string, callback?: (...args: unknown[]) => unknown): CommandDefinition {
  return {
    name,
    description: `${name} description`,
    authority: 'mesh_controller',
    register(cli: CAC): void {
      const command = cli.command(name, `${name} command`);
      command.option('--value <value>', 'value option');
      if (callback !== undefined) command.action(callback);
    },
  };
}

describe('S07-D record command exact boundaries', () => {
  it('retains the public command and complete option vocabulary', () => {
    expect(recordRun).toMatchObject({
      name: 'record run',
      description:
        'Run a test command, capture stdout/stderr + exit code, and emit a test-result.schema.json record under .devai/state/test-results/. Example: `devai evidence test record --tier unit --scope @my/pkg --cmd "pnpm --filter @my/pkg test:unit"`.',
      authority: 'mesh_controller',
    });
    expect(registrationCommand).toEqual([
      'record-run',
      'Run a test command and emit a canonical test-result record',
    ]);
    expect(registrationOptions).toEqual([
      ['--tier <tier>', 'Tier: unit|api|db|e2e|mutation|perf|lint|typecheck|coverage (required)'],
      ['--cmd <command>', 'Shell command to run (required). Quoted; runs via `sh -c`.'],
      ['--scope <scope>', 'Optional sub-scope (e.g. package name)'],
      ['--repo <slug>', 'Repo slug (default: directory name)'],
      [
        '--out <path>',
        'Output file path (default: .devai/state/test-results/<scope-or-repo>/<tier>.json)',
      ],
      ['--repo-root <path>', 'Repo root (default: cwd)'],
      ['--timestamp <iso>', 'Override timestamp (default: now)'],
      ['--human', 'Human-readable banner; otherwise emits the record JSON to stdout'],
    ]);
  });

  it('accepts every declared tier and rejects invalid tier and missing command exactly', async () => {
    spawnSyncMock.mockImplementation(successfulSpawn);
    for (const tier of [
      'unit',
      'api',
      'db',
      'e2e',
      'mutation',
      'perf',
      'lint',
      'typecheck',
      'coverage',
    ]) {
      const result = await captureRecord({ repoRoot: fixture(), tier, cmd: `run-${tier}` });
      expect(JSON.parse(result.stdout)).toMatchObject({ tier, command: `run-${tier}` });
    }

    const invalid = await captureRecord({ repoRoot: fixture(), tier: 'invalid', cmd: 'run' });
    expect(invalid.stderr).toContain(
      'devai evidence test record: --tier must be one of: unit, api, db, e2e, mutation, perf, lint, typecheck, coverage\n',
    );
    const missing = await captureRecord({ repoRoot: fixture(), tier: 'unit' });
    expect(missing.stderr).toContain('devai evidence test record: --cmd is required\n');
    const empty = await captureRecord({ repoRoot: fixture(), tier: 'unit', cmd: '' });
    expect(empty.stderr).toContain('devai evidence test record: --cmd is required\n');
  });

  it('encodes the complete deterministic ULID shape and exact record fields', async () => {
    const root = fixture();
    spawnSyncMock.mockImplementation(successfulSpawn);
    vi.spyOn(Date, 'now').mockReturnValue(33);
    vi.spyOn(Math, 'random').mockReturnValue(31 / 32);
    process.env['CI'] = '1';
    const result = await captureRecord({
      repoRoot: root,
      tier: 'coverage',
      cmd: 'run coverage',
      repo: 'Repo Name!',
      scope: 'scope/name',
      timestamp: '2026-09-11T00:00:00.000Z',
    });
    if (result.stdout.length === 0) throw new Error(`EMPTY_RECORD:${JSON.stringify(result)}`);
    expect(result).toEqual(expect.objectContaining({ exit: 0, stderr: '' }));
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(record).toEqual({
      schemaVersion: '1.0.0',
      id: `TR-0000000011${'Z'.repeat(16)}`,
      repo: 'repo-name-',
      scope: 'scope/name',
      tier: 'coverage',
      timestamp: '2026-09-11T00:00:00.000Z',
      status: 'pass',
      command: 'run coverage',
      env: {
        node: process.version,
        os: `${process.platform}-${process.arch}`,
        branch: 'release/v1.5',
        commit: 'b'.repeat(40),
        ci: true,
      },
      metrics: { duration_ms: 0 },
      evidence: { log_path: '.devai/state/test-results/scope-name/coverage.log' },
      exit_code: 0,
      signal: null,
    });
    expect(
      readFileSync(join(root, '.devai/state/test-results/scope-name/coverage.log'), 'utf8'),
    ).toBe('child-out\nchild-err\n');
  });

  it('preserves failed Git identity, nullable process output, signal and elapsed time', async () => {
    const root = fixture();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(100).mockReturnValueOnce(145).mockReturnValue(33);
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === 'git') return { status: 3, stdout: 'ignored\n', stderr: 'no git\n' };
      return { status: 7, stdout: null, stderr: undefined, signal: 'SIGTERM' };
    });
    delete process.env['CI'];
    const result = await captureRecord({
      repoRoot: root,
      tier: 'perf',
      cmd: 'terminate',
      timestamp: '2026-09-11T00:00:00.000Z',
    });
    expect(result.exit).toBe(7);
    expect(result.stderr).toBe('');
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(record).toMatchObject({
      status: 'error',
      exit_code: 7,
      signal: 'SIGTERM',
      env: {
        branch: 'detached',
        commit: '0000000000000000000000000000000000000000',
        ci: false,
      },
      metrics: { duration_ms: 45 },
      evidence: { log_path: expect.stringMatching(/perf\.log$/u) },
    });
    expect(Object.hasOwn(record, 'scope')).toBe(false);
    const slug = root.split('/').at(-1)?.toLowerCase() ?? '';
    const outputPath = join(root, '.devai/state/test-results', slug, 'perf.json');
    expect(readFileSync(join(root, '.devai/state/test-results', slug, 'perf.log'), 'utf8')).toBe(
      '',
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(result.stdout).toBe(`${JSON.stringify(record)}\n`);
    expect(spawnSyncMock.mock.calls.slice(1)).toEqual([
      ['git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }],
      ['git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }],
    ]);
  });

  it.each([1, 2] as const)('classifies exit %i as fail', async (exitCode) => {
    const root = fixture();
    spawnSyncMock.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === 'git') return successfulSpawn(command, args);
      return { status: exitCode, stdout: '', stderr: '', signal: null };
    });
    const result = await captureRecord({ repoRoot: root, tier: 'unit', cmd: `exit ${exitCode}` });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'fail', exit_code: exitCode });
  });

  it('rethrows an action-output exit without translating its identity', async () => {
    const sentinel = new Error('action-output-exit');
    actionOutputBoundary.forceExit = true;
    spawnSyncMock.mockImplementation(() => {
      throw sentinel;
    });
    await expect(
      captureRecord({ repoRoot: fixture(), tier: 'unit', cmd: 'action-exit' }),
    ).rejects.toBe(sentinel);
  });

  it('distinguishes the CI true spelling and reports thrown child failures exactly', async () => {
    const root = fixture();
    process.env['CI'] = 'true';
    spawnSyncMock.mockImplementation(successfulSpawn);
    const success = await captureRecord({ repoRoot: root, tier: 'unit', cmd: 'ok' });
    expect(JSON.parse(success.stdout)).toMatchObject({ env: { ci: true } });

    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawn-failed');
    });
    const failed = await captureRecord({ repoRoot: fixture(), tier: 'unit', cmd: 'explode' });
    expect(failed).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence test record: spawn-failed\n',
    });
  });
});

describe('S07-D direct evidence command service boundaries', () => {
  it('refuses a definition that fails to register an action with its exact identity', async () => {
    await expect(invokeCommandService(definition('evidence missing'), [])).rejects.toThrow(
      'EVIDENCE_SERVICE_ACTION_MISSING:evidence missing',
    );
  });

  it('captures byte output, explicit string exit and restores all process controls', async () => {
    const priorStdout = process.stdout.write;
    const priorStderr = process.stderr.write;
    const priorExit = process.exit;
    const priorCode = process.exitCode;
    const result = await invokeCommandService(
      definition('evidence bytes', (value: unknown) => {
        expect(value).toBe('payload');
        process.stdout.write(Buffer.from('out-bytes'));
        process.stderr.write(Buffer.from('err-bytes'));
        process.exit('7');
      }),
      ['payload'],
    );
    expect(result).toEqual({ exitCode: 7, stdout: 'out-bytes', stderr: 'err-bytes' });
    expect(process.stdout.write).toBe(priorStdout);
    expect(process.stderr.write).toBe(priorStderr);
    expect(process.exit).toBe(priorExit);
    expect(process.exitCode).toBe(priorCode);
  });

  it('defaults a successful action without an exit request to code zero', async () => {
    const result = await invokeCommandService(
      definition('evidence implicit success', () => {
        process.stdout.write('implicit');
      }),
      [],
    );
    expect(result).toEqual({ exitCode: 0, stdout: 'implicit', stderr: '' });
  });

  it('uses a numeric process exitCode when there is no explicit exit', async () => {
    const result = await invokeCommandService(
      definition('evidence exit-code', () => {
        process.exitCode = 6;
        process.stdout.write('done');
      }),
      [],
    );
    expect(result).toEqual({ exitCode: 6, stdout: 'done', stderr: '' });
  });

  it('normalizes a string process exitCode without replacing it with success', async () => {
    const result = await invokeCommandService(
      definition('evidence string exit-code', () => {
        (process as typeof process & { exitCode?: number | string }).exitCode = '6';
      }),
      [],
    );
    expect(result).toEqual({ exitCode: 6, stdout: '', stderr: '' });
  });

  it('renders a thrown non-Error when stderr is empty and retains prior stderr otherwise', async () => {
    const empty = await invokeCommandService(
      definition('evidence throw value', () => {
        throw 'refused-value';
      }),
      [],
    );
    expect(empty).toEqual({ exitCode: 2, stdout: '', stderr: 'refused-value\n' });

    const retained = await invokeCommandService(
      definition('evidence throw error', () => {
        process.stdout.write('before');
        process.stderr.write('specific refusal\n');
        throw new Error('generic refusal');
      }),
      [],
    );
    expect(retained).toEqual({ exitCode: 2, stdout: 'before', stderr: 'specific refusal\n' });
  });
});
