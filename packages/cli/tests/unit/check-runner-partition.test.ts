// ADR-CHK-0007 rule 11, Inspector Adversarial Acceptance IA-009 and IA-010: one plan
// partitioned across two runs. Both runs plan exactly as an unpartitioned run would; each
// report carries one entry per planned node in plan order; every planned node is owned in
// exactly one report; a partitioned-out node is never started, inspected, or cached; only
// the dependency closure of the listed nodes may execute in both runs; a non-separable plan
// is owned wholly by the including run; the partition flags are refused before any node
// starts where they do not apply; and a partitioned run writes no receipt.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { runCheckTasks, runCheckTasksAsync } from '../../src/services/check-runner/runner.js';
import type {
  CheckRunnerOptions,
  CheckRunnerReport,
  ExecutedTask,
  TaskExecutionResult,
} from '../../src/services/check-runner/types.js';

const NOW = '2026-10-08T00:00:00.000Z';
const CLI = 'test:cli';
const FALLBACK = 'test:local-full';
const CACHE_NODES = '.devai/state/check-cache/v1/nodes';
const PASS: TaskExecutionResult = { status: 0, signal: null, stdout: 'ok\n', stderr: '' };
const FAIL: TaskExecutionResult = { status: 1, signal: null, stdout: '', stderr: 'failed\n' };
const roots: string[] = [];
let ordinal = 0;

type Json = Readonly<Record<string, unknown>>;
type Mode = 'include' | 'exclude';
type Partition = Readonly<{ mode: Mode; nodeIds: readonly string[] }>;
type PartitionedOptions = Omit<CheckRunnerOptions, 'executeTask'> & {
  readonly partition?: Partition;
};
type PartitionedEntry = ExecutedTask & { readonly partition?: string };
type PartitionedReport = CheckRunnerReport & {
  readonly partition?: Readonly<{ mode: Mode; nodes: readonly string[] }>;
};

interface NodeSpec {
  readonly nodeId: string;
  readonly dependencies?: readonly string[];
  readonly selector?: string;
  readonly preflight?: boolean;
}

/**
 * The shape of the real gate: a preflight node, generate, build and package staging as the
 * dependency closure of test:cli, a node that depends on test:cli, and independent nodes.
 * The fallback root is selected only by the `fallback/` prefix, so an affected run over a
 * `src/` change plans every node but the fallback, and a local run plans the fallback too.
 */
const GATE: readonly NodeSpec[] = [
  { nodeId: 'preflight', preflight: true, selector: 'src/' },
  { nodeId: 'generate', dependencies: ['preflight'] },
  { nodeId: 'build', dependencies: ['generate'] },
  { nodeId: 'test:package-staging', dependencies: ['build'] },
  { nodeId: CLI, dependencies: ['test:package-staging'] },
  { nodeId: 'test:cli-summary', dependencies: [CLI] },
  { nodeId: 'lint', dependencies: ['generate'] },
  { nodeId: 'typecheck', dependencies: ['build'] },
  { nodeId: 'docs' },
  {
    nodeId: FALLBACK,
    selector: 'fallback/',
    dependencies: [
      'preflight',
      'generate',
      'build',
      'test:package-staging',
      CLI,
      'test:cli-summary',
      'lint',
      'typecheck',
      'docs',
    ],
  },
];
const CLOSURE = ['preflight', 'generate', 'build', 'test:package-staging'];
const INCLUDED = [CLI, 'test:cli-summary'];
const REST = ['lint', 'typecheck', 'docs'];

function descriptorNode(spec: NodeSpec): Json {
  const common = {
    nodeId: spec.nodeId,
    dependencies: spec.dependencies ?? [],
    cwd: '.',
    inputSelectors: [{ kind: 'prefix', pattern: spec.selector ?? 'src/' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
  };
  if (spec.preflight === true) {
    return {
      ...common,
      runner: 'preflight-v1',
      probes: [
        {
          id: 'descriptor-present',
          class: 'intrinsic',
          probe: { kind: 'file', path: 'test-tasks.json', must_exist: true },
          expected: 'test-tasks.json is present',
          observed: null,
          status: 'pass',
          remediation: 'Commit test-tasks.json.',
          depends_on: [],
        },
      ],
      outputContract: { kind: 'probes', requiredStatus: 'pass' },
    };
  }
  return {
    ...common,
    argv: ['node', `bin/${spec.nodeId.replaceAll(':', '-')}.mjs`],
    runner: 'node-v1',
    outputContract: { kind: 'marker', value: spec.nodeId },
  };
}

function descriptor(specs: readonly NodeSpec[]): Json {
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'partition-inspector',
    repositoryId: 'fixture/partition',
    fallbackNodeId: FALLBACK,
    dynamicFallbackSelectors: [],
    tasks: specs.map(descriptorNode),
    // Every node is eligible (a closed profile must name the fallback too); a change a
    // node's selector matches never falls back to the fallback root.
    profiles: [
      {
        profileId: 'affected',
        mode: 'affected',
        requiredNodes: [],
        eligibleNodes: specs.map((spec) => spec.nodeId),
      },
      // An rc profile exists, so an rc partition is refused for the partition, not the profile.
      { profileId: 'rc', mode: 'fixed', requiredNodes: ['docs'] },
    ],
  };
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z',
    },
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function put(root: string, path: string, bytes: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes, 'utf8');
}

/** A two-commit repository whose second commit changes `changed`; returns the base too. */
function repository(
  specs: readonly NodeSpec[] = GATE,
  changed = 'src/main.ts',
): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-partition-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Partition Inspector']);
  git(root, ['config', 'user.email', 'partition-inspector@example.invalid']);
  put(root, '.gitignore', '.devai/state/*\n');
  put(root, 'src/main.ts', 'export const value = 1;\n');
  put(root, 'docs/readme.md', '# fixture\n');
  put(root, 'fallback/marker.txt', 'one\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor(specs), null, 2)}\n`);
  // Every node only shares, so four workers really overlap where the plan allows it.
  const nodes = Object.fromEntries(specs.map((spec) => [spec.nodeId, { shared: ['src'] }]));
  put(
    root,
    'test-task-exclusivity.json',
    `${JSON.stringify({ schemaVersion: '1.0.0', nodes }, null, 2)}\n`,
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  put(root, changed, `changed ${changed}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'change']);
  return { root, base };
}

async function inScope<T>(callback: () => Promise<T>): Promise<T> {
  ordinal += 1;
  const id = `check-runner-partition-${String(ordinal)}`;
  let receipt = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-partition-test',
    issuer_version: '1.0.0',
    invocation_id: id,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${id}-${String(++receipt)}`,
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: id,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

interface Run {
  readonly report: PartitionedReport;
  readonly started: readonly string[];
}

async function run(
  root: string,
  base: string,
  options: Partial<PartitionedOptions> = {},
  failing: readonly string[] = [],
  workers = 4,
): Promise<Run> {
  const started: string[] = [];
  const executeTask = async (
    _argv: readonly string[],
    _cwd: string,
    _timeout: number,
    _environment: Readonly<Record<string, string>>,
    identity: Readonly<{ nodeId: string }>,
  ): Promise<TaskExecutionResult> => {
    started.push(identity.nodeId);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return failing.includes(identity.nodeId) ? FAIL : PASS;
  };
  const report = (await inScope(() =>
    runCheckTasksAsync({
      repoRoot: root,
      target: 'affected',
      operation: 'run',
      baseCommit: base,
      toolchain: { node: 'v-test' },
      environment: {},
      resolveExecutable: () => ({ path: process.execPath, sha256: 'e'.repeat(64) }),
      now: () => NOW,
      ...options,
      executeTask,
      workers,
    } as Parameters<typeof runCheckTasksAsync>[0]),
  )) as PartitionedReport;
  return { report, started };
}

const include = (...nodeIds: string[]): Partial<PartitionedOptions> => ({
  partition: { mode: 'include', nodeIds },
});
const exclude = (...nodeIds: string[]): Partial<PartitionedOptions> => ({
  partition: { mode: 'exclude', nodeIds },
});

function entries(report: PartitionedReport): readonly PartitionedEntry[] {
  return (report.execution ?? []) as readonly PartitionedEntry[];
}

function byPartition(report: PartitionedReport): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of entries(report)) {
    const key = entry.partition ?? 'none';
    (out[key] ??= []).push(entry.nodeId);
  }
  return out;
}

function comparable(entry: ExecutedTask) {
  const { nodeId, taskKey, disposition, outcome, reason, exitCode, signal } = entry;
  return { nodeId, taskKey, disposition, outcome, reason, exitCode, signal };
}

function cached(root: string, nodeId: string): boolean {
  return existsSync(join(root, CACHE_NODES, `${Buffer.from(nodeId).toString('base64url')}.json`));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('IA-009: a separable affected plan split on test:cli', () => {
  async function trio() {
    const whole = repository();
    const included = repository();
    const excluded = repository();
    return {
      whole: await run(whole.root, whole.base),
      include: await run(included.root, included.base, include(CLI)),
      exclude: await run(excluded.root, excluded.base, exclude(CLI)),
      roots: { include: included.root, exclude: excluded.root },
    };
  }

  it('plans byte-identical plans with one task-policy digest in both runs', async () => {
    const { whole, include: inc, exclude: exc } = await trio();
    const planned = whole.report.plan.tasks.map((task) => task.nodeId);
    expect(planned).toEqual([...CLOSURE, ...INCLUDED, ...REST]);
    expect(JSON.stringify(inc.report.plan)).toBe(JSON.stringify(whole.report.plan));
    expect(JSON.stringify(exc.report.plan)).toBe(JSON.stringify(whole.report.plan));
    expect(inc.report.plan.taskPolicyDigest).toBe(exc.report.plan.taskPolicyDigest);
  });

  it('carries one entry per planned node, in plan order, in each report', async () => {
    const { whole, include: inc, exclude: exc } = await trio();
    const planned = whole.report.plan.tasks.map((task) => task.nodeId);
    for (const report of [inc.report, exc.report]) {
      expect(entries(report).map((entry) => entry.nodeId)).toEqual(planned);
      expect(entries(report).map((entry) => entry.taskKey)).toEqual(
        whole.report.plan.tasks.map((task) => task.taskKey),
      );
    }
    expect(inc.report.partition).toEqual({ mode: 'include', nodes: [CLI] });
    expect(exc.report.partition).toEqual({ mode: 'exclude', nodes: [CLI] });
    // An unpartitioned report carries no partition block and no partitioned-out entry.
    expect((whole.report as PartitionedReport).partition).toBeUndefined();
    expect(entries(whole.report).every((entry) => entry.partition === undefined)).toBe(true);
  });

  it('owns every planned node exactly once across the pair', async () => {
    const { include: inc, exclude: exc } = await trio();
    expect(byPartition(inc.report)).toEqual({
      prerequisite: CLOSURE,
      owned: INCLUDED,
      'partitioned-out': REST,
    });
    expect(byPartition(exc.report)).toEqual({
      owned: [...CLOSURE, ...REST],
      'partitioned-out': INCLUDED,
    });
  });

  it('never starts, inspects, or caches a partitioned-out node', async () => {
    const { include: inc, exclude: exc, roots: where } = await trio();
    for (const [result, root] of [
      [inc, where.include],
      [exc, where.exclude],
    ] as const) {
      for (const entry of entries(result.report).filter(
        (candidate) => candidate.partition === 'partitioned-out',
      )) {
        expect(entry).toMatchObject({
          disposition: 'partitioned-out',
          outcome: 'SKIPPED',
          reason: 'partitioned-out',
        });
        expect(entry.resultDigest).toBeUndefined();
        expect(entry.exitCode).toBeUndefined();
        expect(result.started).not.toContain(entry.nodeId);
        expect(cached(root, entry.nodeId), `${entry.nodeId} cache index`).toBe(false);
      }
    }
  });

  it('executes test:cli only in the including run and only its closure in both', async () => {
    const { include: inc, exclude: exc } = await trio();
    // The preflight node runs its probes in-process, so it never reaches the executor.
    const executable = (nodeIds: readonly string[]) =>
      nodeIds.filter((nodeId) => nodeId !== 'preflight');
    expect(inc.started).toContain(CLI);
    expect(exc.started).not.toContain(CLI);
    const both = inc.started.filter((nodeId) => exc.started.includes(nodeId));
    expect([...both].sort()).toEqual([...executable(CLOSURE)].sort());
    expect([...inc.started].sort()).toEqual([...executable([...CLOSURE, ...INCLUDED])].sort());
  });

  it('runs preflight nodes as prerequisites in the including run and owns them in the other', async () => {
    const { include: inc, exclude: exc } = await trio();
    const preflight = (report: PartitionedReport) =>
      entries(report).find((entry) => entry.nodeId === 'preflight');
    expect(preflight(inc.report)).toMatchObject({
      partition: 'prerequisite',
      disposition: 'executed',
      outcome: 'PASS',
    });
    expect(preflight(exc.report)).toMatchObject({
      partition: 'owned',
      disposition: 'executed',
      outcome: 'PASS',
    });
  });

  it('owned entries in plan order form the unpartitioned comparable projection', async () => {
    const { whole, include: inc, exclude: exc } = await trio();
    const owned = whole.report.plan.tasks.map((task) => {
      const entry = [...entries(inc.report), ...entries(exc.report)].find(
        (candidate) => candidate.nodeId === task.nodeId && candidate.partition === 'owned',
      );
      if (entry === undefined) throw new Error(`no owned entry for ${task.nodeId}`);
      return comparable(entry);
    });
    expect(owned).toEqual(entries(whole.report).map(comparable));
  });

  it('writes no receipt from either partitioned run', async () => {
    const { include: inc, exclude: exc } = await trio();
    for (const report of [inc.report, exc.report]) {
      expect(report.receipt).toBeUndefined();
      expect(report.receiptRefusal).toBe('partitioned-run');
    }
  });

  it('computes each verdict over its owned entries only', async () => {
    // A failing node owned by the excluding run fails only that run, and a failing
    // test:cli fails only the including run.
    const lint = repository();
    const lintInclude = await run(lint.root, lint.base, include(CLI), ['lint']);
    const lintRest = repository();
    const lintExclude = await run(lintRest.root, lintRest.base, exclude(CLI), ['lint']);
    expect(lintInclude.report.exitCode).toBe(0);
    expect(lintExclude.report.exitCode).not.toBe(0);

    const cli = repository();
    const cliInclude = await run(cli.root, cli.base, include(CLI), [CLI]);
    const cliRest = repository();
    const cliExclude = await run(cliRest.root, cliRest.base, exclude(CLI), [CLI]);
    expect(cliInclude.report.exitCode).not.toBe(0);
    expect(cliExclude.report.exitCode).toBe(0);
  });

  it('holds at one worker as at four', async () => {
    const one = repository();
    const four = repository();
    const sequential = await run(one.root, one.base, include(CLI), [], 1);
    const parallel = await run(four.root, four.base, include(CLI), [], 4);
    expect(entries(parallel.report).map(comparable)).toEqual(
      entries(sequential.report).map(comparable),
    );
    expect(byPartition(sequential.report)).toEqual(byPartition(parallel.report));
  });
});

describe('IA-010: plans that do not split, and refusals', () => {
  it('lets the including run own a non-separable test:local-full plan whole', async () => {
    // test:local-full depends on test:cli and on lint, typecheck and docs, which lie outside
    // the closure of test:cli, so the plan cannot be split.
    const local = { target: 'local' as const };
    const whole = repository();
    const included = repository();
    const excluded = repository();
    const unsplit = await run(whole.root, whole.base, local);
    const inc = await run(included.root, included.base, { ...local, ...include(CLI) });
    const exc = await run(excluded.root, excluded.base, { ...local, ...exclude(CLI) });
    const planned = unsplit.report.plan.tasks.map((task) => task.nodeId);
    expect(planned).toContain(FALLBACK);
    expect(byPartition(inc.report)).toEqual({ owned: planned });
    expect(byPartition(exc.report)).toEqual({ 'partitioned-out': planned });
    expect(exc.started).toEqual([]);
    expect(exc.report.exitCode).toBe(0);
    expect(entries(inc.report).map(comparable)).toEqual(entries(unsplit.report).map(comparable));
  });

  it('lets the excluding run own everything when test:cli is not planned', async () => {
    // docs alone selects docs/, so a docs-only change plans docs and not test:cli.
    const docsOnly: NodeSpec[] = GATE.map((spec) =>
      spec.nodeId === 'docs' ? { ...spec, selector: 'docs/' } : spec,
    );
    const included = repository(docsOnly, 'docs/readme.md');
    const excluded = repository(docsOnly, 'docs/readme.md');
    const inc = await run(included.root, included.base, include(CLI));
    const exc = await run(excluded.root, excluded.base, exclude(CLI));
    const planned = inc.report.plan.tasks.map((task) => task.nodeId);
    expect(planned).toContain('docs');
    expect(planned).not.toContain(CLI);
    expect(byPartition(inc.report)).toEqual({ 'partitioned-out': planned });
    expect(inc.started).toEqual([]);
    expect(inc.report.exitCode).toBe(0);
    expect(byPartition(exc.report)).toEqual({ owned: planned });
  });

  it.each([
    ['an rc selection', { target: 'rc' as const }, include(CLI)],
    ['a preflight selection', { target: 'preflight' as const }, include(CLI)],
    [
      'a protected execution identity',
      { protectedExecutionIdentity: { kind: 'fixture' } },
      exclude(CLI),
    ],
    ['an unknown node id', {}, include('test:clii')],
    ['an unknown node id beside a known one', {}, exclude(CLI, 'nope')],
    ['an empty list', {}, include()],
    ['an operation other than run', { operation: 'plan' as const }, include(CLI)],
  ])('refuses a partition with %s before any node starts', async (_label, extra, partition) => {
    // One worker, so the refusal can never be the worker rule's: rc and protected runs
    // refuse more than one worker on their own.
    const { root, base } = repository();
    await expect(run(root, base, { ...extra, ...partition }, [], 1)).rejects.toThrow(
      /^CHECK_RUNNER_PARTITION/u,
    );
    expect(existsSync(join(root, CACHE_NODES))).toBe(false);
  });

  it('is refused identically by the sequential host', async () => {
    const { root, base } = repository();
    const started: string[] = [];
    await expect(
      inScope(async () =>
        runCheckTasks({
          repoRoot: root,
          target: 'affected',
          operation: 'run',
          baseCommit: base,
          toolchain: { node: 'v-test' },
          environment: {},
          partition: { mode: 'include', nodeIds: ['test:clii'] },
          executeTask: (_argv, _cwd, _timeout, _environment, identity) => {
            started.push(identity.nodeId);
            return PASS;
          },
        } as CheckRunnerOptions),
      ),
    ).rejects.toThrow(/^CHECK_RUNNER_PARTITION/u);
    expect(started).toEqual([]);
  });
});
