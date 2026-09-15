import { describe, expect, it } from 'vitest';
import {
  createReleasePolicyClosure,
  verifyReleasePolicyClosure,
} from '../../src/services/release-policy-closure.js';
import {
  createLifecyclePolicyFixture,
  type LifecyclePolicyFixture,
} from '../helpers/release-policy-resolution-fixture.js';

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
    ).toThrow(/^rpl-package-identity-mismatch$/u);
  });

  it('preserves the closed package-identity refusal for corrupt archives', () => {
    const fixture = createLifecyclePolicyFixture();
    const closure = createReleasePolicyClosure({
      plan: fixture.receipt,
      resolution: fixture.resolution,
    });
    expect(() =>
      verify(fixture, {
        ...closure,
        evidence: {
          ...closure.evidence,
          archive: Buffer.from(`${closure.evidence.archive}corrupt`),
        },
      }),
    ).toThrow(/^rpl-package-identity-mismatch$/u);
  });

  it('rejects malformed closures and altered raw Git evidence under the closed policy code', () => {
    const fixture = createLifecyclePolicyFixture();
    const closure = createReleasePolicyClosure({
      plan: fixture.receipt,
      resolution: fixture.resolution,
    });
    expect(() => verify(fixture, { ...closure, format: 'other' } as never)).toThrow(
      /^rpl-policy-resolution-mismatch$/u,
    );
    const objects = new Map(closure.evidence.candidate_objects);
    const bindingBytes = fixture.candidate.read('.devai/config/adopter-policy-binding.json');
    const binding = [...objects].find(
      ([, object]) => object.type === 'blob' && Buffer.from(object.bytes).equals(bindingBytes),
    );
    expect(binding).toBeDefined();
    if (binding === undefined) throw new Error('fixture binding object');
    objects.set(binding[0], { ...binding[1], bytes: Buffer.from(`${binding[1].bytes}\n`) });
    expect(() =>
      verify(fixture, {
        ...closure,
        evidence: { ...closure.evidence, candidate_objects: objects },
      }),
    ).toThrow(/^rpl-policy-resolution-mismatch$/u);
  });

  it('requires the external-producer closure branch and never accepts a structurally copied fixture', () => {
    const fixture: LifecyclePolicyFixture = createLifecyclePolicyFixture();
    const closure = createReleasePolicyClosure({
      plan: fixture.receipt,
      resolution: fixture.resolution,
    });
    expect(() =>
      verify(fixture, {
        ...closure,
        evidence: {
          archive: closure.evidence.archive,
          candidate_objects: closure.evidence.candidate_objects,
        },
      }),
    ).toThrow(/^rpl-policy-resolution-mismatch$/u);
  });
});
