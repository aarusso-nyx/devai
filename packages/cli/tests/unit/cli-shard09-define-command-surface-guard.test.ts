import { describe, expect, it } from 'vitest';
import type { RegistryEntry } from '../../src/define-command.js';

describe('define-command action surface guard', () => {
  it('rejects count, path, tier, and each ordered identity drift exactly', async () => {
    const { canonicalRegistry, validateActionSurface } =
      await import('../../src/define-command.js?cli-shard09-surface-guard');
    const canonical = canonicalRegistry();
    const [first, second] = canonical;
    if (first === undefined || second === undefined)
      throw new Error('canonical registry is incomplete');

    expect(() => validateActionSurface(canonical.slice(1))).toThrowError(
      new Error(
        `ACTION_COUNT_GUARD: expected ${canonical.length} canonical handlers, received ${canonical.length - 1}`,
      ),
    );

    const separatorCollision = canonical.map((entry, index) =>
      index === 0
        ? { ...entry, path: ['a', 'bc'] }
        : index === 1
          ? { ...entry, path: ['ab', 'c'] }
          : entry,
    );
    expect(() => validateActionSurface(separatorCollision)).toThrowError(
      new Error(`ACTION_HANDLER_ORDER_DRIFT: expected ${first.name}, received ${first.name}`),
    );

    const duplicatePath = canonical.map((entry, index) =>
      index === 1 ? { ...entry, path: first.path } : entry,
    );
    expect(() => validateActionSurface(duplicatePath)).toThrowError(
      new Error('ACTION_PATH_DUPLICATE'),
    );

    const missingTier = canonical.map((entry, index) =>
      index === 0 ? ({ ...entry, tier: 'missing' } as unknown as RegistryEntry) : entry,
    );
    expect(() => validateActionSurface(missingTier)).toThrowError(new Error('ACTION_TIER_MISSING'));

    const sparse = canonical.slice();
    delete sparse[0];
    expect(() => validateActionSurface(sparse)).toThrowError(
      new Error(`ACTION_HANDLER_ORDER_DRIFT: expected ${first.name}, received <none>`),
    );

    for (const changed of [
      { ...first, name: 'foreign action' },
      { ...first, handler: 'foreign-handler' },
      { ...first, internal_name: 'foreign-internal' },
      { ...first, path: ['foreign', 'path'] },
    ]) {
      const entries = [changed, ...canonical.slice(1)];
      expect(() => validateActionSurface(entries)).toThrowError(
        new Error(`ACTION_HANDLER_ORDER_DRIFT: expected ${first.name}, received ${changed.name}`),
      );
    }
  });
});
