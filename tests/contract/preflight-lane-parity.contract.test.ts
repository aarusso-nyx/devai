// ADR-CHK-0001, Inspector Adversarial Acceptance IA-003: the probe descriptor
// run locally and the one run in the pull-request lane produce byte-identical
// planned node sets for the same base and candidate.
//
// The lane (.github/workflows/pull-request-checks.yml) must reduce to exactly
// three run steps: install, a bootstrap CLI `check` with the preflight target,
// and a bootstrap CLI `check` with the affected target. The lane's two check
// invocations are then replayed here with --task-plan against the repository's
// own base (HEAD~1) and candidate (HEAD), and compared with the documented local
// invocations `check --preflight|--affected --task-plan --base <base>`.
//
// Red today: the lane still has the verifier-package, bootstrap, release:pr-gate,
// and step-aggregator run steps and no direct check invocation; the check
// command rejects `--preflight` as an unknown option; and test-tasks.json
// declares no `preflight-v1` node.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve('.');
const WORKFLOW = join(ROOT, '.github/workflows/pull-request-checks.yml');
const BOOTSTRAP_CLI = join(ROOT, '.devai/state/pr-bootstrap/cli/bin.js');
// The lane binds the base as a pull_request event does: an expression reads
// github.event.pull_request.base.sha directly, or through a job or step env
// variable whose expression selects it by event (merge_group reads its own base).
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/gu;
const BASE_REFERENCE = 'github.event.pull_request.base.sha';
const EVENT_TEST = /^github\.event_name\s*==\s*'([a-z_]+)'$/u;
const CHECK_INVOCATION = /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\s+([^\n;&|]*)/u;

type Environment = Readonly<Record<string, unknown>>;
type WorkflowStep = Readonly<{
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Environment;
}>;
type Workflow = Readonly<{
  env?: Environment;
  jobs?: Readonly<Record<string, { env?: Environment; steps?: readonly WorkflowStep[] }>>;
}>;
type LaneStep = Readonly<{
  kind: 'install' | 'check:preflight' | 'check:affected' | 'other';
  run: string;
  /** Workflow, job, then step env, uninterpolated; later scopes win. */
  env: Environment;
}>;

/**
 * One enforced deadline per bounded case or hook (#324). Every child of that case or hook gets
 * only the time remaining, so the children together never outrun the Vitest bound around them.
 * Each child leads its own process group. When the deadline passes, or a captured stream exceeds
 * its cap, the whole group gets SIGKILL; the helper then waits a bounded grace for `close` and,
 * if a descendant still holds the pipes, destroys them and fails instead of pending forever.
 * Only the deadline counts as a timeout: any other exit or signal is the child's own result.
 *
 * Known limits, documented rather than handled: a descendant that calls setsid or setpgid
 * leaves the group and escapes the group kill, and `close` proves only that every holder of
 * the child's pipes has closed them, not that every grandchild has exited.
 */
interface Deadline {
  readonly totalMs: number;
  remaining(): number;
}

function deadline(totalMs: number): Deadline {
  const end = performance.now() + totalMs;
  return { totalMs, remaining: () => Math.max(0, Math.floor(end - performance.now())) };
}

interface ChildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Captured bytes per stream before the group is killed. A runaway guard, not a size limit
 * on legitimate output: `check --affected --task-plan --format json` printed more than 1 MiB
 * for a large diff, so the cap matches the 64 MiB `maxBuffer` the synchronous calls used.
 */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
/** How long `close` may take after the group kill before the pipes are destroyed. */
const CLOSE_GRACE_MS = 2_000;

function runBounded(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv }>,
  limit: Deadline,
): Promise<ChildResult> {
  const label = [command, ...args].join(' ');
  const remaining = limit.remaining();
  if (remaining === 0) {
    return Promise.reject(
      new Error(
        `${label} was not started: the ${String(limit.totalMs)} ms deadline of its case was already spent`,
      ),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captured = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const bytes = { stdout: 0, stderr: 0 };
    let killReason: string | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      outcome();
    };
    const killGroup = (reason: string): void => {
      if (killReason !== undefined) return;
      killReason = reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() =>
          rejectPromise(
            new Error(
              `${label}: ${reason}; its process group was killed, but its pipes stayed open ${String(CLOSE_GRACE_MS)} ms later (a descendant outside the group still holds them)`,
            ),
          ),
        );
      }, CLOSE_GRACE_MS);
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        bytes[stream] += chunk.length;
        if (bytes[stream] > OUTPUT_CAP_BYTES) {
          killGroup(`its ${stream} exceeded the ${String(OUTPUT_CAP_BYTES)}-byte capture cap`);
          return;
        }
        captured[stream].push(chunk);
      });
    }
    const deadlineTimer = setTimeout(
      () => killGroup(`it exceeded the enforced ${String(limit.totalMs)} ms deadline of its case`),
      remaining,
    );
    child.on('error', (error) => settle(() => rejectPromise(error)));
    // `close` fires once every holder of the child's pipes has closed them.
    child.on('close', (status, signal) => {
      settle(() => {
        if (killReason !== undefined) {
          rejectPromise(new Error(`${label}: ${killReason}; its process group was killed`));
          return;
        }
        resolvePromise({
          status,
          signal,
          stdout: Buffer.concat(captured.stdout).toString('utf8'),
          stderr: Buffer.concat(captured.stderr).toString('utf8'),
        });
      });
    });
  });
}

async function git(args: readonly string[], limit: Deadline): Promise<string> {
  const result = await runBounded('git', args, { cwd: ROOT }, limit);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function laneRunSteps(): readonly LaneStep[] {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => ({
      step,
      env: { ...workflow.env, ...job.env, ...step.env },
    })),
  );
  return steps
    .filter(
      (entry): entry is { step: WorkflowStep & { run: string }; env: Environment } =>
        typeof entry.step.run === 'string',
    )
    .map(({ step, env }) => {
      const run = step.run.trim();
      const check = CHECK_INVOCATION.exec(run)?.[1] ?? '';
      if (/\bpnpm install --frozen-lockfile\b/u.test(run) && check === '') {
        return { kind: 'install', run, env };
      }
      if (/(?:^|\s)--preflight(?:\s|$)/u.test(check)) {
        return { kind: 'check:preflight', run, env };
      }
      if (/(?:^|\s)--affected(?:\s|$)/u.test(check)) return { kind: 'check:affected', run, env };
      return { kind: 'other', run, env };
    });
}

/**
 * Evaluates one expression body as a pull_request event on the local base: the
 * `a && b || c` form over `github.event_name == '<event>'` tests and the pull
 * request base. Anything else stays unresolved.
 */
function pullRequestExpression(inner: string, base: string): string | undefined {
  for (const alternative of inner.split('||')) {
    let value: string | boolean | undefined = true;
    for (const operand of alternative.split('&&').map((text) => text.trim())) {
      const event = EVENT_TEST.exec(operand);
      if (event !== null) value = event[1] === 'pull_request';
      else if (operand === BASE_REFERENCE) value = base;
      else return undefined;
      if (value === false) break;
    }
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Replaces each `${{ }}` the local base resolves; leaves the others for the refusal below. */
function interpolate(text: string, base: string): string {
  return text.replace(
    EXPRESSION,
    (all, inner: string) => pullRequestExpression(inner, base) ?? all,
  );
}

/** One shell word: a literal, or `$VAR` / `${VAR}` (optionally quoted) from the step env. */
function shellWord(word: string, environment: Readonly<Record<string, string>>): string {
  const unquoted = word.replace(/^(["'])(.*)\1$/u, '$2');
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(unquoted);
  if (variable === null) return unquoted;
  return environment[variable[1] ?? variable[2] ?? ''] ?? unquoted;
}

/** The check argument vector of a lane step, bound to a local base, as a plan-only call. */
function laneCheckArguments(step: LaneStep, base: string): readonly string[] {
  const { run } = step;
  const environment = Object.fromEntries(
    Object.entries(step.env).map(([name, value]) => [name, interpolate(String(value), base)]),
  );
  const match = CHECK_INVOCATION.exec(interpolate(run, base));
  if (match?.[1] === undefined) throw new Error(`no bootstrap CLI check invocation in: ${run}`);
  const args = match[1]
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => shellWord(word, environment));
  const unresolved = args.find((arg) => arg.includes('${{') || arg.startsWith('$'));
  if (unresolved !== undefined)
    throw new Error(`unresolved lane expression ${unresolved} in: ${run}`);
  const operations = new Set(['--run', '--task-plan', '--status', '--explain']);
  const planned = args.filter((arg) => !operations.has(arg));
  const withoutFormat = planned.flatMap((arg, index) =>
    arg === '--format' || planned[index - 1] === '--format' ? [] : [arg],
  );
  return ['check', ...withoutFormat, '--task-plan'];
}

type PlannedNode = Readonly<{ nodeId: string; dependencies: readonly string[] }>;

/** Runs the bootstrap CLI and returns the canonical bytes of its planned node set. */
async function plannedNodeSet(
  args: readonly string[],
  base: string,
  limit: Deadline,
): Promise<string> {
  const result = await runBounded(
    process.execPath,
    [BOOTSTRAP_CLI, ...args, '--format', 'json'],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DEVAI_FORMAT_BASE: base },
    },
    limit,
  );
  let output: { result?: { value?: { plan?: { tasks?: readonly PlannedNode[] } } } } | undefined;
  try {
    output = JSON.parse(result.stdout) as typeof output;
  } catch {
    output = undefined;
  }
  const tasks = output?.result?.value?.plan?.tasks;
  if (tasks === undefined) {
    throw new Error(
      `${args.join(' ')} planned nothing (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.stdout}${result.stderr}`,
    );
  }
  return JSON.stringify(
    tasks.map((task) => ({ nodeId: task.nodeId, dependencies: [...task.dependencies].sort() })),
  );
}

function preflightNodeIds(): readonly string[] {
  const descriptor = JSON.parse(readFileSync(join(ROOT, 'test-tasks.json'), 'utf8')) as {
    tasks: readonly Readonly<{ nodeId: string; runner: string }>[];
  };
  return descriptor.tasks
    .filter((task) => task.runner === 'preflight-v1')
    .map((task) => task.nodeId);
}

/** The hook bound, and inside it the one deadline its bootstrap and `git` children share. */
const SETUP_HOOK_TIMEOUT_MS = 300_000;
const SETUP_DEADLINE_MS = 290_000;

let base = '';

beforeAll(async () => {
  const limit = deadline(SETUP_DEADLINE_MS);
  // The lane compiles the bootstrap CLI before any check; do the same when it is absent.
  if (!existsSync(BOOTSTRAP_CLI)) {
    const bootstrap = await runBounded('pnpm', ['run', 'release:bootstrap'], { cwd: ROOT }, limit);
    if (bootstrap.status !== 0) {
      throw new Error(`pnpm run release:bootstrap failed: ${bootstrap.stdout}${bootstrap.stderr}`);
    }
  }
  base = await git(['rev-parse', 'HEAD~1^{commit}'], limit);
}, SETUP_HOOK_TIMEOUT_MS);

describe('preflight lane parity (ADR-CHK-0001 IA-003)', () => {
  it('accepts a valid child output larger than 1 MiB in full', async () => {
    // Regression for the former 1 MiB cap: a large affected plan was killed as runaway output.
    const script =
      'process.stdout.write(JSON.stringify({ tasks: Array.from({ length: 40000 }, (_, i) => ({ nodeId: "n" + i, pad: "x".repeat(40) })) }))';
    const result = await runBounded(
      process.execPath,
      ['-e', script],
      { cwd: ROOT },
      deadline(60_000),
    );
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(2 * 1024 * 1024);
    expect((JSON.parse(result.stdout) as { tasks: unknown[] }).tasks).toHaveLength(40000);
  });

  it('reduces the pull-request lane to install, preflight check, affected check', () => {
    expect(
      laneRunSteps().map((step) => step.kind),
      'the run steps of pull-request-checks.yml',
    ).toEqual(['install', 'check:preflight', 'check:affected']);
  });

  it('declares preflight probes in test-tasks.json or .devai/config/preflight-probes.json', () => {
    // DEVAI keeps its own probes in the adopter-owned probe file, which the
    // --preflight target plans as a synthetic root node outside the task policy.
    const adopterProbes = join(ROOT, '.devai/config/preflight-probes.json');
    const probeCount =
      preflightNodeIds().length +
      (existsSync(adopterProbes)
        ? (JSON.parse(readFileSync(adopterProbes, 'utf8')) as readonly unknown[]).length
        : 0);
    expect(probeCount, 'preflight probes from either source').toBeGreaterThan(0);
  });

  // Each plan is a bootstrap CLI process that fingerprints the live working tree: 3 to 4 s
  // alone, so a case of two or three plans costs 7 to 11 s alone and 10 s at load average
  // 200 (#246). The RC coverage lane's 15 s default and the local 30 s default both fell
  // under that once parallel workers shared the machine, so each case carries its own bound,
  // and its plans share one deadline inside it (#324).
  // The file also runs in the `local-serial` lane: consecutive plans are byte-identical only
  // while no sibling test writes into the same working tree between them.
  const PLAN_CASE_TIMEOUT_MS = 120_000;
  const PLAN_CASE_DEADLINE_MS = 110_000;

  it.each(['--preflight', '--affected'] as const)(
    'plans a byte-identical node set for the local %s invocation on consecutive runs',
    async (target) => {
      const limit = deadline(PLAN_CASE_DEADLINE_MS);
      const args = ['check', target, '--task-plan', '--base', base];
      const first = await plannedNodeSet(args, base, limit);
      const second = await plannedNodeSet(args, base, limit);
      expect(second, `consecutive local ${target} plans`).toBe(first);
      const planned = (JSON.parse(first) as PlannedNode[]).map((task) => task.nodeId);
      for (const nodeId of preflightNodeIds()) {
        expect(planned, `the ${target} plan selects preflight node ${nodeId}`).toContain(nodeId);
      }
    },
    PLAN_CASE_TIMEOUT_MS,
  );

  it.each([
    ['check:preflight', '--preflight'],
    ['check:affected', '--affected'],
  ] as const)(
    'plans the lane %s invocation exactly as the local invocation',
    async (kind, target) => {
      const limit = deadline(PLAN_CASE_DEADLINE_MS);
      const step = laneRunSteps().find((candidate) => candidate.kind === kind);
      expect(step, `the lane carries a ${kind} step`).toBeDefined();
      if (step === undefined) return;
      const laneArgs = laneCheckArguments(step, base);
      const lane = await plannedNodeSet(laneArgs, base, limit);
      expect(await plannedNodeSet(laneArgs, base, limit), `consecutive lane ${kind} plans`).toBe(
        lane,
      );
      const local = await plannedNodeSet(
        ['check', target, '--task-plan', '--base', base],
        base,
        limit,
      );
      expect(lane, `lane ${kind} and local ${target} planned node sets`).toBe(local);
    },
    PLAN_CASE_TIMEOUT_MS,
  );
});
