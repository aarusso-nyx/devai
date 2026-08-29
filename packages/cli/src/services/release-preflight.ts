import { getValidator } from '@devai-nyx/schemas';
import { sha256Hex } from './check-runner/canonical.js';

export const PREFLIGHT_CAPABILITIES = [
  'formatting-hygiene',
  'lint',
  'type-integrity',
  'schema-consistency',
  'secret-scan',
  'path-portability',
  'package-integrity',
  'exact-candidate',
] as const;

export type ReleaseFailureClass =
  | 'static-defect'
  | 'sensor-stale'
  | 'environment-drift'
  | 'product-regression'
  | 'policy-invalid'
  | 'evidence-mismatch'
  | 'unknown';

export interface ReleasePreflightReceipt {
  readonly schemaVersion: '1.0.0';
  readonly repository: Readonly<{ id: string; commit: string; tree: string }>;
  readonly base: Readonly<{ commit: string; tree: string }>;
  readonly releaseIntentDigest: string;
  readonly releaseProfileDigest: string;
  readonly taskPolicyDigest: string;
  readonly toolchainDigest: string;
  readonly checks: readonly Readonly<{
    capability: string;
    status: 'executed' | 'reused' | 'not-required' | 'failed' | 'blocked' | 'unknown';
    reasonCode: string;
    failureClass?: ReleaseFailureClass;
    resultDigest?: string;
  }>[];
  readonly verdict: 'pass' | 'block';
  readonly blockingReasons: readonly string[];
  readonly createdAt: string;
}

export interface ReleasePreflightExpected {
  readonly repository: ReleasePreflightReceipt['repository'];
  readonly base: ReleasePreflightReceipt['base'];
  readonly releaseIntentDigest: string;
  readonly releaseProfileDigest: string;
  readonly taskPolicyDigest: string;
  readonly toolchainDigest: string;
}

export function verifyReleasePreflightReceipt(
  receipt: unknown,
  expected: ReleasePreflightExpected,
): Readonly<{ digest: string; receipt: ReleasePreflightReceipt }> {
  const validate = getValidator('release-preflight-receipt.schema.json');
  if (!validate(receipt)) {
    throw new Error(`CHECK_RELEASE_PREFLIGHT_INVALID:${JSON.stringify(validate.errors)}`);
  }
  const value = receipt as ReleasePreflightReceipt;
  for (const key of [
    'releaseIntentDigest',
    'releaseProfileDigest',
    'taskPolicyDigest',
    'toolchainDigest',
  ] as const) {
    if (value[key] !== expected[key])
      throw new Error(`CHECK_RELEASE_PREFLIGHT_${key.toUpperCase()}_MISMATCH`);
  }
  if (
    value.repository.id !== expected.repository.id ||
    value.repository.commit !== expected.repository.commit ||
    value.repository.tree !== expected.repository.tree
  ) {
    throw new Error('CHECK_RELEASE_PREFLIGHT_CANDIDATE_MISMATCH');
  }
  if (value.base.commit !== expected.base.commit || value.base.tree !== expected.base.tree) {
    throw new Error('CHECK_RELEASE_PREFLIGHT_BASE_MISMATCH');
  }
  if (value.verdict !== 'pass' || value.blockingReasons.length > 0) {
    throw new Error('CHECK_RELEASE_PREFLIGHT_BLOCKED');
  }
  const byCapability = new Map(value.checks.map((check) => [check.capability, check]));
  for (const capability of PREFLIGHT_CAPABILITIES) {
    const check = byCapability.get(capability);
    if (check === undefined || !['executed', 'reused'].includes(check.status)) {
      throw new Error(`CHECK_RELEASE_PREFLIGHT_CAPABILITY_MISSING:${capability}`);
    }
  }
  return { digest: sha256Hex(value), receipt: value };
}
