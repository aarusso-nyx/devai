import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import Reporter from '../../src/native-test-reporter.js';
import {
  inspectNativeTestResults,
  type NativeTestResultContract,
} from '../../src/commands/sense/native-test-results.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const require = createRequire(join(ROOT, 'package.json'));
const NONCE = 'f'.repeat(64); // Fixture-only child nonce, never a registered production reading.
const PROJECT = 'stream-fixture-project';
const FILE = 'diagnostics.fixture.test.mjs';
const TITLES = ['awaited diagnostics', 'native assertion outcome', 'retained skipped case'];
const MARKERS = [
  'PINO_BEFORE_COLLECTION_PRESERVED',
  'AWAITED_BEFORE_STDOUT_α',
  'AWAITED_BEFORE_STDERR_β',
  'AWAITED_AFTER_STDOUT_γ',
  'AWAITED_AFTER_STDERR_δ',
  'RAW_STDOUT_PRESERVED_Ω',
  '{"level":30,"msg":"PINO_EQUIVALENT_PRESERVED"}',
  'RAW_STDERR_PRESERVED_λ',
  'CONSOLE_LOG_PRESERVED_é',
  'CONSOLE_ERROR_PRESERVED_ç',
  'CONSOLE_WARN_PRESERVED_ñ',
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface Report {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  success: boolean;
  devaiCollection: {
    schemaVersion: string;
    reporter: string;
    nonce: string;
    invalid: string[];
    plannedFiles: string[];
    tests: { title: string; project: string; ancestors: string[] }[];
    resolvedSelection: { project: string; pool: string }[];
  };
}
function run(
  pool: 'forks' | 'threads',
  options: { fail?: boolean; rawConsole?: boolean; filtered?: boolean } = {},
) {
  expect(JSON.parse(readFileSync(require.resolve('vitest/package.json'), 'utf8'))).toMatchObject({
    version: '4.1.11',
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-reporter-streams-fixture-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}\n');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  const source = readFileSync(join(ROOT, 'packages/cli/src/native-test-reporter.ts'), 'utf8');
  const reporter = join(root, 'reporter.mjs');
  const built = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  expect(built.diagnostics ?? []).toEqual([]);
  writeFileSync(reporter, built.outputText);
  copyFileSync(
    join(ROOT, 'packages/cli/tests/fixtures/native-reporter-streams/diagnostics.fixture.mjs'),
    join(root, FILE),
  );
  const config = join(root, 'vitest.config.mjs');
  writeFileSync(
    config,
    `export default { test: { name: ${JSON.stringify(PROJECT)}, include: [${JSON.stringify(FILE)}], environment: 'node', maxWorkers: 1, fileParallelism: false, disableConsoleIntercept: ${options.rawConsole === true}, onConsoleLog() { return false; } } };\n`,
  );
  const argv = [
    join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run',
    '--config',
    config,
    '--pool',
    pool,
    '--reporter',
    reporter,
    ...(options.filtered ? ['--testNamePattern', 'awaited diagnostics'] : []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    DEVAI_NATIVE_COLLECTION_NONCE: NONCE,
    DEVAI_STREAM_FIXTURE_FAIL_ONLY: options.fail ? '1' : '0',
  };
  delete env['FORCE_COLOR'];
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: 'utf8',
    timeout: 25_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  expect(result.error, result.stderr).toBeUndefined();
  // Parse the ENTIRE stream: no log stripping, last-line selection or JSON recovery.
  const report = JSON.parse(result.stdout) as Report;
  expect(result.stdout.trim().startsWith('{')).toBe(true);
  expect(result.stdout.trim().endsWith('}')).toBe(true);
  for (const marker of MARKERS) {
    expect(result.stderr, marker).toContain(marker);
    expect(result.stdout, marker).not.toContain(marker);
  }
  return { root, result, report };
}
function contract(): NativeTestResultContract {
  return {
    schemaVersion: '1.0.0',
    format: 'vitest-json',
    projectId: 'fixture-output-custody',
    transport: { kind: 'direct' },
    executableFiles: [FILE],
    requiredTestIds: TITLES.map(
      (title) =>
        `test:v1:${encodeURIComponent(JSON.stringify(['fixture-output-custody', FILE, ['native reporter stream fixture'], title]))}`,
    ).sort(),
    selectionEvidence: {
      kind: 'devai-native-collection',
      reporter: 'vitest-v1',
      projectName: PROJECT,
    },
  };
}

describe('real Vitest 4.1.11 worker streams and native result custody', () => {
  it.each(['forks', 'threads'] as const)(
    '%s keeps all awaited worker diagnostics on stderr and the full skipped cohort in JSON',
    (pool) => {
      const { root, result, report } = run(pool);
      expect(result.status).toBe(0);
      expect(report).toMatchObject({
        numTotalTests: 3,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 1,
        success: true,
      });
      expect(report.devaiCollection).toMatchObject({
        schemaVersion: '1.0.0',
        reporter: 'vitest-v1',
        nonce: NONCE,
        invalid: [],
        plannedFiles: [join(root, FILE)],
      });
      expect(report.devaiCollection.tests.map((row) => row.title).sort()).toEqual(
        [...TITLES].sort(),
      );
      expect(report.devaiCollection.resolvedSelection).toEqual([
        expect.objectContaining({ project: PROJECT, pool }),
      ]);
      const population = inspectNativeTestResults(contract(), result.stdout, result.stderr, {
        repoRoot: root,
        collectionNonce: NONCE,
      });
      expect(population.testIds).toEqual(contract().requiredTestIds);
      expect(population.executedTestIds).toHaveLength(2);
      expect(population.skippedTestIds).toHaveLength(1);
      expect(population.status).toBe('unknown');
      expect(population.findings).toEqual(['NATIVE_RESULT_UNEXECUTED_OBLIGATIONS']);
      expect(
        inspectNativeTestResults(contract(), result.stdout, result.stderr, {
          repoRoot: root,
          collectionNonce: 'e'.repeat(64),
        }).findings,
      ).toContain('NATIVE_COLLECTION_CUSTODY_INVALID');
    },
  );
  it.each(['forks', 'threads'] as const)(
    '%s preserves a real failing assertion and skipped outcome without corrupting JSON',
    (pool) => {
      const { root, result, report } = run(pool, { fail: true });
      expect(result.status).toBe(1);
      expect(report).toMatchObject({
        numTotalTests: 3,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 1,
        success: false,
      });
      expect(report.devaiCollection.nonce).toBe(NONCE);
      expect(report.devaiCollection.invalid).toEqual([]);
      const population = inspectNativeTestResults(contract(), result.stdout, result.stderr, {
        repoRoot: root,
        collectionNonce: NONCE,
      });
      expect(population.failedTestIds).toHaveLength(1);
      expect(population.skippedTestIds).toHaveLength(1);
      expect(population.testIds).toHaveLength(3);
    },
  );
  it.each(['forks', 'threads'] as const)(
    '%s also routes console output when native interception is disabled',
    (pool) => {
      const { result, report } = run(pool, { rawConsole: true });
      expect(result.status).toBe(0);
      expect(report.numPassedTests).toBe(2);
      expect(report.devaiCollection.invalid).toEqual([]);
    },
  );
  it('keeps a partially executed cohort UNKNOWN with its unexecuted obligations', () => {
    const { root, result, report } = run('forks', { filtered: true });
    expect(result.status).toBe(0);
    // Actual baseline and candidate retain the full cohort without setting a filter marker.
    // Acceptance follows the native reader: pending obligations must never become PASS.
    expect(report.devaiCollection.tests).toHaveLength(3);
    expect(report.numPassedTests).toBe(1);
    expect(report.numPendingTests).toBe(2);
    const population = inspectNativeTestResults(contract(), result.stdout, result.stderr, {
      repoRoot: root,
      collectionNonce: NONCE,
    });
    expect(population.testIds).toEqual(contract().requiredTestIds);
    expect(population.executedTestIds).toHaveLength(1);
    expect(population.skippedTestIds).toHaveLength(2);
    expect(population.status).toBe('unknown');
    expect(population.findings).toContain('NATIVE_RESULT_UNEXECUTED_OBLIGATIONS');
  });
});

function context() {
  const callbacks: (() => void)[] = [],
    stdout: string[] = [],
    stderr: string[] = [];
  const output = new PassThrough(),
    error = new PassThrough();
  output.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
  error.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const boundConsole = new Console({ stdout: output, stderr: error, colorMode: false });
  const logger = {
    outputStream: output,
    errorStream: error,
    console: boundConsole,
    log: boundConsole.log.bind(boundConsole),
  };
  const ctx = {
    config: { root: ROOT, passWithNoTests: true },
    _tmpDir: tmpdir(),
    logger,
    snapshot: { summary: {} },
    onClose(callback: () => void) {
      callbacks.push(callback);
    },
  };
  return { ctx, logger, callbacks, output, error, stdout, stderr };
}
type Context = Parameters<Reporter['onInit']>[0];
describe('observable logger shape, lifecycle and ownership', () => {
  it('is idempotent for the same context and leaves native JSON on its original Console sink until context close', async () => {
    const fixture = context(),
      reporter = new Reporter(),
      originalConsole = fixture.logger.console,
      originalLog = fixture.logger.log;
    reporter.onInit(fixture.ctx);
    reporter.onInit(fixture.ctx);
    expect(fixture.callbacks).toHaveLength(1);
    expect(fixture.logger.outputStream).toBe(fixture.error);
    expect(fixture.logger.console).toBe(originalConsole);
    expect(fixture.logger.log).toBe(originalLog);
    reporter.onUserConsoleLog({ type: 'stdout', content: 'exact stdout\nΩ' });
    reporter.onUserConsoleLog({ type: 'stderr', content: '\nexact stderr\n' });
    expect(fixture.stderr.join('')).toBe('exact stdout\nΩ\nexact stderr\n');
    await reporter.onTestRunEnd([]);
    expect(JSON.parse(fixture.stdout.join('')) as unknown).toMatchObject({
      devaiCollection: { reporter: 'vitest-v1' },
    });
    expect(fixture.logger.outputStream).toBe(fixture.error); // No restoration at run-end/watch boundary.
    fixture.callbacks[0]?.();
    expect(fixture.logger.outputStream).toBe(fixture.output);
    fixture.callbacks[0]?.();
    expect(fixture.logger.outputStream).toBe(fixture.output);
    expect(() => reporter.onUserConsoleLog({ type: 'stdout', content: 'after close' })).toThrow(
      'DEVAI_NATIVE_REPORTER_NOT_INITIALIZED',
    );
  });
  it.each([undefined, null, {}, { outputStream: { write: 1 } }, { console: { log: false } }])(
    'refuses an unsupported logger before changing streams: %j',
    (logger) => {
      const fixture = context(),
        reporter = new Reporter();
      expect(() => reporter.onInit({ ...fixture.ctx, logger } as unknown as Context)).toThrow(
        'DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED',
      );
      expect(fixture.callbacks).toHaveLength(0);
      expect(fixture.logger.outputStream).toBe(fixture.output);
    },
  );
  it('rejects merged streams, missing observable methods and missing context-close registration', () => {
    for (const change of [
      (value: Context) => {
        value.logger.errorStream = value.logger.outputStream;
      },
      (value: Context) => {
        value.logger.console = {} as Context['logger']['console'];
      },
      (value: Context) => {
        value.logger.log = undefined as unknown as Context['logger']['log'];
      },
      (value: Context) => {
        value.onClose = undefined as unknown as Context['onClose'];
      },
    ]) {
      const fixture = context(),
        reporter = new Reporter();
      change(fixture.ctx);
      expect(() => reporter.onInit(fixture.ctx)).toThrow(
        'DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED',
      );
      expect(fixture.callbacks).toHaveLength(0);
    }
  });
  it.each(['readonly', 'ignored'] as const)(
    'fails closed when the observable output assignment is %s',
    (mode) => {
      const fixture = context(),
        reporter = new Reporter();
      if (mode === 'readonly')
        Object.defineProperty(fixture.logger, 'outputStream', {
          value: fixture.output,
          writable: false,
        });
      else
        Object.defineProperty(fixture.logger, 'outputStream', {
          get: () => fixture.output,
          set: () => {},
        });
      expect(() => reporter.onInit(fixture.ctx)).toThrow(
        'DEVAI_NATIVE_REPORTER_LOGGER_UNSUPPORTED',
      );
      expect(fixture.callbacks).toHaveLength(0);
      expect(fixture.logger.outputStream).toBe(fixture.output);
    },
  );
  it('refuses another active context and does not restore foreign stream routing on close', () => {
    const fixture = context(),
      other = context(),
      reporter = new Reporter();
    reporter.onInit(fixture.ctx);
    expect(() => reporter.onInit(other.ctx)).toThrow('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
    const foreign = new PassThrough();
    fixture.logger.outputStream = foreign;
    expect(() => reporter.onInit(fixture.ctx)).toThrow('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
    fixture.callbacks[0]?.();
    expect(fixture.logger.outputStream).toBe(foreign);
    expect(other.callbacks).toHaveLength(0);
  });
  it('does not overwrite another owner of the error stream, Console or log function', () => {
    const fixture = context(),
      reporter = new Reporter();
    reporter.onInit(fixture.ctx);
    const foreign = new PassThrough();
    fixture.logger.errorStream = foreign;
    const foreignConsole = new Console({ stdout: foreign });
    const foreignLog = foreignConsole.log.bind(foreignConsole);
    fixture.logger.console = foreignConsole;
    fixture.logger.log = foreignLog;
    expect(() => reporter.onInit(fixture.ctx)).toThrow('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
    fixture.callbacks[0]?.();
    expect(fixture.logger.errorStream).toBe(foreign);
    expect(fixture.logger.outputStream).toBe(fixture.error);
    expect(fixture.logger.console).toBe(foreignConsole);
    expect(fixture.logger.log).toBe(foreignLog);
  });
  it('refuses mutation of log on the same Console identity and preserves that foreign method', () => {
    const fixture = context(),
      reporter = new Reporter();
    reporter.onInit(fixture.ctx);
    const foreignConsoleLog = () => {};
    fixture.logger.console.log = foreignConsoleLog;
    expect(() => reporter.onInit(fixture.ctx)).toThrow('DEVAI_NATIVE_REPORTER_LOGGER_CHANGED');
    fixture.callbacks[0]?.();
    expect(fixture.logger.console.log).toBe(foreignConsoleLog);
  });
  it('allows fresh initialization after close while an old close callback cannot steal the new routing', () => {
    const fixture = context(),
      reporter = new Reporter();
    reporter.onInit(fixture.ctx);
    fixture.callbacks[0]?.();
    reporter.onInit(fixture.ctx);
    expect(fixture.callbacks).toHaveLength(2);
    fixture.callbacks[0]?.();
    expect(fixture.logger.outputStream).toBe(fixture.error);
    fixture.callbacks[1]?.();
    expect(fixture.logger.outputStream).toBe(fixture.output);
  });
  it('rolls back its own stream change when close-hook registration fails', () => {
    const fixture = context(),
      reporter = new Reporter();
    fixture.ctx.onClose = () => {
      throw new Error('fixture close registration rejected');
    };
    expect(() => reporter.onInit(fixture.ctx)).toThrow('fixture close registration rejected');
    expect(fixture.logger.outputStream).toBe(fixture.output);
    expect(() => reporter.onUserConsoleLog({ type: 'stdout', content: 'uninitialized' })).toThrow(
      'DEVAI_NATIVE_REPORTER_NOT_INITIALIZED',
    );
  });
  it('refuses diagnostic content with the wrong observable type and requires initialization', () => {
    const reporter = new Reporter();
    expect(() => reporter.onUserConsoleLog({ type: 'stdout', content: 'before init' })).toThrow(
      'DEVAI_NATIVE_REPORTER_NOT_INITIALIZED',
    );
    const fixture = context();
    reporter.onInit(fixture.ctx);
    expect(() =>
      reporter.onUserConsoleLog({ type: 'stdout', content: null as unknown as string }),
    ).toThrow('DEVAI_NATIVE_DIAGNOSTIC_INVALID');
    fixture.callbacks[0]?.();
  });
});
