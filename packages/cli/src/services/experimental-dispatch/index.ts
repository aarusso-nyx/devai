/**
 * The experimental agent dispatch engine of ADR-MDL-0005 (`round dispatch`). For one
 * admitted agent task it composes the governed prompt, then runs the Article 19
 * ladder — up to three attempts at the requested model and one at the next tier —
 * each in a fresh task worktree, around the hash-linked dispatch journal, with the
 * Article 6 write-scope check and non-promoting evidence after every attempt.
 * Nothing here pushes, merges, publishes, or retries uncertain work.
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
  appendDispatchJournalEvent,
  createWorktree,
  destroyWorktree,
  loadTask,
  saveTask,
  type ExperimentalActivation,
  type TaskRecord,
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
import { join, relative, sep } from 'node:path';

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

/** SHA-256 of every regular file under `root`, excluding `.git`, by relative path. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        const bytes = stat.isSymbolicLink() ? Buffer.from(`symlink`) : readFileSync(path);
        files.set(relative(root, path), createHash('sha256').update(bytes).digest('hex'));
      }
    }
  };
  walk(root);
  return files;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
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
 * Tokens an attempt spent against the invocation budget: every reported counter, cache
 * reads and writes included. Missing input or output counters leave the spend unverifiable;
 * a cache counter the provider never reports (codex cache writes) counts as zero spend.
 */
function counted(attempt: AgentCliAttempt): number | undefined {
  const usage = attempt.output.usage;
  if (usage.input_tokens.value === null || usage.output_tokens.value === null) return undefined;
  return (
    usage.input_tokens.value +
    usage.output_tokens.value +
    (usage.cache_read_tokens.value ?? 0) +
    (usage.cache_write_tokens.value ?? 0)
  );
}

interface AttemptPlan {
  readonly number: number;
  readonly model: string;
  readonly tier: 'default' | 'bumped';
}

function ladder(task: TaskRecord, request: AgentRequest, activation: ExperimentalActivation) {
  const limit = Math.min(activation.budgets.attempts_per_task, request.max_iterations, 4);
  const plans: AttemptPlan[] = [];
  for (let number = 1; number <= Math.min(DEFAULT_TIER_ATTEMPTS, limit); number += 1) {
    plans.push({ number, model: request.model, tier: 'default' });
  }
  const bumped = bumpedModel(request.runtime, request.model, activation);
  if (limit > DEFAULT_TIER_ATTEMPTS && bumped !== undefined) {
    plans.push({ number: DEFAULT_TIER_ATTEMPTS + 1, model: bumped, tier: 'bumped' });
  }
  void task;
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

function setStatus(repoRoot: string, taskId: string, status: TaskRecord['status']): void {
  saveTask(repoRoot, { ...loadTask(repoRoot, taskId), status });
}

/**
 * Dispatch one admitted agent task through the experimental ladder. The task ends
 * `awaiting_human_review` with its passing attempt's worktree kept for review, or
 * `experimental_blocked` after the ladder or a budget is exhausted. The runner
 * already holds the task's locks and has marked it `in_progress`.
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
  const budgets = context.activation.budgets;
  const wallClockMs = Math.min(
    budgets.attempt_wall_clock_minutes * 60_000,
    request.timeout_ms ?? Number.POSITIVE_INFINITY,
  );
  let lastCode = 'EXPERIMENTAL_LADDER_EXHAUSTED';
  for (const plan of ladder(task, request, context.activation)) {
    if (context.budget.attempts >= budgets.attempts_per_invocation) {
      lastCode = 'EXPERIMENTAL_ATTEMPT_BUDGET_EXHAUSTED';
      break;
    }
    if (context.budget.unverifiable) {
      lastCode = 'EXPERIMENTAL_USAGE_UNVERIFIABLE';
      break;
    }
    if (context.budget.tokens >= budgets.tokens_per_invocation) {
      lastCode = 'EXPERIMENTAL_TOKEN_BUDGET_EXHAUSTED';
      break;
    }
    context.budget.attempts += 1;
    let outcome: { readonly ok: boolean; readonly code: string; readonly evidence_id?: string };
    try {
      outcome = await runAttempt(context, task, request, plan, composed, wallClockMs);
    } catch (error) {
      // Setup failed before any provider started (for example the worktree was refused).
      setStatus(context.repoRoot, task.id, 'experimental_blocked');
      return { ok: false, code: errorCode(error) };
    }
    if (outcome.ok) {
      setStatus(context.repoRoot, task.id, 'awaiting_human_review');
      return {
        ok: true,
        ...(outcome.evidence_id !== undefined && { evidence_id: outcome.evidence_id }),
      };
    }
    lastCode = outcome.code;
  }
  setStatus(context.repoRoot, task.id, 'experimental_blocked');
  return { ok: false, code: lastCode };
}

async function runAttempt(
  context: ExperimentalDispatchContext,
  task: TaskRecord,
  request: AgentRequest,
  plan: AttemptPlan,
  composed: ReturnType<typeof composeAgentPrompt>,
  wallClockMs: number,
): Promise<{ readonly ok: boolean; readonly code: string; readonly evidence_id: string }> {
  const { repoRoot, roundId } = context;
  const journal = (entry: Record<string, unknown>) =>
    appendDispatchJournalEvent(repoRoot, roundId, {
      task_id: task.id,
      attempt: plan.number,
      ...entry,
    } as Parameters<typeof appendDispatchJournalEvent>[2]);

  // The worktree is prepared before the intent: a setup failure starts no provider and
  // must not leave an uncertain journal attempt behind.
  const worktreeId = `WT-${task.id}-A${String(plan.number)}`;
  const worktree = createWorktree({
    repoRoot,
    id: worktreeId,
    branch: `experimental/${task.id}/attempt-${String(plan.number)}`,
    baseRef: context.baseRef ?? 'HEAD',
    taskId: task.id,
  });
  const before = snapshot(worktree.path);
  journal({
    event: 'intent',
    runtime: request.runtime,
    model: plan.model,
    effort: request.effort,
    tier: plan.tier,
    prompt_sha256: composed.prompt_sha256,
  });
  const invocation = (context.invocation ?? agentCliInvocation)({
    runtime: request.runtime,
    model: plan.model,
    effort: request.effort,
  });
  const startedAt = new Date().toISOString();
  let attempt: AgentCliAttempt;
  try {
    attempt = await runAgentCliAttempt({
      invocation,
      cwd: worktree.path,
      prompt: composed.prompt,
      timeoutMs: wallClockMs,
      ...(context.env !== undefined && { env: context.env }),
      onSpawned: (pid) => journal({ event: 'spawned', pid }),
    });
  } catch (error) {
    // The authority refused the spawn: no provider started, so the attempt settles as an
    // error instead of staying uncertain.
    attempt = refusedAttempt(request.runtime, errorCode(error));
  }
  journal({
    event: 'exited',
    exit_code: attempt.process.exit_code,
    signal: attempt.process.signal,
    timed_out: attempt.process.timed_out,
  });
  writeDiagnostics(repoRoot, roundId, `${task.id}-A${String(plan.number)}`, attempt);
  const completedAt = new Date().toISOString();
  const after = snapshot(worktree.path);
  const changed = changedPaths(before, after);
  const outOfScope = changed.filter((path) => article6Role(path) !== task.discipline);
  const tokens = counted(attempt);
  if (tokens === undefined) context.budget.unverifiable = true;
  else context.budget.tokens += tokens;

  const code = !attempt.ok
    ? (attempt.output.failure ??
      (attempt.process.timed_out
        ? 'AGENT_CLI_TIMED_OUT'
        : attempt.process.spawn_error !== null
          ? 'AGENT_CLI_SPAWN_FAILED'
          : 'AGENT_CLI_EXIT_NONZERO'))
    : outOfScope.length > 0
      ? 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION'
      : '';
  const passed = code === '';
  const evidence = attemptEvidence(task, request, plan, {
    candidateSha: gitHead(worktree.path),
    composed,
    attempt,
    changed: changed.flatMap((path) =>
      after.has(path) ? [{ id: path, digest_sha256: after.get(path) as string }] : [],
    ),
    startedAt,
    completedAt,
    code,
    outOfScope,
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
  journal({ event: 'settled', outcome: passed ? 'pass' : attempt.ok ? 'fail' : 'error' });
  if (passed) {
    saveTask(repoRoot, {
      ...loadTask(repoRoot, task.id),
      worktree_id: worktreeId,
      branch: worktree.branch,
    });
  } else if (existsSync(worktree.path)) {
    // The changed-file digests are retained in the evidence; the attempt's tree is not.
    destroyWorktree({ repoRoot, id: worktreeId });
  }
  return { ok: passed, code, evidence_id: evidence.id };
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
    readonly outOfScope: readonly string[];
  },
): TaskExecutionEvidence {
  const id = `TXE-${canonicalSha256({ task: task.id, attempt: plan.number, at: facts.startedAt }).slice(0, 16)}`;
  const passed = facts.code === '';
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
    verdict: passed ? 'pass' : facts.attempt.ok ? 'fail' : 'error',
    ...(!passed && {
      failure: {
        code: facts.code,
        message:
          facts.outOfScope.length > 0
            ? `writes outside the ${task.discipline} paths: ${facts.outOfScope.slice(0, 20).join(', ')}`
            : `the ${request.runtime} attempt did not complete successfully`,
        rollback_disposition: 'preserved-for-repair' as const,
      },
    }),
    evidence_refs: [],
    experimental: true,
  });
}
