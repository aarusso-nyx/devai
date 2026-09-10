// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { describe, expect, it } from 'vitest';
import {
  authorityErrorCode,
  authorityErrorContext,
  authorityRemediation,
  taggedFailure,
} from '../../src/authority/index.js';

describe('authority error values', () => {
  it('constructs an immutable tagged failure with optional immutable context', () => {
    const without = taggedFailure('refused', 'POLICY_DENY');
    expect(without).toEqual({
      ok: false,
      category: 'refused',
      code: 'POLICY_DENY',
      reasons: ['POLICY_DENY'],
    });
    expect(Object.isFrozen(without)).toBe(true);
    expect(Object.isFrozen(without.reasons)).toBe(true);

    const withContext = taggedFailure('dependency-error', 'AUTHORITY_TOOL_UNAVAILABLE', {
      command: 'tool',
    });
    expect(withContext).toEqual({
      ok: false,
      category: 'dependency-error',
      code: 'AUTHORITY_TOOL_UNAVAILABLE',
      reasons: ['AUTHORITY_TOOL_UNAVAILABLE'],
      context: { command: 'tool' },
    });
    expect(Object.isFrozen(withContext.context)).toBe(true);
  });

  it('renders role remediation with and without a declared role population', () => {
    expect(
      authorityRemediation('AUTHORITY_HUMAN_ROLE_DENIED', { allowed_roles: ['owner', 'engineer'] }),
    ).toBe('Declare one of: owner, engineer via --as-role.');
    expect(authorityRemediation('AUTHORITY_HUMAN_ROLE_DENIED', { allowed_roles: [] })).toBe(
      'Declare an allowed role via --as-role.',
    );
    expect(authorityRemediation('AUTHORITY_HUMAN_ROLE_DENIED', { allowed_roles: 'owner' })).toBe(
      'Declare an allowed role via --as-role.',
    );
  });

  it.each([
    [{ write: true }, "This action's effect is 'local-write'; remove --write."],
    [{ allow_publish: true }, "This action's effect is 'local-write'; remove --publish."],
    [{ as_role: true }, "This action's effect is 'local-write'; remove --as-role."],
    [
      { authority_session: true },
      "This action's effect is 'local-write'; remove --authority-session.",
    ],
    [
      { write: true, allow_publish: true, as_role: true, authority_session: true },
      "This action's effect is 'local-write'; remove --write and --publish and --as-role and --authority-session.",
    ],
    [{}, "This action's effect is 'local-write'; remove the authority declaration."],
  ] as const)('renders inapplicable declaration %j', (declared, expected) => {
    expect(
      authorityRemediation('AUTHORITY_DECLARATION_NOT_APPLICABLE', {
        effect: 'local-write',
        declared,
      }),
    ).toBe(expected);
  });

  it('uses read and empty declaration fallbacks for malformed declaration context', () => {
    expect(authorityRemediation('AUTHORITY_DECLARATION_NOT_APPLICABLE', {})).toBe(
      "This action's effect is 'read'; remove the authority declaration.",
    );
  });

  it('renders ordered, singular, and default policy binding commands', () => {
    expect(
      authorityRemediation('AUTHORITY_POLICY_MISSING', { commands: ['first', 'second'] }),
    ).toBe('Run in order:\n1. first\n2. second');
    expect(authorityRemediation('AUTHORITY_POLICY_MISSING', { commands: ['only'] })).toBe(
      'Run: only',
    );
    expect(authorityRemediation('AUTHORITY_POLICY_MISSING', { command: 'fallback' })).toBe(
      'Run: fallback',
    );
    expect(authorityRemediation('AUTHORITY_POLICY_MISSING', {})).toBe(
      'Run: devai init bind --target <repo> --as-role architect --write',
    );
  });

  it('renders consent remediations exactly', () => {
    expect(authorityRemediation('AUTHORITY_WRITE_CONSENT_REQUIRED', {})).toBe(
      'Add --write after reviewing the action plan.',
    );
    expect(authorityRemediation('AUTHORITY_PUBLISH_CONSENT_REQUIRED', {})).toBe(
      'Add --write and --publish after reviewing the remote effect.',
    );
  });

  it.each([
    ['cwd escapes the repository', 'The declared cwd must resolve inside the repository.'],
    ['cwd does not exist', 'The declared cwd must exist before the task can run.'],
    ['cwd must be declared', 'Declare the task cwd in the adopter-owned task descriptor.'],
    ['shell must be false', 'Declare an argv-based task with shell disabled.'],
  ] as const)('renders host-process reason %s', (reason, expected) => {
    expect(authorityRemediation('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED', { reason })).toBe(
      expected,
    );
  });

  it('renders the exact undeclared host process', () => {
    expect(
      authorityRemediation('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED', {
        executable: 'tool',
        argv: ['run', '--flag'],
        descriptor_path: '.devai/tasks.json',
      }),
    ).toBe('Declare the exact process in .devai/tasks.json; received tool ["run","--flag"].');
    expect(authorityRemediation('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED', {})).toBe(
      'Declare the exact process in <unknown>; received <unknown> [].',
    );
  });

  it('distinguishes dependency remediation from ordinary refusal', () => {
    expect(authorityRemediation('OTHER', { category: 'dependency-error' })).toBe(
      'Materialize the required repository state, then retry.',
    );
    expect(authorityRemediation('OTHER', { category: 'refused' })).toBe(
      'Use a declared role and the required consent flags.',
    );
  });

  it.each([
    ['AUTHORITY_DENIED', 'AUTHORITY_DENIED'],
    ['AUTHORITY_DENIED: detail', 'AUTHORITY_DENIED'],
    ['UNCLASSIFIED_RESOURCE', 'UNCLASSIFIED_RESOURCE'],
    ['POLICY_DENY: detail', 'POLICY_DENY'],
    ['authority policy: missing', 'AUTHORITY_POLICY_MISSING'],
  ] as const)('extracts authority code from %s', (message, expected) => {
    expect(authorityErrorCode(new Error(message))).toBe(expected);
  });

  it.each(['prefix AUTHORITY_DENIED', 'AUTHORITY-lower', 'POLICY_DENIED', 'random'])(
    'rejects noncanonical error code %s',
    (message) => expect(authorityErrorCode(new Error(message))).toBeUndefined(),
  );

  it('rejects non-Error code inputs', () => {
    expect(authorityErrorCode('AUTHORITY_DENIED')).toBeUndefined();
  });

  it('extracts attached or serialized error context and rejects malformed forms', () => {
    const attached = Object.assign(new Error('AUTHORITY_DENIED'), {
      context: { source: 'attached' },
    });
    expect(authorityErrorContext(attached)).toEqual({ source: 'attached' });
    expect(authorityErrorContext(new Error('AUTHORITY_DENIED:{"source":"serialized"}'))).toEqual({
      source: 'serialized',
    });
    expect(authorityErrorContext(new Error(':{"source":"leading-separator"}'))).toEqual({
      source: 'leading-separator',
    });
    expect(
      authorityErrorContext(
        Object.assign(new Error('AUTHORITY_DENIED:{"source":"json"}'), { context: [] }),
      ),
    ).toEqual({ source: 'json' });
    expect(authorityErrorContext(new Error('AUTHORITY_DENIED'))).toBeUndefined();
    expect(authorityErrorContext(new Error('{}'))).toBeUndefined();
    expect(authorityErrorContext(new Error('AUTHORITY_DENIED:not-json'))).toBeUndefined();
    expect(authorityErrorContext(new Error('AUTHORITY_DENIED:[1]'))).toBeUndefined();
    expect(authorityErrorContext('AUTHORITY_DENIED:{"source":"string"}')).toBeUndefined();
  });
});
