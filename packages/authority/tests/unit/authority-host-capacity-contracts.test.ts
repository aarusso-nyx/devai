import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runWithAuthorityHostEffects,
  withProtectedReleaseExportCapacity,
  withProtectedReleasePrepareCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacity,
  type ProtectedReleaseExportCapacityBinding,
  type ProtectedReleasePrepareCapacity,
  type ProtectedReleasePrepareCapacityBinding,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

// Protected capacity sequence contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

const lanes = [
  {
    action: 'release prepare',
    other: 'release export',
    max: 256,
    code: 'release-prepare-capacity-unavailable',
    with: (binding: unknown, callback: unknown) =>
      withProtectedReleasePrepareCapacity(
        binding as ProtectedReleasePrepareCapacityBinding,
        callback as () => Promise<unknown>,
      ),
  },
  {
    action: 'release export',
    other: 'release prepare',
    max: 128,
    code: 'release-export-capacity-unavailable',
    with: (binding: unknown, callback: unknown) =>
      withProtectedReleaseExportCapacity(
        binding as ProtectedReleaseExportCapacityBinding,
        callback as () => Promise<unknown>,
      ),
  },
] as const;

function locator(action: string, objects = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }) {
  return {
    action_id: action,
    repository: { id: 'owner/repository', ...objects },
    candidate: { ...objects },
    plan_receipt_digest_sha256: 'c'.repeat(64),
  };
}

async function harness(
  lane: (typeof lanes)[number],
  effect: 'read' | 'local-write' = 'local-write',
) {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: 'capacity-contracts',
    invocation_id: 'capacity-invocation',
  });
  disposers.push(() => {
    issuer.dispose();
  });
  const reads = vi.fn((_binding: unknown) => ({
    remaining_batches: lane.max,
    remaining_targets: 8192,
  }));
  const scope: AuthorityHostEffectScope = {
    action_id: lane.action,
    invocation_id: 'capacity-invocation',
    effect,
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_prepare_capacity: (binding) => reads(binding) as ProtectedReleasePrepareCapacity,
    read_export_capacity: (binding) => reads(binding) as ProtectedReleaseExportCapacity,
  };
  return {
    issuer,
    reads,
    run: <T>(callback: () => T) => runWithAuthorityHostEffects(scope, callback),
  };
}

for (const lane of lanes)
  describe(`${lane.action} capacity sequence`, () => {
    // Mutants 427, 608: the locator's own action must be this lane's action even when the
    // surrounding scope already is.
    it('refuses a locator bound to the other release phase', async () => {
      const h = await harness(lane);
      const callback = vi.fn(async () => undefined);
      await expect(h.run(() => lane.with(locator(lane.other), callback))).rejects.toThrow(
        lane.code,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(h.reads).not.toHaveBeenCalled();
    });

    // Mutants 451, 452: object names are anchored on both sides; equal-width garbage on
    // every object does not slip past the width comparison.
    it.each([
      ['a leading character', { commit: 'x' + 'a'.repeat(40), tree: 'x' + 'b'.repeat(40) }],
      ['a trailing character', { commit: 'a'.repeat(40) + 'x', tree: 'b'.repeat(40) + 'x' }],
    ])('refuses object names carrying %s', async (_name, objects) => {
      const h = await harness(lane);
      await expect(
        h.run(() => lane.with(locator(lane.action, objects), async () => undefined)),
      ).rejects.toThrow(lane.code);
      expect(h.reads).not.toHaveBeenCalled();
    });

    // Mutants 565, 710: a read-only scope never opens a capacity sequence.
    it('refuses to open a sequence under a read scope', async () => {
      const h = await harness(lane, 'read');
      const callback = vi.fn(async () => undefined);
      await expect(h.run(() => lane.with(locator(lane.action), callback))).rejects.toThrow(
        lane.code,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(h.reads).not.toHaveBeenCalled();
    });

    // Mutants 568, 713: the sequence body must be callable before the account is read.
    it.each([[undefined], [null], ['callback'], [{}]])(
      'refuses the non-callable sequence body %j before reading the account',
      async (callback) => {
        const h = await harness(lane);
        await expect(h.run(() => lane.with(locator(lane.action), callback))).rejects.toThrow(
          lane.code,
        );
        expect(h.reads).not.toHaveBeenCalled();
      },
    );

    // Mutants 574, 719: an issuer disposed inside the scope closes the account.
    it('refuses to open a sequence once the issuer is disposed', async () => {
      const h = await harness(lane);
      const callback = vi.fn(async () => undefined);
      await expect(
        h.run(() => {
          h.issuer.dispose();
          return lane.with(locator(lane.action), callback);
        }),
      ).rejects.toThrow(lane.code);
      expect(callback).not.toHaveBeenCalled();
      expect(h.reads).not.toHaveBeenCalled();
    });
  });

// Mutants 615-619: export operates on the prepared candidate only, so its candidate must be
// the repository identity; prepare admits a distinct candidate.
describe('candidate identity across lanes', () => {
  const distinct = () => ({
    ...locator('release export'),
    candidate: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
  });

  it.each(['commit', 'tree'] as const)(
    'refuses an export locator whose candidate %s differs from the repository',
    async (key) => {
      const lane = lanes[1];
      const h = await harness(lane);
      const binding = { ...locator(lane.action), candidate: { ...locator(lane.action).candidate } };
      binding.candidate[key] = 'd'.repeat(40);
      await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
        lane.code,
      );
      expect(h.reads).not.toHaveBeenCalled();
    },
  );

  it('admits a prepare locator whose candidate differs from the repository', async () => {
    const lane = lanes[0];
    const h = await harness(lane);
    const binding = { ...distinct(), action_id: lane.action };
    await expect(h.run(() => lane.with(binding, async () => 'prepared'))).resolves.toBe('prepared');
    expect(h.reads).toHaveBeenCalledOnce();
    expect(h.reads.mock.calls[0]?.[0]).toMatchObject({ candidate: binding.candidate });
  });
});
