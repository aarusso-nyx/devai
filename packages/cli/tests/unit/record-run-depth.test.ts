import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const spawnSyncMock = vi.hoisted(() =>
  vi.fn((command: string, args?: readonly string[]) => {
    if (args === undefined) return { status: 0, stdout: '', stderr: '', signal: null };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { status: 0, stdout: 'main\n', stderr: '', signal: null };
    }
    if (command === 'git')
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', signal: null };
    const shell = args[1] ?? '';
    if (shell.includes('exit 1'))
      return { status: 1, stdout: 'out\n', stderr: 'err\n', signal: null };
    if (shell.includes('exit 7')) return { status: 7, stdout: '', stderr: 'fatal\n', signal: null };
    return {
      status: 0,
      stdout: shell.includes('clean') ? 'clean\n' : 'hello\n',
      stderr: '',
      signal: null,
    };
  }),
);
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: spawnSyncMock,
}));
import { recordRun } from '../../src/commands/record/run.js';

type Options = {
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
  action(callback: (options: Options) => Promise<void>): Capture;
};
let invoke: (options: Options) => Promise<void>;
const roots: string[] = [];
const oldExit = process.exit;
const oldCode = process.exitCode;
const oldOut = process.stdout.write;
const oldErr = process.stderr.write;

beforeAll(() => {
  const command: Capture = {
    command: () => command,
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  recordRun.register({ command: () => command } as unknown as CAC);
});

beforeEach(() => spawnSyncMock.mockClear());

afterEach(() => {
  process.exit = oldExit;
  process.exitCode = oldCode;
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-record-run-depth-'));
  roots.push(root);
  return root;
}

async function run(options: Options): Promise<{ stdout: string; stderr: string; exit: number }> {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  let requestedExit: number | undefined;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    process.exitCode = code ?? 0;
    requestedExit = code ?? 0;
    return undefined as never;
  }) as typeof process.exit;
  try {
    await withAuthorityHostTestScope(() => invoke(options));
  } finally {
    exit = requestedExit ?? process.exitCode ?? exit;
    process.exit = oldExit;
    process.exitCode = oldCode;
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
  return { stdout, stderr, exit };
}

describe('record run command boundaries', () => {
  it('records a successful child with its log and fixed metadata', async () => {
    const repoRoot = fixture();
    const result = await run({
      repoRoot,
      tier: 'unit',
      cmd: "printf 'hello\\n'",
      scope: '@demo/pkg',
      timestamp: '2026-09-09T00:00:00.000Z',
    });
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('');
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: '1.0.0',
      repo: expect.stringMatching(/^devai-record-run-depth-/u),
      scope: '@demo/pkg',
      tier: 'unit',
      timestamp: '2026-09-09T00:00:00.000Z',
      status: 'pass',
      command: "printf 'hello\\n'",
      exit_code: 0,
      signal: null,
      env: { branch: 'main', commit: 'a'.repeat(40) },
      metrics: { duration_ms: expect.any(Number) },
    });
    const outputDir = join(repoRoot, '.devai/state/test-results', '-demo-pkg', 'unit.json');
    expect(JSON.parse(readFileSync(outputDir, 'utf8'))).toEqual(record);
    expect(
      readFileSync(join(repoRoot, '.devai/state/test-results', '-demo-pkg', 'unit.log'), 'utf8'),
    ).toBe('hello\n');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "printf 'hello\\n'"],
      expect.objectContaining({ cwd: repoRoot, maxBuffer: 1024 * 1024 * 64 }),
    );
  });

  it('records child failure output and forwards exit status', async () => {
    const repoRoot = fixture();
    const result = await run({
      repoRoot,
      tier: 'api',
      cmd: "printf 'out\\n'; printf 'err\\n' >&2; exit 1",
    });
    expect(result.exit).toBe(1);
    const record = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(record).toMatchObject({ status: 'fail', tier: 'api', exit_code: 1, signal: null });
    const generatedDir = readdirSync(join(repoRoot, '.devai/state/test-results'))[0];
    if (generatedDir === undefined) throw new Error('generated result directory missing');
    expect(generatedDir).toMatch(/^devai-record-run-depth-/u);
    expect(
      readFileSync(join(repoRoot, '.devai/state/test-results', generatedDir, 'api.log'), 'utf8'),
    ).toBe('out\nerr\n');
  });

  it('classifies an unexpected child exit as error while preserving the code', async () => {
    const repoRoot = fixture();
    const result = await run({ repoRoot, tier: 'db', cmd: "printf 'fatal\\n' >&2; exit 7" });
    expect(result.exit).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', exit_code: 7 });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "printf 'fatal\\n' >&2; exit 7"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it('uses an explicit absolute output and sanitized repo metadata in human mode', async () => {
    const repoRoot = fixture();
    const out = join(repoRoot, 'custom/result.json');
    const result = await run({
      repoRoot,
      tier: 'lint',
      cmd: "printf 'clean\\n'",
      repo: 'Release Repo! 1',
      scope: 'docs/pkg',
      out,
      human: true,
      timestamp: '2026-09-09T00:00:00.000Z',
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toMatch(/^devai evidence test record: PASS lint docs-pkg \(\d+ms\) on /u);
    const record = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      repo: 'release-repo--1',
      scope: 'docs/pkg',
      tier: 'lint',
      status: 'pass',
    });
    expect(record.evidence).toEqual({ log_path: join(repoRoot, 'custom/lint.log') });
    expect(readdirSync(join(repoRoot, 'custom')).sort()).toEqual(['lint.log', 'result.json']);
  });
});
