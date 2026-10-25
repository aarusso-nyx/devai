import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveInvocationEntry } from '../../src/authority/sense-selection.js';
import { boundedSelectors } from '../../src/authority/broker-targets.js';
import { buildCoreAuthorityRules } from '../../src/authority/policy-core-rules.js';
import { machineSubject, subjectGroups } from '../../src/authority/policy-support.js';
import { deriveActionEffectFromCapabilities } from '../../src/command-manifest.js';
import { routeArgv } from '../../src/command-router.js';
import { stripAuthorityArgv } from '../../src/authority/authority-harness.js';
import { parseReconciliationHostInput } from '../../src/authority/reconciliation-host-input.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-provision-selection-')));
const entries = canonicalRegistry();
const entry = entries.find((value) => value.name === 'init bind');
if (entry === undefined) throw new Error('canonical init bind missing');
const flags = [
  '--reconciliation-host',
  '--target',
  root,
  '--as-role',
  'architect',
  '--write',
  '--format',
  'json',
];
const argv = (args: readonly string[]) => [process.execPath, 'devai', 'init', 'bind', ...args];
afterAll(() => rmSync(root, { recursive: true }));

describe('exact native host opt-in is narrower than ordinary binding', () => {
  it('routes authority-stripped argv while requiring the original role at native authorization', () => {
    const original = argv(flags);
    const stripped = stripAuthorityArgv(original);
    expect(routeArgv(stripped, entries, '2.8.0').kind).toBe('dispatch');
    expect(() => parseReconciliationHostInput('init bind', stripped, root, 'architect')).toThrow(
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
    );
    expect(resolveInvocationEntry(entry, original).authority_contract.planner.kind).toBe(
      'exact-plan',
    );
  });
  it('admits only the protected resource with one exact plan and no filesystem or subprocess capability', () => {
    const resolved = resolveInvocationEntry(entry, argv(flags));
    expect(resolved.effects).toBe('local-write');
    expect(deriveActionEffectFromCapabilities(resolved.authority_contract.capabilities)).toBe(
      resolved.effects,
    );
    expect(resolved.authority_contract.capabilities).toEqual(['reconciliation-host:write']);
    expect(resolved.authority_contract.planner).toMatchObject({
      kind: 'exact-plan',
      target_kinds: ['reconciliation-host'],
      atomicity: 'whole-plan',
    });
    expect(resolved.authority_contract.boundary).toMatchObject({
      adapter_ids: ['reconciliation-host-authority-boundary'],
    });
    expect(resolved.authority_contract.subject).toEqual(entry.authority_contract.subject);
  });
  it.each([
    '--constitution',
    '--full',
    '--review-authority-policy',
    '--after-constitution',
    '--human',
    '--reconciliation-host',
  ])('refuses mixed or duplicated selector %s', (flag) => {
    expect(() => resolveInvocationEntry(entry, argv([...flags, flag]))).toThrow(
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
    );
  });
  it.each(['--authority-session', '--plan', '--approval', '--adopter-policy', '--tier'])(
    'refuses foreign selector %s',
    (flag) => {
      expect(() => resolveInvocationEntry(entry, argv([...flags, flag, 'fixture']))).toThrow(
        'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
      );
    },
  );
  it.each(['owner', 'inspector', 'engineer', 'Architect'])(
    'refuses another initiating role %s',
    (role) => {
      expect(() =>
        resolveInvocationEntry(entry, argv(flags.map((v) => (v === 'architect' ? role : v)))),
      ).toThrow('AUTHORITY_RECONCILIATION_INVOCATION_INVALID');
    },
  );
  it('requires explicit write consent', () => {
    expect(() => resolveInvocationEntry(entry, argv(flags.filter((v) => v !== '--write')))).toThrow(
      'AUTHORITY_RECONCILIATION_INVOCATION_INVALID',
    );
  });
  it.each(['--constitution', '--review-authority-policy'])(
    'preserves ordinary binding selection %s',
    (selector) => {
      expect(resolveInvocationEntry(entry, argv([selector]))).toBe(entry);
    },
  );
  it.each(['reconciliation-host', 'proof-index'])(
    'never turns protected %s into a legacy remote bounded selector',
    (kind) => {
      expect(boundedSelectors(kind, 'fixture-repository', 'init bind')).toEqual([]);
    },
  );
  it('grants only binding-machine provision for this repository, with Architect initiation', () => {
    const rules = buildCoreAuthorityRules({
      entries: entries.filter(
        (value) =>
          ![
            'evidence reconcile approve',
            'evidence reconcile materialize',
            'evidence reconcile stage-proof',
            'sense bootstrap-inventory',
          ].includes(value.name),
      ),
      repositoryId: 'fixture-repository',
      groups: subjectGroups(entries),
      human: (role) => [{ kind: 'human', roles: [role] }],
      joint: [],
    });
    // Preserve the original provisioning-only 70-action population and its one-rule upper bound.
    expect(
      entries.filter(
        (value) =>
          ![
            'evidence reconcile approve',
            'evidence reconcile materialize',
            'evidence reconcile stage-proof',
            'sense bootstrap-inventory',
          ].includes(value.name),
      ),
    ).toHaveLength(70);
    const rule = rules.find((value) => value.rule_id === 'core-reconciliation-host-provision');
    expect(rule).toMatchObject({
      action_ids: ['init bind'],
      selector: {
        kind: 'reconciliation-host',
        repository_id: 'fixture-repository',
        operations: ['provision'],
      },
      subjects: [machineSubject('binding')],
      required_consent: { write: true, allow_publish: false, experimental: false },
    });
    expect(rules.filter((value) => value.selector.kind === 'reconciliation-host')).toHaveLength(1);
  });
});
