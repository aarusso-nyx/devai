export type TaskTarget = 'affected' | 'local' | 'rc' | 'release';
export type TaskOperation = 'plan' | 'run' | 'status' | 'explain';
export type TaskOutcome = 'PASS' | 'FAIL' | 'TIMEOUT' | 'KILLED' | 'ABORTED';

export interface InputSelector {
  readonly kind: 'exact' | 'prefix' | 'glob';
  readonly pattern: string;
}

export interface TaskDescriptorNode {
  readonly nodeId: string;
  readonly dependencies: readonly string[];
  readonly argv: readonly string[];
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
  readonly schemaVersion: '1.1.0';
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
  readonly disposition: 'executed' | 'reused' | 'aborted';
  readonly outcome: TaskOutcome;
  readonly reason: string;
  readonly durationMs: number;
  readonly resultDigest?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly diagnosticPath?: string;
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
  ) => TaskExecutionResult;
  /** Trusted host-only execution identity; never populated from CLI documents. */
  readonly resolveExecutable?: (name: string) => Readonly<{ path: string; sha256: string }>;
  readonly protectedExecutionIdentity?: Readonly<Record<string, unknown>>;
  /** Protected executors return sealed bytes after namespace quiescence, not worktree reads. */
  readonly readTaskOutput?: (path: string) => Buffer;
  readonly now?: () => string;
}
