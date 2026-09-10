import { canonicalRegistry } from '../../src/define-command.js';
import {
  resolveInvocationEntry,
  resolveSenseInvocation,
} from '../../src/authority/sense-selection.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const senseRun = canonicalRegistry().find((entry) => entry.name === 'sense run');
if (senseRun === undefined) throw new Error('sense run registry entry missing');
const check = canonicalRegistry().find((entry) => entry.name === 'check');
if (check === undefined) throw new Error('check registry entry missing');

function argv(...tail: readonly string[]): readonly string[] {
  return ['node', 'devai', 'sense', 'run', ...tail];
}

describe('sense invocation authority boundaries', () => {
  it('reduces a read-only check to an authority contract with no mutation boundary', () => {
    const resolved = resolveInvocationEntry(check, [
      'node',
      'devai',
      'check',
      '--only',
      'schema',
      '--repo-root',
      process.cwd(),
    ]);

    expect(resolved.effects).toBe('read');
    expect(resolved.authority_contract.effect).toBe('read');
    expect(resolved.authority_contract.capabilities).toEqual([
      'db:read',
      'proc:docker',
      'proc:dynamic',
      'proc:git',
      'proc:pnpm',
      'proc:psql',
      'proc:sandbox-exec',
    ]);
    expect(resolved.authority_contract.subject).toEqual({ kind: 'none' });
    expect(resolved.authority_contract.consent).toEqual({
      write: false,
      allow_publish: false,
      experimental: false,
    });
    expect(resolved.authority_contract.planner).toEqual({ kind: 'none' });
    expect(resolved.authority_contract.boundary).toEqual({ kind: 'none' });
    expect(resolved.authority_contract.readiness).toEqual({
      requires_binding: false,
      independent_acceptance_required: true,
    });
  });

  it('projects a translation check to its exact filesystem mutation boundary', () => {
    const resolved = resolveInvocationEntry(check, [
      'node',
      'devai',
      'check',
      '--only',
      'translation',
      '--repo-root',
      process.cwd(),
    ]);

    expect(resolved).toBe(check);
    expect(resolved.effects).toBe('local-write');
    expect(resolved.authority_contract.effect).toBe('local-write');
  });

  it('forwards the exact check suite and only selectors to the check planner', () => {
    expect(() =>
      resolveInvocationEntry(check, [
        'node',
        'devai',
        'check',
        '--suite',
        'not-a-suite',
        '--repo-root',
        process.cwd(),
      ]),
    ).toThrow('CHECK_SUITE_UNKNOWN:not-a-suite');
    expect(() =>
      resolveInvocationEntry(check, [
        'node',
        'devai',
        'check',
        '--only',
        'not-a-member',
        '--repo-root',
        process.cwd(),
      ]),
    ).toThrow('CHECK_MEMBER_UNKNOWN:not-a-member');
    expect(() =>
      resolveInvocationEntry(check, [
        'node',
        'devai',
        'check',
        '--suite',
        'standard',
        '--only',
        'schema',
        '--repo-root',
        process.cwd(),
      ]),
    ).toThrow('CHECK_SELECTION_CONFLICT');
  });

  it('loads check policy from the exact explicit repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-check-authority-root-'));
    try {
      mkdirSync(join(root, 'law/policy'), { recursive: true });
      writeFileSync(join(root, 'law/policy/check-suites.json'), '{}\n');
      expect(() =>
        resolveInvocationEntry(check, [
          'node',
          'devai',
          'check',
          '--only',
          'schema',
          '--repo-root',
          root,
        ]),
      ).toThrow('CHECK_POLICY_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects a canonical read kind into a read authority contract', () => {
    const resolved = resolveSenseInvocation(senseRun, argv('decision_record_integrity'));
    expect(resolved?.selection.selection).toEqual({
      type: 'kind',
      value: 'decision_record_integrity',
    });
    expect(resolved?.selection.aggregate_effect).toBe('read');
    expect(resolved?.entry.effects).toBe('read');
    expect(resolved?.entry.authority_contract.subject).toEqual(senseRun.authority_contract.subject);
    expect(resolved?.entry.authority_contract.consent).toMatchObject({
      write: false,
      allow_publish: false,
    });
    expect(resolved?.entry.authority_contract.planner).toEqual({ kind: 'none' });
    expect(resolved?.entry.authority_contract.boundary).toEqual({ kind: 'none' });
  });

  it('rejects simultaneous positional kind and preset selection', () => {
    expect(() =>
      resolveSenseInvocation(senseRun, argv('decision_record_integrity', '--preset', 'baseline')),
    ).toThrow('SENSE_SELECTION_EXACTLY_ONE_REQUIRED');
  });

  it.each([
    ['unknown_kind', 'SENSE_KIND_UNKNOWN:unknown_kind'],
    ['--preset', 'SENSE_PRESET_UNKNOWN:unknown_preset'],
  ] as const)('rejects unknown %s selections', (kindOrFlag, expected) => {
    const args = kindOrFlag === '--preset' ? argv('--preset', 'unknown_preset') : argv(kindOrFlag);
    expect(() => resolveSenseInvocation(senseRun, args)).toThrow(expected);
  });

  it('requires and forwards the canonical round ID for sweep', () => {
    expect(() => resolveSenseInvocation(senseRun, argv('--preset', 'sweep'))).toThrow(
      'SENSE_ROUND_REQUIRED',
    );
    const resolved = resolveSenseInvocation(
      senseRun,
      argv('--preset', 'sweep', '--round', 'R-0007'),
    );
    expect(resolved?.selection.selection).toEqual({ type: 'preset', value: 'sweep' });
    expect(resolved?.selection.round_required).toBe(true);
    expect(resolved?.selection.round_id).toBe('R-0007');
  });

  it('rejects malformed round IDs even for a non-round-required kind', () => {
    expect(() =>
      resolveSenseInvocation(senseRun, argv('decision_record_integrity', '--round', 'round-7')),
    ).toThrow('SENSE_ROUND_INVALID:round-7');
  });

  it('projects database and remote capability targets without dropping either boundary', () => {
    const resolved = resolveSenseInvocation(senseRun, argv('runtime_probe_data'));
    expect(resolved?.selection.selection).toEqual({ type: 'kind', value: 'runtime_probe_data' });
    expect(resolved?.entry.effects).toBe('remote-write');
    expect(resolved?.entry.authority_contract.planner).toMatchObject({
      kind: 'bounded-batches',
      target_kinds: ['db', 'remote'],
    });
    expect(resolved?.entry.authority_contract.boundary).toMatchObject({
      kind: 'mutation-adapters',
      adapter_ids: ['db-authority-boundary', 'remote-authority-boundary'],
    });
  });
  it('keeps a filesystem-only selection free of database and remote boundaries', () => {
    const resolved = resolveSenseInvocation(senseRun, argv('build'));
    expect(resolved?.entry.effects).toBe('local-write');
    expect(resolved?.entry.authority_contract.planner).toMatchObject({
      kind: 'bounded-batches',
      target_kinds: ['fs'],
    });
    expect(resolved?.entry.authority_contract.boundary).toMatchObject({
      kind: 'mutation-adapters',
      adapter_ids: ['fs-authority-boundary'],
    });
    expect(resolved?.entry.authority_contract.consent).toMatchObject({
      write: true,
      allow_publish: false,
    });
  });

  it('projects a multi-sensor preset with one canonical entry per capability', () => {
    const resolved = resolveSenseInvocation(senseRun, argv('--preset', 'baseline'));
    const capabilities = resolved?.entry.authority_contract.capabilities ?? [];
    expect(capabilities.length).toBeGreaterThan(0);
    expect(capabilities).toEqual([...new Set(capabilities)]);
  });

  it('deduplicates repeated selected capabilities before authority projection', async () => {
    vi.resetModules();
    vi.doMock('../../src/commands/sense/facade.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/commands/sense/facade.js')>();
      return {
        ...actual,
        resolveSenseSelection: (
          ...args: Parameters<typeof actual.resolveSenseSelection>
        ): ReturnType<typeof actual.resolveSenseSelection> => {
          const selection = actual.resolveSenseSelection(...args);
          const member = selection.members[0];
          if (member === undefined) throw new Error('sense selection member missing');
          return {
            ...selection,
            aggregate_effect: 'local-write',
            members: [{ ...member, capabilities: ['fs:workspace', 'fs:workspace'] }],
          };
        },
      };
    });
    try {
      const isolated = await import('../../src/authority/sense-selection.js');
      const resolved = isolated.resolveSenseInvocation(senseRun, argv('decision_record_integrity'));
      expect(resolved?.entry.effects).toBe('local-write');
      expect(resolved?.entry.authority_contract.capabilities).toEqual(['fs:workspace']);
    } finally {
      vi.doUnmock('../../src/commands/sense/facade.js');
      vi.resetModules();
    }
  });

  it('rejects an unknown selected capability before projecting an authority contract', async () => {
    vi.resetModules();
    vi.doMock('../../src/commands/sense/facade.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/commands/sense/facade.js')>();
      return {
        ...actual,
        resolveSenseSelection: (
          ...args: Parameters<typeof actual.resolveSenseSelection>
        ): ReturnType<typeof actual.resolveSenseSelection> => {
          const selection = actual.resolveSenseSelection(...args);
          const member = selection.members[0];
          if (member === undefined) throw new Error('sense selection member missing');
          return {
            ...selection,
            members: [{ ...member, capabilities: ['unknown:capability'] }],
          };
        },
      };
    });
    try {
      const isolated = await import('../../src/authority/sense-selection.js');
      expect(() =>
        isolated.resolveSenseInvocation(senseRun, argv('decision_record_integrity')),
      ).toThrow('SENSE_CAPABILITY_UNKNOWN:unknown:capability');
    } finally {
      vi.doUnmock('../../src/commands/sense/facade.js');
      vi.resetModules();
    }
  });
});
