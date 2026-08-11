export type HumanExecutorRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

export interface HumanExecutorRequest {
  readonly kind: 'human';
  readonly role: HumanExecutorRole;
  readonly completion_evidence?: readonly string[];
}

export interface HumanCompletionIdentity {
  readonly task_id: string;
  readonly round_id: string;
  readonly role: HumanExecutorRole;
}

export interface HumanCompletionOptions {
  readonly task_id: string;
  readonly round_id: string;
  readonly executor: HumanExecutorRequest;
  readonly evidence: readonly string[];
  /**
   * The identity recorded by the completion boundary. When omitted, the
   * requested identity is used; callers cannot use this field to substitute a
   * different task, round, or governance role.
   */
  readonly completion?: HumanCompletionIdentity;
  /** Optional persisted-task binding for callers completing a loaded task. */
  readonly task?: {
    readonly id: string;
    readonly round_id: string;
  };
  /** Optional shorthand for the authenticated completing role. */
  readonly completed_by_role?: HumanExecutorRole;
}

export interface HumanCompletionSuccess {
  readonly ok: true;
  readonly task_id: string;
  readonly round_id: string;
  readonly role: HumanExecutorRole;
  readonly evidence: readonly string[];
}

export interface HumanCompletionFailure {
  readonly ok: false;
  readonly code:
    | 'TASK_HUMAN_EXECUTOR_REQUIRED'
    | 'TASK_HUMAN_TASK_MISMATCH'
    | 'TASK_HUMAN_ROUND_MISMATCH'
    | 'TASK_HUMAN_ROLE_MISMATCH'
    | 'TASK_HUMAN_EVIDENCE_REQUIRED';
}

export type HumanCompletionResult = HumanCompletionSuccess | HumanCompletionFailure;

function nonemptyUniqueStrings(values: readonly string[]): readonly string[] | null {
  if (values.length === 0) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0 || seen.has(value)) return null;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/**
 * Completes a human executor without permitting the completion record to
 * replace any part of the requested governance identity.
 */
export function completeHumanTask(options: HumanCompletionOptions): HumanCompletionResult {
  if (options.executor.kind !== 'human') {
    return { ok: false, code: 'TASK_HUMAN_EXECUTOR_REQUIRED' };
  }

  if (options.task !== undefined) {
    if (options.task.id !== options.task_id) {
      return { ok: false, code: 'TASK_HUMAN_TASK_MISMATCH' };
    }
    if (options.task.round_id !== options.round_id) {
      return { ok: false, code: 'TASK_HUMAN_ROUND_MISMATCH' };
    }
  }

  if (options.completion !== undefined) {
    if (options.completion.task_id !== options.task_id) {
      return { ok: false, code: 'TASK_HUMAN_TASK_MISMATCH' };
    }
    if (options.completion.round_id !== options.round_id) {
      return { ok: false, code: 'TASK_HUMAN_ROUND_MISMATCH' };
    }
    if (options.completion.role !== options.executor.role) {
      return { ok: false, code: 'TASK_HUMAN_ROLE_MISMATCH' };
    }
  }

  if (
    options.completed_by_role !== undefined &&
    options.completed_by_role !== options.executor.role
  ) {
    return { ok: false, code: 'TASK_HUMAN_ROLE_MISMATCH' };
  }

  const evidence = nonemptyUniqueStrings(options.evidence);
  if (evidence === null) {
    return { ok: false, code: 'TASK_HUMAN_EVIDENCE_REQUIRED' };
  }

  const requiredEvidence = options.executor.completion_evidence ?? [];
  if (
    requiredEvidence.some(
      (requirement) =>
        typeof requirement !== 'string' ||
        requirement.trim().length === 0 ||
        !evidence.includes(requirement),
    )
  ) {
    return { ok: false, code: 'TASK_HUMAN_EVIDENCE_REQUIRED' };
  }

  return {
    ok: true,
    task_id: options.task_id,
    round_id: options.round_id,
    role: options.executor.role,
    evidence,
  };
}
