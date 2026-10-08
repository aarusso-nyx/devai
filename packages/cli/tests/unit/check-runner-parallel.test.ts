// ADR-CHK-0007 Inspector Adversarial Acceptance IA-001 to IA-008: the check runner executes
// independent plan nodes on a bounded worker pool, never overlaps conflicting nodes, keeps
// the sequential failure semantics, reports in plan order, and keeps the worker count and
// test-task-exclusivity.json out of every key, digest, and receipt.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { runCheckTasks, runCheckTasksAsync } from '../../src/services/check-runner/runner.js';
import {
  CHECK_WORKERS_ENV,
  MAX_CHECK_WORKERS,
  TASK_EXCLUSIVITY_PATH,
  defaultCheckWorkers,
  resolveCheckWorkers,
  sequentialOnlyTarget,
} from '../../src/services/check-runner/runner-schedule.js';
import type {
  CheckRunnerOptions,
  CheckRunnerReport,
  TaskExecutionResult,
} from '../../src/services/check-runner/types.js';

const NOW = '2026-10-07T00:00:00.000Z';
const FALLBACK = 'test:local-full';
const UNSET_PROBE_ENV = 'DEVAI_W23_PARALLEL_FIXTURE_NEVER_SET';
const PASS: TaskExecutionResult = { status: 0, signal: null, stdout: 'ok\n', stderr: '' };
const FAIL: TaskExecutionResult = { status: 1, signal: null, stdout: '', stderr: 'failed\n' };
const roots: string[] = [];
let ordinal = 0;

type Json = Readonly<Record<string, unknown>>;

/** One fixture node; `test:local-full` is appended and depends on every other node. */
interface NodeSpec {
  readonly nodeId: string;
  readonly dependencies?: readonly string[];
  readonly selector?: string;
  readonly allowlistedEnv?: readonly string[];
  readonly outputContract?: Json;
  readonly probes?: readonly Json[];
}

function scriptName(nodeId: string): string {
  return `bin/${nodeId.replaceAll(':', '-')}.mjs`;
}

function descriptorNode(spec: NodeSpec): Json {
  const common = {
    nodeId: spec.nodeId,
    dependencies: spec.dependencies ?? [],
    cwd: '.',
    inputSelectors: [{ kind: 'prefix', pattern: spec.selector ?? 'src/' }],
    toolchainKeys: ['node'],
    allowlistedEnv: spec.allowlistedEnv ?? [],
  };
  if (spec.probes !== undefined) {
    return {
      ...common,
      runner: 'preflight-v1',
      probes: spec.probes,
      outputContract: { kind: 'probes', requiredStatus: 'pass' },
    };
  }
  return {
    ...common,
    argv: ['node', scriptName(spec.nodeId)],
    runner: 'node-v1',
    outputContract: spec.outputContract ?? { kind: 'marker', value: spec.nodeId },
  };
}

function descriptor(specs: readonly NodeSpec[]): Json {
  const all = [...specs, { nodeId: FALLBACK, dependencies: specs.map((spec) => spec.nodeId) }];
  return {
    schemaVersion: '1.0.0',
    descriptorVersion: 'parallel-runner-inspector',
    repositoryId: 'fixture/parallel-runner',
    fallbackNodeId: FALLBACK,
    dynamicFallbackSelectors: [],
    tasks: all.map(descriptorNode),
    profiles: [{ profileId: 'affected', mode: 'affected', requiredNodes: [], eligibleNodes: [] }],
  };
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-10-07T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-07T00:00:00Z',
    },
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function put(root: string, path: string, bytes: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, 'utf8');
}

interface RepositoryOptions {
  /** Contents of test-task-exclusivity.json; `null` leaves the file absent. */
  readonly exclusivity?: unknown;
  /** Raw bytes instead of a JSON document. */
  readonly exclusivityBytes?: string;
  /** Extra committed files, for example real node scripts. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * A committed fixture repository. test-task-exclusivity.json is git-ignored, so its
 * presence and content never change the commit, the tree, or the cleanliness of the
 * checkout: only the runner's own reading of it can make two runs differ.
 */
function repository(specs: readonly NodeSpec[], options: RepositoryOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-parallel-ia-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Parallel Inspector']);
  git(root, ['config', 'user.email', 'parallel-inspector@example.invalid']);
  put(root, '.gitignore', `.devai/state/*\nout/\ngen/\n${TASK_EXCLUSIVITY_PATH}\n`);
  put(root, 'src/main.ts', 'export const value = 1;\n');
  put(root, 'cached/stable.txt', 'stable\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor(specs), null, 2)}\n`);
  for (const [path, bytes] of Object.entries(options.files ?? {})) put(root, path, bytes);
  if (options.exclusivityBytes !== undefined) {
    put(root, TASK_EXCLUSIVITY_PATH, options.exclusivityBytes);
  } else if (options.exclusivity !== null && options.exclusivity !== undefined) {
    put(root, TASK_EXCLUSIVITY_PATH, `${JSON.stringify(options.exclusivity, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

/** Declares every node, including the fallback, with the given entries or `{}`. */
function declareAll(specs: readonly NodeSpec[], entries: Readonly<Record<string, Json>> = {}) {
  return {
    schemaVersion: '1.0.0',
    nodes: Object.fromEntries(
      [...specs.map((spec) => spec.nodeId), FALLBACK].map((nodeId) => [
        nodeId,
        entries[nodeId] ?? {},
      ]),
    ),
  };
}

async function inScope<T>(callback: () => Promise<T>): Promise<T> {
  ordinal += 1;
  const id = `check-runner-parallel-ia-${String(ordinal)}`;
  let receipt = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-parallel-ia-test',
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Behavior {
  readonly delayMs?: number;
  readonly result?: 'pass' | 'fail' | 'throw';
}

/** Records every start and end as an ordered event and tracks concurrency. */
class Recorder {
  readonly events: string[] = [];
  readonly timeouts = new Map<string, number>();
  running = 0;
  peak = 0;
  firstStart = Infinity;
  lastEnd = -Infinity;
  /** The declared output paths of each node, which a passing node must leave behind. */
  private readonly outputs: ReadonlyMap<string, readonly string[]>;

  constructor(
    private readonly root: string,
    private readonly behavior: Readonly<Record<string, Behavior>> = {},
    private readonly defaultDelayMs = 5,
  ) {
    const document = JSON.parse(readFileSync(join(root, 'test-tasks.json'), 'utf8')) as {
      tasks: { nodeId: string; outputContract: { paths?: string[] } }[];
    };
    this.outputs = new Map(
      document.tasks.map((task) => [task.nodeId, task.outputContract.paths ?? []]),
    );
  }

  readonly execute = async (
    _argv: readonly string[],
    _cwd: string,
    timeoutMs: number,
    _environment: Readonly<Record<string, string>>,
    identity: Readonly<{ nodeId: string }>,
  ): Promise<TaskExecutionResult> => {
    const { nodeId } = identity;
    const behavior = this.behavior[nodeId] ?? {};
    this.events.push(`start:${nodeId}`);
    this.firstStart = Math.min(this.firstStart, performance.now());
    this.timeouts.set(nodeId, timeoutMs);
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    try {
      await sleep(behavior.delayMs ?? this.defaultDelayMs);
      if (behavior.result === 'throw') throw new Error(`HOST_REFUSED:${nodeId}`);
      for (const path of this.outputs.get(nodeId) ?? []) put(this.root, path, `${nodeId}\n`);
      return behavior.result === 'fail' ? FAIL : PASS;
    } finally {
      this.running -= 1;
      this.lastEnd = Math.max(this.lastEnd, performance.now());
      this.events.push(`end:${nodeId}`);
    }
  };

  started(): string[] {
    return this.events.filter((event) => event.startsWith('start:')).map((event) => event.slice(6));
  }

  ended(): string[] {
    return this.events.filter((event) => event.startsWith('end:')).map((event) => event.slice(4));
  }

  at(kind: 'start' | 'end', nodeId: string): number {
    const index = this.events.indexOf(`${kind}:${nodeId}`);
    if (index < 0) throw new Error(`fixture: no ${kind} event for ${nodeId}`);
    return index;
  }

  overlap(left: string, right: string): boolean {
    return (
      this.at('start', left) < this.at('end', right) &&
      this.at('start', right) < this.at('end', left)
    );
  }
}

function baseOptions(root: string): Omit<CheckRunnerOptions, 'executeTask'> {
  return {
    repoRoot: root,
    target: 'local',
    operation: 'run',
    toolchain: { node: 'v-test' },
    environment: {},
    resolveExecutable: () => ({ path: process.execPath, sha256: 'e'.repeat(64) }),
    now: () => NOW,
  };
}

function runAsync(
  root: string,
  recorder: Recorder | undefined,
  workers: number,
  extra: Partial<Omit<CheckRunnerOptions, 'executeTask'>> = {},
): Promise<CheckRunnerReport> {
  return inScope(() =>
    runCheckTasksAsync({
      ...baseOptions(root),
      ...extra,
      ...(recorder !== undefined && { executeTask: recorder.execute }),
      workers,
    }),
  );
}

/** ADR-CHK-0007 rule 9: the comparable projection of one execution entry. */
function comparable(report: CheckRunnerReport) {
  return (report.execution ?? []).map(
    ({ nodeId, taskKey, disposition, outcome, reason, exitCode, signal }) => ({
      nodeId,
      taskKey,
      disposition,
      outcome,
      reason,
      exitCode,
      signal,
    }),
  );
}

function verdict(report: CheckRunnerReport) {
  return {
    planned: report.plan.tasks.map((task) => task.nodeId),
    execution: comparable(report),
    blocked: report.blocked,
    receiptPresent: report.receipt !== undefined,
    refusal: report.receiptRefusal,
    exitCode: report.exitCode,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

// A plan whose independent middle can run four wide: a writer, readers of its key, and a
// fallback root. Every node declares; readers only share.
const FAN: readonly NodeSpec[] = [
  { nodeId: 'generate' },
  { nodeId: 'unit-a', dependencies: ['generate'] },
  { nodeId: 'unit-b', dependencies: ['generate'] },
  { nodeId: 'unit-c', dependencies: ['generate'] },
  { nodeId: 'unit-d', dependencies: ['generate'] },
];
const FAN_EXCLUSIVITY = declareAll(FAN, {
  generate: { exclusive: ['sources'] },
  'unit-a': { shared: ['sources'] },
  'unit-b': { shared: ['sources'] },
  'unit-c': { shared: ['sources'] },
  'unit-d': { shared: ['sources'] },
});

describe('IA-001 and rule 9: one worker and four workers reach the same verdict', () => {
  // Plan order: a BLOCKED extrinsic probe, a node reused from a primed cache, a FAIL, an
  // ABORTED dependent of the FAIL, a blocked-environment dependent of the probe, passes.
  const SPECS: readonly NodeSpec[] = [
    {
      nodeId: 'preflight',
      selector: 'test-tasks.json',
      probes: [
        {
          id: 'fixture-environment',
          class: 'extrinsic',
          probe: { kind: 'environment', name: UNSET_PROBE_ENV },
          expected: `${UNSET_PROBE_ENV} is set`,
          observed: null,
          status: 'pass',
          remediation: `Set ${UNSET_PROBE_ENV}.`,
          depends_on: [],
        },
      ],
    },
    { nodeId: 'cached', selector: 'cached/' },
    { nodeId: 'generate' },
    { nodeId: 'unit-a', dependencies: ['generate'] },
    { nodeId: 'unit-b', dependencies: ['generate'] },
    { nodeId: 'unit-c', dependencies: ['generate'] },
    { nodeId: 'integration', dependencies: ['unit-b'] },
    { nodeId: 'e2e', dependencies: ['preflight'] },
  ];
  const BEHAVIOR: Readonly<Record<string, Behavior>> = {
    generate: { delayMs: 5 },
    'unit-a': { delayMs: 60 },
    'unit-b': { delayMs: 5, result: 'fail' },
    'unit-c': { delayMs: 30 },
  };

  /** A primed repository: `cached` passed once, then src/ changed so the rest re-run. */
  async function primed(): Promise<string> {
    const root = repository(SPECS, {
      exclusivity: declareAll(SPECS, {
        generate: { exclusive: ['sources'] },
        'unit-a': { shared: ['sources'] },
        'unit-b': { shared: ['sources'] },
        'unit-c': { shared: ['sources'] },
      }),
    });
    await runAsync(root, new Recorder(root), 1);
    put(root, 'src/main.ts', 'export const value = 2;\n');
    git(root, ['commit', '-qam', 'change sources']);
    return root;
  }

  it('records the same comparable projection, blocked list, receipt presence and exit code', async () => {
    const sequentialRoot = await primed();
    const parallelRoot = await primed();
    const sequential = await runAsync(sequentialRoot, new Recorder(sequentialRoot, BEHAVIOR), 1);
    const parallelRecorder = new Recorder(parallelRoot, BEHAVIOR);
    const parallel = await runAsync(parallelRoot, parallelRecorder, 4);

    // The fixture really holds every disposition class the guarantee is about.
    const outcomes = Object.fromEntries(
      comparable(sequential).map(({ nodeId, disposition, outcome, reason }) => [
        nodeId,
        [disposition, outcome, reason],
      ]),
    );
    expect(outcomes['preflight']).toEqual(['executed', 'BLOCKED', expect.any(String)]);
    expect(outcomes['cached']?.[0]).toBe('reused');
    expect(outcomes['unit-b']).toEqual(['executed', 'FAIL', 'process-exit-1']);
    expect(outcomes['integration']).toEqual(['aborted', 'ABORTED', 'dependency-not-pass']);
    expect(outcomes['e2e']?.[0]).toBe('blocked-environment');
    expect(outcomes['unit-a']?.slice(0, 2)).toEqual(['executed', 'PASS']);
    expect(sequential.blocked?.length).toBeGreaterThan(0);
    expect(sequential.exitCode).not.toBe(0);

    // Four workers really ran nodes at once, and still reached the same verdict.
    expect(parallelRecorder.peak).toBeGreaterThan(1);
    expect(verdict(parallel)).toEqual(verdict(sequential));
  });
});

describe('IA-002 and rule 6: dependencies gate starts; the report keeps plan order', () => {
  // Independent nodes finish in reverse plan order; each chain link waits for its dependency.
  const SPECS: readonly NodeSpec[] = [
    { nodeId: 'root' },
    { nodeId: 'slowest', dependencies: ['root'] },
    { nodeId: 'slower', dependencies: ['root'] },
    { nodeId: 'slow', dependencies: ['root'] },
    { nodeId: 'fast', dependencies: ['root'] },
    { nodeId: 'after-fast', dependencies: ['fast'] },
    { nodeId: 'after-slowest', dependencies: ['slowest', 'after-fast'] },
  ];
  const BEHAVIOR: Readonly<Record<string, Behavior>> = {
    root: { delayMs: 5 },
    slowest: { delayMs: 120 },
    slower: { delayMs: 80 },
    slow: { delayMs: 40 },
    fast: { delayMs: 5 },
    'after-fast': { delayMs: 5 },
    'after-slowest': { delayMs: 5 },
  };

  it('never starts a node before all of its dependencies have ended', async () => {
    const root = repository(SPECS, { exclusivity: declareAll(SPECS) });
    const recorder = new Recorder(root, BEHAVIOR);
    const report = await runAsync(root, recorder, 4);

    const plan = [...SPECS.map((spec) => spec.nodeId), FALLBACK];
    for (const spec of [...SPECS, { nodeId: FALLBACK, dependencies: SPECS.map((s) => s.nodeId) }]) {
      for (const dependency of spec.dependencies ?? []) {
        expect(recorder.at('end', dependency), `${dependency} before ${spec.nodeId}`).toBeLessThan(
          recorder.at('start', spec.nodeId),
        );
      }
    }
    // Completion order differs from plan order (the independent four end in reverse) ...
    const independent = ['slowest', 'slower', 'slow', 'fast'];
    expect(recorder.ended().filter((nodeId) => independent.includes(nodeId))).toEqual(
      [...independent].reverse(),
    );
    expect(recorder.ended()).not.toEqual(plan);
    // ... while the report is assembled in plan order.
    expect(report.plan.tasks.map((task) => task.nodeId)).toEqual(plan);
    expect(report.execution?.map((entry) => entry.nodeId)).toEqual(plan);
    expect(report.exitCode).toBe(0);
  });
});

describe('IA-003 and rule 2: the worker count bounds concurrency', () => {
  const WIDE: readonly NodeSpec[] = Array.from({ length: 8 }, (_, at) => ({
    nodeId: `leaf-${String(at)}`,
  }));

  it.each([1, 2, 3, 5])('never runs more than %i node processes at once', async (workers) => {
    const root = repository(WIDE, { exclusivity: declareAll(WIDE) });
    const recorder = new Recorder(root, {}, 20);
    const report = await runAsync(root, recorder, workers);
    expect(report.exitCode).toBe(0);
    expect(recorder.peak).toBe(Math.min(workers, WIDE.length));
  });

  it('with one worker starts nodes in plan order and never overlaps two', async () => {
    const root = repository(WIDE, { exclusivity: declareAll(WIDE) });
    const recorder = new Recorder(root, {}, 5);
    await runAsync(root, recorder, 1);
    expect(recorder.peak).toBe(1);
    expect(recorder.started()).toEqual([...WIDE.map((spec) => spec.nodeId), FALLBACK]);
    expect(recorder.events).toEqual(
      recorder.started().flatMap((nodeId) => [`start:${nodeId}`, `end:${nodeId}`]),
    );
  });

  it('runs independent nodes concurrently, so wall time stays well below their summed time', async () => {
    const root = repository(FAN, { exclusivity: FAN_EXCLUSIVITY });
    const recorder = new Recorder(root, {}, 100);
    const report = await runAsync(root, recorder, 4);
    // The execution window, from the first node's start to the last node's end.
    const wall = recorder.lastEnd - recorder.firstStart;
    const summed = (report.execution ?? []).reduce((total, entry) => total + entry.durationMs, 0);

    expect(report.exitCode).toBe(0);
    expect(recorder.peak).toBe(4);
    // Six nodes of ~100 ms: ~600 ms in sequence, ~300 ms on the critical path.
    expect(summed).toBeGreaterThanOrEqual(600);
    expect(wall).toBeLessThan(summed * 0.75);
  });

  it('runs real node processes concurrently through the default executor', async () => {
    const scripts = Object.fromEntries(
      [...FAN.map((spec) => spec.nodeId), FALLBACK].map((nodeId) => [
        scriptName(nodeId),
        nodeId.startsWith('unit-') ? 'setTimeout(() => {}, 500);\n' : '\n',
      ]),
    );
    const walls: number[] = [];
    const reports: CheckRunnerReport[] = [];
    for (const workers of [1, 4]) {
      const root = repository(FAN, { exclusivity: FAN_EXCLUSIVITY, files: scripts });
      const started = performance.now();
      reports.push(await runAsync(root, undefined, workers, { timeoutMs: 20_000 }));
      walls.push(performance.now() - started);
    }
    const [sequential, parallel] = reports;
    expect(sequential?.exitCode).toBe(0);
    expect(parallel && comparable(parallel)).toEqual(sequential && comparable(sequential));
    // Four 500 ms units: ~2 s in sequence, ~0.5 s side by side.
    expect(walls[1] ?? Infinity).toBeLessThan((walls[0] ?? 0) - 1000);
  }, 60_000);
});

describe('IA-004 and rule 5: conflicting nodes never overlap and keep plan order', () => {
  // `early` is earlier in plan order but waits for `gate`; `late` is ready at once. A
  // conflict must hold `late` until `early` ends; without one, `late` runs first.
  function pair(early: Partial<NodeSpec>, late: Partial<NodeSpec>): NodeSpec[] {
    return [
      { nodeId: 'gate' },
      { ...early, nodeId: 'early', dependencies: ['gate'] },
      { ...late, nodeId: 'late' },
    ];
  }
  const TIMING: Readonly<Record<string, Behavior>> = {
    gate: { delayMs: 60 },
    early: { delayMs: 40 },
    late: { delayMs: 40 },
  };
  const OUT = (path: string): Json => ({ kind: 'build', paths: [path] });

  type Case = readonly [
    string,
    NodeSpec[],
    Readonly<Record<string, Json>> | 'undeclared-late' | 'undeclared-early',
  ];
  const conflicting: readonly Case[] = [
    [
      'an exclusive key the other shares',
      pair({}, {}),
      { early: { exclusive: ['db-x'] }, late: { shared: ['db-x'] } },
    ],
    [
      'a shared key the other holds exclusively',
      pair({}, {}),
      { early: { shared: ['dist'] }, late: { exclusive: ['dist'] } },
    ],
    [
      'an exclusive key both hold exclusively',
      pair({}, {}),
      { early: { exclusive: ['dist'] }, late: { exclusive: ['dist'] } },
    ],
    ['a declared node and an undeclared later node', pair({}, {}), 'undeclared-late'],
    ['an undeclared node and a declared later node', pair({}, {}), 'undeclared-early'],
    [
      'equal output paths',
      pair({ outputContract: OUT('out/shared.json') }, { outputContract: OUT('out/shared.json') }),
      {},
    ],
    [
      'an output path under a generated namespace prefix',
      pair(
        {
          outputContract: {
            kind: 'build',
            generated_namespaces: [{ derivation: 'fixture', prefix: 'gen' }],
          },
        },
        { outputContract: OUT('gen/late.json') },
      ),
      {},
    ],
    [
      'two nodes that both allowlist DEVAI_DB_URL',
      pair({ allowlistedEnv: ['DEVAI_DB_URL'] }, { allowlistedEnv: ['CI', 'DEVAI_DB_URL'] }),
      {},
    ],
  ];

  function exclusivityFor(specs: NodeSpec[], entries: Case[2]) {
    if (entries === 'undeclared-late' || entries === 'undeclared-early') {
      const missing = entries === 'undeclared-late' ? 'late' : 'early';
      const declared = declareAll(specs);
      const nodes = Object.fromEntries(
        Object.entries(declared.nodes).filter(([id]) => id !== missing),
      );
      return { ...declared, nodes };
    }
    return declareAll(specs, entries);
  }

  async function observe(specs: NodeSpec[], entries: Case[2]): Promise<Recorder> {
    const root = repository(specs, { exclusivity: exclusivityFor(specs, entries) });
    const recorder = new Recorder(root, TIMING);
    const report = await runAsync(root, recorder, 4);
    expect(report.exitCode, JSON.stringify(comparable(report))).toBe(0);
    return recorder;
  }

  it.each(conflicting)('serializes %s, earlier plan node first', async (_label, specs, entries) => {
    const recorder = await observe(specs, entries);
    expect(recorder.overlap('early', 'late')).toBe(false);
    expect(recorder.at('start', 'early')).toBeLessThan(recorder.at('start', 'late'));
    expect(recorder.at('end', 'early')).toBeLessThan(recorder.at('start', 'late'));
  });

  it.each([
    [
      'two nodes that only share a key',
      pair({}, {}),
      { early: { shared: ['dist'] }, late: { shared: ['dist'] } },
    ],
    [
      'disjoint exclusive keys',
      pair({}, {}),
      { early: { exclusive: ['a'] }, late: { exclusive: ['b'] } },
    ],
    [
      'sibling paths that only share a name prefix',
      pair({ outputContract: OUT('out/dist') }, { outputContract: OUT('out/distx') }),
      {},
    ],
    [
      'one node allowlisting DEVAI_DB_URL',
      pair({ allowlistedEnv: ['DEVAI_DB_URL'] }, { allowlistedEnv: ['CI'] }),
      {},
    ],
  ] as const satisfies readonly Case[])('overlaps %s', async (_label, specs, entries) => {
    const recorder = await observe([...specs], entries);
    // `late` is free to start while `early` still waits for `gate`, and they overlap.
    expect(recorder.at('start', 'late')).toBeLessThan(recorder.at('start', 'early'));
    expect(recorder.overlap('gate', 'late')).toBe(true);
  });

  it('runs every plan one node at a time when test-task-exclusivity.json is absent', async () => {
    const root = repository(FAN, { exclusivity: null });
    const recorder = new Recorder(root, {}, 10);
    const report = await runAsync(root, recorder, 4);
    expect(report.exitCode).toBe(0);
    expect(recorder.peak).toBe(1);
    expect(recorder.started()).toEqual([...FAN.map((spec) => spec.nodeId), FALLBACK]);
  });
});

describe('IA-005 and rule 8: no fail-fast', () => {
  it('lets running siblings finish, starts every independent node, and aborts only dependents', async () => {
    const ordered: NodeSpec[] = [
      { nodeId: 'long' },
      { nodeId: 'broken' },
      { nodeId: 'gate' },
      { nodeId: 'after-broken', dependencies: ['broken'] },
      { nodeId: 'beyond', dependencies: ['after-broken'] },
      { nodeId: 'independent-late', dependencies: ['gate'] },
    ];
    const root = repository(ordered, { exclusivity: declareAll(ordered) });
    const recorder = new Recorder(root, {
      long: { delayMs: 150 },
      broken: { delayMs: 5, result: 'fail' },
      gate: { delayMs: 40 },
      'independent-late': { delayMs: 5 },
    });
    const report = await runAsync(root, recorder, 4);

    // The failure ended while `long` was running; `long` ran its full course and passed.
    expect(recorder.at('end', 'broken')).toBeLessThan(recorder.at('end', 'long'));
    expect(recorder.overlap('broken', 'long')).toBe(true);
    // A node that only became ready after the failure still started.
    expect(recorder.at('start', 'independent-late')).toBeGreaterThan(recorder.at('end', 'broken'));
    expect(recorder.started()).not.toContain('after-broken');
    expect(recorder.started()).not.toContain('beyond');
    expect(recorder.started()).not.toContain(FALLBACK);
    expect(recorder.running).toBe(0);

    expect(
      report.execution?.map(({ nodeId, disposition, outcome, reason }) => [
        nodeId,
        disposition,
        outcome,
        reason,
      ]),
    ).toEqual([
      ['long', 'executed', 'PASS', 'cache-miss'],
      ['broken', 'executed', 'FAIL', 'process-exit-1'],
      ['gate', 'executed', 'PASS', 'cache-miss'],
      ['after-broken', 'aborted', 'ABORTED', 'dependency-not-pass'],
      ['beyond', 'aborted', 'ABORTED', 'dependency-not-pass'],
      ['independent-late', 'executed', 'PASS', 'cache-miss'],
      [FALLBACK, 'aborted', 'ABORTED', 'dependency-not-pass'],
    ]);
    expect(report.exitCode).not.toBe(0);
  });

  it('on a host error stops new starts, lets running nodes settle, then raises it', async () => {
    const root = repository(FAN, { exclusivity: FAN_EXCLUSIVITY });
    const recorder = new Recorder(root, {
      'unit-a': { delayMs: 120 },
      'unit-b': { delayMs: 5, result: 'throw' },
      'unit-c': { delayMs: 120 },
      'unit-d': { delayMs: 120 },
    });
    await expect(runAsync(root, recorder, 3)).rejects.toThrow('HOST_REFUSED:unit-b');
    expect(recorder.running).toBe(0);
    expect(recorder.ended()).toEqual(expect.arrayContaining(['unit-a', 'unit-c']));
    const failedAt = recorder.at('end', 'unit-b');
    expect(
      recorder.events.slice(failedAt + 1).filter((event) => event.startsWith('start:')),
    ).toEqual([]);
    expect(recorder.started()).not.toContain('unit-d');
  });
});

describe("IA-006 and rule 7: per-task timeouts run from each node's own start", () => {
  it('hands every node the full per-task timeout, whatever it waited, and keeps the default', async () => {
    const SPECS: readonly NodeSpec[] = [{ nodeId: 'holder' }, { nodeId: 'waiter' }];
    // Both hold `lock`, so `waiter` queues behind `holder` longer than the timeout itself.
    const exclusivity = declareAll(SPECS, {
      holder: { exclusive: ['lock'] },
      waiter: { exclusive: ['lock'] },
    });
    const root = repository(SPECS, { exclusivity });
    const recorder = new Recorder(root, { holder: { delayMs: 120 }, waiter: { delayMs: 5 } });
    const report = await runAsync(root, recorder, 4, { timeoutMs: 50 });
    expect(recorder.at('start', 'waiter')).toBeGreaterThan(recorder.at('end', 'holder'));
    expect(recorder.timeouts.get('waiter')).toBe(50);
    expect(report.execution?.find((entry) => entry.nodeId === 'waiter')?.outcome).toBe('PASS');

    const defaultRoot = repository(SPECS, { exclusivity });
    const defaults = new Recorder(defaultRoot);
    await runAsync(defaultRoot, defaults, 4);
    expect([...defaults.timeouts.values()]).toEqual([30 * 60_000, 30 * 60_000, 30 * 60_000]);
  });

  it('runs a real process that queued past the timeout and times out only a node that overruns', async () => {
    const SPECS: readonly NodeSpec[] = [
      { nodeId: 'holder' },
      { nodeId: 'waiter' },
      { nodeId: 'overrun' },
    ];
    const exclusivity = declareAll(SPECS, {
      holder: { exclusive: ['lock'] },
      waiter: { exclusive: ['lock'] },
      overrun: { shared: ['elsewhere'] },
    });
    const root = repository(SPECS, {
      exclusivity,
      files: {
        [scriptName('holder')]: 'setTimeout(() => {}, 1200);\n',
        [scriptName('waiter')]: 'setTimeout(() => {}, 100);\n',
        [scriptName('overrun')]: 'setTimeout(() => {}, 60_000);\n',
        [scriptName(FALLBACK)]: '\n',
      },
    });
    const report = await runAsync(root, undefined, 4, { timeoutMs: 1000 });
    const outcome = (nodeId: string) => report.execution?.find((entry) => entry.nodeId === nodeId);
    // `holder` overruns its own 1000 ms and times out, like `overrun`. `waiter` queued
    // behind `holder` for about the whole timeout, yet passes: its clock starts at its start.
    expect(outcome('holder')?.outcome).toBe('TIMEOUT');
    expect(outcome('overrun')?.outcome).toBe('TIMEOUT');
    expect(outcome('waiter')?.outcome).toBe('PASS');
  }, 30_000);
});

describe('IA-007 and rules 2-3: worker count resolution and release sequencing', () => {
  it('defaults to min(4, CPUs) and admits 1 to 16', () => {
    expect(MAX_CHECK_WORKERS).toBe(16);
    expect(CHECK_WORKERS_ENV).toBe('DEVAI_CHECK_TASK_WORKERS');
    for (const [cpus, expected] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [8, 4],
      [64, 4],
    ] as const) {
      expect(defaultCheckWorkers(cpus), `cpus ${String(cpus)}`).toBe(expected);
      expect(resolveCheckWorkers(undefined, {}, cpus)).toBe(expected);
    }
    for (const admitted of ['1', '2', '16'])
      expect(resolveCheckWorkers(admitted, {}, 4)).toBe(Number(admitted));
  });

  it('lets --task-workers win over DEVAI_CHECK_TASK_WORKERS, which wins over the default', () => {
    expect(resolveCheckWorkers(undefined, { DEVAI_CHECK_TASK_WORKERS: '7' }, 2)).toBe(7);
    expect(resolveCheckWorkers('3', { DEVAI_CHECK_TASK_WORKERS: '7' }, 2)).toBe(3);
    expect(resolveCheckWorkers('1', { DEVAI_CHECK_TASK_WORKERS: '16' }, 8)).toBe(1);
    // The flag wins even over an environment value that would itself be refused.
    expect(resolveCheckWorkers('2', { DEVAI_CHECK_TASK_WORKERS: 'many' }, 8)).toBe(2);
  });

  it.each(['', '0', '17', '1.5', '2.0', '-1', '+2', ' 2', '0x2', '1e1', 'two', 'NaN'])(
    'refuses %j from either source with CHECK_RUNNER_WORKERS',
    (value) => {
      expect(() => resolveCheckWorkers(value, {}, 4)).toThrow(/^CHECK_RUNNER_WORKERS/u);
      expect(() => resolveCheckWorkers(undefined, { DEVAI_CHECK_TASK_WORKERS: value }, 4)).toThrow(
        /^CHECK_RUNNER_WORKERS/u,
      );
    },
  );

  it('admits more than one worker only for affected, preflight and local selections', () => {
    const targets = ['affected', 'local', 'preflight', 'rc', 'release'] as const;
    expect(targets.filter((target) => !sequentialOnlyTarget(target))).toEqual([
      'affected',
      'local',
      'preflight',
    ]);
    // A protected execution identity is sequential whatever its selection.
    for (const target of targets) expect(sequentialOnlyTarget(target, true)).toBe(true);
  });

  it('keeps rc, release and protected runs at one worker and ignores the environment there', () => {
    expect(sequentialOnlyTarget('rc')).toBe(true);
    expect(sequentialOnlyTarget('release')).toBe(true);
    expect(sequentialOnlyTarget('affected', true)).toBe(true);
    for (const environment of [
      { DEVAI_CHECK_TASK_WORKERS: '8' },
      { DEVAI_CHECK_TASK_WORKERS: 'many' },
      { DEVAI_CHECK_TASK_WORKERS: '' },
    ]) {
      expect(resolveCheckWorkers(undefined, environment, 8, true)).toBe(1);
    }
    expect(resolveCheckWorkers('1', {}, 8, true)).toBe(1);
    for (const refused of ['2', '16', '0', '17']) {
      expect(() => resolveCheckWorkers(refused, {}, 8, true)).toThrow(/^CHECK_RUNNER_WORKERS/u);
    }
  });

  it.each([
    ['an rc target with two workers', { target: 'rc' as const }, 2],
    ['a release target with two workers', { target: 'release' as const }, 2],
    [
      'a protected execution identity with two workers',
      { protectedExecutionIdentity: { kind: 'fixture' } },
      2,
    ],
    ['zero workers', {}, 0],
    ['seventeen workers', {}, 17],
    ['a fractional worker count', {}, 1.5],
    ['a non-numeric worker count', {}, Number.NaN],
  ])('refuses %s before any node starts', async (_label, extra, workers) => {
    const root = repository(FAN, { exclusivity: FAN_EXCLUSIVITY });
    const recorder = new Recorder(root);
    await expect(runAsync(root, recorder, workers, extra)).rejects.toThrow(
      /^CHECK_RUNNER_WORKERS/u,
    );
    expect(recorder.events).toEqual([]);
  });
});

describe('IA-008 and rule 10: scheduling is not an input', () => {
  const SPECS: readonly NodeSpec[] = [
    { nodeId: 'generate' },
    { nodeId: 'unit-a', dependencies: ['generate'] },
    { nodeId: 'unit-b', dependencies: ['generate'] },
    { nodeId: 'unit-c', dependencies: ['generate'] },
  ];
  const DECLARATIONS = [
    null,
    declareAll(SPECS),
    declareAll(SPECS, { generate: { exclusive: ['sources'] }, 'unit-a': { shared: ['sources'] } }),
    declareAll(SPECS, { 'unit-b': { exclusive: ['x', 'y'] }, 'unit-c': { shared: ['x'] } }),
  ] as const;

  /** A clean two-commit repository whose affected run is receipt-bearing. */
  function affectedRepository(exclusivity: unknown): { root: string; base: string } {
    const root = repository(SPECS, { exclusivity });
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, 'src/main.ts', 'export const value = 2;\n');
    git(root, ['commit', '-qam', 'change sources']);
    return { root, base };
  }

  async function affectedReport(
    mode: 'sync' | number,
    exclusivity: unknown,
    behavior: Readonly<Record<string, Behavior>> = {},
  ): Promise<string> {
    const { root, base } = affectedRepository(exclusivity);
    const recorder = new Recorder(root, behavior, 0);
    const options = { ...baseOptions(root), target: 'affected' as const, baseCommit: base };
    const report =
      mode === 'sync'
        ? await inScope(() =>
            Promise.resolve(
              runCheckTasks({
                ...options,
                executeTask: (_argv, _cwd, _timeout, _environment, identity) =>
                  identity.nodeId === 'unit-c' ? FAIL : PASS,
              }),
            ),
          )
        : await inScope(() =>
            runCheckTasksAsync({ ...options, executeTask: recorder.execute, workers: mode }),
          );
    return JSON.stringify(report).replaceAll(root, '<root>');
  }

  it('yields byte-identical plans, task keys, digests and receipts whatever the workers and declarations', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const behavior: Readonly<Record<string, Behavior>> = { 'unit-c': { result: 'fail' } };
    const sequential = await affectedReport('sync', null);
    const parsed = JSON.parse(sequential) as CheckRunnerReport;
    // The fixture is receipt-bearing and planned the whole fan, so the comparison is not vacuous.
    expect(parsed.plan.tasks.map((task) => task.nodeId)).toEqual([
      ...SPECS.map((spec) => spec.nodeId),
      FALLBACK,
    ]);
    expect(parsed.receipt ?? parsed.receiptRefusal).toBeDefined();
    expect(parsed.receipt?.digest ?? parsed.receiptRefusal).toEqual(expect.any(String));

    for (const workers of [1, 2, 4, 16]) {
      for (const declaration of DECLARATIONS) {
        expect(
          await affectedReport(workers, declaration, behavior),
          `workers ${String(workers)}, ${JSON.stringify(declaration)}`,
        ).toBe(sequential);
      }
    }
  }, 60_000);

  /**
   * Refuse the same file through the sequential host, one async worker, and four: the
   * refusal must not depend on the worker count, and no node may start in any of them.
   */
  async function refusals(options: RepositoryOptions): Promise<string[]> {
    const messages: string[] = [];
    for (const mode of ['sync', 1, 4] as const) {
      const root = repository(SPECS, options);
      const recorder = new Recorder(root);
      const attempt =
        mode === 'sync'
          ? inScope(async () =>
              runCheckTasks({
                ...baseOptions(root),
                executeTask: (_argv, _cwd, _timeout, _environment, identity) => {
                  recorder.events.push(`start:${identity.nodeId}`);
                  return PASS;
                },
              }),
            )
          : runAsync(root, recorder, mode);
      const error = await attempt.then(
        () => new Error(`no refusal with ${String(mode)}`),
        (refusal: unknown) => refusal,
      );
      expect(recorder.events, `nodes started with ${String(mode)}`).toEqual([]);
      messages.push(error instanceof Error ? error.message : String(error));
    }
    return messages.map((message) =>
      message.replaceAll(/\/[^\s]*devai-check-runner-parallel-ia-[^\s/]*/gu, '<root>'),
    );
  }

  it('refuses a declaration of a node the descriptor does not declare at every worker count', async () => {
    const messages = await refusals({
      exclusivity: { schemaVersion: '1.0.0', nodes: { 'unit-z': {} } },
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(
      /^CHECK_RUNNER_EXCLUSIVITY: unit-z is not a node of the task descriptor/u,
    );
  });

  it.each([
    [
      'a misspelled declaration list',
      { schemaVersion: '1.0.0', nodes: { generate: { exlusive: ['sources'] } } },
    ],
    [
      'an unknown declaration field',
      { schemaVersion: '1.0.0', nodes: { generate: { exclusive: ['s'], order: 1 } } },
    ],
    [
      'an uppercase key',
      { schemaVersion: '1.0.0', nodes: { generate: { exclusive: ['Sources'] } } },
    ],
    [
      'a key with a colon',
      { schemaVersion: '1.0.0', nodes: { generate: { shared: ['db:main'] } } },
    ],
    ['a repeated key', { schemaVersion: '1.0.0', nodes: { generate: { shared: ['s', 's'] } } }],
    ['an empty node id', { schemaVersion: '1.0.0', nodes: { '': {} } }],
    ['another schema version', { schemaVersion: '2.0.0', nodes: {} }],
    ['an unknown top-level field', { schemaVersion: '1.0.0', nodes: {}, workers: 4 }],
    ['nodes as an array', { schemaVersion: '1.0.0', nodes: [] }],
    ['a document that is not an object', ['generate']],
  ])(
    'refuses a file with %s against test-task-exclusivity.schema.json at every worker count',
    async (_label, document) => {
      const messages = await refusals({ exclusivity: document });
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toMatch(
        /^CHECK_RUNNER_EXCLUSIVITY: test-task-exclusivity\.json fails test-task-exclusivity\.schema\.json/u,
      );
    },
  );

  it('refuses an exclusivity file that is not JSON at every worker count', async () => {
    const messages = await refusals({ exclusivityBytes: '{ "schemaVersion": "1.0.0", ' });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/^CHECK_RUNNER_EXCLUSIVITY/u);
  });
});
