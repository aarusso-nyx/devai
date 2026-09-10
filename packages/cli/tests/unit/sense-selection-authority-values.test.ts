// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { describe, expect, it } from 'vitest';
import {
  actionCapability,
  capabilitiesForEffect,
  flagValue,
  resolvedEntry,
  resolveSenseInvocation,
  targetsFor,
} from '../../src/authority/sense-selection.js';
import { canonicalRegistry } from '../../src/define-command.js';

const senseRun = canonicalRegistry().find((entry) => entry.name === 'sense run');
if (senseRun === undefined) throw new Error('sense run registry entry missing');
const check = canonicalRegistry().find((entry) => entry.name === 'check');
if (check === undefined) throw new Error('check registry entry missing');

describe('sense selection authority helper values', () => {
  it('reads flags at every valid position and rejects only absent flags', () => {
    expect(flagValue(['--repo-root', '/fixture'], '--repo-root')).toBe('/fixture');
    expect(flagValue(['node', '--repo-root', '/fixture'], '--repo-root')).toBe('/fixture');
    expect(flagValue(['--repo-root'], '--repo-root')).toBeUndefined();
    expect(flagValue([], '--repo-root')).toBeUndefined();
  });

  it.each([
    'fs:workspace',
    'db:read',
    'host-cache:write',
    'proc:custom-tool',
    'net:custom-service',
  ] as const)('accepts the supported capability family for %s', (capability) => {
    expect(actionCapability(capability)).toBe(capability);
  });

  it.each(['process:tool', 'network:service', '', 'fs'])(
    'rejects the unsupported capability %j',
    (capability) => {
      expect(() => actionCapability(capability)).toThrow(`SENSE_CAPABILITY_UNKNOWN:${capability}`);
    },
  );

  it('derives each concrete mutation target once and in canonical order', () => {
    expect(targetsFor(['net:z', 'db:write', 'fs:workspace', 'net:a', 'db:read'])).toEqual([
      'fs',
      'db',
      'remote',
    ]);
    expect(targetsFor(['proc:git', 'host-cache:write'])).toEqual([]);
  });

  it('keeps all capabilities for local and remote writes', () => {
    const capabilities = ['fs:workspace', 'db:read', 'host-cache:write'] as const;
    expect(capabilitiesForEffect(capabilities, 'local-write')).toBe(capabilities);
    expect(capabilitiesForEffect(capabilities, 'remote-write')).toBe(capabilities);
  });

  it('keeps only capabilities admitted by read and harness effects', () => {
    const capabilities = [
      'fs:workspace',
      'fs:f5-state',
      'db:read',
      'proc:git',
      'host-cache:write',
    ] as const;
    expect(capabilitiesForEffect(capabilities, 'read')).toEqual(['db:read', 'proc:git']);
    expect(capabilitiesForEffect(capabilities, 'harness-write')).toEqual([
      'fs:f5-state',
      'db:read',
      'proc:git',
    ]);
  });

  it('returns undefined only when the entry is not sense run', () => {
    expect(resolveSenseInvocation(check, ['node', 'devai', 'check'])).toBeUndefined();
  });

  it('rejects an invocation with neither a kind nor a preset at the selection boundary', () => {
    expect(() => resolveSenseInvocation(senseRun, ['node', 'devai', 'sense', 'run'])).toThrow(
      'SENSE_SELECTION_EXACTLY_ONE_REQUIRED',
    );
  });

  it('does not impose the generic write planner on a resolved read selection', () => {
    const resolved = resolveSenseInvocation(senseRun, [
      'node',
      'devai',
      'sense',
      'run',
      'decision_record_integrity',
    ]);
    if (resolved === undefined) throw new Error('sense selection missing');
    const invalidGeneric = {
      ...senseRun,
      authority_contract: {
        ...senseRun.authority_contract,
        planner: { kind: 'none' as const },
        boundary: { kind: 'none' as const },
      },
    };
    expect(resolvedEntry(invalidGeneric, resolved.selection).effects).toBe('read');
  });
});
