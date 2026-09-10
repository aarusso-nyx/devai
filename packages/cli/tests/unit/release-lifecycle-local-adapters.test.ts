import { describe, expect, it, vi } from 'vitest';
import { builtInReleaseLifecycleLocalProvider } from '../../src/services/release-lifecycle-local-adapters.js';

const context = {
  repo_root: '/fixture/repository',
  resolve_receipt: vi.fn(),
  resolve_plan_input: vi.fn(),
  read_contained_bytes: vi.fn(),
};

describe('built-in release lifecycle local provider', () => {
  it('exposes only the explicit fail-closed preflight provider', async () => {
    expect(builtInReleaseLifecycleLocalProvider(context, 'release prepare')).toBeUndefined();

    const provider = builtInReleaseLifecycleLocalProvider(context, 'release preflight');
    expect(provider).toBeTypeOf('function');
    expect(await provider?.({} as never)).toEqual({
      outcome: 'failure',
      code: 'release-certification-provider-unavailable',
    });
  });
});
