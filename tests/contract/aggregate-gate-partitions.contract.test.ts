// ADR-CHK-0007 rule 11, Inspector Adversarial Acceptance IA-011 (aggregator side): the
// devai-release-gate aggregator passes only when both partition jobs passed, exactly one
// include and one exclude report exist over the same listed nodes, both reports agree on
// candidate, base, descriptor digest, task-policy digest and planned node set, each report
// holds one entry per planned node in plan order, every planned node has exactly one owned
// entry across the pair, and every owned entry is a PASS (executed or reused).
// Prerequisite entries never count toward a node's verdict.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/aggregate-gate-partitions.mjs');

interface Finding {
  readonly code: string;
  readonly detail: string;
}
interface Aggregate {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
}
type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped';
interface AggregateInput {
  readonly include: unknown;
  readonly exclude: unknown;
  readonly includeResult: JobResult;
  readonly excludeResult: JobResult;
}
const { aggregateGatePartitions } = (await import(pathToFileURL(SCRIPT).href)) as {
  aggregateGatePartitions: (input: AggregateInput) => Aggregate;
};

type Entry = Record<string, unknown>;
type Report = {
  plan: Record<string, unknown> & { tasks: { nodeId: string; taskKey: string }[] };
  partition?: { mode: string; nodes: string[] };
  execution: Entry[];
  exitCode: number;
  receiptRefusal?: string;
};

const NODES = ['generate', 'build', 'test:cli', 'lint'] as const;
const key = (nodeId: string): string =>
  Buffer.from(nodeId).toString('hex').padEnd(64, '0').slice(0, 64);

function plan() {
  return {
    schemaVersion: '1.0.0',
    repository: { id: 'aarusso-nyx/devai', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    target: 'affected',
    clean: true,
    baseCommit: 'c'.repeat(40),
    descriptorDigest: 'd'.repeat(64),
    taskPolicy: { requiredNodes: [] },
    taskPolicyDigest: 'e'.repeat(64),
    changedPaths: ['packages/cli/src/index.ts'],
    tasks: NODES.map((nodeId) => ({ nodeId, taskKey: key(nodeId) })),
  };
}

const ran = (nodeId: string, partition: 'owned' | 'prerequisite'): Entry => ({
  nodeId,
  taskKey: key(nodeId),
  disposition: 'executed',
  outcome: 'PASS',
  reason: 'cache-miss',
  durationMs: 10,
  resultDigest: 'f'.repeat(64),
  exitCode: 0,
  partition,
});
const out = (nodeId: string): Entry => ({
  nodeId,
  taskKey: key(nodeId),
  disposition: 'partitioned-out',
  outcome: 'SKIPPED',
  reason: 'partitioned-out',
  durationMs: 0,
  partition: 'partitioned-out',
});

/** gate-cli owns test:cli and runs generate and build as prerequisites. */
function includeReport(): Report {
  return {
    plan: plan(),
    partition: { mode: 'include', nodes: ['test:cli'] },
    execution: [
      ran('generate', 'prerequisite'),
      ran('build', 'prerequisite'),
      ran('test:cli', 'owned'),
      out('lint'),
    ],
    exitCode: 0,
    receiptRefusal: 'partitioned-run',
  };
}

/** gate-rest owns everything else. */
function excludeReport(): Report {
  return {
    plan: plan(),
    partition: { mode: 'exclude', nodes: ['test:cli'] },
    execution: [
      ran('generate', 'owned'),
      ran('build', 'owned'),
      out('test:cli'),
      ran('lint', 'owned'),
    ],
    exitCode: 0,
    receiptRefusal: 'partitioned-run',
  };
}

function aggregate(
  edit: (pair: { include: Report; exclude: Report }) => void = () => undefined,
  results: Partial<Pick<AggregateInput, 'includeResult' | 'excludeResult'>> = {},
): Aggregate {
  const pair = { include: includeReport(), exclude: excludeReport() };
  edit(pair);
  return aggregateGatePartitions({
    include: pair.include,
    exclude: pair.exclude,
    includeResult: results.includeResult ?? 'success',
    excludeResult: results.excludeResult ?? 'success',
  });
}

const entryOf = (report: Report, nodeId: string): Entry => {
  const entry = report.execution.find((candidate) => candidate.nodeId === nodeId);
  if (entry === undefined) throw new Error(`fixture: no entry for ${nodeId}`);
  return entry;
};

function expectFailure(result: Aggregate, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.findings.map((finding) => finding.code)).toContain(code);
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('devai-release-gate aggregator: passing pairs', () => {
  it('passes a well-formed pair', () => {
    expect(aggregate()).toEqual({ ok: true, findings: [] });
  });

  it('passes an owned entry that was reused', () => {
    const result = aggregate(({ exclude }) => {
      Object.assign(entryOf(exclude, 'lint'), {
        disposition: 'reused',
        reason: 'cache-hit',
        durationMs: 0,
      });
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('never counts a prerequisite entry toward a verdict', () => {
    // generate failed as a prerequisite in gate-cli, but gate-rest owns it and it passed there.
    const result = aggregate(({ include }) => {
      Object.assign(entryOf(include, 'generate'), {
        outcome: 'FAIL',
        reason: 'process-exit-1',
        exitCode: 1,
      });
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('passes a non-separable pair where gate-rest owns nothing', () => {
    const result = aggregate((pair) => {
      pair.include.execution = NODES.map((nodeId) => ran(nodeId, 'owned'));
      pair.exclude.execution = NODES.map(out);
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('passes a pair where test:cli is not planned and gate-cli owns nothing', () => {
    const result = aggregate((pair) => {
      for (const report of [pair.include, pair.exclude]) {
        report.plan.tasks = report.plan.tasks.filter((task) => task.nodeId !== 'test:cli');
      }
      pair.include.execution = ['generate', 'build', 'lint'].map(out);
      pair.exclude.execution = ['generate', 'build', 'lint'].map((nodeId) => ran(nodeId, 'owned'));
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });
});

describe('devai-release-gate aggregator: job results', () => {
  it.each([
    ['includeResult', 'failure'],
    ['includeResult', 'cancelled'],
    ['includeResult', 'skipped'],
    ['excludeResult', 'failure'],
    ['excludeResult', 'cancelled'],
    ['excludeResult', 'skipped'],
  ] as const)('fails when %s is %s, even with perfect reports', (slot, value) => {
    expectFailure(aggregate(undefined, { [slot]: value }), 'PARTITION_JOB_NOT_SUCCESS');
  });
});

describe('devai-release-gate aggregator: the two reports', () => {
  it.each(['include', 'exclude'] as const)('fails when the %s report is missing', (slot) => {
    expectFailure(
      aggregate((pair) => {
        (pair as Record<string, unknown>)[slot] = undefined;
      }),
      'PARTITION_REPORT_MISSING',
    );
  });

  it.each([
    [
      'two include reports',
      (pair: { include: Report; exclude: Report }) => {
        pair.exclude.partition = { mode: 'include', nodes: ['test:cli'] };
      },
    ],
    [
      'two exclude reports',
      (pair: { include: Report; exclude: Report }) => {
        pair.include.partition = { mode: 'exclude', nodes: ['test:cli'] };
      },
    ],
    [
      'swapped reports',
      (pair: { include: Report; exclude: Report }) => {
        const include = pair.include;
        pair.include = pair.exclude;
        pair.exclude = include;
      },
    ],
    [
      'an unpartitioned report',
      (pair: { include: Report; exclude: Report }) => {
        delete pair.exclude.partition;
      },
    ],
    [
      'different listed nodes',
      (pair: { include: Report; exclude: Report }) => {
        pair.exclude.partition = { mode: 'exclude', nodes: ['test:cli', 'lint'] };
      },
    ],
  ])('fails on %s', (_label, edit) => {
    expect(aggregate(edit).ok).toBe(false);
  });

  it.each([
    [
      'candidate commit',
      (report: Report) => {
        report.plan.repository = {
          id: 'aarusso-nyx/devai',
          commit: '9'.repeat(40),
          tree: 'b'.repeat(40),
        };
      },
    ],
    [
      'base',
      (report: Report) => {
        report.plan.baseCommit = '9'.repeat(40);
      },
    ],
    [
      'descriptor digest',
      (report: Report) => {
        report.plan.descriptorDigest = '9'.repeat(64);
      },
    ],
    [
      'task-policy digest',
      (report: Report) => {
        report.plan.taskPolicyDigest = '9'.repeat(64);
      },
    ],
    [
      'planned node set',
      (report: Report) => {
        report.plan.tasks = report.plan.tasks.filter((task) => task.nodeId !== 'lint');
        report.execution = report.execution.filter((entry) => entry.nodeId !== 'lint');
      },
    ],
  ])('fails when the reports differ in %s', (_label, edit) => {
    expectFailure(
      aggregate(({ exclude }) => {
        edit(exclude);
      }),
      'PARTITION_REPORT_MISMATCH',
    );
  });
});

describe('devai-release-gate aggregator: entries', () => {
  it.each([
    [
      'a missing entry',
      (report: Report) => {
        report.execution = report.execution.filter((entry) => entry.nodeId !== 'build');
      },
    ],
    [
      'a duplicated entry',
      (report: Report) => {
        report.execution = [...report.execution, ran('lint', 'owned')];
      },
    ],
    [
      'entries out of plan order',
      (report: Report) => {
        report.execution = [...report.execution].reverse();
      },
    ],
    [
      'an entry for an unplanned node',
      (report: Report) => {
        report.execution = [...report.execution, ran('docs:links', 'owned')];
      },
    ],
  ])('fails on %s', (_label, edit) => {
    expectFailure(
      aggregate(({ exclude }) => {
        edit(exclude);
      }),
      'PARTITION_ENTRY_SHAPE',
    );
  });

  it('fails when a node is owned by neither report', () => {
    expectFailure(
      aggregate(({ include }) => {
        include.execution = include.execution.map((entry) =>
          entry.nodeId === 'test:cli' ? out('test:cli') : entry,
        );
      }),
      'PARTITION_OWNED_ZERO',
    );
  });

  it('fails when a node is only ever a prerequisite', () => {
    expectFailure(
      aggregate(({ exclude }) => {
        exclude.execution = exclude.execution.map((entry) =>
          entry.nodeId === 'generate' ? ran('generate', 'prerequisite') : entry,
        );
      }),
      'PARTITION_OWNED_ZERO',
    );
  });

  it('fails when a node is owned by both reports', () => {
    expectFailure(
      aggregate(({ include }) => {
        include.execution = include.execution.map((entry) =>
          entry.nodeId === 'lint' ? ran('lint', 'owned') : entry,
        );
      }),
      'PARTITION_OWNED_TWICE',
    );
  });

  it.each([
    ['FAIL', { disposition: 'executed', outcome: 'FAIL', reason: 'process-exit-1', exitCode: 1 }],
    ['TIMEOUT', { disposition: 'executed', outcome: 'TIMEOUT', reason: 'process-ETIMEDOUT' }],
    ['ABORTED', { disposition: 'aborted', outcome: 'ABORTED', reason: 'dependency-not-pass' }],
    [
      'blocked-environment',
      { disposition: 'blocked-environment', outcome: 'BLOCKED', reason: 'blocked-environment' },
    ],
    ['SKIPPED', { disposition: 'partitioned-out', outcome: 'SKIPPED', reason: 'partitioned-out' }],
  ])('fails when an owned entry is %s', (_label, fields) => {
    expectFailure(
      aggregate(({ include }) => {
        Object.assign(entryOf(include, 'test:cli'), fields, { partition: 'owned' });
      }),
      'PARTITION_OWNED_NOT_PASS',
    );
  });
});

describe('aggregate-gate-partitions.mjs command line', () => {
  function write(name: string, value: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), 'devai-aggregate-partitions-'));
    roots.push(directory);
    const path = join(directory, name);
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    return path;
  }

  function cli(args: readonly string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  const args = (
    include: string,
    exclude: string,
    includeResult = 'success',
    excludeResult = 'success',
  ) => [
    '--include-report',
    include,
    '--exclude-report',
    exclude,
    '--include-result',
    includeResult,
    '--exclude-result',
    excludeResult,
  ];

  it('exits 0 and prints the verdict for a passing pair', () => {
    const result = cli(
      args(write('cli.json', includeReport()), write('rest.json', excludeReport())),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, findings: [] });
  });

  it('exits 1 for a failing pair', () => {
    const failing = includeReport();
    Object.assign(entryOf(failing, 'test:cli'), {
      outcome: 'FAIL',
      reason: 'process-exit-1',
      exitCode: 1,
    });
    const result = cli(args(write('cli.json', failing), write('rest.json', excludeReport())));
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout.trim()) as Aggregate).ok).toBe(false);
  });

  it('exits 1 when a job was cancelled', () => {
    const result = cli(
      args(
        write('cli.json', includeReport()),
        write('rest.json', excludeReport()),
        'success',
        'cancelled',
      ),
    );
    expect(result.status).toBe(1);
  });

  it('exits 1 when a report was never uploaded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-aggregate-partitions-'));
    roots.push(directory);
    const result = cli(args(join(directory, 'absent.json'), write('rest.json', excludeReport())));
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout.trim()) as Aggregate).findings.map((f) => f.code)).toContain(
      'PARTITION_REPORT_MISSING',
    );
  });

  it('reads a report from an artifact directory holding exactly one JSON file', () => {
    const cliDirectory = write('devai-gate-report.json', includeReport());
    const restDirectory = write('devai-gate-report.json', excludeReport());
    const result = cli(args(resolve(cliDirectory, '..'), resolve(restDirectory, '..')));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, findings: [] });
  });

  it('fails an artifact directory that holds more than one report', () => {
    const cliReport = write('devai-gate-report.json', includeReport());
    const directory = resolve(cliReport, '..');
    writeFileSync(join(directory, 'second.json'), `${JSON.stringify(includeReport())}\n`);
    const result = cli(args(directory, write('rest.json', excludeReport())));
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout.trim()) as Aggregate).findings.map((f) => f.code)).toContain(
      'PARTITION_EXTRA_REPORT',
    );
  });

  it('fails an artifact directory that holds no report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-aggregate-partitions-'));
    roots.push(directory);
    const result = cli(args(directory, write('rest.json', excludeReport())));
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout.trim()) as Aggregate).findings.map((f) => f.code)).toContain(
      'PARTITION_REPORT_MISSING',
    );
  });

  it('accepts the check command result envelope around a report', () => {
    const envelope = (report: Report) => ({
      schemaVersion: '1.0.0',
      action_id: 'check',
      ok: true,
      result: { verdict: 'pass', media_type: 'application/json', value: report },
    });
    const result = cli(
      args(
        write('cli.json', envelope(includeReport())),
        write('rest.json', envelope(excludeReport())),
      ),
    );
    expect(result.status).toBe(0);
  });

  it('exits 1 when a report is not JSON', () => {
    const result = cli(args(write('cli.json', '{ "plan": '), write('rest.json', excludeReport())));
    expect(result.status).toBe(1);
  });

  it.each([
    ['no arguments', []],
    [
      'a missing exclude report',
      ['--include-report', 'a.json', '--include-result', 'success', '--exclude-result', 'success'],
    ],
    ['an unknown job result', args('a.json', 'b.json', 'passed', 'success')],
    ['an unknown flag', [...args('a.json', 'b.json'), '--extra-report', 'c.json']],
  ])('exits 2 on %s', (_label, argv) => {
    expect(cli(argv).status).toBe(2);
  });
});
