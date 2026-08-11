export type TaskStatus =
  | 'queued'
  | 'ready'
  | 'lock_denied'
  | 'in_progress'
  | 'checkpoint'
  | 'pre_merge'
  | 'merging'
  | 'completed'
  | 'awaiting_human_review'
  | 'experimental_blocked'
  | 'escalated'
  | 'rgr_pending'
  | 'cancelled';

export type TaskDiscipline = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type TaskSubstrate = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';
export type TaskEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';

interface RoutineTaskExecutorBase {
  readonly kind: 'routine';
  readonly cwd: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly effects: readonly TaskEffect[];
  readonly timeout_ms: number;
  readonly authority_checks: readonly string[];
}

export type RoutineTaskExecutor = RoutineTaskExecutorBase &
  (
    | { readonly action_id: string; readonly argv?: never }
    | { readonly argv: readonly string[]; readonly action_id?: never }
  );

export type AgentSelection = { readonly mode: 'exact'; readonly registry_id: string };

export interface AgentTaskExecutor {
  readonly kind: 'agent';
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly selection: AgentSelection;
  readonly recipe_name?: string;
  readonly recipe_variant?: string;
  readonly prompt_composition_id: string;
  readonly max_iterations: number;
  readonly capabilities: readonly string[];
  readonly timeout_ms?: number;
}

export interface HumanTaskExecutor {
  readonly kind: 'human';
  readonly role: TaskDiscipline;
  readonly instructions_ref: string;
  readonly completion_evidence: readonly string[];
  readonly timeout_ms: number;
  readonly timeout_behavior: 'block' | 'escalate';
}

export interface CompositeDependency {
  readonly task_id: string;
  readonly depends_on: readonly string[];
}

export interface CompositeTaskExecutor {
  readonly kind: 'composite';
  readonly child_task_ids: readonly string[];
  readonly dependencies: readonly CompositeDependency[];
  readonly failure_policy: 'stop-dependent-branch' | 'stop-composite';
}

export type TaskExecutor =
  RoutineTaskExecutor | AgentTaskExecutor | HumanTaskExecutor | CompositeTaskExecutor;

export interface TaskIterationRecord {
  readonly iteration: number;
  readonly started_at: string;
  readonly ended_at?: string | null;
  readonly verdict: 'PASS' | 'REVIEW' | 'FAIL' | 'RGR' | 'ESCALATED';
  readonly hard_gate_failures?: readonly string[];
  readonly soft_gate_failures?: readonly string[];
  readonly evidence_refs?: readonly string[];
}

/** The immutable task request persisted by the task loop. */
export interface TaskRecord {
  readonly schemaVersion: '2.0.0';
  readonly id: string;
  readonly round_id: string;
  readonly status: TaskStatus;
  readonly discipline: TaskDiscipline;
  readonly discipline_specialization?: string;
  readonly title: string;
  readonly description?: string;
  readonly lifecycle?: 'supported' | 'experimental';
  readonly acceptance_commands?: readonly (readonly string[])[];
  readonly coupled_task_group?: string | null;
  readonly coupled_pipeline_position?: 'architect' | 'inspector' | 'engineer' | null;
  readonly upstream_task_id?: string | null;
  readonly target_modules: readonly string[];
  readonly target_substrates: readonly TaskSubstrate[];
  readonly target_invariants?: readonly string[];
  readonly created_at: string;
  readonly db_isolation: 'database' | 'cluster';
  readonly iteration_count: number;
  readonly max_iterations?: number;
  readonly spawned_at?: string | null;
  readonly completed_at?: string | null;
  readonly branch?: string | null;
  readonly worktree_id?: string | null;
  readonly prompt_composition_id?: string | null;
  readonly executor: TaskExecutor;
  readonly intent_diff?: {
    readonly summary?: string;
    readonly planned_files?: readonly string[];
    readonly planned_steps?: readonly string[];
  };
  readonly actual_diff?: {
    readonly files_changed?: number;
    readonly additions?: number;
    readonly deletions?: number;
    readonly diff_evidence_ref?: string;
  };
  readonly iteration_trail?: readonly TaskIterationRecord[];
  readonly priority?: number;
  readonly tags?: readonly string[];
}

export type TaskRecordClassification =
  | { readonly kind: 'current'; readonly executable: true; readonly record: TaskRecord }
  | {
      readonly kind: 'invalid';
      readonly executable: false;
      readonly code:
        | 'TASK_RECORD_INVALID'
        | 'TASK_SCHEMA_VERSION_UNSUPPORTED'
        | 'TASK_ROUND_ID_REQUIRED'
        | 'TASK_EXECUTOR_REQUIRED';
    };

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Classify without enriching or rewriting the caller's value. Full schema
 * validation remains the persistence boundary's responsibility.
 */
export function classifyTaskRecord(value: unknown): TaskRecordClassification {
  const record = objectRecord(value);
  if (record === null) return { kind: 'invalid', executable: false, code: 'TASK_RECORD_INVALID' };

  if (record['schemaVersion'] !== '2.0.0') {
    return {
      kind: 'invalid',
      executable: false,
      code: 'TASK_SCHEMA_VERSION_UNSUPPORTED',
    };
  }
  if (typeof record['round_id'] !== 'string' || record['round_id'].length === 0) {
    return { kind: 'invalid', executable: false, code: 'TASK_ROUND_ID_REQUIRED' };
  }
  if (objectRecord(record['executor']) === null) {
    return { kind: 'invalid', executable: false, code: 'TASK_EXECUTOR_REQUIRED' };
  }
  return {
    kind: 'current',
    executable: true,
    record: value as TaskRecord,
  };
}

export interface ValidateTaskRoundOptions {
  readonly operation: string;
  readonly requested_round_id?: string;
  readonly task_round_id: string;
  readonly active_round_ids: readonly string[];
}

export type TaskRoundValidation =
  | { readonly ok: true; readonly round_id: string; readonly operation: string }
  | {
      readonly ok: false;
      readonly code:
        | 'TASK_ROUND_REQUIRED'
        | 'TASK_ROUND_ID_REQUIRED'
        | 'TASK_ROUND_INACTIVE'
        | 'TASK_ROUND_MISMATCH';
      readonly operation: string;
    };

/** Pure pre-resource validation for the requested, task-owned active round. */
export function validateTaskRound(options: ValidateTaskRoundOptions): TaskRoundValidation {
  if (typeof options.requested_round_id !== 'string' || options.requested_round_id.length === 0) {
    return { ok: false, code: 'TASK_ROUND_REQUIRED', operation: options.operation };
  }
  if (typeof options.task_round_id !== 'string' || options.task_round_id.length === 0) {
    return { ok: false, code: 'TASK_ROUND_ID_REQUIRED', operation: options.operation };
  }
  if (!options.active_round_ids.includes(options.requested_round_id)) {
    return { ok: false, code: 'TASK_ROUND_INACTIVE', operation: options.operation };
  }
  if (options.requested_round_id !== options.task_round_id) {
    return { ok: false, code: 'TASK_ROUND_MISMATCH', operation: options.operation };
  }
  return {
    ok: true,
    round_id: options.task_round_id,
    operation: options.operation,
  };
}
