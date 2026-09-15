import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveReleaseMutationRequirements,
  type ReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';
import { verifyResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  createLifecyclePolicyFixture,
  type LifecyclePolicyFixture,
} from '../helpers/release-policy-resolution-fixture.js';

function fixture() {
  return createLifecyclePolicyFixture();
}

function request(value: LifecyclePolicyFixture, receipt = value.receipt): ReleaseLifecycleRequest {
  const candidate = value.candidate.repository;
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release prepare',
    repository_locator: candidate,
    candidate_locator: {
      commit: candidate.commit,
      tree: candidate.tree,
      release_units: [
        {
          release_unit: value.resolution.release_unit,
          version: '1.5.0',
          package_roster: [
            {
              package_id: value.resolution.release_unit,
              manifest_path: 'package.json',
              manifest_digest_sha256: createHash('sha256').update(value.package_json).digest('hex'),
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt',
        receipt_id: String(receipt.receipt_id),
        receipt_digest_sha256: String(receipt.receipt_digest_sha256),
        path: 'receipts/plan.json',
      },
    ],
  };
}

function resolvers(value: LifecyclePolicyFixture) {
  return { resolve_receipt: () => value.receipt, resolve_plan_input: value.resolve_plan_input };
}

describe('verified release mutation requirement derivation (ADR-MUT-0008)', () => {
  it('returns null only for a genuinely verified not-required plan', () => {
    const value = createLifecyclePolicyFixture();
    expect(
      verifyResolvedReleasePlanReceipt({ receipt: value.receipt, resolution: value.resolution }),
    ).toBe(true);
    expect(value.receipt.determination).toMatchObject({
      mutation: 'none',
      mutation_disposition: {
        status: 'not-required',
        reason: 'mutation-external-hardening',
      },
    });
    expect(resolveReleaseMutationRequirements(request(value), resolvers(value))).toEqual([
      { release_unit: value.resolution.release_unit, binding: null },
    ]);
  });

  it.each(['both', 'receipt', 'plan'] as const)(
    'refuses missing %s resolvers instead of inferring none',
    (missing) => {
      const value = createLifecyclePolicyFixture();
      const controls =
        missing === 'both'
          ? {}
          : missing === 'receipt'
            ? { resolve_plan_input: value.resolve_plan_input }
            : { resolve_receipt: () => value.receipt };
      expect(() => resolveReleaseMutationRequirements(request(value), controls)).toThrow(
        missing === 'plan'
          ? 'rpl-semantic-verification-not-performed'
          : 'release-receipt-provider-unavailable',
      );
    },
  );

  it.each(['required', 'none'] as const)(
    'refuses an unbranded forwarding resolver for %s',
    (kind) => {
      const value = kind === 'required' ? fixture() : createLifecyclePolicyFixture();
      const forwarded = vi.fn(value.resolve_plan_input);
      expect(() =>
        resolveReleaseMutationRequirements(request(value), {
          resolve_receipt: () => value.receipt,
          resolve_plan_input: forwarded,
        }),
      ).toThrow('rpl-semantic-verification-not-performed');
      expect(forwarded).not.toHaveBeenCalled();
    },
  );

  it('refuses a genuine but stale resolution from a different profile and candidate', () => {
    const value = fixture();
    const stale = createLifecyclePolicyFixture(
      [],
      {},
      { files: new Map([['extra.txt', Buffer.from('different source')]]) },
    );
    expect(stale.candidate.repository.commit).not.toBe(value.candidate.repository.commit);
    expect(() =>
      resolveReleaseMutationRequirements(request(value), {
        resolve_receipt: () => value.receipt,
        resolve_plan_input: stale.resolve_plan_input,
      }),
    ).toThrow('rpl-semantic-verification-not-performed');
  });

  it('refuses a resealed none determination copied over the genuine required receipt', () => {
    const value = fixture();
    const none = createLifecyclePolicyFixture();
    const { receipt_id: _id, receipt_digest_sha256: _digest, ...projection } = value.receipt;
    const altered = {
      ...projection,
      determination: { ...(none.receipt.determination as object), mutation: 'targeted' },
    };
    const digest = canonicalSha256(altered);
    const forged = {
      ...altered,
      receipt_id: `RPL-${digest.slice(0, 16)}`,
      receipt_digest_sha256: digest,
    };
    expect(() =>
      resolveReleaseMutationRequirements(request(value, forged), {
        resolve_receipt: () => forged,
        resolve_plan_input: value.resolve_plan_input,
      }),
    ).toThrow('rpl-semantic-verification-not-performed');
  });

  it('captures the request before a receipt resolver mutates the caller-owned candidate and unit', () => {
    const value = fixture();
    const selected = structuredClone(request(value));
    const original = structuredClone(selected);
    const resolve_receipt = vi.fn(() => {
      Object.assign(selected.repository_locator, {
        id: 'foreign/repository',
        commit: '0'.repeat(40),
      });
      Object.assign(selected.candidate_locator, { commit: '0'.repeat(40) });
      Object.assign(selected.candidate_locator.release_units[0] ?? {}, {
        release_unit: '@fixture/foreign',
      });
      return value.receipt;
    });
    const result = resolveReleaseMutationRequirements(selected, {
      resolve_receipt,
      resolve_plan_input: value.resolve_plan_input,
    });
    expect(resolve_receipt).toHaveBeenCalledOnce();
    expect(resolve_receipt).toHaveBeenCalledWith(original.receipt_locators?.[0]);
    expect(result[0]).toMatchObject({
      release_unit: value.resolution.release_unit,
      binding: null,
    });
    expect(selected).not.toEqual(original);
  });

  it.each(['candidate', 'unit', 'locator', 'missing-receipt', 'duplicate-receipt'] as const)(
    'refuses a %s request mismatch against the verified receipt',
    (change) => {
      const value = fixture();
      const selected = structuredClone(request(value));
      if (change === 'candidate') {
        Object.assign(selected.candidate_locator, { commit: '0'.repeat(40) });
        Object.assign(selected.repository_locator, { commit: '0'.repeat(40) });
      } else if (change === 'unit')
        Object.assign(selected.candidate_locator.release_units[0] ?? {}, {
          release_unit: '@fixture/foreign',
        });
      else if (change === 'locator')
        Object.assign(selected.receipt_locators?.[0] ?? {}, {
          receipt_digest_sha256: '0'.repeat(64),
        });
      else
        Object.assign(selected, {
          receipt_locators:
            change === 'missing-receipt'
              ? []
              : [...(selected.receipt_locators ?? []), ...(selected.receipt_locators ?? [])],
        });
      expect(() => resolveReleaseMutationRequirements(selected, resolvers(value))).toThrow(
        change === 'missing-receipt' || change === 'duplicate-receipt'
          ? 'release-request-projection-invalid'
          : 'release-receipt-identity-mismatch',
      );
    },
  );
});
