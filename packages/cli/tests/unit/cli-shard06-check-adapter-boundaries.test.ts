// S06-A score-bearing public contract seams. CompileError tuples are excluded
// from the shard score; these cases target surviving and uncovered predicates.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dependencyBoundary = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: dependencyBoundary.spawnSync,
}));

import {
  aggregateCheckResults,
  knownCheckMembers,
  loadCheckSuitePolicy,
  resolveCheckPlan,
  runCheckPlan,
  suggestCheckMembers,
  type CheckMemberResult,
  type ResolvedCheckMember,
} from '../../src/commands/check/contracts.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import { checkActionEffectsCmd } from '../../src/commands/check/action-effects.js';
import { checkDependencies } from '../../src/commands/check/dependencies.js';
import { checkSchemasForRepository } from '../../src/commands/check/schemas.js';
import { checkSensorIntegrityCmd } from '../../src/commands/check/sensor-integrity.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

afterEach(() => {
  dependencyBoundary.spawnSync.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join('/tmp', prefix));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}

function policyRoot(mutator?: (policy: Record<string, unknown>) => void): string {
  const root = temporaryRoot('devai-s06-policy-');
  const policy = JSON.parse(
    readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8'),
  ) as Record<string, unknown>;
  mutator?.(policy);
  put(root, 'law/policy/check-suites.json', policy);
  return root;
}

describe('S06-A check contract selection and policy boundaries', () => {
  it('loads the canonical policy through the fallback and preserves its public shape', () => {
    const fallbackRoot = temporaryRoot('devai-s06-policy-fallback-');
    const fallback = loadCheckSuitePolicy(fallbackRoot);
    const local = loadCheckSuitePolicy(ROOT);

    expect(fallback).toEqual(local);
    expect(fallback).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'check-suites',
      status: 'active',
      authority: 'Architect',
      ordering: 'members-execute-in-declared-order-without-coalescing',
      unknown_behavior: 'error-never-pass',
    });
    expect(fallback.prerequisites).toEqual([
      'clean-or-explicitly-described-worktree',
      'frozen-install-complete',
      'pnpm-run-devai-prepare',
    ]);
    expect(
      fallback.suites.map(({ name, members, excluded }) => ({ name, members, excluded })),
    ).toEqual([
      { name: 'quick', members: ['ledger-local'], excluded: [] },
      { name: 'standard', members: ['ledger-local'], excluded: [] },
      { name: 'full', members: ['ledger-rc'], excluded: [] },
      { name: 'release', members: ['ledger-rc'], excluded: [] },
    ]);
  });

  it.each([
    ['schemaVersion', '2.0.0'],
    ['id', 'other-policy'],
    ['status', 'inactive'],
    ['authority', 'Owner'],
    ['decision', 'unexpected'],
    ['ordering', 'unordered'],
    ['unknown_behavior', 'pass-unknown'],
  ] as const)('rejects policy identity drift in %s', (field, value) => {
    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          policy[field] = value;
        }),
      ),
    ).toThrow('CHECK_POLICY_INVALID: canonical identity or behavior drifted');
  });

  it('fails closed for malformed populations and suite references', () => {
    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          policy.prerequisites = [];
        }),
      ),
    ).toThrow('CHECK_POLICY_PREREQUISITES_INVALID: empty population');

    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          const members = policy.member_definitions as Array<Record<string, unknown>>;
          const first = members[0];
          const second = members[1];
          if (first === undefined || second === undefined) throw new Error('fixture incomplete');
          second.id = first.id;
        }),
      ),
    ).toThrow('CHECK_POLICY_MEMBERS_INVALID: duplicate value');

    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          const members = policy.member_definitions as Array<Record<string, unknown>>;
          const first = members[0];
          if (first === undefined) throw new Error('fixture incomplete');
          const binding = first.binding as Record<string, unknown>;
          binding.argv = ['check'];
          binding.gate_id = 'also-present';
        }),
      ),
    ).toThrow('CHECK_POLICY_BINDING_INVALID:ledger-local');

    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          const suites = policy.suites as Array<Record<string, unknown>>;
          const second = suites[1];
          if (second === undefined) throw new Error('fixture incomplete');
          second.name = 'quick';
        }),
      ),
    ).toThrow('CHECK_POLICY_SUITE_ORDER_INVALID:quick');

    expect(() =>
      loadCheckSuitePolicy(
        policyRoot((policy) => {
          const suites = policy.suites as Array<Record<string, unknown>>;
          const first = suites[0];
          if (first === undefined) throw new Error('fixture incomplete');
          const members = first.members as string[];
          members[0] = 'missing-member';
        }),
      ),
    ).toThrow('CHECK_POLICY_SUITE_MEMBER_UNKNOWN:missing-member');
  });

  it('returns the complete known selector population and deterministic typo suggestions', () => {
    const known = knownCheckMembers(ROOT);
    expect(known).toEqual([
      'action-coverage',
      'action-effects',
      'adrs',
      'blueprint',
      'change-taxonomy',
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
    expect(suggestCheckMembers(ROOT, 'schem')).toEqual(['schema', 'schemas']);
    expect(suggestCheckMembers(ROOT, 'schemaa')).toEqual(['schema', 'schemas']);
    expect(suggestCheckMembers(ROOT, 'schemass')).toEqual(['schemas', 'schema']);
    expect(suggestCheckMembers(ROOT, 'zzzzzz')).toEqual([]);
  });

  it('resolves aliases and current selectors with exact public effects and bindings', () => {
    expect(resolveCheckPlan(ROOT, { only: 'schemas' })).toMatchObject({
      selection: { kind: 'only', member: 'schemas' },
      maximum_effect: 'read',
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
    });
    expect(resolveCheckPlan(ROOT, { only: 'translation' })).toMatchObject({
      selection: { kind: 'only', member: 'translation' },
      maximum_effect: 'local-write',
      members: [{ service_id: 'translation', effect: 'local-write', cost: 'high' }],
    });
    expect(() => resolveCheckPlan(ROOT, { suite: 'quick', only: 'ledger-local' })).toThrow(
      'CHECK_SELECTION_CONFLICT: --suite and --only are mutually exclusive',
    );
    expect(() => resolveCheckPlan(ROOT, { only: 'not-a-selector' })).toThrow(
      'CHECK_MEMBER_UNKNOWN:not-a-selector',
    );
    expect(() => resolveCheckPlan(ROOT, { suite: 'missing-suite' })).toThrow(
      'CHECK_SUITE_UNKNOWN:missing-suite',
    );
  });

  function result(id: string, status: CheckMemberResult['status']): CheckMemberResult {
    return {
      id,
      status,
      effect: 'read',
      binding: { kind: 'runtime-gate', gate_id: `check-${id}` },
      duration_ms: 1,
    };
  }

  it('aggregates readiness and execution with fail, review, unknown, and error precedence', () => {
    expect(aggregateCheckResults([result('pass', 'pass')])).toEqual({
      execution_status: 'pass',
      readiness_status: 'pass',
      counts: { pass: 1, review: 0, fail: 0, unknown: 0, na: 0, error: 0 },
      exit_code: 0,
    });
    expect(
      aggregateCheckResults([result('review', 'review'), result('unknown', 'unknown')]),
    ).toEqual({
      execution_status: 'pass',
      readiness_status: 'review',
      counts: { pass: 0, review: 1, fail: 0, unknown: 1, na: 0, error: 0 },
      exit_code: 1,
    });
    expect(
      aggregateCheckResults([result('fail', 'fail'), result('review', 'review')]),
    ).toMatchObject({
      execution_status: 'pass',
      readiness_status: 'fail',
      exit_code: 2,
    });
    expect(aggregateCheckResults([result('error', 'error'), result('pass', 'pass')])).toMatchObject(
      {
        execution_status: 'error',
        readiness_status: 'pass',
        exit_code: 2,
      },
    );
    expect(aggregateCheckResults([])).toMatchObject({
      execution_status: 'pass',
      readiness_status: 'na',
      exit_code: 0,
    });
  });

  it('turns executor identity mismatches and throws into bounded public errors', async () => {
    const plan = resolveCheckPlan(ROOT, { only: 'schemas' });
    const mismatch = await runCheckPlan(plan, () => result('wrong-id', 'pass'));
    expect(mismatch).toMatchObject({
      ok: false,
      execution_status: 'error',
      readiness_status: 'na',
      counts: { error: 1 },
      results: [
        {
          id: 'schemas',
          status: 'error',
          code: 'CHECK_RESULT_IDENTITY_MISMATCH',
          message: 'executor returned wrong-id for schemas',
        },
      ],
    });

    const thrown = await runCheckPlan(plan, () => {
      throw new Error('service exploded');
    });
    expect(thrown.results).toEqual([
      expect.objectContaining({
        id: 'schemas',
        status: 'error',
        code: 'CHECK_EXECUTION_ERROR',
        message: 'service exploded',
        duration_ms: 0,
      }),
    ]);
  });
});

function processResult(status: number, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, error: undefined };
}

function subprocessMember(serviceId: string): ResolvedCheckMember {
  return {
    id: serviceId,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'literal-argv', argv: ['pnpm', 'vitest', 'run'] },
    effect: 'read',
    cost: 'medium',
    output: 'action-envelope',
  };
}

function recordingCli(): {
  readonly cli: { command: (name: string, description: string) => unknown };
  readonly commands: Array<{ name: string; description: string; options: string[] }>;
} {
  const commands: Array<{ name: string; description: string; options: string[] }> = [];
  const cli = {
    command(name: string, description: string) {
      const entry = { name, description, options: [] as string[] };
      commands.push(entry);
      const builder = {
        option(option: string) {
          entry.options.push(option);
          return builder;
        },
        action() {
          return builder;
        },
      };
      return builder;
    },
  };
  return { cli, commands };
}

describe('S06-A check command registration contracts', () => {
  it('preserves the action-effects command identity and registration spelling', () => {
    const { cli, commands } = recordingCli();
    checkActionEffectsCmd.register(cli as never);
    expect(checkActionEffectsCmd).toMatchObject({
      name: 'check action-effects',
      authority: 'policy_firewall',
    });
    expect(commands).toEqual([
      {
        name: 'check-action-effects',
        description: 'Run the shadow action-effect analyzer',
        options: ['--repo-root <path>', '--tsconfig <path>', '--registry <path>', '--human'],
      },
    ]);
  });

  it('preserves the sensor-integrity command identity and registration defaults', () => {
    const { cli, commands } = recordingCli();
    checkSensorIntegrityCmd.register(cli as never);
    expect(checkSensorIntegrityCmd).toMatchObject({
      name: 'check sensor-integrity',
      description:
        'Flag SensorReadings that share a command_hash across distinct sensor.kind values (relabeled, not independently measured). Advisory: exits REVIEW on findings, never FAIL.',
    });
    expect(commands).toEqual([
      {
        name: 'check-sensor-integrity',
        description: 'Flag relabeled SensorReadings (shared command_hash, distinct kinds)',
        options: ['--repo-root <path>', '--readings-dir <path>', '--human'],
      },
    ]);
  });
});

describe('S06-A subprocess adapter status boundaries', () => {
  it('fails closed when a subprocess returns malformed JSON with a failing exit code', async () => {
    dependencyBoundary.spawnSync.mockReturnValue(processResult(1, 'not-json', 'stderr-text'));

    const result = await executeCheckMember(subprocessMember('full-tests'), { repoRoot: ROOT });
    expect(result).toMatchObject({
      id: 'full-tests',
      status: 'fail',
      stdout: 'not-json',
      stderr: 'stderr-text',
      exit_code: 1,
    });
    expect(result).not.toHaveProperty('value');
  });
});

function dependencyRoot(): string {
  const root = temporaryRoot('devai-s06-dependencies-');
  put(root, 'package.json', { packageManager: 'pnpm@10.0.0' });
  put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  put(root, 'docs/site/package-lock.json', '{"lockfileVersion":3}\n');
  return root;
}

function cleanModernAudit(): Record<string, unknown> {
  return {
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  };
}

function configureAudits(pnpm: unknown, npm: unknown): void {
  dependencyBoundary.spawnSync.mockImplementation(
    (executable?: string, args?: readonly string[]) => {
      if (args?.[0] === '--version')
        return processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n');
      return processResult(1, JSON.stringify(executable === 'pnpm' ? pnpm : npm));
    },
  );
}

describe('S06-A dependency normalization and aggregate boundaries', () => {
  it('keeps numeric fallback IDs, empty patched versions, and sorted aliases exact', () => {
    const root = dependencyRoot();
    configureAudits(
      {
        advisories: {
          numeric: {
            source: 42,
            github_advisory_id: '',
            id: '',
            module_name: 'numeric-package',
            severity: 'low',
            vulnerable_versions: '<1',
            patched_versions: '<0.0.0',
            cves: ['Z-2', ''],
            aliases: ['A-1'],
            cwe: ['CWE-1'],
          },
        },
        metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } },
      },
      cleanModernAudit(),
    );
    const result = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });
    expect(result.status).toBe('review');
    expect('universes' in result && result.universes.map((universe) => universe.status)).toEqual([
      'review',
      'pass',
    ]);
    expect('universes' in result && result.universes[0]?.advisories).toEqual([
      {
        id: '42',
        package: 'numeric-package',
        severity: 'low',
        affected_range: '<1',
        fixed_versions: [],
        aliases: ['A-1', 'CWE-1', 'Z-2'],
      },
    ]);
  });

  it('rejects empty and conflicting advisory identities instead of laundering raw output', () => {
    const root = dependencyRoot();
    const emptyId = {
      advisories: {
        empty: {
          module_name: 'empty-id',
          severity: 'low',
          vulnerable_versions: '<1',
          patched_versions: '>=1',
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } },
    };
    configureAudits(emptyId, cleanModernAudit());
    const emptyResult = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });
    expect(emptyResult.status).toBe('unknown');
    expect('universes' in emptyResult && emptyResult.universes[0]?.status).toBe('unknown');

    const conflicting = {
      advisories: {
        first: {
          source: 'ADV-1',
          module_name: 'same-package',
          severity: 'low',
          vulnerable_versions: '<1',
          patched_versions: '>=1',
        },
        second: {
          source: 'ADV-1',
          module_name: 'same-package',
          severity: 'high',
          vulnerable_versions: '<2',
          patched_versions: '>=2',
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0 } },
    };
    configureAudits(conflicting, cleanModernAudit());
    const conflictingResult = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });
    expect(conflictingResult.status).toBe('unknown');
    expect('universes' in conflictingResult && conflictingResult.universes[0]?.status).toBe(
      'unknown',
    );
  });

  it('accepts modern reference plus object advisories and preserves fallback fields', () => {
    const root = dependencyRoot();
    configureAudits(cleanModernAudit(), {
      vulnerabilities: {
        modern: {
          name: 'modern-package',
          severity: 'moderate',
          range: '<2',
          via: [
            'ADV-2',
            {
              source: 'ADV-2',
              dependency: 'modern-package',
              severity: 'moderate',
              range: '<2',
            },
          ],
        },
        'ADV-2': { source: 'ADV-2', via: [] },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
    });
    const result = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });
    expect(result.status).toBe('review');
    expect('universes' in result && result.universes.map((universe) => universe.status)).toEqual([
      'pass',
      'review',
    ]);
    expect('universes' in result && result.universes[1]?.advisories[0]).toEqual({
      id: 'ADV-2',
      package: 'modern-package',
      severity: 'moderate',
      affected_range: '<2',
      fixed_versions: [],
      aliases: [],
    });
  });

  it('applies aggregate status precedence across complete pnpm and npm universes', () => {
    const root = dependencyRoot();
    const cleanClassic = {
      advisories: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    };
    const reviewClassic = {
      advisories: {
        review: {
          source: 'ADV-REVIEW',
          module_name: 'review-package',
          severity: 'low',
          vulnerable_versions: '<1',
          patched_versions: '>=1',
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } },
    };
    configureAudits(reviewClassic, cleanModernAudit());
    expect(
      checkDependencies({ repoRoot: root, now: '2026-09-10T00:00:00.000Z', environment: {} }),
    ).toMatchObject({
      status: 'review',
      universes: [{ status: 'review' }, { status: 'pass' }],
    });
    configureAudits(cleanClassic, { malformed: true });
    expect(
      checkDependencies({ repoRoot: root, now: '2026-09-10T00:00:00.000Z', environment: {} }),
    ).toMatchObject({
      status: 'unknown',
      universes: [{ status: 'pass' }, { status: 'unknown' }],
    });
  });

  it('marks a universe unknown when the pinned package-manager version drifts', () => {
    const root = dependencyRoot();
    dependencyBoundary.spawnSync.mockImplementation(
      (executable?: string, args?: readonly string[]) => {
        if (args?.[0] === '--version')
          return processResult(0, executable === 'pnpm' ? '9.9.9\n' : '11.14.1\n');
        return processResult(1, JSON.stringify(cleanModernAudit()));
      },
    );

    const result = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });

    expect(result).toMatchObject({
      status: 'unknown',
      universes: [
        {
          status: 'unknown',
          findings: [
            {
              code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
              message: 'expected pnpm@10.0.0; received 9.9.9',
            },
          ],
        },
        { status: 'pass' },
      ],
    });
  });

  it('marks a universe unknown when audit exits before a trustworthy result', () => {
    const root = dependencyRoot();
    dependencyBoundary.spawnSync.mockImplementation(
      (executable?: string, args?: readonly string[]) => {
        if (args?.[0] === '--version')
          return processResult(0, executable === 'pnpm' ? '10.0.0\n' : '11.14.1\n');
        return processResult(executable === 'pnpm' ? 2 : 1, JSON.stringify(cleanModernAudit()));
      },
    );

    const result = checkDependencies({
      repoRoot: root,
      now: '2026-09-10T00:00:00.000Z',
      environment: {},
    });

    expect(result).toMatchObject({
      status: 'unknown',
      universes: [
        {
          status: 'unknown',
          findings: [
            {
              code: 'DEPENDENCY_SCANNER_UNAVAILABLE',
              message: 'pnpm audit failed before producing a trustworthy result',
            },
          ],
        },
        { status: 'pass' },
      ],
    });
  });
});

describe('S06-A source repository schema dispatch', () => {
  it('takes the source canon path only for an exact DEVAI source identity', () => {
    const root = temporaryRoot('devai-s06-source-schema-');
    put(root, 'package.json', { name: 'devai', private: true });
    mkdirSync(join(root, 'law/schemas'), { recursive: true });
    put(root, 'packages/schemas/src/roster.ts', 'export const ROSTER = [];\n');
    const report = checkSchemasForRepository(root);

    expect(report).toMatchObject({ ok: false, canonical_total: 0 });
    expect(report).not.toHaveProperty('mode');
    expect(report).toHaveProperty('rules', [
      'recursive-closed-complete-objects',
      'predicate-fragments-valid',
      'shared-vocabulary',
      'generated-marker-integrity',
      'dereferenced-publish-byte-identity',
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'generated-marker-integrity',
          path: 'packages/cli/src/generated/action-registry.ts',
        }),
      ]),
    );
  });
});
