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
    ).toMatchObject({ schemaVersion: '1.0.0', id: 'mutation-strength', status: 'active' });
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
