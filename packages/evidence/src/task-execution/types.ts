export type TaskExecutionEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';
export type TaskExecutionVerdict = 'pass' | 'review' | 'fail' | 'unknown' | 'error' | 'cancelled';

export interface TaskRecordBinding {
  readonly schemaVersion: '2.0.0';
  readonly id: string;
  readonly round_id: string;
  readonly executor: Readonly<Record<string, unknown>> & { readonly kind: string };
  readonly [key: string]: unknown;
}

export interface VersionBinding {
  readonly id: string;
  readonly version: string;
  readonly digest_sha256?: string;
}

export interface DigestBinding {
  readonly id: string;
  readonly digest_sha256: string;
  readonly media_type?: string;
}

export interface ResolvedRoutineExecutor {
  readonly kind: 'routine';
  readonly action_id: string | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly effects: readonly TaskExecutionEffect[];
}

export interface ResolvedAgentExecutor {
  readonly kind: 'agent';
  readonly registry_id: string;
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  readonly recipe_name: string | null;
  readonly recipe_variant: string | null;
}

export interface ResolvedHumanExecutor {
  readonly kind: 'human';
  readonly role: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly completion_evidence: readonly string[];
}

export interface ResolvedCompositeExecutor {
  readonly kind: 'composite';
  readonly child_task_ids: readonly string[];
  readonly child_execution_evidence_ids: readonly string[];
}

export type ResolvedTaskExecutor =
  | ResolvedRoutineExecutor
  | ResolvedAgentExecutor
  | ResolvedHumanExecutor
  | ResolvedCompositeExecutor;

export interface SelectionEvidence {
  readonly mode: 'exact' | 'not-applicable';
  readonly considered_registry_ids: readonly string[];
  readonly selected_registry_id: string | null;
  readonly rejection_codes: readonly string[];
  readonly fallback: boolean;
  readonly fallback_reason: string | null;
}

export interface PromptEvidence {
  readonly prompt_composition_id: string;
  readonly prompt_sha256: string;
}

export interface UsageEvidence {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface CostEvidence {
  readonly amount: number;
  readonly currency: 'USD';
  readonly source: 'provider-reported' | 'registry-estimate';
}

/** A provider counter: missing is null, never zero (ADR-MDL-0005 D-7). */
export type UsageCounter =
  | { readonly value: number; readonly status: 'reported' | 'derived' }
  | { readonly value: null; readonly status: 'missing' };

interface UsageEvidenceV2Counters {
  readonly usage_version: 2;
  readonly input_tokens: UsageCounter;
  readonly output_tokens: UsageCounter;
  readonly cache_read_tokens: UsageCounter;
  readonly cache_write_tokens: UsageCounter;
}

/**
 * Version-2 usage for agent attempts, including cache counters and their provenance.
 * A cumulative-delta record computes its values from session totals, so it must say
 * how (ADR-MDL-0005 D-7).
 */
export type UsageEvidenceV2 = UsageEvidenceV2Counters &
  (
    | { readonly counter_mode: 'per-attempt'; readonly derivation?: string }
    | { readonly counter_mode: 'cumulative-delta'; readonly derivation: string }
  );

/** A cost the provider did not report is unknown, never 0. */
export interface CostUnknown {
  readonly amount: null;
  readonly currency: 'USD';
  readonly source: 'unknown';
}

export interface NotApplicableEvidence {
  readonly not_applicable_reason: string;
}

export interface TaskExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly rollback_disposition:
    'not-required' | 'preserved-for-repair' | 'explicit-compensation-required';
}

export interface TaskExecutionEvidence {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly task_id: string;
  readonly round_id: string;
  readonly candidate_sha: string;
  readonly task_record_digest_sha256: string;
  readonly requested_executor_digest_sha256: string;
  readonly resolved_executor: ResolvedTaskExecutor;
  readonly adapter_versions: readonly VersionBinding[];
  readonly tool_versions: readonly VersionBinding[];
  readonly input_digests: readonly DigestBinding[];
  readonly output_digests: readonly DigestBinding[];
  readonly selection: SelectionEvidence;
  readonly prompt: PromptEvidence | NotApplicableEvidence;
  readonly usage: UsageEvidence | UsageEvidenceV2 | NotApplicableEvidence;
  readonly cost: CostEvidence | CostUnknown | NotApplicableEvidence;
  readonly started_at: string;
  readonly completed_at: string;
  readonly verdict: TaskExecutionVerdict;
  readonly failure: TaskExecutionFailure | null;
  readonly evidence_refs: readonly string[];
  /** Present only on non-promoting experimental evidence (ADR-MDL-0005 D-9). */
  readonly experimental?: true;
}

export interface TaskExecutionEvidenceFacts {
  readonly id: string;
  readonly candidate_sha: string;
  readonly resolved_executor: ResolvedTaskExecutor;
  readonly adapter_versions: readonly VersionBinding[];
  readonly tool_versions: readonly VersionBinding[];
  readonly input_digests: readonly DigestBinding[];
  readonly output_digests: readonly DigestBinding[];
  readonly selection: SelectionEvidence;
  readonly prompt: PromptEvidence | NotApplicableEvidence;
  readonly usage: UsageEvidence | UsageEvidenceV2 | NotApplicableEvidence;
  readonly cost: CostEvidence | CostUnknown | NotApplicableEvidence;
  readonly started_at: string;
  readonly completed_at: string;
  readonly verdict: TaskExecutionVerdict;
  readonly failure?: TaskExecutionFailure | null;
  readonly evidence_refs: readonly string[];
  /** Marks non-promoting experimental evidence (ADR-MDL-0005 D-9). */
  readonly experimental?: true;
}

export type TaskExecutionEvidenceValidator = ((value: unknown) => boolean) & {
  readonly errors?: unknown;
};

export type TaskExecutionEvidenceValidation =
  | { readonly ok: true; readonly value: TaskExecutionEvidence }
  | { readonly ok: false; readonly code: string; readonly issues: readonly string[] };

export class TaskExecutionEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TaskExecutionEvidenceError';
    this.code = code;
  }
}
