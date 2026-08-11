import { describe, expect, it } from 'vitest';
import {
  executeAuthorityPolicyMaterialization,
  executeAuthoritySessionOperation,
  runWithAuthorityPolicyMaterialization,
  runWithAuthoritySessionOperation,
} from '../../src/authority/command-capabilities.js';

describe('command authority capabilities', () => {
  it('executes injected operations only inside their scoped host context', () => {
    expect(() => executeAuthoritySessionOperation()).toThrow(
      'AUTHORITY_SESSION_OPERATION_REQUIRED',
    );
    expect(() => executeAuthorityPolicyMaterialization()).toThrow(
      'AUTHORITY_POLICY_MATERIALIZATION_REQUIRED',
    );

    expect(
      runWithAuthoritySessionOperation(
        () => 'session-result',
        () => executeAuthoritySessionOperation(),
      ),
    ).toBe('session-result');
    expect(
      runWithAuthorityPolicyMaterialization(
        () => 'materialization-result',
        () => executeAuthorityPolicyMaterialization(),
      ),
    ).toBe('materialization-result');

    expect(runWithAuthoritySessionOperation(undefined, () => 'plain-session')).toBe(
      'plain-session',
    );
    expect(runWithAuthorityPolicyMaterialization(undefined, () => 'plain-policy')).toBe(
      'plain-policy',
    );
  });
});
