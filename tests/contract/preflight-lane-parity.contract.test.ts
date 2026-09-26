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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve('.');
const WORKFLOW = join(ROOT, '.github/workflows/pull-request-checks.yml');
const BOOTSTRAP_CLI = join(ROOT, '.devai/state/pr-bootstrap/cli/bin.js');
const BASE_EXPRESSION = /\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/gu;
const CHECK_INVOCATION = /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\s+([^\n;&|]*)/u;

type WorkflowStep = Readonly<{ name?: string; id?: string; run?: string; uses?: string }>;
type Workflow = Readonly<{ jobs?: Readonly<Record<string, { steps?: readonly WorkflowStep[] }>> }>;
type LaneStep = Readonly<{
  kind: 'install' | 'check:preflight' | 'check:affected' | 'other';
  run: string;
}>;

function git(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(result.stderr)}`);
  return String(result.stdout).trim();
}

function laneRunSteps(): readonly LaneStep[] {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  return steps
    .filter((step): step is WorkflowStep & { run: string } => typeof step.run === 'string')
    .map((step) => {
      const run = step.run.trim();
      const check = CHECK_INVOCATION.exec(run)?.[1] ?? '';
      if (/\bpnpm install --frozen-lockfile\b/u.test(run) && check === '') {
        return { kind: 'install', run };
      }
      if (/(?:^|\s)--preflight(?:\s|$)/u.test(check)) return { kind: 'check:preflight', run };
      if (/(?:^|\s)--affected(?:\s|$)/u.test(check)) return { kind: 'check:affected', run };
      return { kind: 'other', run };
    });
}

/** The check argument vector of a lane step, bound to a local base, as a plan-only call. */
function laneCheckArguments(run: string, base: string): readonly string[] {
  const match = CHECK_INVOCATION.exec(run.replace(BASE_EXPRESSION, base));
  if (match?.[1] === undefined) throw new Error(`no bootstrap CLI check invocation in: ${run}`);
  const args = match[1].trim().split(/\s+/u).filter(Boolean);
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
function plannedNodeSet(args: readonly string[], base: string): string {
  const result = spawnSync(process.execPath, [BOOTSTRAP_CLI, ...args, '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DEVAI_FORMAT_BASE: base },
  });
  let output: { result?: { value?: { plan?: { tasks?: readonly PlannedNode[] } } } } | undefined;
  try {
    output = JSON.parse(String(result.stdout)) as typeof output;
  } catch {
    output = undefined;
  }
  const tasks = output?.result?.value?.plan?.tasks;
  if (tasks === undefined) {
    throw new Error(
      `${args.join(' ')} planned nothing (exit ${String(result.status)}): ${String(result.stdout)}${String(result.stderr)}`,
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

let base = '';

beforeAll(() => {
  // The lane compiles the bootstrap CLI before any check; do the same when it is absent.
  if (!existsSync(BOOTSTRAP_CLI)) {
    const bootstrap = spawnSync('pnpm', ['run', 'release:bootstrap'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (bootstrap.status !== 0) {
      throw new Error(`pnpm run release:bootstrap failed: ${bootstrap.stdout}${bootstrap.stderr}`);
    }
  }
  base = git(['rev-parse', 'HEAD~1^{commit}']);
}, 300_000);

describe('preflight lane parity (ADR-CHK-0001 IA-003)', () => {
  it('reduces the pull-request lane to install, preflight check, affected check', () => {
    expect(
      laneRunSteps().map((step) => step.kind),
      'the run steps of pull-request-checks.yml',
    ).toEqual(['install', 'check:preflight', 'check:affected']);
  });

  it('declares at least one preflight-v1 node in test-tasks.json', () => {
    expect(preflightNodeIds().length, 'preflight-v1 nodes in test-tasks.json').toBeGreaterThan(0);
  });

  it.each(['--preflight', '--affected'] as const)(
    'plans a byte-identical node set for the local %s invocation on consecutive runs',
    (target) => {
      const args = ['check', target, '--task-plan', '--base', base];
      const first = plannedNodeSet(args, base);
      const second = plannedNodeSet(args, base);
      expect(second, `consecutive local ${target} plans`).toBe(first);
      const planned = (JSON.parse(first) as PlannedNode[]).map((task) => task.nodeId);
      for (const nodeId of preflightNodeIds()) {
        expect(planned, `the ${target} plan selects preflight node ${nodeId}`).toContain(nodeId);
      }
    },
  );

  it.each([
    ['check:preflight', '--preflight'],
    ['check:affected', '--affected'],
  ] as const)('plans the lane %s invocation exactly as the local invocation', (kind, target) => {
    const step = laneRunSteps().find((candidate) => candidate.kind === kind);
    expect(step, `the lane carries a ${kind} step`).toBeDefined();
    if (step === undefined) return;
    const laneArgs = laneCheckArguments(step.run, base);
    const lane = plannedNodeSet(laneArgs, base);
    expect(plannedNodeSet(laneArgs, base), `consecutive lane ${kind} plans`).toBe(lane);
    const local = plannedNodeSet(['check', target, '--task-plan', '--base', base], base);
    expect(lane, `lane ${kind} and local ${target} planned node sets`).toBe(local);
  });
});
