/**
 * The experimental agent dispatch engine of ADR-MDL-0005 (`round dispatch`). For one
 * admitted agent task it composes the governed prompt, then runs the Article 19
 * ladder — up to three attempts at the requested model and one at the next tier —
 * each in a fresh task worktree, around the hash-linked dispatch journal, with the
 * Article 6 write-scope check and non-promoting evidence after every attempt.
 * Attempts are numbered for the task's lifetime, so a retried task continues its
 * ladder (ADR-MDL-0007). Nothing here pushes, merges, publishes, or retries uncertain
 * work.
 */
import {
  ENGINEER_ROOT_WORKSPACE_FILES,
  INSPECTOR_TEST_DIRECTORY_SEGMENT,
  STATIC_AUTHORITY_PREFIXES,
  execFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from '@devai-nyx/authority';
import {
  EXPERIMENTAL_BUMPED_TIER,
  buildTaskExecutionEvidence,
  persistTaskExecutionEvidence,
  type TaskExecutionEvidence,
  type TaskRecordBinding,
} from '@devai-nyx/evidence';
import {
  EXPERIMENTAL_RUNTIME_EFFORTS,
  appendDispatchJournalEvent,
  createWorktree,
  destroyWorktree,
  dispatchAttemptFloor,
  listLocks,
  loadTask,
  retainWorktree,
  saveTask,
  taskLockTargets,
  type ExperimentalActivation,
  type TaskRecord,
  type WorktreeRecord,
} from '@devai-nyx/loop';
import {
  agentCliInvocation,
  composeAgentPrompt,
  parseAgentCliOutput,
  runAgentCliAttempt,
  type AgentCliAttempt,
  type AgentCliInvocation,
  type AgentCliRuntime,
} from '@devai-nyx/skills';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Per-runtime model order from law/policy/model-tiers.json, lowest capability first;
 * the bumped tier of a model is the next entry. A contract test pins this mirror.
 */
export const EXPERIMENTAL_TIER_ORDER: Readonly<Record<AgentCliRuntime, readonly string[]>> = {
  'claude-cli': ['haiku', 'sonnet', 'opus', 'fable'],
  'codex-cli': ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
};

/** Attempts at the requested tier before the one bumped attempt (Article 19). */
const DEFAULT_TIER_ATTEMPTS = 3;

export interface ExperimentalBudget {
  attempts: number;
  tokens: number;
  /** Set once a provider leaves a token counter unreported; no further attempt may spend. */
  unverifiable: boolean;
}

export interface ExperimentalDispatchContext {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly activation: ExperimentalActivation;
  readonly budget: ExperimentalBudget;
  readonly baseRef?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Builds the provider invocation; tests substitute a fake provider. */
  readonly invocation?: (selection: {
    readonly runtime: AgentCliRuntime;
    readonly model: string;
    readonly effort: string;
  }) => Pick<AgentCliInvocation, 'runtime' | 'command' | 'args'>;
}

export interface ExperimentalDispatchResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly evidence_id?: string;
}

interface AgentRequest {
  readonly kind: 'agent';
  readonly runtime: AgentCliRuntime;
  readonly model: string;
  readonly effort: string;
  readonly selection: { readonly mode: string; readonly registry_id?: string };
  readonly prompt_composition_id: string;
  readonly max_iterations: number;
  readonly recipe_name?: string;
  readonly recipe_variant?: string;
  readonly timeout_ms?: number;
}

function agentRequest(task: TaskRecord): AgentRequest | undefined {
  const executor = task.executor as unknown as Partial<AgentRequest>;
  return executor.kind === 'agent' ? (executor as AgentRequest) : undefined;
}

/**
 * Whether the activation admits this task at all; checked for the whole selection
 * before any lock, worktree, or provider is touched.
 */
export function experimentalTaskRefusal(
  task: TaskRecord,
  activation: ExperimentalActivation,
): string | undefined {
  const request = agentRequest(task);
  if (request === undefined) return 'EXPERIMENTAL_TASK_NOT_AGENT';
  if (!activation.disciplines.includes(task.discipline as 'engineer' | 'inspector')) {
    return 'EXPERIMENTAL_DISCIPLINE_NOT_ACTIVATED';
  }
  const runtime = activation.runtimes.find((entry) => entry.runtime === request.runtime);
  if (runtime === undefined) return 'EXPERIMENTAL_RUNTIME_NOT_ACTIVATED';
  if (!(EXPERIMENTAL_RUNTIME_EFFORTS[request.runtime] ?? []).includes(request.effort)) {
    return 'EXPERIMENTAL_EFFORT_NOT_SUPPORTED';
  }
  if (!runtime.models.includes(request.model) || !runtime.efforts.includes(request.effort)) {
    return 'EXPERIMENTAL_SELECTION_NOT_ACTIVATED';
  }
  if (request.selection.mode !== 'exact' || request.selection.registry_id !== request.runtime) {
    return 'EXPERIMENTAL_SELECTION_NOT_EXACT';
  }
  return undefined;
}

/** The single model one tier above, if the Owner's activation also admits it. */
export function bumpedModel(
  runtime: AgentCliRuntime,
  model: string,
  activation: ExperimentalActivation,
): string | undefined {
  const order = EXPERIMENTAL_TIER_ORDER[runtime];
  const next = order[order.indexOf(model) + 1];
  if (order.indexOf(model) < 0 || next === undefined) return undefined;
  const admitted = activation.runtimes.find((entry) => entry.runtime === runtime)?.models ?? [];
  return admitted.includes(next) ? next : undefined;
}

/** The Article 6 role that owns a repository-relative path, or undefined when none may. */
export function article6Role(path: string): string | undefined {
  const normalized = path.split(sep).join('/');
  const segments = normalized.split('/');
  if (segments.length === 1) {
    return (ENGINEER_ROOT_WORKSPACE_FILES as readonly string[]).includes(normalized)
      ? 'engineer'
      : undefined;
  }
  if (segments[0] === 'packages' && segments[2] === INSPECTOR_TEST_DIRECTORY_SEGMENT) {
    return 'inspector';
  }
  const match = [...STATIC_AUTHORITY_PREFIXES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => normalized.startsWith(entry.prefix));
  const authority = match?.authority as readonly string[] | undefined;
  return authority?.length === 1 ? authority[0] : undefined;
}

/** A worktree's file digests, and the symbolic links in it that resolve outside it. */
export interface WorktreeSnapshot {
  readonly files: ReadonlyMap<string, string>;
  readonly escaping: ReadonlySet<string>;
}

/**
 * SHA-256 of every regular file under `root`, excluding `.git`, by relative path. A
 * symbolic link is hashed by its target, so retargeting it is a change, and every link
 * whose target resolves outside the worktree is named: writing through such a link
 * would change a file the write-scope check cannot see.
 */
export function snapshotWorktree(root: string): WorktreeSnapshot {
  const roots = new Set([resolve(root)]);
  try {
    roots.add(realpathSync(root));
  } catch {
    // The lexical root is enough when it cannot be resolved.
  }
  const inside = (target: string): boolean =>
    [...roots].some((base) => target === base || target.startsWith(`${base}${sep}`));
  const files = new Map<string, string>();
  const escaping = new Set<string>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        let resolved = resolve(dirname(path), target);
        try {
          resolved = realpathSync(path);
        } catch {
          // A dangling link is judged by its lexical target.
        }
        if (!inside(resolved)) escaping.add(rel);
        files.set(rel, createHash('sha256').update(`symlink:${target}`).digest('hex'));
      } else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        files.set(rel, createHash('sha256').update(readFileSync(path)).digest('hex'));
      }
    }
  };
  walk(root);
  return { files, escaping };
}

function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function gitHead(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Tokens an attempt spent against the invocation budget: every counter, cache reads and
 * writes included. Any counter the provider left unreported makes the spend
 * unverifiable; a missing counter is never charged as zero (ADR-MDL-0005 D-7).
 */
export function attemptSpend(usage: AgentCliAttempt['output']['usage']): number | undefined {
  const counters = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_tokens,
    usage.cache_write_tokens,
  ];
  let total = 0;
  for (const counter of counters) {
    if (counter.value === null) return undefined;
    total += counter.value;
  }
  return total;
}

interface AttemptPlan {
  readonly number: number;
  readonly model: string;
  readonly tier: 'default' | 'bumped';
}

/**
 * The remaining Article 19 ladder: attempts `floor + 1` up to the task's bound, three
 * at the requested model and the fourth at the bumped tier when the Owner admits it.
 */
function attemptPlans(
  request: AgentRequest,
  activation: ExperimentalActivation,
  floor: number,
): AttemptPlan[] {
  const limit = Math.min(activation.budgets.attempts_per_task, request.max_iterations, 4);
  const plans: AttemptPlan[] = [];
  for (let number = floor + 1; number <= Math.min(DEFAULT_TIER_ATTEMPTS, limit); number += 1) {
    plans.push({ number, model: request.model, tier: 'default' });
  }
  const bumped = bumpedModel(request.runtime, request.model, activation);
  if (limit > DEFAULT_TIER_ATTEMPTS && floor <= DEFAULT_TIER_ATTEMPTS && bumped !== undefined) {
    plans.push({ number: DEFAULT_TIER_ATTEMPTS + 1, model: bumped, tier: 'bumped' });
  }
  return plans;
}

/** A stable code for an unexpected failure: the error message when it is one, else a generic code. */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,}$/u.test(message) ? message : 'EXPERIMENTAL_ATTEMPT_FAILED';
}

function refusedAttempt(runtime: AgentCliRuntime, code: string): AgentCliAttempt {
  const output = parseAgentCliOutput(runtime, '');
  return {
    ok: false,
    output: { ...output, failure: code },
    process: {
      exit_code: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
      timed_out: false,
      spawn_error: code,
    },
  };
}

const DIAGNOSTIC_TAIL_BYTES = 8 * 1024;

function tail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= DIAGNOSTIC_TAIL_BYTES
    ? text
    : bytes.subarray(bytes.length - DIAGNOSTIC_TAIL_BYTES).toString('utf8');
}

/**
 * Retain the bounded tail of the provider streams as diagnostics only
 * (round-execution.json failure.partial_output), never as evidence of success.
 */
function writeDiagnostics(
  repoRoot: string,
  roundId: string,
  name: string,
  attempt: AgentCliAttempt,
): void {
  const dir = join(repoRoot, '.devai/state/round-runs', roundId, 'diagnostics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify(
      {
        exit_code: attempt.process.exit_code,
        signal: attempt.process.signal,
        timed_out: attempt.process.timed_out,
        spawn_error: attempt.process.spawn_error,
        failure: attempt.output.failure,
        stdout_tail: tail(attempt.process.stdout),
        stderr_tail: tail(attempt.process.stderr),
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
}

/** Whether the task still holds every lock it declared, unexpired. */
function locksHeld(repoRoot: string, task: TaskRecord): boolean {
  const now = Date.now();
  const held = listLocks({ locksDir: join(repoRoot, '.devai/state/locks') }).filter(
    (lock) => lock.task_id === task.id && now - new Date(lock.acquired_at).getTime() < lock.ttl_ms,
  );
  return taskLockTargets(task).every((target) =>
    held.some((lock) => `${lock.substrate}:${lock.module}` === target),
  );
}

function budgetRefusal(context: ExperimentalDispatchContext): string | undefined {
  const budgets = context.activation.budgets;
  if (context.budget.attempts >= budgets.attempts_per_invocation) {
    return 'EXPERIMENTAL_ATTEMPT_BUDGET_EXHAUSTED';
  }
  if (context.budget.unverifiable) return 'EXPERIMENTAL_USAGE_UNVERIFIABLE';
  if (context.budget.tokens >= budgets.tokens_per_invocation) {
    return 'EXPERIMENTAL_TOKEN_BUDGET_EXHAUSTED';
  }
  return undefined;
}

/**
 * A task whose ladder never started an attempt in this dispatch stays `ready`, and the
 * runner's iteration count for it is undone, so a budget that ran out or a host without
 * capacity never blocks untouched work. Its locks stay held: `round-execution.json`
 * resources.release_on releases them only on completion, escalation, a gap pause or
 * cancellation, and the next dispatch reuses them while they are unexpired.
 */
function returnUntouched(
  context: ExperimentalDispatchContext,
  task: TaskRecord,
  code: string,
): ExperimentalDispatchResult {
  const current = loadTask(context.repoRoot, task.id);
  saveTask(context.repoRoot, {
    ...current,
    status: 'ready',
    iteration_count: Math.max(0, current.iteration_count - 1),
  });
  return { ok: false, code };
}

/** Bind the task to its current attempt worktree, so retained work is always found from it. */
function bindWorktree(
  repoRoot: string,
  taskId: string,
  worktree: Pick<WorktreeRecord, 'id' | 'branch'>,
  status?: TaskRecord['status'],
): void {
  saveTask(repoRoot, {
    ...loadTask(repoRoot, taskId),
    worktree_id: worktree.id,
    branch: worktree.branch,
    ...(status !== undefined && { status }),
  });
}

/**
 * Create the attempt worktree from the round base, bound to the task and owned by this
 * process, before any journal record: a failure here starts no provider. A base tree
 * holding a symbolic link that escapes the worktree refuses before spawn.
 */
function prepareAttempt(
  context: ExperimentalDispatchContext,
  task: TaskRecord,
  plan: AttemptPlan,
): Readonly<{ worktree: WorktreeRecord; before: WorktreeSnapshot }> {
  const worktree = createWorktree({
    repoRoot: context.repoRoot,
    id: `WT-${task.id}-A${String(plan.number)}`,
    branch: `experimental/${task.id}/attempt-${String(plan.number)}`,
    baseRef: context.baseRef ?? 'HEAD',
    taskId: task.id,
    owner: { pid: process.pid, hostname: hostname() },
  });
  try {
    const before = snapshotWorktree(worktree.path);
    if (before.escaping.size > 0) throw new Error('EXPERIMENTAL_SYMLINK_ESCAPE');
    return { worktree, before };
  } catch (error) {
    destroyWorktree({ repoRoot: context.repoRoot, id: worktree.id });
    throw error;
  }
}

type AttemptOutcome =
  | {
      readonly kind: 'evidenced';
      readonly passed: boolean;
      /** True when no further attempt may follow (a lost lock). */
      readonly stop: boolean;
      readonly code: string;
      readonly outcome: 'pass' | 'fail' | 'error';
      readonly evidence_id: string;
    }
  | { readonly kind: 'uncertain'; readonly code: string };

/**
 * Dispatch one admitted agent task through the experimental ladder. The task ends
 * `awaiting_human_review` with its passing attempt's worktree retained for review, or
 * `experimental_blocked` with its last failed attempt's worktree retained after the
 * ladder or a budget is exhausted (IA-006), or `ready` when no attempt could start.
 * The task outcome and worktree binding are persisted before the attempt settles. The
 * runner already holds the task's locks and has marked it `in_progress`.
 */
export async function dispatchExperimentalTask(
  context: ExperimentalDispatchContext,
  task: TaskRecord,
): Promise<ExperimentalDispatchResult> {
  const request = agentRequest(task);
  const refusal = experimentalTaskRefusal(task, context.activation);
  if (request === undefined || refusal !== undefined) {
    return { ok: false, code: refusal ?? 'EXPERIMENTAL_TASK_NOT_AGENT' };
  }
  const composed = composeAgentPrompt({ repoRoot: context.repoRoot, task });
  if (composed.composition.id !== request.prompt_composition_id) {
    // Article 37: drift is attributable; the Architect re-binds the task to the new id.
    return { ok: false, code: 'TASK_PROMPT_COMPOSITION_DRIFT' };
  }
  const { repoRoot, roundId } = context;
  const wallClockMs = Math.min(
    context.activation.budgets.attempt_wall_clock_minutes * 60_000,
    request.timeout_ms ?? Number.POSITIVE_INFINITY,
  );
  const plans = attemptPlans(
    request,
    context.activation,
    dispatchAttemptFloor(repoRoot, roundId, task.id),
  );
  let started = 0;
  let previous: WorktreeRecord | undefined;
  let lastCode = 'EXPERIMENTAL_LADDER_EXHAUSTED';
  for (const [index, plan] of plans.entries()) {
    const refusedByBudget = budgetRefusal(context);
    if (refusedByBudget !== undefined) {
      if (started === 0) return returnUntouched(context, task, refusedByBudget);
      lastCode = refusedByBudget;
      break;
    }
    let prepared: Awaited<ReturnType<typeof prepareAttempt>>;
    try {
      prepared = prepareAttempt(context, task, plan);
      bindWorktree(repoRoot, task.id, prepared.worktree);
      appendDispatchJournalEvent(repoRoot, roundId, {
        task_id: task.id,
        attempt: plan.number,
        event: 'intent',
        runtime: request.runtime,
        model: plan.model,
        effort: request.effort,
        tier: plan.tier,
        prompt_sha256: composed.prompt_sha256,
      });
    } catch (error) {
      // Nothing started: no intent was recorded, so the worktree is not evidence.
      const code = errorCode(error);
      const current = loadTask(repoRoot, task.id);
      if (current.worktree_id === `WT-${task.id}-A${String(plan.number)}`) {
        if (existsSync(join(repoRoot, '.devai/worktrees', current.worktree_id))) {
          destroyWorktree({ repoRoot, id: current.worktree_id });
        }
        if (previous === undefined) {
          const { worktree_id: _worktree, branch: _branch, ...rest } = current;
          void _worktree;
          void _branch;
          saveTask(repoRoot, rest);
        } else bindWorktree(repoRoot, task.id, previous);
      }
      if (started === 0) return returnUntouched(context, task, code);
      lastCode = code;
      break;
    }
    started += 1;
    context.budget.attempts += 1;
    if (previous !== undefined && existsSync(previous.path)) {
      // The earlier failed attempt's tree is superseded; its digests stay in its evidence.
      destroyWorktree({ repoRoot, id: previous.id });
    }
    previous = undefined;
    const { worktree } = prepared;
    const outcome = await runAttempt(context, task, request, plan, composed, wallClockMs, prepared);
    if (outcome.kind === 'uncertain') {
      // A provider may have run: the attempt stays open in the journal, its worktree is
      // retained and bound, and the round blocks until a human disposition (D-6). Its
      // spend is unknown, so nothing else in this invocation may spend either.
      context.budget.unverifiable = true;
      retainWorktree({ repoRoot, id: worktree.id });
      bindWorktree(repoRoot, task.id, worktree, 'experimental_blocked');
      return { ok: false, code: outcome.code };
    }
    const settle = (): void => {
      appendDispatchJournalEvent(repoRoot, roundId, {
        task_id: task.id,
        attempt: plan.number,
        event: 'settled',
        outcome: outcome.outcome,
      });
    };
    retainWorktree({ repoRoot, id: worktree.id });
    if (outcome.passed) {
      bindWorktree(repoRoot, task.id, worktree, 'awaiting_human_review');
      settle();
      return { ok: true, evidence_id: outcome.evidence_id };
    }
    const another = index + 1 < plans.length && budgetRefusal(context) === undefined;
    if (outcome.stop || !another) {
      bindWorktree(repoRoot, task.id, worktree, 'experimental_blocked');
      settle();
      return { ok: false, code: outcome.code };
    }
    settle();
    previous = worktree;
    lastCode = outcome.code;
  }
  // The ladder was already spent, or a budget or setup failure stopped it after an
  // attempt; the last failed attempt's worktree stays retained and bound (IA-006).
  saveTask(repoRoot, { ...loadTask(repoRoot, task.id), status: 'experimental_blocked' });
  return { ok: false, code: lastCode };
}

async function runAttempt(
  context: ExperimentalDispatchContext,
  task: TaskRecord,
  request: AgentRequest,
  plan: AttemptPlan,
  composed: ReturnType<typeof composeAgentPrompt>,
  wallClockMs: number,
  prepared: Readonly<{ worktree: WorktreeRecord; before: WorktreeSnapshot }>,
): Promise<AttemptOutcome> {
  const { repoRoot, roundId } = context;
  const { worktree, before } = prepared;
  const journal = (entry: Record<string, unknown>) =>
    appendDispatchJournalEvent(repoRoot, roundId, {
      task_id: task.id,
      attempt: plan.number,
      ...entry,
    } as Parameters<typeof appendDispatchJournalEvent>[2]);
  const invocation = (context.invocation ?? agentCliInvocation)({
    runtime: request.runtime,
    model: plan.model,
    effort: request.effort,
  });
  const startedAt = new Date().toISOString();
  let spawned = false;
  let attempt: AgentCliAttempt;
  try {
    attempt = await runAgentCliAttempt({
      invocation,
      cwd: worktree.path,
      prompt: composed.prompt,
      timeoutMs: wallClockMs,
      ...(context.env !== undefined && { env: context.env }),
      onSpawned: (pid) => {
        spawned = true;
        journal({ event: 'spawned', pid });
      },
    });
  } catch (error) {
    const code = errorCode(error);
    if (spawned || code === 'AGENT_CLI_SPAWN_RECORD_FAILED') {
      // A provider process existed: whatever it did is unknown, never a refused spawn.
      return {
        kind: 'uncertain',
        code: code === 'EXPERIMENTAL_ATTEMPT_FAILED' ? 'TASK_DISPATCH_UNCERTAIN' : code,
      };
    }
    // The authority refused the spawn: no provider started, so the attempt settles as an
    // error instead of staying uncertain.
    attempt = refusedAttempt(request.runtime, code);
  }
  try {
    journal({
      event: 'exited',
      exit_code: attempt.process.exit_code,
      signal: attempt.process.signal,
      timed_out: attempt.process.timed_out,
    });
    writeDiagnostics(repoRoot, roundId, `${task.id}-A${String(plan.number)}`, attempt);
    const completedAt = new Date().toISOString();
    const after = snapshotWorktree(worktree.path);
    const changed = changedPaths(before.files, after.files);
    const escaping = [...after.escaping].sort();
    const outOfScope = changed.filter((path) => article6Role(path) !== task.discipline);
    const tokens = attemptSpend(attempt.output.usage);
    if (tokens === undefined) context.budget.unverifiable = true;
    else context.budget.tokens += tokens;
    const lockLost = attempt.ok && !locksHeld(repoRoot, task);
    const code = !attempt.ok
      ? (attempt.output.failure ??
        (attempt.process.timed_out
          ? 'AGENT_CLI_TIMED_OUT'
          : attempt.process.spawn_error !== null
            ? 'AGENT_CLI_SPAWN_FAILED'
            : 'AGENT_CLI_EXIT_NONZERO'))
      : escaping.length > 0
        ? 'EXPERIMENTAL_SYMLINK_ESCAPE'
        : outOfScope.length > 0
          ? 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION'
          : lockLost
            ? 'TASK_RESOURCE_LOCK_LOST'
            : '';
    const passed = code === '';
    const verdict = passed ? 'pass' : attempt.ok && !lockLost ? 'fail' : 'error';
    const evidence = attemptEvidence(task, request, plan, {
      candidateSha: gitHead(worktree.path),
      composed,
      attempt,
      changed: changed.flatMap((path) => {
        const digest = after.files.get(path);
        return digest === undefined ? [] : [{ id: path, digest_sha256: digest }];
      }),
      startedAt,
      completedAt,
      code,
      verdict,
      violations: escaping.length > 0 ? escaping : outOfScope,
    });
    persistTaskExecutionEvidence({
      repoRoot,
      relativePath: join(
        '.devai/state/round-runs',
        roundId,
        'task-executions',
        `${evidence.id}.json`,
      ),
      task: task as unknown as TaskRecordBinding,
      candidate_sha: evidence.candidate_sha,
      evidence,
    });
    journal({ event: 'evidence-written', evidence_id: evidence.id });
    return {
      kind: 'evidenced',
      passed,
      stop: lockLost,
      code,
      outcome: verdict,
      evidence_id: evidence.id,
    };
  } catch (error) {
    // The provider ran; a failure while recording its outcome leaves the attempt open.
    return { kind: 'uncertain', code: errorCode(error) };
  }
}

function attemptEvidence(
  task: TaskRecord,
  request: AgentRequest,
  plan: AttemptPlan,
  facts: {
    readonly candidateSha: string;
    readonly composed: ReturnType<typeof composeAgentPrompt>;
    readonly attempt: AgentCliAttempt;
    readonly changed: readonly { readonly id: string; readonly digest_sha256: string }[];
    readonly startedAt: string;
    readonly completedAt: string;
    readonly code: string;
    readonly verdict: 'pass' | 'fail' | 'error';
    readonly violations: readonly string[];
  },
): TaskExecutionEvidence {
  const id = `TXE-${canonicalSha256({ task: task.id, attempt: plan.number, at: facts.startedAt }).slice(0, 16)}`;
  const passed = facts.verdict === 'pass';
  const message =
    facts.code === 'EXPERIMENTAL_SYMLINK_ESCAPE'
      ? `symbolic links resolving outside the worktree: ${facts.violations.slice(0, 20).join(', ')}`
      : facts.code === 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION'
        ? `writes outside the ${task.discipline} paths: ${facts.violations.slice(0, 20).join(', ')}`
        : facts.code === 'TASK_RESOURCE_LOCK_LOST'
          ? 'the task lost a declared resource lock before its result could be accepted'
          : `the ${request.runtime} attempt did not complete successfully`;
  return buildTaskExecutionEvidence(task as unknown as TaskRecordBinding, {
    id,
    candidate_sha: facts.candidateSha,
    resolved_executor: {
      kind: 'agent',
      registry_id: request.runtime,
      runtime: request.runtime,
      model: plan.model,
      effort: request.effort,
      recipe_name: request.recipe_name ?? null,
      recipe_variant: request.recipe_variant ?? null,
    },
    adapter_versions: [{ id: `@devai-nyx/skills:agent-cli:${request.runtime}`, version: '1.0.0' }],
    tool_versions: [],
    input_digests: [{ id: 'prompt', digest_sha256: facts.composed.prompt_sha256 }],
    output_digests: facts.changed,
    selection: {
      mode: 'exact',
      considered_registry_ids: [request.runtime],
      selected_registry_id: request.runtime,
      rejection_codes: [],
      fallback: plan.tier === 'bumped',
      fallback_reason: plan.tier === 'bumped' ? EXPERIMENTAL_BUMPED_TIER : null,
    },
    prompt: {
      prompt_composition_id: facts.composed.composition.id,
      prompt_sha256: facts.composed.prompt_sha256,
    },
    usage: facts.attempt.output.usage,
    cost: facts.attempt.output.cost,
    started_at: facts.startedAt,
    completed_at: facts.completedAt,
    verdict: facts.verdict,
    ...(!passed && {
      failure: {
        code: facts.code,
        message,
        rollback_disposition: 'preserved-for-repair' as const,
      },
    }),
    evidence_refs: [],
    experimental: true,
  });
}
