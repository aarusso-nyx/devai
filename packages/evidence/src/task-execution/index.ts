import { existsSync, mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { getValidator, type SchemaName } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

const TASK_EXECUTION_EVIDENCE_SCHEMA =
  'task-execution-evidence.schema.json' as unknown as SchemaName;

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
  readonly usage: UsageEvidence | NotApplicableEvidence;
  readonly cost: CostEvidence | NotApplicableEvidence;
  readonly started_at: string;
  readonly completed_at: string;
  readonly verdict: TaskExecutionVerdict;
  readonly failure: TaskExecutionFailure | null;
  readonly evidence_refs: readonly string[];
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
  readonly usage: UsageEvidence | NotApplicableEvidence;
  readonly cost: CostEvidence | NotApplicableEvidence;
  readonly started_at: string;
  readonly completed_at: string;
  readonly verdict: TaskExecutionVerdict;
  readonly failure?: TaskExecutionFailure | null;
  readonly evidence_refs: readonly string[];
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

function evidenceValidator(): TaskExecutionEvidenceValidator {
  return getValidator(TASK_EXECUTION_EVIDENCE_SCHEMA) as TaskExecutionEvidenceValidator;
}

function schemaIssues(validator: TaskExecutionEvidenceValidator): readonly string[] {
  if (!Array.isArray(validator.errors)) return ['schema validation failed without diagnostics'];
  return validator.errors.map((issue) => {
    if (issue === null || typeof issue !== 'object') return String(issue);
    const record = issue as { readonly instancePath?: unknown; readonly message?: unknown };
    const path = typeof record.instancePath === 'string' ? record.instancePath : '/';
    const message = typeof record.message === 'string' ? record.message : 'invalid value';
    return `${path.length === 0 ? '/' : path} ${message}`;
  });
}

function freezeSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current as Record<string, unknown>)) visit(child);
    Object.freeze(current);
  };
  visit(snapshot);
  return snapshot;
}

function isNotApplicable(value: unknown): value is NotApplicableEvidence {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly not_applicable_reason?: unknown }).not_applicable_reason ===
      'string'
  );
}

function requireSemantic(condition: boolean, code: string, message: string): void {
  if (!condition) throw new TaskExecutionEvidenceError(code, message);
}

function sameOrderedStrings(left: readonly string[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function validateTimestamps(evidence: TaskExecutionEvidence): void {
  const started = Date.parse(evidence.started_at);
  const completed = Date.parse(evidence.completed_at);
  requireSemantic(
    Number.isFinite(started) && Number.isFinite(completed) && completed >= started,
    'TASK_EXECUTION_EVIDENCE_TIMESTAMP_INVALID',
    'completed_at must be at or after started_at',
  );
}

function validateAgentSelection(task: TaskRecordBinding, evidence: TaskExecutionEvidence): void {
  const request = task.executor;
  const requestedSelection = request['selection'];
  requireSemantic(
    requestedSelection !== null &&
      typeof requestedSelection === 'object' &&
      !Array.isArray(requestedSelection),
    'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
    'agent task has no selection contract',
  );
  const requested = requestedSelection as Readonly<Record<string, unknown>>;
  requireSemantic(
    evidence.selection.mode === requested['mode'],
    'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
    'recorded selection mode differs from the immutable request',
  );
  const resolved = evidence.resolved_executor;
  if (resolved.kind !== 'agent') {
    throw new TaskExecutionEvidenceError(
      'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
      'agent selection evidence has a non-agent resolved executor',
    );
  }
  requireSemantic(
    evidence.selection.selected_registry_id === resolved.registry_id,
    'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
    'selected registry identity differs from the resolved executor',
  );
  requireSemantic(
    evidence.selection.considered_registry_ids.includes(resolved.registry_id),
    'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
    'selected registry identity was not recorded as considered',
  );
  requireSemantic(
    resolved.recipe_name ===
      (typeof request['recipe_name'] === 'string' ? request['recipe_name'] : null) &&
      resolved.recipe_variant ===
        (typeof request['recipe_variant'] === 'string' ? request['recipe_variant'] : null),
    'TASK_EXECUTION_EVIDENCE_RECIPE_MISMATCH',
    'resolved recipe identity differs from the immutable request',
  );

  if (requested['mode'] === 'exact') {
    const registryId = requested['registry_id'];
    requireSemantic(
      typeof registryId === 'string' &&
        resolved.registry_id === registryId &&
        evidence.selection.considered_registry_ids.length === 1 &&
        evidence.selection.considered_registry_ids[0] === registryId &&
        !evidence.selection.fallback &&
        evidence.selection.fallback_reason === null,
      'TASK_EXECUTION_EVIDENCE_EXACT_SUBSTITUTION',
      'exact selection must resolve only the exact requested registry identity',
    );
    requireSemantic(
      resolved.runtime === request['runtime'] &&
        resolved.model === request['model'] &&
        resolved.effort === request['effort'],
      'TASK_EXECUTION_EVIDENCE_EXACT_SUBSTITUTION',
      'exact selection changed requested runtime, model, or effort',
    );
  }

  requireSemantic(
    requested['mode'] === 'exact',
    'TASK_EXECUTION_EVIDENCE_SELECTION_MISMATCH',
    'agent execution requires exact host selection',
  );
}

function validateExecutionSemantics(
  task: TaskRecordBinding,
  evidence: TaskExecutionEvidence,
): void {
  requireSemantic(
    task.executor.kind === evidence.resolved_executor.kind,
    'TASK_EXECUTION_EVIDENCE_EXECUTOR_KIND_MISMATCH',
    'resolved executor kind differs from the immutable request',
  );
  validateTimestamps(evidence);

  const failed = ['fail', 'error', 'cancelled'].includes(evidence.verdict);
  requireSemantic(
    failed ? evidence.failure !== null : evidence.verdict !== 'pass' || evidence.failure === null,
    'TASK_EXECUTION_EVIDENCE_FAILURE_MISMATCH',
    'failure details are required for failed verdicts and forbidden for pass',
  );

  if (task.executor.kind === 'agent') {
    validateAgentSelection(task, evidence);
    requireSemantic(
      !isNotApplicable(evidence.prompt) &&
        evidence.prompt.prompt_composition_id === task.executor['prompt_composition_id'],
      'TASK_EXECUTION_EVIDENCE_PROMPT_MISMATCH',
      'agent evidence must bind the exact requested prompt composition',
    );
    return;
  }

  if (task.executor.kind === 'routine') {
    const resolved = evidence.resolved_executor;
    requireSemantic(
      resolved.kind === 'routine' &&
        resolved.cwd === task.executor['cwd'] &&
        sameOrderedStrings(resolved.effects, arrayValue(task.executor['effects'])),
      'TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH',
      'resolved routine cwd or effects differ from the immutable request',
    );
    if (typeof task.executor['action_id'] === 'string') {
      requireSemantic(
        resolved.kind === 'routine' && resolved.action_id === task.executor['action_id'],
        'TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH',
        'resolved routine action differs from the immutable request',
      );
    } else {
      requireSemantic(
        resolved.kind === 'routine' &&
          resolved.action_id === null &&
          sameOrderedStrings(resolved.argv, arrayValue(task.executor['argv'])),
        'TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH',
        'resolved literal argv differs from the immutable request',
      );
    }
  }

  if (task.executor.kind === 'human') {
    const resolved = evidence.resolved_executor;
    requireSemantic(
      resolved.kind === 'human' &&
        resolved.role === task.executor['role'] &&
        resolved.completion_evidence.every((reference) =>
          evidence.evidence_refs.includes(reference),
        ),
      'TASK_EXECUTION_EVIDENCE_HUMAN_MISMATCH',
      'resolved human role or completion evidence differs from the bound execution',
    );
  }

  if (task.executor.kind === 'composite') {
    const resolved = evidence.resolved_executor;
    requireSemantic(
      resolved.kind === 'composite' &&
        sameOrderedStrings(resolved.child_task_ids, arrayValue(task.executor['child_task_ids'])) &&
        resolved.child_execution_evidence_ids.length === resolved.child_task_ids.length,
      'TASK_EXECUTION_EVIDENCE_COMPOSITE_MISMATCH',
      'resolved composite children differ from the immutable request or lack child evidence',
    );
  }

  requireSemantic(
    evidence.selection.mode === 'not-applicable' &&
      evidence.selection.considered_registry_ids.length === 0 &&
      evidence.selection.selected_registry_id === null &&
      evidence.selection.rejection_codes.length === 0 &&
      !evidence.selection.fallback &&
      evidence.selection.fallback_reason === null,
    'TASK_EXECUTION_EVIDENCE_SELECTION_NOT_APPLICABLE',
    'non-agent evidence cannot record model selection or fallback',
  );
  requireSemantic(
    isNotApplicable(evidence.prompt) &&
      isNotApplicable(evidence.usage) &&
      isNotApplicable(evidence.cost),
    'TASK_EXECUTION_EVIDENCE_PROVIDER_FACTS_NOT_APPLICABLE',
    'non-agent evidence must mark prompt, usage, and cost not applicable',
  );
}

export function canonicalTaskRecordDigest(task: TaskRecordBinding): string {
  return canonicalSha256(task);
}

export function canonicalRequestedExecutorDigest(task: TaskRecordBinding): string {
  return canonicalSha256(task.executor);
}

export function checkTaskExecutionEvidence(
  value: unknown,
  validator: TaskExecutionEvidenceValidator = evidenceValidator(),
): TaskExecutionEvidenceValidation {
  if (!validator(value)) {
    return {
      ok: false,
      code: 'TASK_EXECUTION_EVIDENCE_SCHEMA_INVALID',
      issues: schemaIssues(validator),
    };
  }
  return { ok: true, value: value as TaskExecutionEvidence };
}

export function validateTaskExecutionEvidence(
  value: unknown,
  validator?: TaskExecutionEvidenceValidator,
): TaskExecutionEvidence {
  const result = checkTaskExecutionEvidence(value, validator ?? evidenceValidator());
  if (!result.ok) {
    throw new TaskExecutionEvidenceError(result.code, result.issues.join('; '));
  }
  return result.value;
}

export function assertTaskExecutionEvidenceBinding(
  evidence: TaskExecutionEvidence,
  task: TaskRecordBinding,
  candidateSha: string,
): void {
  requireSemantic(
    evidence.task_id === task.id && evidence.round_id === task.round_id,
    'TASK_EXECUTION_EVIDENCE_TASK_BINDING_MISMATCH',
    'task or round identity differs from the bound task record',
  );
  requireSemantic(
    evidence.candidate_sha === candidateSha,
    'TASK_EXECUTION_EVIDENCE_CANDIDATE_MISMATCH',
    'candidate identity differs from the expected exact candidate',
  );
  requireSemantic(
    evidence.task_record_digest_sha256 === canonicalTaskRecordDigest(task),
    'TASK_EXECUTION_EVIDENCE_TASK_DIGEST_MISMATCH',
    'task-record digest differs from the canonical task record',
  );
  requireSemantic(
    evidence.requested_executor_digest_sha256 === canonicalRequestedExecutorDigest(task),
    'TASK_EXECUTION_EVIDENCE_EXECUTOR_DIGEST_MISMATCH',
    'requested-executor digest differs from the immutable executor request',
  );
  validateExecutionSemantics(task, evidence);
}

export function buildTaskExecutionEvidence(
  task: TaskRecordBinding,
  facts: TaskExecutionEvidenceFacts,
  validator?: TaskExecutionEvidenceValidator,
): TaskExecutionEvidence {
  const record = freezeSnapshot<TaskExecutionEvidence>({
    schemaVersion: '1.0.0',
    id: facts.id,
    task_id: task.id,
    round_id: task.round_id,
    candidate_sha: facts.candidate_sha,
    task_record_digest_sha256: canonicalTaskRecordDigest(task),
    requested_executor_digest_sha256: canonicalRequestedExecutorDigest(task),
    resolved_executor: facts.resolved_executor,
    adapter_versions: facts.adapter_versions,
    tool_versions: facts.tool_versions,
    input_digests: facts.input_digests,
    output_digests: facts.output_digests,
    selection: facts.selection,
    prompt: facts.prompt,
    usage: facts.usage,
    cost: facts.cost,
    started_at: facts.started_at,
    completed_at: facts.completed_at,
    verdict: facts.verdict,
    failure: facts.failure ?? null,
    evidence_refs: facts.evidence_refs,
  });
  const validated = validateTaskExecutionEvidence(record, validator);
  assertTaskExecutionEvidenceBinding(validated, task, facts.candidate_sha);
  return validated;
}

function safePersistencePath(repoRoot: string, relativePath: string): string {
  requireSemantic(
    relativePath.length > 0 && !isAbsolute(relativePath),
    'TASK_EXECUTION_EVIDENCE_PATH_INVALID',
    'persistence path must be nonempty and relative to the repository root',
  );
  const normalized = normalize(relativePath);
  requireSemantic(
    normalized !== '..' && !normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
    'TASK_EXECUTION_EVIDENCE_PATH_INVALID',
    'persistence path cannot escape the repository root',
  );
  const root = resolve(repoRoot);
  const target = resolve(root, normalized);
  requireSemantic(
    relative(root, target) === normalized,
    'TASK_EXECUTION_EVIDENCE_PATH_INVALID',
    'persistence path must use one canonical relative spelling',
  );
  return target;
}

export interface PersistTaskExecutionEvidenceOptions {
  readonly repoRoot: string;
  readonly relativePath: string;
  readonly task: TaskRecordBinding;
  readonly candidate_sha: string;
  readonly evidence: TaskExecutionEvidence;
  readonly validator?: TaskExecutionEvidenceValidator;
}

export interface PersistTaskExecutionEvidenceResult {
  readonly evidence: TaskExecutionEvidence;
  readonly path: string;
  readonly relativePath: string;
}

export function persistTaskExecutionEvidence(
  options: PersistTaskExecutionEvidenceOptions,
): PersistTaskExecutionEvidenceResult {
  const validated = validateTaskExecutionEvidence(options.evidence, options.validator);
  assertTaskExecutionEvidenceBinding(validated, options.task, options.candidate_sha);
  const target = safePersistencePath(options.repoRoot, options.relativePath);
  requireSemantic(
    basename(target) === `${validated.id}.json`,
    'TASK_EXECUTION_EVIDENCE_PATH_BINDING_MISMATCH',
    'persistence filename must equal the bound evidence identity',
  );
  requireSemantic(
    !existsSync(target),
    'TASK_EXECUTION_EVIDENCE_ALREADY_EXISTS',
    'task-execution evidence is append-only and cannot overwrite an existing record',
  );

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
  return { evidence: validated, path: target, relativePath: options.relativePath };
}
