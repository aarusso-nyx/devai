import {
  type ReleaseRecord,
  type ReleaseCheck,
  nextReleaseId,
  persist,
  type ReleaseVerdict,
  type ReleaseDriftObservation,
} from './records.js';

export interface PostdeployVerifyOptions {
  readonly repoRoot: string;
  readonly artifactRef: string;
  readonly artifactChainHead: string;
  readonly auditChainHead: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly now?: string;
}

/**
 * Post-deploy verification — record form: compares two SHAs supplied
 * by the operator. The match decision is mechanical equality.
 *
 * For the detector form (run a runtime-attestation charter against the
 * deployed runtime, extract the head, compare), see
 * `runPostdeployVerifyFromCharter` below.
 */
export function runPostdeployVerify(opts: PostdeployVerifyOptions): ReleaseRecord {
  const match = opts.artifactChainHead === opts.auditChainHead;
  const checks: ReleaseCheck[] = [
    {
      name: 'audit-chain.head-match',
      verdict: match ? 'pass' : 'block',
      detail: match
        ? 'observed head matches artifact head'
        : `observed=${opts.auditChainHead.slice(0, 12)}… vs artifact=${opts.artifactChainHead.slice(0, 12)}…`,
    },
  ];
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'postdeploy-verify',
    decided_at: opts.now ?? new Date().toISOString(),
    artifact_ref: opts.artifactRef,
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict: match ? 'pass' : 'block',
    ...(match ? {} : { reasons: ['audit-chain head mismatch'] }),
    inputs: {
      audit_chain_head: opts.auditChainHead,
      artifact_chain_head: opts.artifactChainHead,
    },
    checks,
    rollback_recommended: !match,
  };
  persist(opts.repoRoot, record);
  return record;
}

/**
 * Probe outcome carried into the release record. Mirrors what the
 * runtime-probe substrate returns, narrowed to what release records
 * need (we don't duplicate the SensorReading verdict surface).
 */
export interface ProbeAggregate {
  readonly summary_verdict: 'pass' | 'fail' | 'review' | 'skipped' | 'killed' | 'error' | 'unknown';
  readonly pass: number;
  readonly fail: number;
  readonly error: number;
  readonly review: number;
  readonly skipped: number;
  readonly findings: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

export interface PostdeployVerifyFromCharterOptions {
  readonly repoRoot: string;
  readonly artifactRef: string;
  readonly artifactChainHead?: string;
  readonly probeAggregate: ProbeAggregate;
  readonly charterPath: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly now?: string;
}

/**
 * Post-deploy verification — detector form. The CLI runs a
 * runtime-attestation charter via the existing `executeRuntimeProbe`
 * machinery and passes the aggregated outcome here. A charter whose
 * probes all pass means the deployed runtime matches expectations
 * (typically: the chain-head endpoint returned a value that includes
 * the artifact-of-record SHA). Any fail/error in the probe set →
 * block + rollback_recommended.
 *
 * This composes — charter execution stays in the sensors substrate;
 * release-record persistence stays here.
 */
export function runPostdeployVerifyFromCharter(
  opts: PostdeployVerifyFromCharterOptions,
): ReleaseRecord {
  const probeOk = opts.probeAggregate.summary_verdict === 'pass';
  const verdict: ReleaseVerdict = probeOk ? 'pass' : 'block';
  const findings = opts.probeAggregate.findings;
  const checks: ReleaseCheck[] = [
    {
      name: 'runtime-attestation.probes',
      verdict: probeOk ? 'pass' : 'block',
      detail: probeOk
        ? `${String(opts.probeAggregate.pass)} probe(s) passed`
        : `${String(opts.probeAggregate.fail + opts.probeAggregate.error)} probe(s) failed/errored; charter=${opts.charterPath}`,
    },
  ];
  const reasons = probeOk
    ? undefined
    : findings.length > 0
      ? findings.map((f) => f.message).slice(0, 5)
      : [`runtime-attestation charter ${opts.charterPath} did not pass`];
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'postdeploy-verify',
    decided_at: opts.now ?? new Date().toISOString(),
    artifact_ref: opts.artifactRef,
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict,
    ...(reasons !== undefined && { reasons }),
    inputs: {
      ...(opts.artifactChainHead !== undefined && { artifact_chain_head: opts.artifactChainHead }),
    },
    checks,
    rollback_recommended: !probeOk,
  };
  persist(opts.repoRoot, record);
  return record;
}

export interface RuntimeDriftOptions {
  readonly repoRoot: string;
  readonly observations: readonly ReleaseDriftObservation[];
  readonly artifactRef?: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly now?: string;
}

export function runRuntimeDrift(opts: RuntimeDriftOptions): ReleaseRecord {
  const verdict: ReleaseVerdict = opts.observations.length === 0 ? 'pass' : 'review';
  const reasons =
    opts.observations.length > 0
      ? [`${String(opts.observations.length)} runtime drift observation(s)`]
      : undefined;
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'runtime-drift',
    decided_at: opts.now ?? new Date().toISOString(),
    ...(opts.artifactRef !== undefined && { artifact_ref: opts.artifactRef }),
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict,
    ...(reasons !== undefined && { reasons }),
    inputs: {},
    drift_observations: opts.observations,
    rollback_recommended: opts.observations.length > 0,
  };
  persist(opts.repoRoot, record);
  return record;
}

/**
 * Probe outcome shape needed for the runtime-drift detector path.
 * Each failed/errored probe in the charter becomes a drift
 * observation (surface = probe name; delta = joined failed
 * expectations).
 */
export interface DriftProbeOutcome {
  readonly pid: string;
  readonly name: string;
  readonly verdict: 'pass' | 'fail' | 'review' | 'error' | 'skipped';
  readonly failed_expectations: readonly string[];
}

export interface RuntimeDriftFromCharterOptions {
  readonly repoRoot: string;
  readonly outcomes: readonly DriftProbeOutcome[];
  readonly charterPath: string;
  readonly artifactRef?: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly now?: string;
}

/**
 * Runtime-drift detector form. The CLI executes a runtime-drift
 * charter via `executeRuntimeProbe`; each non-pass probe is
 * translated into a `ReleaseDriftObservation` and persisted alongside
 * the gate verdict. The verdict is `review` when any observation
 * lands and `pass` otherwise (matching the record-form semantics).
 *
 * Charter authoring convention: each probe's `name` becomes the
 * observation's `surface`; each probe's `failed_expectations`
 * joined with `; ` becomes the `delta`. Operators can therefore
 * write charters that describe *expected* runtime configuration;
 * the verb records *unexpected* divergence.
 */
export function runRuntimeDriftFromCharter(opts: RuntimeDriftFromCharterOptions): ReleaseRecord {
  const observations: ReleaseDriftObservation[] = opts.outcomes
    .filter((o) => o.verdict !== 'pass' && o.verdict !== 'skipped')
    .map((o) => ({
      surface: o.name,
      delta:
        o.failed_expectations.length > 0
          ? o.failed_expectations.join('; ')
          : `probe verdict=${o.verdict}`,
    }));
  const verdict: ReleaseVerdict = observations.length === 0 ? 'pass' : 'review';
  const reasons =
    observations.length > 0
      ? [
          `${String(observations.length)} runtime drift observation(s) from charter ${opts.charterPath}`,
        ]
      : undefined;
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'runtime-drift',
    decided_at: opts.now ?? new Date().toISOString(),
    ...(opts.artifactRef !== undefined && { artifact_ref: opts.artifactRef }),
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict,
    ...(reasons !== undefined && { reasons }),
    inputs: {},
    drift_observations: observations,
    rollback_recommended: observations.length > 0,
  };
  persist(opts.repoRoot, record);
  return record;
}
