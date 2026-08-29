import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_CAPABILITIES,
  verifyReleasePreflightReceipt,
} from '../../src/services/release-preflight.js';

const expected = {
  repository: { id: 'example/repo', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  base: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
  releaseIntentDigest: '1'.repeat(64),
  releaseProfileDigest: '2'.repeat(64),
  taskPolicyDigest: '3'.repeat(64),
  toolchainDigest: '4'.repeat(64),
} as const;

function receipt() {
  return {
    schemaVersion: '1.0.0',
    ...expected,
    checks: PREFLIGHT_CAPABILITIES.map((capability, index) => ({
      capability,
      status: 'executed',
      reasonCode: 'required-floor',
      resultDigest: String(index + 1)
        .repeat(64)
        .slice(0, 64),
    })),
    verdict: 'pass',
    blockingReasons: [],
    createdAt: '2026-08-29T00:00:00.000Z',
  } as const;
}

describe('release preflight receipt', () => {
  it('accepts exact candidate, policy, task, and toolchain bindings', () => {
    expect(verifyReleasePreflightReceipt(receipt(), expected).digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects a wrong candidate and one-byte policy change', () => {
    expect(() =>
      verifyReleasePreflightReceipt(
        {
          ...receipt(),
          repository: { ...expected.repository, tree: 'f'.repeat(40) },
        },
        expected,
      ),
    ).toThrow('CHECK_RELEASE_PREFLIGHT_CANDIDATE_MISMATCH');
    expect(() =>
      verifyReleasePreflightReceipt(
        {
          ...receipt(),
          releaseIntentDigest: `0${'1'.repeat(63)}`,
        },
        expected,
      ),
    ).toThrow('RELEASEINTENTDIGEST_MISMATCH');
  });

  it('rejects not-required in the unconditional floor', () => {
    const value = receipt();
    expect(() =>
      verifyReleasePreflightReceipt(
        {
          ...value,
          checks: value.checks.map((check) =>
            check.capability === 'lint'
              ? { capability: check.capability, status: 'not-required', reasonCode: 'wrong' }
              : check,
          ),
        },
        expected,
      ),
    ).toThrow('CHECK_RELEASE_PREFLIGHT_CAPABILITY_MISSING:lint');
  });

  it('requires a bounded failure classification for unsuccessful checks', () => {
    const value = receipt();
    const failed = {
      ...value,
      verdict: 'block',
      blockingReasons: ['lint-failed'],
      checks: value.checks.map((check) =>
        check.capability === 'lint'
          ? { capability: check.capability, status: 'failed', reasonCode: 'lint-failed' }
          : check,
      ),
    };
    expect(() => verifyReleasePreflightReceipt(failed, expected)).toThrow(
      'CHECK_RELEASE_PREFLIGHT_INVALID',
    );
    expect(() =>
      verifyReleasePreflightReceipt(
        {
          ...failed,
          checks: failed.checks.map((check) =>
            check.capability === 'lint' ? { ...check, failureClass: 'static-defect' } : check,
          ),
        },
        expected,
      ),
    ).toThrow('CHECK_RELEASE_PREFLIGHT_BLOCKED');
  });
});
