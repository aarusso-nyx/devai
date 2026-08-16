import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRemoteLocalOnlyNodes } from '../../src/commands/check/ci-local-only.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-local-only-'));
  roots.push(root);
  put(root, '.devai/config/project.json', {
    ci_economy: {
      attested_rc: {
        profile: 'rc',
        transport: 'protected-tag-v1',
        tag_prefix: 'devai-local-evidence/',
        binding: 'exact-tree',
        required_check: 'verified-local-rc',
        failure_mode: 'fail-closed',
        local_only_nodes: ['test:mutation'],
      },
    },
  });
  put(root, 'test-tasks.json', {
    tasks: [{ nodeId: 'test:mutation', argv: ['pnpm', 'run', 'test:mutation'] }],
  });
  put(root, 'package.json', {
    scripts: {
      'test:mutation': 'pnpm -r stryker',
      'ci:stynx:full': 'pnpm run test:unit && pnpm run test:mutation',
      'ci:remote': 'pnpm run test:unit',
      'test:unit': 'vitest run',
    },
  });
  return root;
}

describe('attested RC local-only workflow inspection', () => {
  it('accepts remote-safe chains and rejects direct and transitive mutation execution', () => {
    const root = fixture();
    const safe = inspectRemoteLocalOnlyNodes(root, [
      { file: 'ci.yml', text: 'run: pnpm run ci:remote\n' },
    ]);
    expect(safe.errors).toEqual([]);
    expect(safe.violations).toEqual([]);
    expect(safe.forbiddenScripts).toContain('ci:stynx:full');

    const indirect = inspectRemoteLocalOnlyNodes(root, [
      { file: 'audit.yml', text: 'run: pnpm run ci:stynx:full\n' },
    ]);
    expect(indirect.violations).toContain(
      'audit.yml: reaches local-only script ci:stynx:full',
    );

    const direct = inspectRemoteLocalOnlyNodes(root, [
      { file: 'hardening.yml', text: 'run: pnpm exec stryker run\n' },
    ]);
    expect(direct.violations).toContain('hardening.yml: direct Stryker invocation');
  });

  it('fails closed for missing nodes and unresolvable script chains', () => {
    const root = fixture();
    const project = JSON.parse(
      readFileSync(join(root, '.devai/config/project.json'), 'utf8'),
    ) as { ci_economy: { attested_rc: { local_only_nodes: string[] } } };
    project.ci_economy.attested_rc.local_only_nodes = ['test:missing'];
    put(root, '.devai/config/project.json', project);
    const result = inspectRemoteLocalOnlyNodes(root, [
      { file: 'ci.yml', text: 'run: pnpm run unknown:possibly-local\n' },
    ]);
    expect(result.errors).toContain(
      'local-only node test:missing is absent or malformed in test-tasks.json',
    );
    expect(result.violations).toContain(
      'ci.yml: script chain unknown:possibly-local cannot be resolved',
    );
  });
});
