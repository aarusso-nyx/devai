// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonical,
  declaredInvocationAuthority,
  disposeCliInvocationAuthority,
  guardedInvocationDisposal,
  rememberResolvedInvocationAuthority,
} from '../../src/authority/index.js';

afterEach(() => {
  disposeCliInvocationAuthority();
});

describe('authority index helper values', () => {
  it('keeps authority context absent for experimental argv', () => {
    rememberResolvedInvocationAuthority('architect', 'cli-flag', ['--experimental']);
    expect(declaredInvocationAuthority()).toBeUndefined();
  });

  it('records publish consent only for the exact publish flag', () => {
    rememberResolvedInvocationAuthority('owner', 'session-state', []);
    expect(declaredInvocationAuthority()).toEqual({
      actor: { kind: 'human', role: 'owner', declaration_source: 'session-state' },
      consent: { write: true, allow_publish: false, experimental: false },
    });
    rememberResolvedInvocationAuthority('owner', 'session-state', ['--publish']);
    expect(declaredInvocationAuthority()?.consent.allow_publish).toBe(true);
  });

  it('executes the guarded disposal callback exactly once', () => {
    const dispose = vi.fn();
    guardedInvocationDisposal(dispose)();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes nested records by sorted keys and values', () => {
    expect(canonical({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });
});
