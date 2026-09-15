import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readProtectedReleasePrepareCapacity,
  readProtectedReleaseExportCapacity,
  withProtectedReleasePrepareCapacity,
  withProtectedReleaseExportCapacity,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
  type ProtectedReleasePrepareCapacityBinding,
  type ProtectedReleaseExportCapacityBinding,
  type ProtectedReleasePrepareCapacity,
  type ProtectedReleaseExportCapacity,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
const lanes = [
  {
    action: 'release prepare',
    max: 256,
    code: 'release-prepare-capacity-unavailable',
    with: (binding: unknown, callback: () => Promise<unknown>) =>
      withProtectedReleasePrepareCapacity(
        binding as ProtectedReleasePrepareCapacityBinding,
        callback,
      ),
    read: (binding: unknown) =>
      readProtectedReleasePrepareCapacity(binding as ProtectedReleasePrepareCapacityBinding),
  },
  {
    action: 'release export',
    max: 128,
    code: 'release-export-capacity-unavailable',
    with: (binding: unknown, callback: () => Promise<unknown>) =>
      withProtectedReleaseExportCapacity(
        binding as ProtectedReleaseExportCapacityBinding,
        callback,
      ),
    read: (binding: unknown) =>
      readProtectedReleaseExportCapacity(binding as ProtectedReleaseExportCapacityBinding),
  },
];
function locator(action: string): Record<string, unknown> {
  return {
    action_id: action,
    repository: { id: 'owner/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    plan_receipt_digest_sha256: 'c'.repeat(64),
  };
}
async function harness(
  lane: (typeof lanes)[number],
  response: unknown = { remaining_batches: lane.max, remaining_targets: 8192 },
) {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: 'capacity-validation',
    invocation_id: 'capacity-invocation',
  });
  disposers.push(() => {
    issuer.dispose();
  });
  const reads = vi.fn((_binding: unknown) => response);
  const scope: AuthorityHostEffectScope = {
    action_id: lane.action,
    invocation_id: 'capacity-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
    read_prepare_capacity: (binding) => reads(binding) as ProtectedReleasePrepareCapacity,
    read_export_capacity: (binding) => reads(binding) as ProtectedReleaseExportCapacity,
  };
  return { reads, run: <T>(callback: () => T) => runWithAuthorityHostEffects(scope, callback) };
}
for (const lane of lanes)
  describe(`${lane.action} exact capacity controls`, () => {
    for (const field of ['remaining_batches', 'remaining_targets']) {
      const max = field === 'remaining_batches' ? lane.max : 8192;
      it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, max + 1, '0', null, undefined])(
        `refuses invalid ${field} %j before entering the sequence`,
        async (value) => {
          const h = await harness(lane, {
            remaining_batches: lane.max,
            remaining_targets: 8192,
            [field]: value,
          });
          const callback = vi.fn(async () => undefined);
          await expect(h.run(() => lane.with(locator(lane.action), callback))).rejects.toThrow(
            lane.code,
          );
          expect(callback).not.toHaveBeenCalled();
        },
      );
      it.each([0, 1, max])(
        `accepts the exact ${field} endpoint %s as immutable observed data`,
        async (value) => {
          const response = { remaining_batches: lane.max, remaining_targets: 8192, [field]: value };
          const h = await harness(lane, response),
            binding = locator(lane.action);
          await h.run(() =>
            lane.with(binding, async () => {
              const observed = lane.read(binding);
              expect(observed).toEqual(response);
              expect(Object.isFrozen(observed)).toBe(true);
            }),
          );
        },
      );
    }
    it.each(['action_id', 'repository', 'candidate', 'plan_receipt_digest_sha256'])(
      'refuses a missing locator field %s',
      async (field) => {
        const h = await harness(lane),
          binding = locator(lane.action);
        Reflect.deleteProperty(binding, field);
        await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
          lane.code,
        );
        expect(h.reads).not.toHaveBeenCalled();
      },
    );
    it.each(['repository', 'candidate'])(
      'requires an exact own-property %s record',
      async (field) => {
        for (const malformed of [
          null,
          [],
          1,
          {},
          Object.create({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) }),
        ]) {
          const h = await harness(lane),
            binding = locator(lane.action);
          binding[field] = malformed;
          await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
            lane.code,
          );
          expect(h.reads).not.toHaveBeenCalled();
        }
      },
    );
    it.each(['repository', 'candidate'])('rejects an invalid Git identity in %s', async (field) => {
      for (const key of ['commit', 'tree'])
        for (const value of [
          '',
          'a'.repeat(39),
          'a'.repeat(41),
          'G'.repeat(40),
          'a'.repeat(64),
          1,
        ]) {
          const binding = locator(lane.action);
          binding[field] = { ...(binding[field] as object), [key]: value };
          const h = await harness(lane);
          await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
            lane.code,
          );
          expect(h.reads).not.toHaveBeenCalled();
        }
    });
    it('supports an entirely SHA-256 Git repository without mixing object formats', async () => {
      const binding = locator(lane.action);
      binding.repository = { id: 'owner/repository', commit: 'a'.repeat(64), tree: 'b'.repeat(64) };
      binding.candidate = { commit: 'a'.repeat(64), tree: 'b'.repeat(64) };
      const h = await harness(lane);
      await expect(h.run(() => lane.with(binding, async () => 'accepted'))).resolves.toBe(
        'accepted',
      );
    });
    it.each(['', '/absolute', 'white space', 'x'.repeat(201), 1])(
      'refuses invalid repository identity %j',
      async (id) => {
        const binding = locator(lane.action);
        binding.repository = { ...(binding.repository as object), id };
        const h = await harness(lane);
        await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
          lane.code,
        );
        expect(h.reads).not.toHaveBeenCalled();
      },
    );
    it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 1])(
      'refuses invalid plan receipt digest %j',
      async (value) => {
        const binding = locator(lane.action);
        binding.plan_receipt_digest_sha256 = value;
        const h = await harness(lane);
        await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
          lane.code,
        );
        expect(h.reads).not.toHaveBeenCalled();
      },
    );
    it.each(['binding', 'repository', 'candidate', 'capacity'])(
      'refuses accessors in %s without invoking them',
      async (part) => {
        const binding = locator(lane.action),
          response = { remaining_batches: lane.max, remaining_targets: 8192 };
        const object =
          part === 'binding' ? binding : part === 'capacity' ? response : (binding[part] as object);
        const key =
          part === 'binding' ? 'action_id' : part === 'capacity' ? 'remaining_batches' : 'commit';
        const getter = vi.fn(() => {
          throw new Error('accessor executed');
        });
        Object.defineProperty(object, key, { get: getter, enumerable: true, configurable: true });
        const h = await harness(lane, response);
        await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
          lane.code,
        );
        expect(getter).not.toHaveBeenCalled();
      },
    );
    it.each(['binding', 'repository', 'candidate', 'capacity'])(
      'refuses hidden extra fields in %s',
      async (part) => {
        const binding = locator(lane.action),
          response = { remaining_batches: lane.max, remaining_targets: 8192 };
        const object =
          part === 'binding' ? binding : part === 'capacity' ? response : (binding[part] as object);
        Object.defineProperty(object, Symbol('extra authority'), { value: true });
        const h = await harness(lane, response);
        await expect(h.run(() => lane.with(binding, async () => undefined))).rejects.toThrow(
          lane.code,
        );
      },
    );
    it('passes a deeply frozen locator to the account reader', async () => {
      const h = await harness(lane),
        binding = locator(lane.action);
      await h.run(() => lane.with(binding, async () => undefined));
      const passed = h.reads.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(passed).toEqual(binding);
      expect(passed).not.toBe(binding);
      expect(Object.isFrozen(passed)).toBe(true);
      expect(Object.isFrozen(passed.repository)).toBe(true);
      expect(Object.isFrozen(passed.candidate)).toBe(true);
    });
    it.each(['success', 'failure'])(
      'denies asynchronous descendants after sequence %s',
      async (outcome) => {
        const h = await harness(lane),
          binding = locator(lane.action);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        let descendant!: Promise<void>;
        const sequence = h.run(() =>
          lane.with(binding, async () => {
            descendant = (async () => {
              await barrier;
              expect(() => lane.read(binding)).toThrow(lane.code);
            })();
            expect(lane.read(binding)).toEqual({
              remaining_batches: lane.max,
              remaining_targets: 8192,
            });
            if (outcome === 'failure') throw new Error('sequence interrupted');
          }),
        );
        try {
          if (outcome === 'failure') await expect(sequence).rejects.toThrow('sequence interrupted');
          else await sequence;
        } finally {
          release();
          await descendant;
        }
        expect(h.reads).toHaveBeenCalledTimes(2);
      },
    );
    it('keeps a failed account closed so its budget cannot be reset', async () => {
      const h = await harness(lane),
        binding = locator(lane.action),
        error = new Error('interrupted operation');
      await expect(
        h.run(() =>
          lane.with(binding, async () => {
            throw error;
          }),
        ),
      ).rejects.toBe(error);
      await expect(h.run(() => lane.with(binding, async () => lane.read(binding)))).rejects.toThrow(
        lane.code,
      );
      expect(h.reads).toHaveBeenCalledTimes(1);
      expect(() => lane.read(binding)).toThrow(lane.code);
    });
  });
