import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { canonicalSha256, nextCounterId } from '@devai-nyx/utils';

function countJsonFilesRecursively(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += countJsonFilesRecursively(path);
    else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
  }
  return count;
}

/**
 * Release-gate control plane (Phase 11.B, D-39).
 *
 * Three verbs:
 *   - `release gate`              — gate the deploy on RTD readiness,
 *                                   sensor evidence, and invariant state.
 *   - `release postdeploy-verify` — compare runtime audit-chain head
 *                                   against artifact-of-record head.
 *   - `release runtime-drift`     — list observed-vs-claimed drift
 *                                   between deployed runtime and the
 *                                   artifact's manifest.
 *
 * Each verb persists a release-control.schema.json record under
 * .devai/state/releases/REL-NNNN.json with the inputs that drove
 * the decision so the audit trail can be replayed.
 */

export type ReleaseVerdict = 'pass' | 'block' | 'review' | 'inconclusive';
export type ReleaseKind = 'gate' | 'postdeploy-verify' | 'runtime-drift';

export interface ReleaseInputs {
  readonly scorecard_ref?: string;
  readonly sensor_readings_dir?: string;
  readonly invariants_dir?: string;
  readonly audit_chain_head?: string;
  readonly artifact_chain_head?: string;
}

export interface ReleaseCheck {
  readonly name: string;
  readonly verdict: 'pass' | 'block' | 'review' | 'inconclusive' | 'skipped';
  readonly detail?: string;
}

export interface ReleaseDriftObservation {
  readonly surface: string;
  readonly delta: string;
}

export interface ReleaseRecord {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly kind: ReleaseKind;
  readonly decided_at: string;
  readonly artifact_ref?: string;
  readonly environment?: 'dev' | 'staging' | 'stage' | 'prod' | 'preview' | 'other';
  readonly verdict: ReleaseVerdict;
  readonly reasons?: readonly string[];
  readonly inputs: ReleaseInputs;
  readonly checks?: readonly ReleaseCheck[];
  readonly rollback_recommended?: boolean;
  readonly drift_observations?: readonly ReleaseDriftObservation[];
}

const STATE_DIR_REL = '.devai/state/releases';

function stateDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR_REL);
}

function nextReleaseId(repoRoot: string): string {
  return nextCounterId({
    repoRoot,
    key: 'REL',
    prefix: 'REL',
    effects: { mkdirSync, writeFileSync },
  });
}

function persist(repoRoot: string, record: ReleaseRecord): void {
  const ok = validators.releaseControl(record);
  if (!ok) {
    throw new Error(
      `release: produced record failed release-control.schema.json validation: ${JSON.stringify(validators.releaseControl.errors)}`,
    );
  }
  const dir = stateDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
}

function aggregateVerdict(checks: readonly ReleaseCheck[]): ReleaseVerdict {
  if (checks.some((c) => c.verdict === 'block')) return 'block';
  if (checks.some((c) => c.verdict === 'review')) return 'review';
  if (checks.length === 0 || checks.every((c) => c.verdict === 'skipped')) return 'inconclusive';
  if (checks.some((c) => c.verdict === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

export interface GateOptions {
  readonly repoRoot: string;
  readonly scorecardRef?: string;
  readonly sensorReadingsDir?: string;
  readonly invariantsDir?: string;
  readonly artifactRef?: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly auditChainHead?: string;
  readonly now?: string;
}

/**
 * Read the scorecard (if provided) and assemble a gate-decision.
 * The check set is intentionally simple at MVP: scorecard verdict,
 * invariant catalog presence, sensor-reading freshness. Each check
 * produces a check entry; verdict aggregates per aggregateVerdict.
 */
export function runReleaseGate(opts: GateOptions): ReleaseRecord {
  const checks: ReleaseCheck[] = [];
  const reasons: string[] = [];

  // Check 1: scorecard verdict (if a scorecard file is supplied).
  if (opts.scorecardRef !== undefined) {
    if (!existsSync(opts.scorecardRef)) {
      checks.push({
        name: 'scorecard.readable',
        verdict: 'inconclusive',
        detail: `scorecard not found at ${opts.scorecardRef}`,
      });
      reasons.push('scorecard not found');
    } else {
      try {
        const sc = JSON.parse(readFileSync(opts.scorecardRef, 'utf8')) as {
          gate_decision?: string;
          overall_state?: string;
        };
        const decision = sc.gate_decision ?? sc.overall_state ?? 'unknown';
        const verdict: ReleaseCheck['verdict'] =
          decision === 'pass' || decision === 'green'
            ? 'pass'
            : decision === 'fail' || decision === 'red'
              ? 'block'
              : decision === 'review' || decision === 'amber' || decision === 'yellow'
                ? 'review'
                : 'inconclusive';
        checks.push({ name: 'scorecard.decision', verdict, detail: `decision=${decision}` });
        if (verdict === 'block') reasons.push(`scorecard decision: ${decision}`);
        if (verdict === 'review') reasons.push(`scorecard requires review: ${decision}`);
      } catch (err) {
        checks.push({
          name: 'scorecard.parse',
          verdict: 'inconclusive',
          detail: err instanceof Error ? err.message : String(err),
        });
        reasons.push('scorecard parse error');
      }
    }
  } else {
    checks.push({
      name: 'scorecard.decision',
      verdict: 'skipped',
      detail: 'no --scorecard provided',
    });
  }

  // Check 2: invariant catalog non-empty (proxy for "RTD is ready").
  if (opts.invariantsDir !== undefined) {
    if (!existsSync(opts.invariantsDir)) {
      checks.push({
        name: 'invariants.present',
        verdict: 'block',
        detail: `invariants dir not found at ${opts.invariantsDir}`,
      });
      reasons.push('invariants directory missing');
    } else {
      const names = readdirSync(opts.invariantsDir).filter((n) => /^INV-.*\.json$/.test(n));
      if (names.length === 0) {
        checks.push({
          name: 'invariants.present',
          verdict: 'block',
          detail: 'no INV-*.json files',
        });
        reasons.push('invariants catalog empty');
      } else {
        checks.push({
          name: 'invariants.present',
          verdict: 'pass',
          detail: `${String(names.length)} INV file(s)`,
        });
      }
    }
  } else {
    checks.push({ name: 'invariants.present', verdict: 'skipped' });
  }

  // Check 3: sensor readings present.
  if (opts.sensorReadingsDir !== undefined) {
    if (!existsSync(opts.sensorReadingsDir)) {
      checks.push({
        name: 'sensors.fresh',
        verdict: 'review',
        detail: 'no sensor-readings dir found',
      });
      reasons.push('no sensor readings');
    } else {
      const readingCount = countJsonFilesRecursively(opts.sensorReadingsDir);
      const verdict: ReleaseCheck['verdict'] = readingCount > 0 ? 'pass' : 'review';
      checks.push({
        name: 'sensors.fresh',
        verdict,
        detail: `${String(readingCount)} reading(s)`,
      });
      if (verdict === 'review') reasons.push('no sensor readings emitted');
    }
  } else {
    checks.push({ name: 'sensors.fresh', verdict: 'skipped' });
  }

  const verdict = aggregateVerdict(checks);
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'gate',
    decided_at: opts.now ?? new Date().toISOString(),
    ...(opts.artifactRef !== undefined && { artifact_ref: opts.artifactRef }),
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict,
    ...(reasons.length > 0 && { reasons }),
    inputs: {
      ...(opts.scorecardRef !== undefined && { scorecard_ref: opts.scorecardRef }),
      ...(opts.sensorReadingsDir !== undefined && { sensor_readings_dir: opts.sensorReadingsDir }),
      ...(opts.invariantsDir !== undefined && { invariants_dir: opts.invariantsDir }),
      ...(opts.auditChainHead !== undefined && { audit_chain_head: opts.auditChainHead }),
    },
    checks,
  };
  persist(opts.repoRoot, record);
  return record;
}

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

export function listReleases(repoRoot: string): readonly ReleaseRecord[] {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => /^REL-\d{4,}\.json$/.test(n))
      .sort();
  } catch {
    return [];
  }
  const out: ReleaseRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as ReleaseRecord);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

/**
 * Compute a deterministic content hash over a release record for
 * external log / audit-trail purposes. SHA-256 over the
 * current canonical-JSON form.
 *
 * **Not persisted on the release-control.schema.json record
 * itself.** Unlike `agent-run` / `rtd-manifest`, release records
 * carry no stored `manifest_hash` field, so there is no
 * callers compute the hash on demand and MUST treat each call as
 * authoritative for the live record at call time.
 */
export function releaseContentHash(record: ReleaseRecord): string {
  return canonicalSha256(record);
}

export function getReleaseDir(repoRoot: string): string {
  return stateDir(repoRoot);
}
