import { describe, expect, it } from 'vitest';
import {
  createReleasePolicyClosure,
  verifyReleasePolicyClosure,
} from '../../src/services/release-policy-closure.js';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';

function verify(
  fixture: ReturnType<typeof createLifecyclePolicyFixture>,
  closure = createReleasePolicyClosure({ plan: fixture.receipt, resolution: fixture.resolution }),
) {
  return verifyReleasePolicyClosure({
    closure,
    expected: fixture.expected,
    implementation: fixture.package_snapshot,
    limits: {
      maximum_archive_bytes: 4 * 1024 * 1024,
      maximum_unpacked_bytes: 4 * 1024 * 1024,
      maximum_git_bytes: 4 * 1024 * 1024,
      maximum_git_entries: 2000,
    },
  });
}

describe('release policy closure', () => {
  it('reconstructs the exact current v2 plan from the immutable closure', () => {
    const fixture = createLifecyclePolicyFixture();
    expect(verify(fixture).repository).toEqual(fixture.candidate.repository);
  });

  it('refuses absent, plan-tampered, and implementation-identity-mismatched closure evidence', () => {
    const fixture = createLifecyclePolicyFixture();
    const closure = createReleasePolicyClosure({
      plan: fixture.receipt,
      resolution: fixture.resolution,
    });
    expect(() =>
      verify(fixture, {
        ...closure,
        plan: { ...closure.plan, receipt_digest_sha256: '0'.repeat(64) },
      }),
    ).toThrow(/^rpl-policy-resolution-mismatch$/u);
    expect(() =>
      verifyReleasePolicyClosure({
        closure,
        expected: {
          ...fixture.expected,
          installed_package: {
            ...fixture.expected.installed_package,
            archive_sha256: '0'.repeat(64),
          },
        },
        implementation: fixture.package_snapshot,
        limits: {
          maximum_archive_bytes: 4 * 1024 * 1024,
          maximum_unpacked_bytes: 4 * 1024 * 1024,
          maximum_git_bytes: 4 * 1024 * 1024,
          maximum_git_entries: 2000,
        },
      }),
    ).toThrow(/^rpl-policy-resolution-mismatch$/u);
  });
});
