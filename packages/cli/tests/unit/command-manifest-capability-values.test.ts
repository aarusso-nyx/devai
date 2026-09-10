// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { describe, expect, it } from 'vitest';
import {
  deriveActionEffectFromCapabilities,
  registryActionFor,
  type ActionCapability,
  type ActionEffect,
} from '../../src/command-manifest.js';

const CAPABILITY_EFFECTS = [
  ['fs:f5-config', 'local-write'],
  ['fs:f5-state', 'harness-write'],
  ['fs:f4-inventory', 'harness-write'],
  ['fs:proofs', 'harness-write'],
  ['fs:worktree-admin', 'harness-write'],
  ['fs:workspace', 'local-write'],
  ['fs:unknown-write', 'local-write'],
  ['db:read', 'read'],
  ['db:write', 'local-write'],
  ['db:unclassified', 'local-write'],
  ['host-cache:write', 'local-write'],
  ['artifact-sink:write', 'local-write'],
  ['protected-export-signer-v1:sign', 'local-write'],
  ['protected-certification-provider-v3:execute', 'harness-write'],
  ['certification-evidence-sink:write', 'harness-write'],
  ['proc:git', 'read'],
  ['net:github', 'remote-write'],
] as const satisfies readonly (readonly [ActionCapability, ActionEffect])[];

describe('command manifest capability values', () => {
  it.each(CAPABILITY_EFFECTS)('derives %s as an exact %s effect', (capability, effect) => {
    expect(deriveActionEffectFromCapabilities([capability])).toBe(effect);
  });

  it('preserves remote precedence over local and harness capabilities', () => {
    expect(deriveActionEffectFromCapabilities(['fs:workspace', 'fs:f5-state', 'net:github'])).toBe(
      'remote-write',
    );
  });

  it('returns the canonical record and refuses an absent handler with its exact identity', () => {
    expect(registryActionFor('doctor').action_id).toBe('doctor');
    expect(() => registryActionFor('missing action')).toThrow(
      "action 'missing action' is absent from law/policy/action-registry.json",
    );
  });
});
