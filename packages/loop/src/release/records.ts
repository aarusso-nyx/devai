import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { nextCounterId } from '@devai-nyx/utils';

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

export function stateDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR_REL);
}

export function nextReleaseId(repoRoot: string): string {
  return nextCounterId({
    repoRoot,
    key: 'REL',
    prefix: 'REL',
    effects: { mkdirSync, writeFileSync },
  });
}

export function persist(repoRoot: string, record: ReleaseRecord): void {
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

export function aggregateVerdict(checks: readonly ReleaseCheck[]): ReleaseVerdict {
  if (checks.some((c) => c.verdict === 'block')) return 'block';
  if (checks.some((c) => c.verdict === 'review')) return 'review';
  if (checks.length === 0 || checks.every((c) => c.verdict === 'skipped')) return 'inconclusive';
  if (checks.some((c) => c.verdict === 'inconclusive')) return 'inconclusive';
  return 'pass';
}
