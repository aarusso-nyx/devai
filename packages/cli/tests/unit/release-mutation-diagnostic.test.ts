import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts/release-host/mutation-diagnostic.mjs');
const roots: string[] = [];
const statuses = [
  'CompileError',
  'Ignored',
  'Killed',
  'NoCoverage',
  'Pending',
  'RuntimeError',
  'Survived',
  'Timeout',
] as const;

type Status = (typeof statuses)[number];
type DiagnosticRecord = {
  readonly schema_version: '1.0.0';
  readonly kind: 'mutation-toolchain-diagnostic';
  readonly certification: false;
  readonly reusable: false;
  readonly process: {
    readonly status: number | null;
    readonly signal: string | null;
    readonly abnormal: boolean;
    readonly observation_valid: boolean;
  };
  readonly checker_created: boolean | null;
  readonly report: {
    readonly present: boolean | null;
    readonly parseable: boolean | null;
    readonly framework_matches: boolean | null;
    readonly file_count: number | null;
    readonly zero_file_present: boolean | null;
  };
  readonly mutants: {
    readonly total: number | null;
    readonly status_counts: Readonly<Record<Status, number | null>>;
    readonly unknown_status_count: number | null;
  };
  readonly assertions_passed: boolean;
};

type DiagnosticModule = {
  readonly summarizeDiagnostic: (input: {
    readonly status: number | null;
    readonly signal: string | null;
    readonly workerOutput: Buffer | undefined;
    readonly stdout: string | undefined;
    readonly abnormal?: unknown;
  }) => DiagnosticRecord;
};

const diagnostic = (await import(pathToFileURL(SCRIPT).href)) as DiagnosticModule;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-mutation-diagnostic-'));
  roots.push(value);
  return value;
}

function workerOutput(input?: {
  readonly report?: Readonly<Record<string, unknown>>;
  readonly status_counts?: Readonly<Record<string, unknown>>;
  readonly total?: unknown;
  readonly unknown_status_count?: unknown;
  readonly extra?: Readonly<Record<string, unknown>>;
}): Buffer {
  const value = input ?? {};
  const status_counts = Object.fromEntries(
    statuses.map((status) => [status, status === 'Killed' ? 1 : 0]),
  );
  return Buffer.from(
    JSON.stringify({
      report: {
        present: true,
        parseable: true,
        framework_matches: true,
        file_count: 2,
        zero_file_present: true,
        ...value.report,
      },
      mutants: {
        total: value.total ?? 1,
        status_counts: { ...status_counts, ...value.status_counts },
        unknown_status_count: value.unknown_status_count ?? 0,
      },
      ...value.extra,
    }),
    'utf8',
  );
}

describe('release mutation diagnostic observation', () => {
  it('retains only a closed status population and fixed diagnostic facts', () => {
    const summary = diagnostic.summarizeDiagnostic({
      status: 0,
      signal: null,
      workerOutput: workerOutput(),
      stdout: 'Creating 1 checker process(es) and 1 test runner process(es).\n',
    });

    expect(summary).toEqual({
      schema_version: '1.0.0',
      kind: 'mutation-toolchain-diagnostic',
      certification: false,
      reusable: false,
      process: { status: 0, signal: null, abnormal: false, observation_valid: true },
      checker_created: true,
      report: {
        present: true,
        parseable: true,
        framework_matches: true,
        file_count: 2,
        zero_file_present: true,
      },
      mutants: {
        total: 1,
        status_counts: {
          CompileError: 0,
          Ignored: 0,
          Killed: 1,
          NoCoverage: 0,
          Pending: 0,
          RuntimeError: 0,
          Survived: 0,
          Timeout: 0,
        },
        unknown_status_count: 0,
      },
      assertions_passed: true,
    });
  });

  it('keeps compile-error and unknown populations numeric without reflecting unknown enums', () => {
    const compileError = diagnostic.summarizeDiagnostic({
      status: 7,
      signal: null,
      workerOutput: workerOutput({
        total: 3,
        status_counts: { CompileError: 2, Killed: 0 },
        unknown_status_count: 1,
      }),
      stdout: '',
    });
    expect(compileError.mutants).toMatchObject({
      total: 3,
      status_counts: { CompileError: 2, Killed: 0 },
      unknown_status_count: 1,
    });
    expect(compileError.assertions_passed).toBe(false);

    const hostile = diagnostic.summarizeDiagnostic({
      status: 1,
      signal: null,
      workerOutput: workerOutput({
        status_counts: { HostOnlyStatus: 1 },
        total: 2,
      }),
      stdout: '/private/host-only-diagnostic.log',
    });
    expect(hostile.process.observation_valid).toBe(false);
    expect(JSON.stringify(hostile)).not.toContain('HostOnlyStatus');
    expect(JSON.stringify(hostile)).not.toContain('/private/host-only-diagnostic.log');
  });

  it('fails closed without echoing malformed, oversized, or path-bearing worker data', () => {
    for (const workerOutputValue of [
      Buffer.from('{"report":"/private/raw-report.json"}', 'utf8'),
      Buffer.alloc(8_193, 0x61),
      Buffer.from([0xff, 0xfe]),
      workerOutput({
        report: {
          present: false,
          parseable: true,
          framework_matches: true,
          file_count: 1,
          zero_file_present: false,
        },
      }),
    ]) {
      const summary = diagnostic.summarizeDiagnostic({
        status: 0,
        signal: 'SIGTERM',
        workerOutput: workerOutputValue,
        stdout: 'untrusted /private/child.log output',
      });
      expect(summary).toMatchObject({
        process: { status: 0, signal: 'SIGTERM', abnormal: false, observation_valid: false },
        checker_created: null,
        report: {
          present: null,
          parseable: null,
          framework_matches: null,
          file_count: null,
          zero_file_present: null,
        },
        mutants: { total: null, unknown_status_count: null },
        assertions_passed: false,
      });
      expect(Object.values(summary.mutants.status_counts)).toEqual(Array(8).fill(null));
      expect(JSON.stringify(summary)).not.toContain('/private/');
    }
  });

  it('does not fabricate absent report facts and preserves a nonzero process result', () => {
    const summary = diagnostic.summarizeDiagnostic({
      status: 23,
      signal: null,
      workerOutput: workerOutput({
        report: {
          present: false,
          parseable: false,
          framework_matches: null,
          file_count: null,
          zero_file_present: null,
        },
        total: 0,
        status_counts: Object.fromEntries(statuses.map((status) => [status, 0])),
      }),
      stdout: '',
    });
    expect(summary).toMatchObject({
      process: { status: 23, signal: null, abnormal: false, observation_valid: true },
      report: {
        present: false,
        parseable: false,
        framework_matches: null,
        file_count: null,
        zero_file_present: null,
      },
      assertions_passed: false,
    });
  });

  it('treats an abnormal wrapper outcome as a failure even with a complete worker observation', () => {
    const summary = diagnostic.summarizeDiagnostic({
      status: 0,
      signal: null,
      abnormal: true,
      workerOutput: workerOutput(),
      stdout: 'Creating 1 checker process(es) and 1 test runner process(es).',
    });
    expect(summary).toMatchObject({
      process: { status: 0, signal: null, abnormal: true, observation_valid: true },
      checker_created: true,
      assertions_passed: false,
    });
  });

  it('emits one bounded path-free refusal record before the fixed worker can import Stryker', () => {
    const cwd = root();
    const result = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(lines[0] ?? '') as DiagnosticRecord;
    expect(summary).toMatchObject({
      schema_version: '1.0.0',
      kind: 'mutation-toolchain-diagnostic',
      certification: false,
      reusable: false,
      process: { abnormal: false, observation_valid: false },
      checker_created: null,
      assertions_passed: false,
    });
    expect(result.stdout).not.toContain(cwd);
    expect(result.stdout).not.toContain('AssertionError');
    expect(result.stdout).not.toContain('Stryker');
  });
});
