import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const identity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };

describe('release-intent schema', () => {
  it('accepts a bounded candidate-bound intent', () => {
    expect(
      getValidator('release-intent.schema.json')({
        schemaVersion: '1.0.0',
        release_unit: '@example/package',
        current_version: '1.0.0',
        target_version: '1.0.1',
        support: 'current',
        changed_paths: ['packages/example/src/index.ts'],
        changed_packages: ['@example/package'],
        candidate: identity,
        base: identity,
      }),
    ).toBe(true);
  });

  it('rejects a receipt-like unbounded error payload', () => {
    expect(
      getValidator('release-intent.schema.json')({
        schemaVersion: '1.0.0',
        release_unit: 'x',
        current_version: '1.0.0',
        target_version: '1.0.1',
        support: 'current',
        changed_paths: [],
        changed_packages: [],
        candidate: identity,
        base: identity,
        raw_error: 'secret=not-allowed',
      }),
    ).toBe(false);
  });
});
