import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { buildBootstrapPlan, executeBootstrapPlan } from '../../src/bootstrap/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];

aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-adopter-bootstrap-contract-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

describe('adopter mutation-policy bootstrap contract', () => {
  it('plans mutation-strength under Architect-owned law and materializes package bytes', () => {
    const root = target();
    const plan = buildBootstrapPlan({ targetRoot: root, version: '1.2.1', profile: 'tier3' });
    const entry = plan.entries.find((item) => item.path === 'law/policy/mutation-strength.json');
    expect(entry).toMatchObject({ action: 'create', content: expect.any(String) });

    const result = executeBootstrapPlan(plan);
    expect(result.created).toContain('law/policy/mutation-strength.json');
    expect(
      JSON.parse(readFileSync(join(root, 'law/policy/mutation-strength.json'), 'utf8')),
    ).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'mutation-strength',
      status: 'deprecated-external-hardening',
    });
  });

  it('preserves explicit adopter policy bytes and repeats without policy or lockfile writes', () => {
    const root = target();
    put(root, 'law/policy/mutation-strength.json', {
      schemaVersion: '1.0.0',
      id: 'mutation-strength',
      status: 'active',
      adopter_overrides: { required_scenarios: ['critical-teat-path'], survived_max: 0 },
    });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const beforePolicy = readFileSync(join(root, 'law/policy/mutation-strength.json'));
    const beforeLock = readFileSync(join(root, 'pnpm-lock.yaml'));

    const first = executeBootstrapPlan(
      buildBootstrapPlan({ targetRoot: root, version: '1.2.1', profile: 'tier3' }),
    );
    const second = executeBootstrapPlan(
      buildBootstrapPlan({ targetRoot: root, version: '1.2.1', profile: 'tier3' }),
    );

    expect(first.skipped).toContain('law/policy/mutation-strength.json');
    expect(second.created).toEqual([]);
    expect(second.overwritten).toEqual([]);
    expect(readFileSync(join(root, 'law/policy/mutation-strength.json'))).toEqual(beforePolicy);
    expect(readFileSync(join(root, 'pnpm-lock.yaml'))).toEqual(beforeLock);
  });
});

describe('adopter project.json bootstrap contract', () => {
  it.each([
    ['an array', '[]'],
    ['a null document', 'null'],
    ['a scalar string', '"tier3"'],
    ['a scalar number', '3'],
  ])('refuses to reconcile %s instead of rewriting adopter bytes', (_name, bytes) => {
    const root = target();
    const absolute = join(root, '.devai/config/project.json');
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
    const before = readFileSync(absolute);

    expect(() =>
      buildBootstrapPlan({ targetRoot: root, version: '1.2.1', profile: 'tier3' }),
    ).toThrow('PROJECT_CONFIG_INVALID: expected a JSON object');
    expect(readFileSync(absolute)).toEqual(before);
  });
});

describe('adopter profile bootstrap contract', () => {
  const tier3Only = [
    'law/schemas/README.md',
    'docs/dev/operations/README.md',
    'docs/dev/security/README.md',
    'work/rounds/README.md',
    'work/audit/README.md',
    'AGENTS.md',
    'CLAUDE.md',
  ] as const;
  const governedByTier2 = [
    'law/README.md',
    'law/adr/README.md',
    'law/invariants/README.md',
    'law/policy/README.md',
    'law/glossary/README.md',
    'product/README.md',
  ] as const;

  function plannedPaths(profile?: 'tier1' | 'tier2' | 'tier3'): Set<string> {
    const root = target();
    const plan = buildBootstrapPlan({
      targetRoot: root,
      version: '1.2.1',
      ...(profile !== undefined && { profile }),
    });
    return new Set(plan.entries.map((entry) => entry.path));
  }

  it('keeps a tier1 target free of Architect- and Owner-owned scaffolding', () => {
    const paths = plannedPaths('tier1');
    for (const path of [...governedByTier2, ...tier3Only]) {
      expect(paths).not.toContain(path);
    }
    // The machine-owned substrate is still laid down for every tier.
    for (const path of [
      'record/proofs/README.md',
      'record/derived/inventory/README.md',
      'scratch/worktrees/README.md',
      'record/proofs/chain.json',
      '.devai/state/counters.json',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('gives tier2 the governed law substrate without the tier3 extras', () => {
    const paths = plannedPaths('tier2');
    for (const path of governedByTier2) expect(paths).toContain(path);
    for (const path of tier3Only) expect(paths).not.toContain(path);
  });

  it('defaults an unspecified tier to the strict tier3 substrate', () => {
    const paths = plannedPaths();
    for (const path of [...governedByTier2, ...tier3Only]) {
      expect(paths).toContain(path);
    }
  });
});
