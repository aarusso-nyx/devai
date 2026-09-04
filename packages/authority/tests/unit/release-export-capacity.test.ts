import { describe, expect, it } from 'vitest';
import {
  readProtectedReleaseExportCapacity,
  runWithAuthorityHostEffects,
  withProtectedReleaseExportCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacityBinding,
} from '../../src/boundaries/host-effects.js';
import {
  createIssuer,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

const EXPORT_BINDING: ProtectedReleaseExportCapacityBinding = Object.freeze({
  action_id: 'release export',
  repository: Object.freeze({
    id: 'devai-export-capacity-test',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  }),
  candidate: Object.freeze({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }),
  plan_receipt_digest_sha256: 'c'.repeat(64),
});

function binding(
  overrides: Partial<ProtectedReleaseExportCapacityBinding> = {},
): ProtectedReleaseExportCapacityBinding {
  return {
    ...EXPORT_BINDING,
    ...overrides,
    repository: overrides.repository ?? EXPORT_BINDING.repository,
    candidate: overrides.candidate ?? EXPORT_BINDING.candidate,
  };
}

async function capacityHarness(
  initial: Readonly<{ batches: number; targets: number }> = { batches: 128, targets: 8192 },
): Promise<{
  readonly issuer: AuthorityDecisionIssuer;
  readonly observed: ProtectedReleaseExportCapacityBinding[];
  readonly readerCalls: () => number;
  readonly consume: (batches: number, targets: number) => void;
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>;
}> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: 'release-export-capacity-test-issuer',
    invocation_id: 'release-export-capacity-test-invocation',
  });
  let remainingBatches = initial.batches;
  let remainingTargets = initial.targets;
  let calls = 0;
  const observed: ProtectedReleaseExportCapacityBinding[] = [];
  const scope: AuthorityHostEffectScope = {
    action_id: 'release export',
    invocation_id: 'release-export-capacity-test-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_export_capacity: (selected) => {
      calls += 1;
      observed.push(selected);
      return { remaining_batches: remainingBatches, remaining_targets: remainingTargets };
    },
  };
  return {
    issuer,
    observed,
    readerCalls: () => calls,
    consume: (batches, targets) => {
      if (
        !Number.isSafeInteger(batches) ||
        !Number.isSafeInteger(targets) ||
        batches < 0 ||
        targets < 0 ||
        batches > remainingBatches ||
        targets > remainingTargets
      ) {
        throw new Error('test export capacity consumption invalid');
      }
      remainingBatches -= batches;
      remainingTargets -= targets;
    },
    run: async (callback) => await runWithAuthorityHostEffects(scope, callback),
  };
}

describe('release export protected capacity boundary', () => {
  it('reads the exact active account again after counters change', async () => {
    const capacity = await capacityHarness();

    await capacity.run(
      async () =>
        await withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => {
          expect(readProtectedReleaseExportCapacity(EXPORT_BINDING)).toEqual({
            remaining_batches: 128,
            remaining_targets: 8192,
          });
          capacity.consume(17, 8082);
          expect(readProtectedReleaseExportCapacity(EXPORT_BINDING)).toEqual({
            remaining_batches: 111,
            remaining_targets: 110,
          });
        }),
    );

    expect(capacity.readerCalls()).toBe(3);
    expect(capacity.observed).toEqual([EXPORT_BINDING, EXPORT_BINDING, EXPORT_BINDING]);
    capacity.issuer.dispose();
  });

  it('refuses an absent reader, action mismatch, and binding drift before exposing capacity', async () => {
    const issuer = createIssuer(await runtimeApi(), {
      issuer_id: 'release-export-capacity-missing-reader',
      invocation_id: 'release-export-capacity-missing-reader-invocation',
    });
    const missingReader: AuthorityHostEffectScope = {
      action_id: 'release export',
      invocation_id: 'release-export-capacity-missing-reader-invocation',
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (_request, apply) => apply(),
    };
    await expect(
      runWithAuthorityHostEffects(missingReader, () =>
        withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => undefined),
      ),
    ).rejects.toThrow('release-export-capacity-unavailable');
    issuer.dispose();

    const wrongActionIssuer = createIssuer(await runtimeApi(), {
      issuer_id: 'release-export-capacity-wrong-action',
      invocation_id: 'release-export-capacity-wrong-action-invocation',
    });
    const wrongAction: AuthorityHostEffectScope = {
      action_id: 'release certify',
      invocation_id: 'release-export-capacity-wrong-action-invocation',
      effect: 'local-write',
      receipt_store: wrongActionIssuer,
      apply_effect: (_request, apply) => apply(),
      read_export_capacity: () => ({ remaining_batches: 128, remaining_targets: 8192 }),
    };
    await expect(
      runWithAuthorityHostEffects(wrongAction, () =>
        withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => undefined),
      ),
    ).rejects.toThrow('release-export-capacity-unavailable');
    wrongActionIssuer.dispose();

    const capacity = await capacityHarness();
    await capacity.run(
      async () =>
        await withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => {
          expect(() =>
            readProtectedReleaseExportCapacity(
              binding({ plan_receipt_digest_sha256: 'd'.repeat(64) }),
            ),
          ).toThrow('release-export-capacity-unavailable');
          expect(() =>
            readProtectedReleaseExportCapacity(
              binding({ candidate: { commit: 'e'.repeat(40), tree: 'f'.repeat(40) } }),
            ),
          ).toThrow('release-export-capacity-unavailable');
        }),
    );
    expect(capacity.readerCalls()).toBe(1);
    capacity.issuer.dispose();
  });

  it('denies malformed, nested, closed, and escaped capacity accounts', async () => {
    const malformed = await capacityHarness({ batches: 129, targets: 8192 });
    await expect(
      malformed.run(
        async () => await withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => undefined),
      ),
    ).rejects.toThrow('release-export-capacity-unavailable');
    malformed.issuer.dispose();

    const capacity = await capacityHarness();
    let delayed: (() => unknown) | undefined;
    await capacity.run(
      async () =>
        await withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => {
          await expect(
            withProtectedReleaseExportCapacity(EXPORT_BINDING, async () => undefined),
          ).rejects.toThrow('release-export-capacity-unavailable');
          capacity.issuer.dispose();
          expect(() => readProtectedReleaseExportCapacity(EXPORT_BINDING)).toThrow(
            'release-export-capacity-unavailable',
          );
          delayed = () => readProtectedReleaseExportCapacity(EXPORT_BINDING);
        }),
    );
    if (delayed === undefined) throw new Error('expected an escaped capacity descendant');
    expect(delayed).toThrow('release-export-capacity-unavailable');
  });
});
