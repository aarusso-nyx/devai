// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionId,
  allowedRoles,
  canonical,
  declaredInvocationAuthority,
  disposeCliInvocationAuthority,
  entryForArgv,
  flagValue,
  formatFor,
  guardedInvocationDisposal,
  rememberResolvedInvocationAuthority,
  routeRoles,
  targetFor,
} from '../../src/authority/index.js';
import { canonicalRegistry } from '../../src/define-command.js';

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

  it('canonicalizes ordered arrays with explicit framing and separators', () => {
    expect(canonical({ values: ['second', 'first'], empty: [] })).toBe(
      '{"empty":[],"values":["second","first"]}',
    );
  });

  it('reads exact flag values and selects the requested output format', () => {
    expect(flagValue(['--format', 'json'], '--format')).toBe('json');
    expect(flagValue(['round', 'start', '--format', 'json'], '--format')).toBe('json');
    expect(flagValue(['round', 'start'], '--format')).toBeUndefined();
    expect(flagValue(['round', 'start', '--format'], '--format')).toBeUndefined();
    expect(formatFor(['round', 'start', '--format', 'json'])).toBe('json');
    expect(formatFor(['round', 'start', '--json'])).toBe('json');
    expect(formatFor(['round', 'start', '--format', 'human'])).toBe('human');
  });

  it.each([
    [['catalog', 'actions'], 'catalog actions'],
    [['docs', 'cli'], 'docs cli'],
    [['init', 'bind'], 'init bind'],
    [['init', 'record'], 'init record'],
    [['init', 'apply', 'owner'], 'init apply owner'],
    [['other', 'apply', 'owner'], 'other apply'],
    [['init', 'other', 'owner'], 'init other'],
    [['init', 'apply', 'other'], 'init apply'],
    [['round', 'actions'], 'round actions'],
    [['round', 'cli'], 'round cli'],
    [['round', 'bind'], 'round bind'],
    [['round', 'record'], 'round record'],
    [['round', 'start', '--write'], 'round start'],
  ] as const)('resolves the exact action route for %j', (argv, expected) => {
    expect(actionId(argv)).toBe(expected);
  });

  it('constructs the exact authority target for bind and documentation writes', () => {
    expect(targetFor('init bind')).toEqual({
      kind: 'fs',
      id: 'fs:.devai/config/authority-policy.json',
      repository_id: 'adopter-repository',
      canonical_relative_path: '.devai/config/authority-policy.json',
      operation: 'create',
    });
    expect(targetFor('docs cli')).toEqual({
      kind: 'fs',
      id: 'fs:docs/reference/cli',
      repository_id: 'adopter-repository',
      canonical_relative_path: 'docs/reference/cli/index.md',
      operation: 'update',
    });
  });

  it('selects the longest canonical route while preserving its declared roles', () => {
    const entries = canonicalRegistry();
    const owner = entryForArgv(
      [process.execPath, 'devai', 'init', 'apply', 'owner', '--tier', 'tier3'],
      entries,
    );
    const catalog = entryForArgv([process.execPath, 'devai', 'catalog', 'actions'], entries);
    const catalogWithLeadingFlag = entryForArgv(
      [process.execPath, 'devai', '--json', 'catalog', 'actions'],
      entries,
    );
    const binding = entries.find((entry) => entry.name === 'init bind');
    if (owner === undefined) throw new Error('owner route missing');
    const shorterOwnerRoute = { ...owner, name: 'init apply', path: ['init', 'apply'] };
    expect(owner?.name).toBe('init apply owner');
    expect(catalog?.name).toBe('catalog actions');
    expect(catalogWithLeadingFlag?.name).toBe('catalog actions');
    expect(
      entryForArgv(
        [process.execPath, 'devai', 'init', 'apply', 'owner'],
        [shorterOwnerRoute, owner],
      )?.name,
    ).toBe('init apply owner');
    expect(entryForArgv([process.execPath, 'devai', 'missing', 'action'], entries)).toBeUndefined();
    expect(owner === undefined ? [] : routeRoles(owner, [])).toEqual(['owner']);
    expect(owner === undefined ? [] : allowedRoles(owner.authority_contract)).toEqual(['owner']);
    expect(binding === undefined ? [] : routeRoles(binding, [])).toEqual(['architect']);
    expect(catalog === undefined ? [] : allowedRoles(catalog.authority_contract)).toEqual([]);
  });
});
