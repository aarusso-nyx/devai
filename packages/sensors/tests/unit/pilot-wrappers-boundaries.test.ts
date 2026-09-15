import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runCommandMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
}));

vi.mock('../../src/run-command.js', () => ({
  runCommand: runCommandMock,
}));

import { senseLint } from '../../src/lint.js';
import { parseVitestSummary, senseTest, type TestSuite } from '../../src/test.js';

interface RunCommandResult {
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
}

function makeRunCommandResult(overrides: Partial<RunCommandResult> = {}): RunCommandResult {
  return {
    exit_code: 0,
    duration_ms: 10,
    stdout: '',
    stderr: '',
    killed: false,
    ...overrides,
  };
}

interface EslintMessageFixture {
  readonly ruleId: string | null;
  readonly severity: 1 | 2;
  readonly message: string;
  readonly line?: number;
}

interface EslintFileFixture {
  readonly filePath: string;
  readonly messages: readonly EslintMessageFixture[];
  readonly errorCount: number;
  readonly warningCount: number;
}

beforeEach(() => {
  runCommandMock.mockReset();
});

describe('parseVitestSummary', () => {
  it('parses passed and failed counts from a well-formed summary line', () => {
    expect(parseVitestSummary('Tests  12 passed | 3 failed')).toEqual({ passed: 12, failed: 3 });
  });

  it('defaults failed to 0 when the failed clause is absent', () => {
    expect(parseVitestSummary('Tests 8 passed')).toEqual({ passed: 8, failed: 0 });
  });

  it('strips ANSI escape sequences before matching', () => {
    const output = '\u001b[32mTests\u001b[0m 4 passed | 1 failed';
    expect(parseVitestSummary(output)).toEqual({ passed: 4, failed: 1 });
  });

  it('returns null when no summary line is present', () => {
    expect(parseVitestSummary('no summary here')).toBeNull();
  });

  it('parses multi-digit passed counts', () => {
    expect(parseVitestSummary('Tests 123 passed | 4 failed')).toEqual({ passed: 123, failed: 4 });
  });

  it('parses multi-digit failed counts', () => {
    expect(parseVitestSummary('Tests 5 passed | 42 failed')).toEqual({ passed: 5, failed: 42 });
  });

  it('tolerates extra whitespace around the pipe separator', () => {
    expect(parseVitestSummary('Tests 9 passed   |   2 failed')).toEqual({ passed: 9, failed: 2 });
  });

  it('parses failed-first summaries without confusing Test Files counts', () => {
    expect(
      parseVitestSummary(
        ' Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 3 passed (5)',
      ),
    ).toEqual({ passed: 3, failed: 2 });
  });
});

describe('senseLint', () => {
  it('returns pass status, is deterministic, and invokes eslint with the default target and timeout', () => {
    runCommandMock.mockReturnValue(makeRunCommandResult({ exit_code: 0, stdout: '[]' }));

    const reading = senseLint({ cwd: '/repo' });

    expect(runCommandMock).toHaveBeenCalledWith(['npx', 'eslint', '--format=json', '.'], {
      cwd: '/repo',
      timeoutMs: 120_000,
    });
    expect(reading.status).toBe('pass');
    expect(reading.deterministic).toBe(true);
    expect(reading.sensor.name).toBe('lint');
    expect(reading.sensor.kind).toBe('lint');
  });

  it('invokes eslint with the provided target path verbatim', () => {
    runCommandMock.mockReturnValue(makeRunCommandResult({ exit_code: 0, stdout: '[]' }));

    senseLint({ cwd: '/repo', target: 'src/foo.ts' });

    expect(runCommandMock).toHaveBeenCalledWith(['npx', 'eslint', '--format=json', 'src/foo.ts'], {
      cwd: '/repo',
      timeoutMs: 120_000,
    });
  });

  it('forwards a custom timeoutMs to runCommand and into metrics', () => {
    runCommandMock.mockReturnValue(makeRunCommandResult({ exit_code: 0, stdout: '[]' }));

    const reading = senseLint({ cwd: '/repo', timeoutMs: 5_000 });

    expect(runCommandMock).toHaveBeenCalledWith(['npx', 'eslint', '--format=json', '.'], {
      cwd: '/repo',
      timeoutMs: 5_000,
    });
    expect(reading.metrics?.['timeout_ms']).toBe(5_000);
  });

  it('returns fail status and aggregates error/warning counts across multiple files', () => {
    const files: EslintFileFixture[] = [
      { filePath: 'a.ts', messages: [], errorCount: 2, warningCount: 1 },
      { filePath: 'b.ts', messages: [], errorCount: 3, warningCount: 4 },
    ];
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: JSON.stringify(files) }),
    );

    const reading = senseLint({ cwd: '/repo' });

    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['error_count']).toBe(5);
    expect(reading.metrics?.['warning_count']).toBe(5);
  });

  it('returns review status when eslint exits nonzero without reporting errors', () => {
    const files: EslintFileFixture[] = [
      { filePath: 'b.ts', messages: [], errorCount: 0, warningCount: 1 },
    ];
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: JSON.stringify(files) }),
    );

    const reading = senseLint({ cwd: '/repo' });

    expect(reading.status).toBe('review');
  });

  it('marks the reading for review and records a LINT_TIMED_OUT warning when killed', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, killed: true, stdout: '[]' }),
    );

    const reading = senseLint({ cwd: '/repo', timeoutMs: 9_000 });

    expect(reading.status).toBe('review');
    expect(reading.killed).toBe(true);
    const timeoutFinding = reading.findings?.find((f) => f.code === 'LINT_TIMED_OUT');
    expect(timeoutFinding?.severity).toBe('warning');
    expect(timeoutFinding?.message).toContain('9000');
  });

  it('maps eslint severities and null ruleIds onto findings, preserving line numbers', () => {
    const files: EslintFileFixture[] = [
      {
        filePath: 'src/c.ts',
        messages: [
          { ruleId: null, severity: 2, message: 'parse error' },
          { ruleId: 'no-console', severity: 1, message: 'avoid console', line: 10 },
        ],
        errorCount: 1,
        warningCount: 1,
      },
    ];
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: JSON.stringify(files) }),
    );

    const reading = senseLint({ cwd: '/repo' });
    const findings = reading.findings ?? [];

    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.code).toBe('unknown');
    expect(findings[0]?.file).toBe('src/c.ts');
    expect(findings[1]?.severity).toBe('warning');
    expect(findings[1]?.line).toBe(10);
  });

  it('omits the line property on findings when eslint does not report one', () => {
    const files: EslintFileFixture[] = [
      {
        filePath: 'src/d.ts',
        messages: [{ ruleId: 'no-var', severity: 2, message: 'no var' }],
        errorCount: 1,
        warningCount: 0,
      },
    ];
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: JSON.stringify(files) }),
    );

    const reading = senseLint({ cwd: '/repo' });
    const finding = reading.findings?.[0];

    expect(finding).toBeDefined();
    if (finding !== undefined) {
      expect('line' in finding).toBe(false);
    }
  });

  it('tolerates non-JSON stdout without throwing', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 2, stdout: "ESLint couldn't find a config" }),
    );

    const reading = senseLint({ cwd: '/repo' });

    expect(reading.status).toBe('review');
    expect(reading.metrics?.['error_count']).toBe(0);
    expect(reading.metrics?.['warning_count']).toBe(0);
  });

  it('passes exit_code, duration_ms, out_head, and err_head straight through', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({
        exit_code: 0,
        duration_ms: 250,
        stdout: '[]',
        stderr: 'warn: deprecated flag',
      }),
    );

    const reading = senseLint({ cwd: '/repo' });

    expect(reading.exit_code).toBe(0);
    expect(reading.duration_ms).toBe(250);
    expect(reading.out_head).toBe('[]');
    expect(reading.err_head).toBe('warn: deprecated flag');
  });
});

describe('senseTest', () => {
  interface SuiteCase {
    readonly suite: TestSuite;
    readonly expectedCommand: readonly string[];
    readonly expectedKind: string;
    readonly expectedDeterministic: boolean;
  }

  const suiteCases: readonly SuiteCase[] = [
    {
      suite: 'unit',
      expectedCommand: ['pnpm', 'vitest', 'run', '--config', 'tests/config/t1.unit.config.ts'],
      expectedKind: 'unit_test',
      expectedDeterministic: true,
    },
    {
      suite: 'integration',
      expectedCommand: [
        'pnpm',
        'vitest',
        'run',
        '--config',
        'tests/config/t3.integration.config.ts',
      ],
      expectedKind: 'integration_test',
      expectedDeterministic: false,
    },
    {
      suite: 'regression',
      expectedCommand: [
        'pnpm',
        'vitest',
        'run',
        '--config',
        'tests/config/t4.regression.config.ts',
      ],
      expectedKind: 'unit_test',
      expectedDeterministic: true,
    },
    {
      suite: 'e2e',
      expectedCommand: ['pnpm', 'vitest', 'run', '--config', 'tests/config/t5.e2e.config.ts'],
      expectedKind: 'e2e_test',
      expectedDeterministic: false,
    },
    {
      suite: 'all',
      expectedCommand: ['pnpm', 'vitest', 'run'],
      expectedKind: 'unit_test',
      expectedDeterministic: false,
    },
  ];

  it.each(suiteCases)(
    'resolves command, sensor identity, and determinism for suite "$suite"',
    ({ suite, expectedCommand, expectedKind, expectedDeterministic }) => {
      runCommandMock.mockReturnValue(
        makeRunCommandResult({ exit_code: 0, stdout: 'Tests 1 passed' }),
      );

      const reading = senseTest({ cwd: '/repo', suite });

      expect(runCommandMock).toHaveBeenCalledWith(expectedCommand, {
        cwd: '/repo',
        timeoutMs: 600_000,
      });
      expect(reading.sensor.name).toBe(`test.${suite}`);
      expect(reading.sensor.kind).toBe(expectedKind);
      expect(reading.deterministic).toBe(expectedDeterministic);
    },
  );

  it('returns pass status and passes exit_code/duration_ms/out_head through on a clean run', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 0, duration_ms: 4_200, stdout: 'Tests 3 passed' }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('pass');
    expect(reading.exit_code).toBe(0);
    expect(reading.duration_ms).toBe(4_200);
    expect(reading.out_head).toBe('Tests 3 passed');
  });

  it('returns fail status and metrics when stdout reports failed tests', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: 'Tests  8 passed | 2 failed' }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['tests_passed']).toBe(8);
    expect(reading.metrics?.['tests_failed']).toBe(2);
  });

  it('falls back to parsing the summary from stderr when stdout has no match', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({
        exit_code: 1,
        stdout: 'some noisy output',
        stderr: 'Tests  4 passed | 1 failed',
      }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['tests_failed']).toBe(1);
  });

  it('returns error status when neither stream yields a parseable summary', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: 'crash', stderr: 'stack trace' }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('error');
    expect(reading.metrics?.['tests_passed']).toBe(0);
    expect(reading.metrics?.['tests_failed']).toBe(0);
  });

  it('surfaces a killed execution as an error status while preserving the killed flag', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, killed: true, stdout: '', stderr: '' }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('error');
    expect(reading.killed).toBe(true);
  });

  it('uses the default 600000ms timeout when none is provided', () => {
    runCommandMock.mockReturnValue(makeRunCommandResult({ exit_code: 0, stdout: '' }));

    senseTest({ cwd: '/repo', suite: 'unit' });

    expect(runCommandMock).toHaveBeenCalledWith(
      ['pnpm', 'vitest', 'run', '--config', 'tests/config/t1.unit.config.ts'],
      { cwd: '/repo', timeoutMs: 600_000 },
    );
  });

  it('forwards a custom timeoutMs to runCommand', () => {
    runCommandMock.mockReturnValue(makeRunCommandResult({ exit_code: 0, stdout: '' }));

    senseTest({ cwd: '/repo', suite: 'unit', timeoutMs: 30_000 });

    expect(runCommandMock).toHaveBeenCalledWith(
      ['pnpm', 'vitest', 'run', '--config', 'tests/config/t1.unit.config.ts'],
      { cwd: '/repo', timeoutMs: 30_000 },
    );
  });

  it('reports actual failed-first test failures', () => {
    runCommandMock.mockReturnValue(
      makeRunCommandResult({ exit_code: 1, stdout: 'Tests  2 failed | 3 passed' }),
    );

    const reading = senseTest({ cwd: '/repo', suite: 'unit' });

    expect(reading.status).toBe('fail');
    expect(reading.metrics?.['tests_failed']).toBe(2);
  });
});
