import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildSensorReading } from '../../../sensors/src/sensor-reading.js';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW } from '../../../utils/src/exit.js';

const controls = vi.hoisted(() => ({
  defaultRepoRoot: undefined as string | undefined,
  opaqueReadFailure: undefined as unknown,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      if (String(args[0]).endsWith('/opaque.json')) throw controls.opaqueReadFailure;
      return (actual.readFileSync as (...values: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
  };
});

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    resolve: ((...paths: string[]) =>
      controls.defaultRepoRoot !== undefined && paths.length === 1 && paths[0] === '.'
        ? controls.defaultRepoRoot
        : actual.resolve(...paths)) as typeof actual.resolve,
  };
});

const { senseRecordCmd } = await import('../../src/commands/sense/record.js');

const roots: string[] = [];

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-shard09-sense-record-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, body: string): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
  return absolute;
}

async function invoke(args: readonly string[]): Promise<InvocationResult> {
  const cli = cac('devai-shard09-sense-record');
  senseRecordCmd.register(cli);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', 'sense-record', ...args];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    cli.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

afterEach(() => {
  controls.defaultRepoRoot = undefined;
  controls.opaqueReadFailure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI shard 09 sense record register boundaries', () => {
  it('renders rebuild results and maps pass review and fail exits', async () => {
    const defaultRoot = repository();
    controls.defaultRepoRoot = defaultRoot;
    const defaulted = await invoke(['--rebuild']);
    expect(defaulted.exit).toBe(EXIT_REVIEW);
    expect(JSON.parse(defaulted.stdout)).toMatchObject({
      report: { repo_root: defaultRoot },
      reading: { status: 'review' },
    });
    controls.defaultRepoRoot = undefined;

    const passRoot = repository();
    put(passRoot, '.devai/state/sensors/inventory_api/api.json', '{"routes":1}\n');
    const pass = await invoke(['--rebuild', '--repo-root', passRoot, '--human']);
    expect(pass).toEqual({
      exit: EXIT_PASS,
      stdout: 'devai sense record --rebuild: PASS created=1 skipped=0\n',
      stderr: '',
    });

    const reviewRoot = repository();
    const review = await invoke(['--rebuild', '--repo-root', reviewRoot]);
    expect(review.exit).toBe(EXIT_REVIEW);
    expect(review.stderr).toBe('');
    expect(review.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(review.stdout)).toMatchObject({
      report: { ok: true, repo_root: reviewRoot, created: 0, skipped: 0, errors: [] },
      reading: { status: 'review' },
    });

    const failRoot = repository();
    put(failRoot, '.devai/state/sensors/inventory_api/broken.json', '{broken');
    const fail = await invoke(['--rebuild', '--repo-root', failRoot]);
    expect(fail.exit).toBe(EXIT_FAIL);
    expect(fail.stderr).toBe('');
    expect(fail.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(fail.stdout)).toMatchObject({
      report: { ok: false, repo_root: failRoot, created: 0, skipped: 0 },
      reading: { status: 'fail' },
    });
  });

  it('renders created and already-recorded input results', async () => {
    const root = repository();
    const reading = buildSensorReading({
      sensorName: 'build',
      sensorKind: 'build',
      command: ['pnpm', 'build'],
      status: 'pass',
      deterministic: true,
      timestamp: '2026-09-11T08:00:00.000Z',
    });
    const input = put(root, 'reading.json', `${JSON.stringify(reading)}\n`);
    const target = join(root, '.devai/state/sensor-readings/build', `${reading.id}.json`);

    const created = await invoke(['--repo-root', root, '--input', input]);
    expect(created).toEqual({
      exit: EXIT_PASS,
      stdout: `${JSON.stringify({ path: target, action: 'created', reading })}\n`,
      stderr: '',
    });

    const existing = await invoke(['--repo-root', root, '--input', input, '--human']);
    expect(existing).toEqual({
      exit: EXIT_PASS,
      stdout: `devai sense record: already-recorded ${target}\n`,
      stderr: '',
    });
  });

  it('preserves Error and opaque failure diagnostics', async () => {
    const root = repository();
    const malformed = put(root, 'malformed.json', '{broken');
    const error = await invoke(['--repo-root', root, '--input', malformed]);
    expect(error.exit).toBe(EXIT_FAIL);
    expect(error.stdout).toBe('');
    expect(error.stderr).toMatch(/^devai sense record: .*JSON/u);
    expect(error.stderr.endsWith('\n')).toBe(true);

    controls.opaqueReadFailure = 'opaque read failure';
    const opaque = await invoke(['--repo-root', root, '--input', join(root, 'opaque.json')]);
    expect(opaque).toEqual({
      exit: EXIT_FAIL,
      stdout: '',
      stderr: 'devai sense record: opaque read failure\n',
    });
  });
});
