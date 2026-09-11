import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const schemaBoundary = vi.hoisted(() => ({
  roster: ['alpha.schema.json', 'beta.schema.json'] as readonly string[],
  checkSchemas: vi.fn(),
  getValidator: vi.fn(),
  metaGate: vi.fn(),
}));
const fsBoundary = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  actualReaddirSync: undefined as typeof import('node:fs').readdirSync | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsBoundary.actualReaddirSync = actual.readdirSync;
  fsBoundary.readdirSync.mockImplementation(actual.readdirSync);
  return { ...actual, readdirSync: fsBoundary.readdirSync };
});

vi.mock('@devai-nyx/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/schemas')>()),
  ROSTER: schemaBoundary.roster,
  checkSchemas: schemaBoundary.checkSchemas,
  getValidator: schemaBoundary.getValidator,
  metaGate: schemaBoundary.metaGate,
}));

import {
  knownCheckMembers,
  loadCheckSuitePolicy,
  resolveCheckPlan,
  suggestCheckMembers,
} from '../../src/commands/check/contracts.js';
import {
  checkAdopterSchemas,
  checkSchemaCanon,
  checkSchemasCmd,
  checkSchemasForRepository,
} from '../../src/commands/check/schemas.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

beforeEach(() => {
  const actualReaddirSync = fsBoundary.actualReaddirSync;
  if (actualReaddirSync === undefined) throw new Error('real readdirSync unavailable');
  fsBoundary.readdirSync.mockImplementation(actualReaddirSync);
  schemaBoundary.checkSchemas.mockReturnValue([]);
  schemaBoundary.getValidator.mockReturnValue(Object.assign(() => true, { errors: null }));
  schemaBoundary.metaGate.mockReturnValue({ noncompliant: [] });
});

afterEach(() => {
  fsBoundary.readdirSync.mockReset();
  schemaBoundary.checkSchemas.mockReset();
  schemaBoundary.getValidator.mockReset();
  schemaBoundary.metaGate.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function put(root: string, relative: string, value: unknown): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}

function canonicalPolicy(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function policyRoot(
  value: unknown = canonicalPolicy(),
  mutate?: (policy: Record<string, unknown>) => void,
): string {
  const root = temporaryRoot('devai-s06-contract-schema-policy-');
  if (mutate !== undefined) mutate(value as Record<string, unknown>);
  const target = join(root, 'law/policy/check-suites.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value)}\n`);
  return root;
}

describe('S06-A policy parsing and public selection residuals', () => {
  it('reconstructs the complete policy object and preserves every declared ordering boundary', () => {
    const expected = canonicalPolicy();
    delete expected['$schema'];

    expect(loadCheckSuitePolicy(policyRoot())).toEqual(expected);
  });

  it.each([
    [null, 'CHECK_POLICY_INVALID: expected object'],
    [[], 'CHECK_POLICY_INVALID: expected object'],
    ['scalar', 'CHECK_POLICY_INVALID: expected object'],
  ] as const)('rejects a non-record policy %# with the exact public error', (value, error) => {
    expect(() => loadCheckSuitePolicy(policyRoot(value))).toThrow(error);
  });

  it.each([
    ['prerequisites', [1], 'CHECK_POLICY_PREREQUISITES_INVALID: expected string array'],
    ['prerequisites', 'one', 'CHECK_POLICY_PREREQUISITES_INVALID: expected string array'],
    ['member_definitions', null, 'CHECK_POLICY_MEMBERS_INVALID: expected array'],
    ['suites', null, 'CHECK_POLICY_SUITES_INVALID'],
  ] as const)('rejects malformed %s populations exactly', (field, value, error) => {
    const root = policyRoot(canonicalPolicy(), (policy) => {
      policy[field] = value;
    });
    expect(() => loadCheckSuitePolicy(root)).toThrow(error);
  });

  it('binds member and suite validation errors to their exact indices and names', () => {
    const badMember = policyRoot(canonicalPolicy(), (policy) => {
      (policy['member_definitions'] as unknown[])[0] = null;
    });
    expect(() => loadCheckSuitePolicy(badMember)).toThrow(
      'CHECK_POLICY_MEMBER_INVALID:0: expected object',
    );

    const badBinding = policyRoot(canonicalPolicy(), (policy) => {
      const member = (policy['member_definitions'] as Array<Record<string, unknown>>)[0];
      if (member === undefined) throw new Error('fixture member absent');
      member['binding'] = null;
    });
    expect(() => loadCheckSuitePolicy(badBinding)).toThrow(
      'CHECK_POLICY_BINDING_INVALID:0: expected object',
    );

    const ambiguousBinding = policyRoot(canonicalPolicy(), (policy) => {
      const member = (policy['member_definitions'] as Array<Record<string, unknown>>)[0];
      if (member === undefined) throw new Error('fixture member absent');
      (member['binding'] as Record<string, unknown>)['argv'] = ['check'];
    });
    expect(() => loadCheckSuitePolicy(ambiguousBinding)).toThrow(
      'CHECK_POLICY_BINDING_INVALID:ledger-local',
    );

    const badSuiteMembers = policyRoot(canonicalPolicy(), (policy) => {
      const suite = (policy['suites'] as Array<Record<string, unknown>>)[0];
      if (suite === undefined) throw new Error('fixture suite absent');
      suite['members'] = [1];
    });
    expect(() => loadCheckSuitePolicy(badSuiteMembers)).toThrow(
      'CHECK_POLICY_SUITE_MEMBERS_INVALID:quick: expected string array',
    );

    const duplicateExcluded = policyRoot(canonicalPolicy(), (policy) => {
      const suite = (policy['suites'] as Array<Record<string, unknown>>)[0];
      if (suite === undefined) throw new Error('fixture suite absent');
      suite['excluded'] = ['one', 'one'];
    });
    expect(() => loadCheckSuitePolicy(duplicateExcluded)).toThrow(
      'CHECK_POLICY_SUITE_EXCLUDED_INVALID:quick: duplicate value',
    );

    const badExcluded = policyRoot(canonicalPolicy(), (policy) => {
      const suite = (policy['suites'] as Array<Record<string, unknown>>)[0];
      if (suite === undefined) throw new Error('fixture suite absent');
      suite['excluded'] = [1];
    });
    expect(() => loadCheckSuitePolicy(badExcluded)).toThrow(
      'CHECK_POLICY_SUITE_EXCLUDED_INVALID:quick: expected string array',
    );

    const duplicateSuiteMembers = policyRoot(canonicalPolicy(), (policy) => {
      const suite = (policy['suites'] as Array<Record<string, unknown>>)[0];
      if (suite === undefined) throw new Error('fixture suite absent');
      suite['members'] = ['ledger-local', 'ledger-local'];
    });
    expect(() => loadCheckSuitePolicy(duplicateSuiteMembers)).toThrow(
      'CHECK_POLICY_SUITE_MEMBERS_INVALID:quick: duplicate value',
    );

    const duplicateMembers = policyRoot(canonicalPolicy(), (policy) => {
      const definitions = policy['member_definitions'] as Array<Record<string, unknown>>;
      definitions.push({ ...definitions[0] });
    });
    expect(() => loadCheckSuitePolicy(duplicateMembers)).toThrow(
      'CHECK_POLICY_MEMBERS_INVALID: duplicate value',
    );

    const incompleteSuites = policyRoot(canonicalPolicy(), (policy) => {
      (policy['suites'] as unknown[]).pop();
    });
    expect(() => loadCheckSuitePolicy(incompleteSuites)).toThrow('CHECK_POLICY_SUITES_INVALID');
  });

  it('returns the full sorted selector population as an exact public contract', () => {
    expect(knownCheckMembers(ROOT)).toEqual([
      'action-coverage',
      'action-effects',
      'adrs',
      'blueprint',
      'ci-economy',
      'cli-reference',
      'dependencies',
      'docs-governance',
      'docs-links',
      'forbidden-actions',
      'glob-guards',
      'glossary',
      'invariant-strategies',
      'invariants',
      'journeys',
      'ledger-local',
      'ledger-rc',
      'mutation',
      'overrides',
      'pr-compliance',
      'prompt-overlays',
      'schema',
      'schemas',
      'sensor-integrity',
      'test-trace',
      'trace',
      'translation',
    ]);
  });

  it('discriminates edit distance, distance filtering, and deterministic tie ordering', () => {
    expect(suggestCheckMembers(ROOT, 'schemas')).toEqual(['schemas', 'schema']);
    expect(suggestCheckMembers(ROOT, 'schem')).toEqual(['schema', 'schemas']);
    expect(suggestCheckMembers(ROOT, 'zzzzzz')).toEqual([]);
    expect(suggestCheckMembers(ROOT, '')).toEqual([]);

    const capped = policyRoot(canonicalPolicy(), (policy) => {
      const definitions = policy['member_definitions'] as Array<Record<string, unknown>>;
      for (const id of ['bat', 'cat', 'hat', 'mat']) {
        definitions.push({
          id,
          binding: { kind: 'runtime-gate', gate_id: `check-${id}` },
          effect: 'read',
          cost: 'low',
          output: `${id}-report`,
        });
      }
    });
    expect(suggestCheckMembers(capped, 'sat')).toEqual(['bat', 'cat', 'hat']);
  });

  it('resolves legacy aliases only through their exact canonical member identities', () => {
    const root = policyRoot(canonicalPolicy(), (policy) => {
      const definitions = policy['member_definitions'] as Array<Record<string, unknown>>;
      for (const [id, effect] of [
        ['glossary-validation', 'read'],
        ['test-trace-validation', 'harness-write'],
        ['strategy-validation', 'remote-write'],
        ['schema-config-load', 'local-write'],
      ] as const) {
        definitions.push({
          id,
          binding: { kind: 'runtime-gate', gate_id: `gate-${id}` },
          effect,
          cost: 'medium',
          output: `${id}-report`,
        });
      }
    });

    expect(
      ['glossary', 'test-trace', 'invariant-strategies', 'schemas'].map((only) =>
        resolveCheckPlan(root, { only }),
      ),
    ).toEqual(
      [
        ['glossary', 'glossary-validation', 'read'],
        ['test-trace', 'test-trace-validation', 'harness-write'],
        ['invariant-strategies', 'strategy-validation', 'remote-write'],
        ['schemas', 'schema-config-load', 'local-write'],
      ].map(([selector, canonical, effect]) => ({
        selection: { kind: 'only', member: selector },
        prerequisites: [
          'clean-or-explicitly-described-worktree',
          'frozen-install-complete',
          'pnpm-run-devai-prepare',
        ],
        ordering: 'members-execute-in-declared-order-without-coalescing',
        members: [
          {
            id: selector,
            source: 'current-selector',
            service_id: selector,
            binding: { kind: 'runtime-gate', gate_id: `gate-${canonical}` },
            effect,
            cost: 'medium',
            output: `${canonical}-report`,
          },
        ],
        maximum_effect: effect,
      })),
    );
  });

  it('returns complete current-selector and suite plans with exact effects and member order', () => {
    expect(resolveCheckPlan(ROOT, { only: 'schemas' })).toEqual({
      selection: { kind: 'only', member: 'schemas' },
      prerequisites: [
        'clean-or-explicitly-described-worktree',
        'frozen-install-complete',
        'pnpm-run-devai-prepare',
      ],
      ordering: 'members-execute-in-declared-order-without-coalescing',
      members: [
        {
          id: 'schemas',
          source: 'current-selector',
          service_id: 'schemas',
          binding: { kind: 'runtime-gate', gate_id: 'check-schemas' },
          effect: 'read',
          cost: 'low',
          output: 'action-envelope-plus-schemas-report',
        },
      ],
      maximum_effect: 'read',
    });

    const root = policyRoot(canonicalPolicy(), (policy) => {
      const definitions = policy['member_definitions'] as Array<Record<string, unknown>>;
      definitions.push(
        {
          id: 'first-read',
          binding: { kind: 'runtime-gate', gate_id: 'first-read' },
          effect: 'read',
          cost: 'low',
          output: 'first-output',
        },
        {
          id: 'second-remote',
          binding: { kind: 'runtime-gate', gate_id: 'second-remote' },
          effect: 'remote-write',
          cost: 'high',
          output: 'second-output',
        },
      );
      const standard = (policy['suites'] as Array<Record<string, unknown>>)[1];
      if (standard === undefined) throw new Error('standard suite absent');
      standard['members'] = ['second-remote', 'first-read'];
    });
    expect(resolveCheckPlan(root, { suite: 'standard' })).toEqual({
      selection: { kind: 'suite', suite: 'standard' },
      prerequisites: [
        'clean-or-explicitly-described-worktree',
        'frozen-install-complete',
        'pnpm-run-devai-prepare',
      ],
      ordering: 'members-execute-in-declared-order-without-coalescing',
      members: [
        {
          id: 'second-remote',
          binding: { kind: 'runtime-gate', gate_id: 'second-remote' },
          effect: 'remote-write',
          cost: 'high',
          output: 'second-output',
          source: 'suite-policy',
          service_id: 'second-remote',
        },
        {
          id: 'first-read',
          binding: { kind: 'runtime-gate', gate_id: 'first-read' },
          effect: 'read',
          cost: 'low',
          output: 'first-output',
          source: 'suite-policy',
          service_id: 'first-read',
        },
      ],
      maximum_effect: 'remote-write',
    });
  });

  it('reports unknown suite selection with the exact requested identity', () => {
    expect(() => resolveCheckPlan(ROOT, { suite: 'almost-standard' })).toThrow(
      'CHECK_SUITE_UNKNOWN:almost-standard',
    );
  });
});

const SOURCE_ONLY_SCHEMAS = [
  'claim-runtime-inputs.schema.json',
  'documentation-information-architecture.schema.json',
  'inv-override.schema.json',
  'prompt-composition.schema.json',
  'stack-adapter.schema.json',
  'task-freshness.schema.json',
  'test-task-descriptor.schema.json',
] as const;

function schemaCanonRoot(): string {
  const root = temporaryRoot('devai-s06-contract-schema-canon-');
  for (const name of [...schemaBoundary.roster, ...SOURCE_ONLY_SCHEMAS]) {
    put(root, `law/schemas/${name}`, '{}');
    put(root, `packages/schemas/dist/schemas/${name}`, '{}');
  }
  for (const relative of [
    'packages/cli/src/generated/action-registry.ts',
    'packages/effects-check/src/generated/action-catalog.ts',
    'packages/sensors/src/generated/action-kinds.ts',
  ]) {
    put(root, relative, '// @generated from law/policy/action-registry.json\n');
  }
  return root;
}

describe('S06-A schema canon and dispatch residuals', () => {
  it('ignores non-schema directory entries and returns the complete ordered clean report', () => {
    const root = schemaCanonRoot();
    put(root, 'law/schemas/README.txt', 'not a schema');
    fsBoundary.readdirSync.mockReturnValue([
      'test-task-descriptor.schema.json',
      'README.txt',
      'beta.schema.json',
      'alpha.schema.json',
      ...SOURCE_ONLY_SCHEMAS.slice(0, -1).reverse(),
    ]);

    expect(checkSchemaCanon(root)).toEqual({
      ok: true,
      canonical_total: 9,
      rules: [
        'recursive-closed-complete-objects',
        'predicate-fragments-valid',
        'shared-vocabulary',
        'generated-marker-integrity',
        'dereferenced-publish-byte-identity',
      ],
      findings: [],
    });
  });

  it('retains every validator, vocabulary, and schema-canon finding in source order', () => {
    const root = schemaCanonRoot();
    schemaBoundary.getValidator.mockImplementation((name: string) => {
      if (name === 'beta.schema.json') throw new Error('beta predicate failed');
      return Object.assign(() => true, { errors: null });
    });
    schemaBoundary.metaGate.mockReturnValue({
      noncompliant: [{ name: 'vocabulary.schema.json', errors: ['first error', 'second error'] }],
    });
    schemaBoundary.checkSchemas.mockReturnValue([
      { rule: 'restated-verdict-enum', schema: 'alpha.schema.json', path: '/status' },
      { rule: 'open-object', schema: 'beta.schema.json', path: '/payload' },
    ]);

    expect(checkSchemaCanon(root).findings).toEqual([
      {
        rule: 'predicate-fragments-valid',
        path: 'law/schemas/beta.schema.json',
        message: 'beta predicate failed',
      },
      {
        rule: 'shared-vocabulary',
        path: 'law/schemas/vocabulary.schema.json',
        message: 'first error; second error',
      },
      {
        rule: 'shared-vocabulary',
        path: 'law/schemas/alpha.schema.json:/status',
        message: 'restated-verdict-enum',
      },
      {
        rule: 'recursive-closed-complete-objects',
        path: 'law/schemas/beta.schema.json:/payload',
        message: 'open-object',
      },
    ]);
  });

  it('serializes absent adopter validator errors and retains the complete returned object', () => {
    const root = temporaryRoot('devai-s06-contract-schema-adopter-');
    put(root, '.devai/config/project.json', { malformed: true });
    schemaBoundary.getValidator.mockReturnValue(Object.assign(() => false, { errors: undefined }));

    expect(checkAdopterSchemas(root)).toEqual({
      ok: false,
      mode: 'adopter-binding',
      checked: ['.devai/config/project.json'],
      findings: [
        {
          rule: 'adopter-binding-schema',
          path: '.devai/config/project.json',
          message: '[]',
        },
      ],
    });
  });

  it('dispatches exact source identity to canon and incomplete identity to adopter checks', () => {
    const source = schemaCanonRoot();
    put(source, 'package.json', { name: 'devai', private: true });
    put(source, 'packages/schemas/src/roster.ts', 'source roster');
    expect(checkSchemasForRepository(source)).toEqual({
      ok: true,
      canonical_total: 9,
      rules: [
        'recursive-closed-complete-objects',
        'predicate-fragments-valid',
        'shared-vocabulary',
        'generated-marker-integrity',
        'dereferenced-publish-byte-identity',
      ],
      findings: [],
    });

    const adopter = temporaryRoot('devai-s06-contract-schema-dispatch-');
    put(adopter, 'package.json', { name: 'devai', private: false });
    put(adopter, '.devai/config/project.json', { any: 'value' });
    expect(checkSchemasForRepository(adopter)).toEqual({
      ok: true,
      mode: 'adopter-binding',
      checked: ['.devai/config/project.json'],
      findings: [],
    });
  });

  it('preserves the exact exported command identity and registration strings', () => {
    const calls: Array<readonly [string, string]> = [];
    const options: Array<readonly [string, string]> = [];
    const chain = {
      option(flag: string, description: string) {
        options.push([flag, description]);
        return chain;
      },
      action() {
        return chain;
      },
    };
    checkSchemasCmd.register({
      command(name: string, description: string) {
        calls.push([name, description]);
        return chain;
      },
    } as unknown as CAC);

    expect(checkSchemasCmd).toMatchObject({
      name: 'check schemas',
      description: 'Validate the complete recursive schema canon and every governed schema rule.',
      authority: 'policy_firewall',
    });
    expect(calls).toEqual([
      [
        'check-schemas',
        'Validate the complete recursive schema canon and every governed schema rule.',
      ],
    ]);
    expect(options).toEqual([
      ['--repo-root <path>', 'Repository root (default: .)'],
      ['--format <format>', 'Output format: json or human'],
      ['--human', 'Human-readable output'],
    ]);
  });
});
