import { createHash } from 'node:crypto';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';

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

const COUNT_KEYS = [
  'killed',
  'survived',
  'timeout',
  'no_coverage',
  'runtime_error',
  'infrastructure_error',
] as const;

function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function countError(key: (typeof COUNT_KEYS)[number]): MutationV2SemanticError {
  if (key === 'killed') return 'ma2-killed-count-mismatch';
  if (key === 'timeout') return 'ma2-timeout-count-mismatch';
  if (key === 'survived') return 'ma2-survivor-count-mismatch';
  if (key === 'no_coverage') return 'ma2-no-coverage-count-mismatch';
  if (key === 'runtime_error') return 'ma2-runtime-error-count-mismatch';
  return 'ma2-infrastructure-error-count-mismatch';
}

function validCount(value: number): boolean {
  return Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;
}

function sameIdentity(left: MutationV2Identity, right: MutationV2Identity): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

export function computeMutationV2Score(counts: MutationV2Counts): number {
  for (const key of COUNT_KEYS) {
    const value = counts[key];
    if (!validCount(value)) {
      throw new RangeError(`mutation count ${key} must be a nonnegative safe integer`);
    }
  }
  const detected = counts.killed + counts.timeout;
  const scored = detected + counts.survived + counts.no_coverage;
  return scored === 0 ? 100 : (detected / scored) * 100;
}

export async function verifyMutationAssuranceV2(
  reportInput: unknown,
  provider: MutationV2ArtifactProvider,
): Promise<MutationV2Verification> {
  const parsed = parsers.mutationAssuranceV2.safeParse<MutationAssuranceV2Report>(reportInput);
  if (!parsed.ok) {
    return {
      ok: false,
      kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
      errors: ['ma2-semantic-verification-not-performed'],
    };
  }
  const report = parsed.value;
  if (report.disposition === 'not-required') {
    return {
      ok: true,
      kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
      report,
      disposition: 'not-required',
      verdict: 'not-applicable',
    };
  }
  if (report.results === undefined || report.execution === undefined) {
    return {
      ok: true,
      kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
      report,
      disposition: report.disposition,
      verdict: report.verdict,
    };
  }

  const errors = new Set<MutationV2SemanticError>();
  let outcomeArtifact: MutationV2Artifact | undefined;
  let outcomeBytes: Uint8Array | undefined;
  for (const artifact of report.execution.artifacts) {
    const bytes = await provider.readArtifact(artifact);
    if (bytes === undefined) {
      errors.add('ma2-execution-artifact-unresolved');
      continue;
    }
    if (bytesSha256(bytes) !== artifact.sha256) {
      errors.add('ma2-execution-artifact-digest-mismatch');
    }
    if (artifact.kind === 'per-mutant-outcome-log') {
      outcomeArtifact = artifact;
      outcomeBytes = bytes;
    }
  }
  if (outcomeArtifact === undefined || outcomeBytes === undefined) {
    errors.add('ma2-execution-artifact-unresolved');
  }

  let counts: MutationV2Counts | undefined;
  if (outcomeArtifact !== undefined && outcomeBytes !== undefined) {
    try {
      counts = await provider.parseOutcomeLog(outcomeBytes, outcomeArtifact);
    } catch {
      errors.add('ma2-execution-artifact-unresolved');
    }
  }
  if (counts !== undefined) {
    for (const key of COUNT_KEYS) {
      const value = counts[key];
      if (!Number.isFinite(value)) errors.add('ma2-count-not-finite');
      else if (!validCount(value)) errors.add('ma2-count-not-nonnegative-safe-integer');
      if (!Object.is(report.results[key], value)) errors.add(countError(key));
    }
    if (COUNT_KEYS.every((key) => validCount(counts?.[key] ?? Number.NaN))) {
      const score = computeMutationV2Score(counts);
      if (Object.is(report.results.score, -0)) errors.add('ma2-reported-score-negative-zero');
      if (!Object.is(report.results.score, score)) errors.add('ma2-score-samevalue-mismatch');

      const thresholds = await provider.loadThresholds();
      if (report.thresholds_applied.source !== 'law/policy/thresholds.json#/mutation') {
        errors.add('ma2-threshold-source-mismatch');
      }
      if (
        !Object.is(report.thresholds_applied.score_min, thresholds.score_min) ||
        !Object.is(report.thresholds_applied.survived_max, thresholds.survived_max)
      ) {
        errors.add('ma2-threshold-value-mismatch');
      }
      const thresholdsMet =
        score >= thresholds.score_min && counts.survived <= thresholds.survived_max;
      if (report.thresholds_met !== thresholdsMet) errors.add('ma2-thresholds-met-mismatch');
      const expectedVerdict =
        thresholdsMet && counts.runtime_error === 0 && counts.infrastructure_error === 0
          ? 'pass'
          : 'fail';
      if (report.verdict !== expectedVerdict) errors.add('ma2-verdict-mismatch');
    }
  }

  if (report.disposition === 'reused') {
    const prior =
      report.reuse === undefined || provider.loadReusedReport === undefined
        ? undefined
        : await provider.loadReusedReport(report.reuse.reused_from_report_id);
    const priorParsed = parsers.mutationAssuranceV2.safeParse<MutationAssuranceV2Report>(prior);
    if (
      !priorParsed.ok ||
      report.reuse === undefined ||
      priorParsed.value.report_id !== report.reuse.reused_from_report_id ||
      priorParsed.value.record_digest_sha256 !== report.reuse.reused_from_digest_sha256 ||
      priorParsed.value.mode !== report.mode ||
      priorParsed.value.verdict !== 'pass' ||
      !sameIdentity(priorParsed.value.identity, report.identity)
    ) {
      errors.add('ma2-verdict-mismatch');
    }
  }

  return errors.size === 0
    ? {
        ok: true,
        kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
        report,
        disposition: report.disposition,
        verdict: report.verdict,
      }
    : {
        ok: false,
        kernel_id: 'devai.kernel.mutation-assurance-v2.v1',
        errors: [...errors],
      };
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

/**
 * Parameterizes one declared mutation task over package roster entries. An
 * interrupted run preserves completed/reused entries and marks the untouched
 * suffix unknown; refinalization can therefore execute only the missing work.
 */
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
  const packages: MutationRosterPackageResult[] = [];
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (entry === undefined) continue;
    if (entry.not_required_reason !== undefined) {
      packages.push({
        id: entry.id,
        package: entry.package,
        task_node: entry.task_node,
        disposition: 'not-required',
        reason: entry.not_required_reason,
      });
      continue;
    }
    const prior = await input.loadPrior(entry);
    if (prior !== undefined) {
      const parsed = parsers.mutationAssuranceV2.safeParse<MutationAssuranceV2Report>(prior);
      if (
        parsed.ok &&
        parsed.value.mode === entry.mode &&
        parsed.value.verdict === 'pass' &&
        sameIdentity(parsed.value.identity, entry.identity)
      ) {
        const verified = await input.verify(parsed.value, entry);
        if (verified.ok && verified.verdict === 'pass') {
          packages.push({
            id: entry.id,
            package: entry.package,
            task_node: entry.task_node,
            disposition: 'reused',
            report: parsed.value,
            reason: 'exact-input-digest-reuse',
          });
          continue;
        }
      }
    }
    try {
      const report = await input.execute(entry);
      const verified = await input.verify(report, entry);
      if (!verified.ok || verified.verdict !== 'pass') {
        packages.push({
          id: entry.id,
          package: entry.package,
          task_node: entry.task_node,
          disposition: 'failed',
          reason: verified.ok ? `mutation-verdict-${verified.verdict}` : verified.errors.join(','),
        });
        continue;
      }
      packages.push({
        id: entry.id,
        package: entry.package,
        task_node: entry.task_node,
        disposition: 'executed',
        report: verified.report,
        reason: 'fresh-execution',
      });
    } catch {
      packages.push({
        id: entry.id,
        package: entry.package,
        task_node: entry.task_node,
        disposition: 'failed',
        reason: 'execution-interrupted',
      });
      for (const remaining of input.entries.slice(index + 1)) {
        packages.push({
          id: remaining.id,
          package: remaining.package,
          task_node: remaining.task_node,
          disposition: 'unknown',
          reason: 'not-executed-after-interruption',
        });
      }
      return { complete: false, packages, execute: input.execute };
    }
  }
  return { complete: true, packages, execute: input.execute };
}
