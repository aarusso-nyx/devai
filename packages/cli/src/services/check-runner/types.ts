export type TaskTarget = 'affected' | 'local' | 'rc' | 'release' | 'preflight';
export type TaskOperation = 'plan' | 'run' | 'status' | 'explain';
/**
 * BLOCKED (ADR-CHK-0001) is the outcome of a preflight node whose extrinsic probe
 * did not pass, and of every dependent it left blocked-environment. It says
 * nothing about the candidate, so it is never written as a reusable result.
 */
export type TaskOutcome = 'PASS' | 'FAIL' | 'TIMEOUT' | 'KILLED' | 'ABORTED' | 'BLOCKED';

export type PreflightProbeClass = 'extrinsic' | 'intrinsic';
export type PreflightProbeStatus = 'pass' | 'fail' | 'blocked' | 'skipped';

export type PreflightProbeKind =
  | Readonly<{ kind: 'environment'; name: string; expected?: string }>
  | Readonly<{ kind: 'file'; path: string; must_exist: boolean; expected_sha256?: string }>
  | Readonly<{ kind: 'command'; argv: readonly string[]; expected_exit: number }>
  | Readonly<{
      kind: 'git';
      check: 'base-up-to-date' | 'clean-tree' | 'commit-range';
      base?: string;
    }>
  | Readonly<{ kind: 'registry'; url: string; expected_version?: string }>
  | Readonly<{ kind: 'toolchain'; manifest_path: string }>
  | Readonly<{ kind: 'credential'; manifest_id: string }>;

/** One probe as declared by law/schemas/preflight-probe.schema.json. */
export interface PreflightProbe {
  readonly id: string;
  readonly class: PreflightProbeClass;
  readonly probe: PreflightProbeKind;
  readonly expected: string;
  readonly observed: string | null;
  readonly status: PreflightProbeStatus;
  readonly remediation: string;
  readonly depends_on: readonly string[];
}

/** One executed probe as reported: `observed` is always redacted. */
export interface PreflightProbeObservation {
  readonly id: string;
  readonly class: PreflightProbeClass;
  readonly kind: PreflightProbeKind['kind'];
  readonly status: PreflightProbeStatus;
  readonly expected: string;
  readonly observed: string | null;
  readonly remediation: string;
}

export interface InputSelector {
  readonly kind: 'exact' | 'prefix' | 'glob';
  readonly pattern: string;
}

export interface TaskDescriptorNode {
  readonly nodeId: string;
  readonly dependencies: readonly string[];
  /** Empty for a `preflight-v1` node, which declares `probes` instead. */
  readonly argv: readonly string[];
  readonly probes?: readonly PreflightProbe[];
  readonly cwd: string;
  readonly runner: string;
  readonly inputSelectors: readonly InputSelector[];
  readonly toolchainKeys: readonly string[];
  readonly allowlistedEnv: readonly string[];
  readonly outputContract: Readonly<Record<string, unknown>>;
}

export interface TaskDescriptor {
  readonly schemaVersion: '1.0.0';
  readonly descriptorVersion: string;
  readonly repositoryId: string;
  readonly fallbackNodeId: string | null;
  readonly dynamicFallbackSelectors: readonly InputSelector[];
  readonly tasks: readonly TaskDescriptorNode[];
  readonly profiles: readonly Readonly<{
    profileId: string;
    mode: 'affected' | 'fixed';
    requiredNodes: readonly string[];
    eligibleNodes?: readonly string[];
  }>[];
}

export interface TaskPolicyNode {
  readonly nodeId: string;
  readonly taskKey: string;
  readonly dependencies: readonly string[];
  readonly outputContract: Readonly<Record<string, unknown>>;
}

export interface TaskPolicy {
  /** 1.2.0 is required precisely when the release input projection is carried. */
  readonly schemaVersion: '1.1.0' | '1.2.0';
  readonly repositoryId: string;
  readonly requiredNodes: readonly TaskPolicyNode[];
  readonly inputProjection?: Readonly<{
    schemaVersion: '1.0.0';
    source: 'exact-candidate-tree';
    excludedPrefixes: readonly string[];
    digest: string;
  }>;
}

export interface PlannedTask extends TaskPolicyNode {
  readonly argv: readonly string[];
  readonly executable: Readonly<{ path: string; sha256: string }>;
  readonly cwd: string;
  readonly inputDigest: string;
  readonly inputPaths: readonly string[];
  readonly matchedChangedPaths: readonly string[];
  readonly outputContract: Readonly<Record<string, unknown>>;
  readonly cacheState: 'reusable' | 'execute' | 'stale';
  readonly reason: string;
  readonly cachedResultDigest?: string;
}

export interface TaskPlan {
  readonly schemaVersion: '1.0.0';
  readonly repository: Readonly<{ id: string; commit: string; tree: string }>;
  readonly target: TaskTarget;
  readonly clean: boolean;
  readonly baseCommit?: string;
  readonly descriptorDigest: string;
  readonly taskPolicy: TaskPolicy;
  readonly taskPolicyDigest: string;
  readonly releaseIntentDigest?: string;
  readonly releaseProfileDigest?: string;
  readonly toolchainDigest?: string;
  readonly releaseDecision?: import('../release-profile.js').ReleaseVerificationDecision;
  readonly changedPaths: readonly string[];
  readonly tasks: readonly PlannedTask[];
}

export interface TaskResult {
  readonly schemaVersion: '1.0.0';
  readonly nodeId: string;
  readonly taskKey: string;
  readonly status: 'PASS';
  readonly inputDigest: string;
  readonly dependencyResultDigests: Readonly<Record<string, string>>;
  readonly outputDigests: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface CandidateReceipt {
  readonly schemaVersion: '1.1.0';
  readonly repository: Readonly<{ id: string; commit: string; tree: string }>;
  readonly profile: 'affected' | 'rc';
  readonly taskPolicyDigest: string;
  readonly createdAt: string;
  readonly tasks: readonly Readonly<{
    nodeId: string;
    taskKey: string;
    resultDigest: string;
  }>[];
}

export interface ExecutedTask {
  readonly nodeId: string;
  readonly taskKey: string;
  /** blocked-environment: a dependency was BLOCKED, so this node was never executed. */
  readonly disposition: 'executed' | 'reused' | 'aborted' | 'blocked-environment';
  readonly outcome: TaskOutcome;
  readonly reason: string;
  readonly durationMs: number;
  readonly resultDigest?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly diagnosticPath?: string;
  /** Redacted per-probe observations of a `preflight-v1` node. */
  readonly probes?: readonly PreflightProbeObservation[];
  /** Remediation of every probe that did not pass. */
  readonly remediation?: readonly string[];
}

export interface CheckRunnerReport {
  readonly schemaVersion: '1.0.0';
  readonly operation: TaskOperation;
  readonly plan: TaskPlan;
  readonly execution?: readonly ExecutedTask[];
  readonly receipt?: Readonly<{ digest: string; path: string; value: CandidateReceipt }>;
  readonly preflightReceipt?: Readonly<{
    digest: string;
    path: string;
    value: import('../release-preflight.js').ReleasePreflightReceipt;
  }>;
  readonly releaseVerification?: readonly Readonly<{
    nodeId: string;
    status: 'executed' | 'reused' | 'not-required' | 'failed' | 'blocked' | 'unknown';
    reasonCode: string;
    failureClass?: import('../release-preflight.js').ReleaseFailureClass;
    resultDigest?: string;
  }>[];
  readonly receiptRefusal?: string;
  /** BLOCKED nodes aggregated apart from failures, each with its remediation. */
  readonly blocked?: readonly Readonly<{
    nodeId: string;
    disposition: 'executed' | 'blocked-environment';
    reason: string;
    remediation: readonly string[];
  }>[];
  readonly exitCode: number;
}

export interface TaskExecutionResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

export interface CheckRunnerOptions {
  readonly repoRoot: string;
  readonly target: TaskTarget;
  readonly operation: TaskOperation;
  readonly baseCommit?: string;
  readonly timeoutMs?: number;
  readonly descriptorPath?: string;
  readonly descriptorDocument?: TaskDescriptor;
  readonly releaseCandidate?: Readonly<{ commit: string; tree: string }>;
  readonly cacheRoot?: string;
  readonly toolchain?: Readonly<Record<string, string>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly releaseIntent?: unknown;
  readonly releaseProfile?: unknown;
  readonly releaseRequiredNodes?: readonly string[];
  readonly releaseAllNodes?: readonly string[];
  readonly releaseAffectedSelection?: boolean;
  readonly releaseTaskBindings?: Readonly<Record<string, unknown>>;
  readonly releaseStage?: 'preflight' | 'certify';
  readonly preflightReceipt?: unknown;
  readonly executeTask?: (
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>>,
    /** Exact planned identity, including when earlier nodes were skipped or reused. */
    taskIdentity: Readonly<{ nodeId: string; taskKey: string }>,
  ) => TaskExecutionResult;
  /** Trusted host-only execution identity; never populated from CLI documents. */
  readonly resolveExecutable?: (name: string) => Readonly<{ path: string; sha256: string }>;
  readonly protectedExecutionIdentity?: Readonly<Record<string, unknown>>;
  /** Protected executors return sealed bytes after namespace quiescence, not worktree reads. */
  readonly readTaskOutput?: (path: string) => Buffer;
  /** Complete sealed namespace census supplied by the protected executor, not a task path list. */
  readonly capturedTaskOutputPaths?: (task: PlannedTask) => readonly string[];
  /**
   * Trusted host-only declaration that a protected semantic mutation producer will
   * retain this unit's evidence. Never populated from CLI documents: a JSON profile
   * cannot carry a function, so an ordinary `devai check` can never claim it.
   */
  readonly resolveProtectedMutationProducer?: () => string;
  readonly now?: () => string;
}
