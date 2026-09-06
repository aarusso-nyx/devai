import { describe, expect, it } from 'vitest';
import {
  readProtectedReleasePrepareCapacity,
  runWithAuthorityHostEffects,
  withProtectedReleasePrepareCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleasePrepareCapacityBinding,
} from '../../src/boundaries/host-effects.js';
import {
  createIssuer,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-002, INV-REL-001

const PREPARE_BINDING: ProtectedReleasePrepareCapacityBinding = Object.freeze({
  action_id: 'release prepare',
  repository: Object.freeze({
    id: 'devai-capacity-test',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  }),
  candidate: Object.freeze({ commit: 'c'.repeat(40), tree: 'd'.repeat(40) }),
  plan_receipt_digest_sha256: 'e'.repeat(64),
});

function binding(
  overrides: Partial<ProtectedReleasePrepareCapacityBinding> = {},
): ProtectedReleasePrepareCapacityBinding {
  return {
    ...PREPARE_BINDING,
    ...overrides,
    repository: overrides.repository ?? PREPARE_BINDING.repository,
    candidate: overrides.candidate ?? PREPARE_BINDING.candidate,
  };
}

async function capacityHarness(
  initial: Readonly<{ batches: number; targets: number }> = { batches: 256, targets: 8192 },
): Promise<{
  readonly issuer: AuthorityDecisionIssuer;
  readonly observed: ProtectedReleasePrepareCapacityBinding[];
  readonly readerCalls: () => number;
  readonly consume: (batches: number, targets: number) => void;
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>;
}> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: 'release-prepare-capacity-test-issuer',
    invocation_id: 'release-prepare-capacity-test-invocation',
  });
  let remainingBatches = initial.batches;
  let remainingTargets = initial.targets;
  let calls = 0;
  const observed: ProtectedReleasePrepareCapacityBinding[] = [];
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'release-prepare-capacity-test-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_prepare_capacity: (selected) => {
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
        throw new Error('test capacity consumption invalid');
      }
      remainingBatches -= batches;
      remainingTargets -= targets;
    },
    run: async (callback) => await runWithAuthorityHostEffects(scope, callback),
  };
}

describe('release prepare protected capacity boundary', () => {
  it('reads the exact live account again after actual same-account counter consumption', async () => {
    const capacity = await capacityHarness();

    await capacity.run(
      async () =>
        await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => {
          expect(readProtectedReleasePrepareCapacity(PREPARE_BINDING)).toEqual({
            remaining_batches: 256,
            remaining_targets: 8192,
          });
          capacity.consume(109, 8045);
          expect(readProtectedReleasePrepareCapacity(PREPARE_BINDING)).toEqual({
            remaining_batches: 147,
            remaining_targets: 147,
          });
        }),
    );

    expect(capacity.readerCalls()).toBe(3);
    expect(capacity.observed).toEqual([PREPARE_BINDING, PREPARE_BINDING, PREPARE_BINDING]);
  });

  it('refuses missing readers and a candidate or plan binding outside the live invocation', async () => {
    const issuer = createIssuer(await runtimeApi(), {
      issuer_id: 'release-prepare-capacity-missing-reader',
      invocation_id: 'release-prepare-capacity-missing-reader-invocation',
    });
    const missingReaderScope: AuthorityHostEffectScope = {
      action_id: 'release prepare',
      invocation_id: 'release-prepare-capacity-missing-reader-invocation',
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (_request, apply) => apply(),
    };
    await expect(
      runWithAuthorityHostEffects(missingReaderScope, () =>
        withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => undefined),
      ),
    ).rejects.toThrow('release-prepare-capacity-unavailable');

    const capacity = await capacityHarness();
    await capacity.run(
      async () =>
        await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => {
          expect(() =>
            readProtectedReleasePrepareCapacity(
              binding({ candidate: { commit: 'f'.repeat(40), tree: '0'.repeat(40) } }),
            ),
          ).toThrow('release-prepare-capacity-unavailable');
          expect(() =>
            readProtectedReleasePrepareCapacity(
              binding({ plan_receipt_digest_sha256: '1'.repeat(64) }),
            ),
          ).toThrow('release-prepare-capacity-unavailable');
        }),
    );
    expect(capacity.readerCalls()).toBe(1);
  });

  it('refuses malformed or stale account observations rather than accepting a caller budget', async () => {
    const malformed = await capacityHarness({ batches: 257, targets: 8192 });
    await expect(
      malformed.run(
        async () =>
          await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => undefined),
      ),
    ).rejects.toThrow('release-prepare-capacity-unavailable');

    const stale = await capacityHarness();
    await stale.run(
      async () =>
        await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => {
          stale.issuer.dispose();
          expect(() => readProtectedReleasePrepareCapacity(PREPARE_BINDING)).toThrow(
            'release-prepare-capacity-unavailable',
          );
        }),
    );
  });

  it('denies a competing or nested sequence for the same protected account', async () => {
    const capacity = await capacityHarness();
    await capacity.run(
      async () =>
        await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => {
          await expect(
            withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => undefined),
          ).rejects.toThrow('release-prepare-capacity-unavailable');
          expect(readProtectedReleasePrepareCapacity(PREPARE_BINDING)).toEqual({
            remaining_batches: 256,
            remaining_targets: 8192,
          });
        }),
    );
  });

  it('keeps the complete protected cleanup scope live across await, then denies escaped descendants', async () => {
    const capacity = await capacityHarness();
    let delayed: (() => unknown) | undefined;

    await capacity.run(
      async () =>
        await withProtectedReleasePrepareCapacity(PREPARE_BINDING, async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(readProtectedReleasePrepareCapacity(PREPARE_BINDING)).toEqual({
            remaining_batches: 256,
            remaining_targets: 8192,
          });
          delayed = () => readProtectedReleasePrepareCapacity(PREPARE_BINDING);
        }),
    );

    expect(delayed).toBeTypeOf('function');
    if (delayed === undefined) throw new Error('expected an escaped capacity descendant');
    expect(delayed).toThrow('release-prepare-capacity-unavailable');
  });
});
