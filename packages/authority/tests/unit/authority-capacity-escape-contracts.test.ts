import { AsyncResource } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runWithAuthorityHostEffects,
  spawnSync as guardedSpawnSync,
  withProtectedReleaseExportCapacity,
  withProtectedReleasePrepareCapacity,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacity,
  type ProtectedReleaseExportCapacityBinding,
  type ProtectedReleasePrepareCapacity,
  type ProtectedReleasePrepareCapacityBinding,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

// Capacity sequence escape contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's. A guarded
// host effect is the observer: it runs only when both the sequence context and the scope it
// belongs to are the live ones.

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

const lanes = [
  {
    action: 'release prepare',
    code: 'release-prepare-capacity-unavailable',
    with: (binding: unknown, callback: () => Promise<unknown>) =>
      withProtectedReleasePrepareCapacity(
        binding as ProtectedReleasePrepareCapacityBinding,
        callback,
      ),
  },
  {
    action: 'release export',
    code: 'release-export-capacity-unavailable',
    with: (binding: unknown, callback: () => Promise<unknown>) =>
      withProtectedReleaseExportCapacity(
        binding as ProtectedReleaseExportCapacityBinding,
        callback,
      ),
  },
] as const;

const locator = (action: string) => ({
  action_id: action,
  repository: { id: 'owner/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  plan_receipt_digest_sha256: 'c'.repeat(64),
});

const effect = () => guardedSpawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).status;

async function harness(lane: (typeof lanes)[number]) {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: 'capacity-escape',
    invocation_id: 'capacity-invocation',
  });
  disposers.push(() => {
    issuer.dispose();
  });
  const scope = (): AuthorityHostEffectScope => ({
    action_id: lane.action,
    invocation_id: 'capacity-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_prepare_capacity: () =>
      ({ remaining_batches: 256, remaining_targets: 8192 }) as ProtectedReleasePrepareCapacity,
    read_export_capacity: () =>
      ({ remaining_batches: 128, remaining_targets: 8192 }) as ProtectedReleaseExportCapacity,
  });
  return { scope };
}

for (const lane of lanes)
  describe(`${lane.action} sequence escapes`, () => {
    // Mutants 538, 683: an effect bound to the scope before the sequence opened does not
    // carry the sequence context and is refused while the account is live.
    it('refuses an effect bound outside the sequence context', async () => {
      const h = await harness(lane);
      await runWithAuthorityHostEffects(h.scope(), async () => {
        expect(effect()).toBe(0);
        const escaped = AsyncResource.bind(effect);
        await lane.with(locator(lane.action), async () => {
          expect(effect()).toBe(0);
          expect(escaped).toThrow(lane.code);
        });
      });
    });

    // Mutants 540, 685: an effect issued from another scope object over the same receipt
    // store, nested inside the sequence, is refused.
    it('refuses an effect from a nested scope sharing the receipt store', async () => {
      const h = await harness(lane);
      await runWithAuthorityHostEffects(h.scope(), async () => {
        await lane.with(locator(lane.action), async () => {
          expect(effect()).toBe(0);
          expect(() => runWithAuthorityHostEffects(h.scope(), effect)).toThrow(lane.code);
        });
      });
    });
  });
