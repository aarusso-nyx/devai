import { describe, expect, it, vi } from 'vitest';
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

async function fixture() {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'scope-validation' });
  const apply_effect = vi.fn((_request, apply: () => unknown) => apply());
  const scope: AuthorityHostEffectScope = {
    action_id: 'release prepare',
    invocation_id: 'scope-validation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect,
  };
  return { issuer, scope, apply_effect };
}

describe('host effect scope admission', () => {
  it.each([
    { action_id: '' },
    { invocation_id: '' },
    { invocation_id: 'another-invocation' },
    { apply_effect: undefined },
    { apply_effect: {} },
    { receipt_store: {} },
    { receipt_store: null },
  ])('refuses invalid scope field %j before entering its callback', async (change) => {
    const value = await fixture();
    const callback = vi.fn();
    try {
      expect(() =>
        Reflect.apply(runWithAuthorityHostEffects, undefined, [
          { ...value.scope, ...change },
          callback,
        ]),
      ).toThrow('AUTHORITY_HOST_SCOPE_INVALID');
      expect(callback).not.toHaveBeenCalled();
      expect(value.apply_effect).not.toHaveBeenCalled();
    } finally {
      value.issuer.dispose();
    }
  });

  it('refuses a disposed genuine issuer with an otherwise matching scope', async () => {
    const value = await fixture();
    expect(value.issuer.dispose()).toMatchObject({ ok: true });
    const callback = vi.fn();
    expect(() => runWithAuthorityHostEffects(value.scope, callback)).toThrow(
      'AUTHORITY_HOST_SCOPE_INVALID',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(value.apply_effect).not.toHaveBeenCalled();
  });

  it('enters a matching live issuer scope once and preserves its callback result', async () => {
    const value = await fixture();
    const result = Object.freeze({ completed: true });
    const callback = vi.fn(() => result);
    try {
      expect(runWithAuthorityHostEffects(value.scope, callback)).toBe(result);
      expect(callback).toHaveBeenCalledExactlyOnceWith();
      expect(value.apply_effect).not.toHaveBeenCalled();
    } finally {
      value.issuer.dispose();
    }
  });
});
