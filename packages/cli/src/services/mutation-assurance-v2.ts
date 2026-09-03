/** Historical assurance-v2 shapes remain readable. ADR-MUT-0003 retires every callable
 * writer and semantic kernel; compatibility entrypoints refuse before touching providers. */
export interface MutationV2IdentityBinding {
  readonly digest_sha256: string;
  readonly member_count: number;
  readonly canonical_form: 'utf8-lines-of-<relative_path>-space-<sha256>-newline';
}

export interface MutationV2Identity {
  readonly candidate: {
    readonly release_unit: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly source: MutationV2IdentityBinding;
  readonly test: MutationV2IdentityBinding;
  readonly config: MutationV2IdentityBinding;
  readonly toolchain: MutationV2IdentityBinding;
  readonly roster: MutationV2IdentityBinding;
  readonly threshold: MutationV2IdentityBinding;
  readonly sanitizer: MutationV2IdentityBinding;
  readonly orchestration: MutationV2IdentityBinding;
  readonly lockfile: MutationV2IdentityBinding;
}

export interface MutationV2Counts {
  readonly killed: number;
  readonly survived: number;
  readonly timeout: number;
  readonly no_coverage: number;
  readonly runtime_error: number;
  readonly infrastructure_error: number;
}

export interface MutationV2Artifact {
  readonly kind:
    | 'mutant-roster'
    | 'per-mutant-outcome-log'
    | 'runner-output'
    | 'score-computation'
    | 'threshold-snapshot';
  readonly path: string;
  readonly sha256: string;
}

export interface MutationAssuranceV2Report extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: '2.0.0';
  readonly report_id: string;
  readonly mode: 'targeted' | 'full';
  readonly satisfies_requirement: 'targeted' | 'full';
  readonly disposition: 'executed' | 'reused' | 'not-required' | 'failed' | 'unknown';
  readonly verdict: 'pass' | 'fail' | 'unknown' | 'not-applicable';
  readonly identity: MutationV2Identity;
  readonly results?: MutationV2Counts & { readonly score: number };
  readonly thresholds_applied: {
    readonly source: 'law/policy/thresholds.json#/mutation';
    readonly score_min: number;
    readonly survived_max: number;
  };
  readonly thresholds_met?: boolean;
  readonly execution?: {
    readonly kernel_id: 'devai.kernel.mutation-assurance-v2.v1';
    readonly artifacts: readonly MutationV2Artifact[];
    readonly recomputed_from_artifacts: true;
    readonly schema_assertion_establishes_pass: false;
  };
  readonly reuse?: {
    readonly reused_from_report_id: string;
    readonly reused_from_digest_sha256: string;
    readonly all_identities_match: true;
  };
  readonly independently_checkable: boolean;
}

export interface MutationV2ArtifactProvider {
  /** Resolve exact artifact bytes. Missing artifacts must return undefined. */
  readonly readArtifact: (
    artifact: MutationV2Artifact,
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
  /** Parse the canonical per-mutant log. No default parser is guessed. */
  readonly parseOutcomeLog: (
    bytes: Uint8Array,
    artifact: MutationV2Artifact,
  ) => MutationV2Counts | Promise<MutationV2Counts>;
  readonly loadThresholds: () =>
    | { readonly score_min: number; readonly survived_max: number }
    | Promise<{ readonly score_min: number; readonly survived_max: number }>;
  readonly loadReusedReport?: (
    reportId: string,
  ) => unknown | undefined | Promise<unknown | undefined>;
}

export type MutationV2SemanticError =
  | 'ma2-execution-artifact-unresolved'
  | 'ma2-execution-artifact-digest-mismatch'
  | 'ma2-killed-count-mismatch'
  | 'ma2-timeout-count-mismatch'
  | 'ma2-survivor-count-mismatch'
  | 'ma2-no-coverage-count-mismatch'
  | 'ma2-runtime-error-count-mismatch'
  | 'ma2-infrastructure-error-count-mismatch'
  | 'ma2-count-not-nonnegative-safe-integer'
  | 'ma2-count-not-finite'
  | 'ma2-reported-score-negative-zero'
  | 'ma2-score-samevalue-mismatch'
  | 'ma2-threshold-source-mismatch'
  | 'ma2-threshold-value-mismatch'
  | 'ma2-thresholds-met-mismatch'
  | 'ma2-verdict-mismatch'
  | 'ma2-semantic-verification-not-performed';

export type MutationV2Verification =
  | {
      readonly ok: true;
      readonly kernel_id: 'devai.kernel.mutation-assurance-v2.v1';
      readonly report: MutationAssuranceV2Report;
      readonly disposition: MutationAssuranceV2Report['disposition'];
      readonly verdict: MutationAssuranceV2Report['verdict'];
    }
  | {
      readonly ok: false;
      readonly kernel_id: 'devai.kernel.mutation-assurance-v2.v1';
      readonly errors: readonly MutationV2SemanticError[];
    };

function retiredMutationProtocol(): never {
  throw Object.assign(new Error('MUTATION_VERSION_UNSUPPORTED'), {
    code: 'MUTATION_VERSION_UNSUPPORTED',
  });
}

/** @deprecated No new assurance-v2 scores or verdicts may be produced. */
export function computeMutationV2Score(counts: MutationV2Counts): number {
  void counts;
  return retiredMutationProtocol();
}

/** @deprecated Use the source-pinned mutation-evidence-v21 semantic verifier. */
export async function verifyMutationAssuranceV2(
  reportInput: unknown,
  provider: MutationV2ArtifactProvider,
): Promise<MutationV2Verification> {
  void reportInput;
  void provider;
  return retiredMutationProtocol();
}

export interface MutationRosterExecutionEntry<TContext> {
  readonly id: string;
  readonly package: string;
  readonly task_node: string;
  readonly mode: 'targeted' | 'full';
  readonly identity: MutationV2Identity;
  readonly context: TContext;
  readonly not_required_reason?:
    'documentation-only-change' | 'metadata-only-change' | 'no-behavioral-surface-selected';
}

export interface MutationRosterPackageResult {
  readonly id: string;
  readonly package: string;
  readonly task_node: string;
  readonly disposition: 'executed' | 'reused' | 'not-required' | 'failed' | 'unknown';
  readonly report?: MutationAssuranceV2Report;
  readonly reason: string;
}

export interface MutationRosterExecution<TContext> {
  readonly complete: boolean;
  readonly packages: readonly MutationRosterPackageResult[];
  readonly execute: (entry: MutationRosterExecutionEntry<TContext>) => unknown | Promise<unknown>;
}

/** @deprecated The divergent assurance-v2 execution contract is retired. */
export async function executeParameterizedMutationRoster<TContext>(input: {
  readonly entries: readonly MutationRosterExecutionEntry<TContext>[];
  readonly loadPrior: (
    entry: MutationRosterExecutionEntry<TContext>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  readonly verify: (
    report: unknown,
    entry: MutationRosterExecutionEntry<TContext>,
  ) => MutationV2Verification | Promise<MutationV2Verification>;
  readonly execute: (entry: MutationRosterExecutionEntry<TContext>) => unknown | Promise<unknown>;
}): Promise<MutationRosterExecution<TContext>> {
  void input;
  return retiredMutationProtocol();
}
