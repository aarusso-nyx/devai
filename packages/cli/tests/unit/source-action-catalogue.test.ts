import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';
import { classWriteVerbs } from '../../src/authority/policy-support.js';
import { buildTrustedAuthoritySources } from '../../src/authority/policy.js';
import { expectCurrentActionIds } from './historical-action-catalogue.js';

const root = resolve(import.meta.dirname, '../../../..');
const fixture = resolve(import.meta.dirname, '../fixtures/source-apply-b1');
const paths = [
  [
    'law/policy/action-registry.json',
    'a478ebfa1b3bb92044abcf5475b40e49dd0a9566ca21b357c99d0f395da5dace',
    'ba2ea9732dc66015289d5d1de8272d7266c20bc918a2b1208e2e64b7e3caeb13',
  ],
  [
    'packages/cli/src/generated/action-registry.ts',
    '1e93e6eb5b707a30d53c220fe26436547d25f397e36cde23fa0fa8ca2661131b',
    '9f08afa66c6c3d01cc8646a4abe716d132b29d56f53055d3fa87cf2a0fac526a',
  ],
  [
    'packages/effects-check/src/generated/action-catalog.ts',
    '7b36a21fa60dd0a2e8707a7658b84997e637848f58e20577e059d7a773da261e',
    'a4d20811209e8864ff988eff792cd35ed0ec7d9c1987a3e4e8b3758ac1a11bba',
  ],
  [
    'packages/sensors/src/generated/action-kinds.ts',
    'f6b113b84d8356232a4fbf23013f73f8696b486e1f79d596004aaf1411bb18fe',
    'f6b113b84d8356232a4fbf23013f73f8696b486e1f79d596004aaf1411bb18fe',
  ],
] as const;
const bytes = (path: string) => readFileSync(path);
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const parse = (path: string) =>
  JSON.parse(bytes(path).toString('utf8')) as {
    counts: Record<string, number>;
    entries: Array<{ action_id: string }>;
  };
const added = ['source apply architect', 'source apply engineer', 'source apply inspector'];

describe('source action catalogue transition', () => {
  it.each(paths)('preserves historical and candidate bytes for %s', (path, b1, candidate) => {
    expect(sha(bytes(join(fixture, `${path}.txt`)))).toBe(b1);
    expect(sha(bytes(join(root, path)))).toBe(candidate);
  });
  it('retains all 74 complete B1 entries and adds exactly three reviewed contracts', () => {
    const b1 = parse(join(fixture, 'law/policy/action-registry.json.txt'));
    const live = parse(join(root, 'law/policy/action-registry.json'));
    const extra = live.entries.filter((entry) => added.includes(entry.action_id));
    expectCurrentActionIds(b1.entries.map((entry) => entry.action_id));
    expect(live.entries).toHaveLength(77);
    expect(live.counts).toEqual({ ...b1.counts, preview: 25, total: 77 });
    expect(live.entries.filter((entry) => !added.includes(entry.action_id))).toEqual(b1.entries);
    expect(extra).toEqual(
      JSON.parse(
        bytes(
          resolve(import.meta.dirname, '../fixtures/source-apply-registry-entries.json'),
        ).toString('utf8'),
      ),
    );
  });
  it('admits exactly the three role-specific verbs to the current class sets', () => {
    expect(classWriteVerbs(canonicalRegistry())).toEqual({
      root: ['source apply engineer', 'task start'],
      test: ['check', 'source apply inspector'],
      architecture: [
        'init apply architect',
        'release export',
        'round plan',
        'round seal',
        'source apply architect',
      ],
    });
  });
  it('continues to reject read, state-only, mixed-initiator and non-harness variants in the live registry', () => {
    const entries = canonicalRegistry();
    const check = entries.find((entry) => entry.name === 'check');
    const task = entries.find((entry) => entry.name === 'task start');
    if (!check || !task) throw new Error('BASE_ACTION_MISSING');
    const variant = (
      entry: RegistryEntry,
      name: string,
      effect: RegistryEntry['effects'],
      capabilities: readonly string[],
      subject: object,
    ): RegistryEntry =>
      ({
        ...entry,
        name,
        handler: name.replaceAll(' ', '-'),
        effects: effect,
        authority_contract: { ...entry.authority_contract, action_id: name, capabilities, subject },
      }) as RegistryEntry;
    const additions = [
      variant(
        check,
        'synthetic live read',
        'read',
        ['fs:workspace'],
        check.authority_contract.subject,
      ),
      variant(
        task,
        'synthetic live state',
        'local-write',
        ['fs:f5-state'],
        task.authority_contract.subject,
      ),
      variant(task, 'synthetic live mixed', 'harness-write', ['fs:workspace'], {
        kind: 'derived-machine',
        actor: 'harness',
        transition: 'harness-write',
        initiator: { allowed_roles: ['engineer', 'inspector'], preserve_in_context: true },
      }),
      variant(task, 'synthetic live binding', 'harness-write', ['fs:workspace'], {
        kind: 'derived-machine',
        actor: 'binding',
        transition: 'bind',
        initiator: { allowed_roles: ['engineer'], preserve_in_context: true },
      }),
    ];
    expect(classWriteVerbs([...entries, ...additions])).toEqual(classWriteVerbs(entries));
    const architect = entries.find((entry) => entry.name === 'round seal');
    if (!architect) throw new Error('BASE_ACTION_MISSING');
    const positive = [
      variant(
        check,
        'synthetic live inspector write',
        check.effects,
        ['fs:workspace'],
        check.authority_contract.subject,
      ),
      variant(
        architect,
        'synthetic live architect write',
        architect.effects,
        ['fs:workspace'],
        architect.authority_contract.subject,
      ),
    ];
    const base = classWriteVerbs(entries);
    expect(classWriteVerbs([...entries, ...additions, ...positive])).toEqual({
      root: base.root,
      test: [...base.test, 'synthetic live inspector write'].sort(),
      architecture: [...base.architecture, 'synthetic live architect write'].sort(),
    });
  });
  it('limits source Inspector core grants to the two Article 6 test roots', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-source-core-'));
    try {
      mkdirSync(join(repo, '.devai/config'), { recursive: true });
      writeFileSync(
        join(repo, '.devai/config/project.json'),
        JSON.stringify({ name: 'source-core-test' }),
      );
      const sources = buildTrustedAuthoritySources(
        canonicalRegistry(),
        repo,
        '0.0.0-test',
        readFileSync(join(root, 'law/constitution.md'), 'utf8'),
      );
      const rules = sources.immutableCore.rules;
      const selected = rules.filter((rule) => rule.rule_id.startsWith('core-inspector-source-'));
      expect(selected.map((rule) => rule.rule_id)).toEqual([
        'core-inspector-source-tests',
        'core-inspector-source-package-tests',
      ]);
      expect(
        selected.map((rule) => ({
          actions: rule.action_ids,
          precedence: rule.precedence,
          subjects: rule.subjects,
          glob: rule.selector.canonical_relative_path_glob,
          operations: rule.selector.operations,
        })),
      ).toEqual([
        {
          actions: ['source apply inspector'],
          precedence: 800,
          subjects: [{ kind: 'human', roles: ['inspector'] }],
          glob: 'tests/**',
          operations: ['create', 'update'],
        },
        {
          actions: ['source apply inspector'],
          precedence: 800,
          subjects: [{ kind: 'human', roles: ['inspector'] }],
          glob: 'packages/*/tests/**',
          operations: ['create', 'update'],
        },
      ]);
      expect(
        rules.some((rule) =>
          ['core-inspector-tests', 'core-inspector-tests-plural'].includes(rule.rule_id),
        ),
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('changes only the explicitly identified live core and package-extension action groups', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-source-delta-'));
    try {
      mkdirSync(join(repo, '.devai/config'), { recursive: true });
      writeFileSync(
        join(repo, '.devai/config/project.json'),
        JSON.stringify({ name: 'source-delta-test' }),
      );
      const entries = canonicalRegistry();
      const oldEntries = entries.filter((entry) => !added.includes(entry.name));
      const constitution = readFileSync(join(root, 'law/constitution.md'), 'utf8');
      const old = buildTrustedAuthoritySources(oldEntries, repo, '0.0.0-test', constitution);
      const current = buildTrustedAuthoritySources(entries, repo, '0.0.0-test', constitution);
      const architectCore = new Set([
        'core-joint-glossary-root',
        'core-joint-glossary',
        'core-architect-docs-root',
        'core-architect-docs',
        'core-architect-governance-1',
        'core-architect-governance-2',
        'core-architect-work-records-1',
        'core-architect-work-records-2',
        'core-architect-work-records-3',
        'core-architect-work-records-4',
        'core-round-workspace-container-1',
        'core-round-workspace-container-2',
        'core-round-workspace-container-3',
        'core-architect-local-rounds-root',
        'core-architect-local-rounds',
      ]);
      const engineerExtension = new Set([
        'adopter-engineer-packages',
        'adopter-engineer-scripts',
        'adopter-engineer-workflows',
        ...Array.from({ length: 7 }, (_, index) => `adopter-engineer-root-${String(index + 1)}`),
      ]);
      const architectExtension = new Set(
        Array.from({ length: 6 }, (_, index) => `adopter-architect-root-${String(index + 1)}`),
      );
      const expectedRules = (
        rules: typeof old.immutableCore.rules,
        architect: Set<string>,
        engineer = new Set<string>(),
      ) =>
        rules.map((rule) => ({
          ...rule,
          action_ids: architect.has(rule.rule_id)
            ? [...rule.action_ids, 'source apply architect'].sort()
            : engineer.has(rule.rule_id)
              ? [...rule.action_ids, 'source apply engineer'].sort()
              : rule.action_ids,
        }));
      const addedCore = new Set([
        'core-inspector-source-tests',
        'core-inspector-source-package-tests',
      ]);
      expect(current.immutableCore.rules.filter((rule) => !addedCore.has(rule.rule_id))).toEqual(
        expectedRules(old.immutableCore.rules, architectCore),
      );
      expect(current.additiveExtensions[0]?.rules).toEqual(
        expectedRules(
          old.additiveExtensions[0]?.rules ?? [],
          architectExtension,
          engineerExtension,
        ),
      );
      expect(current.additiveExtensions[0]?.canonical_source_bytes).not.toEqual(
        old.additiveExtensions[0]?.canonical_source_bytes,
      );
      const extension = current.additiveExtensions[0];
      if (extension === undefined) throw new Error('SOURCE_EXTENSION_MISSING');
      expect({
        core: sha(current.immutableCore.canonical_source_bytes),
        extension: sha(extension.canonical_source_bytes),
      }).toEqual({
        core: 'c1b199853e0a4cdb2bdb4f4f74940a55a316ecaf2846c0ba741242f87bdc0eef',
        extension: '7343fcdd340a448e96505da1ed2f4e82b9a2f516b15165b5406dd2a34d6aa991',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
