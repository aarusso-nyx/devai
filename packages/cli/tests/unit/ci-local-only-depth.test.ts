import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectRemoteLocalOnlyNodes,
  readAttestedRcConfig,
} from '../../src/commands/check/ci-local-only.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}

function validConfig(localOnlyNodes: string[] = ['test:mutation']): unknown {
  return {
    ci_economy: {
      attested_rc: {
        profile: 'rc',
        transport: 'protected-tag-v1',
        tag_prefix: 'devai-local-evidence/',
        binding: 'exact-tree',
        required_check: 'verified-local-rc',
        failure_mode: 'fail-closed',
        local_only_nodes: localOnlyNodes,
      },
    },
  };
}

function fixture(config: unknown = validConfig()): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-ci-local-only-depth-'));
  roots.push(root);
  put(root, '.devai/config/project.json', config);
  put(root, 'test-tasks.json', {
    tasks: [{ nodeId: 'test:mutation', argv: ['pnpm', 'run', 'test:mutation'] }],
  });
  put(root, 'package.json', {
    scripts: {
      'test:mutation': 'pnpm -r stryker',
      'ci:remote': 'pnpm run test:unit',
      'test:unit': 'vitest run',
    },
  });
  return root;
}

describe('ci-local-only public boundaries', () => {
  it('reports malformed project configuration without throwing', () => {
    const root = fixture('{');
    expect(readAttestedRcConfig(root)).toEqual({
      errors: ['.devai/config/project.json is not valid JSON'],
    });
  });

  it.each(['missing', 'unknown'] as const)('rejects a %s attested_rc field', (kind) => {
    const config = validConfig() as { ci_economy: { attested_rc: Record<string, unknown> } };
    if (kind === 'missing') delete config.ci_economy.attested_rc.transport;
    else config.ci_economy.attested_rc.extra = true;
    const root = fixture(config);
    expect(readAttestedRcConfig(root)).toEqual({
      errors: ['ci_economy.attested_rc has missing or unknown fields'],
    });
  });

  it.each(['prefix', 'empty-roster'] as const)('rejects an invalid %s', (kind) => {
    const config = validConfig(kind === 'empty-roster' ? [] : ['test:mutation']) as {
      ci_economy: { attested_rc: Record<string, unknown> };
    };
    if (kind === 'prefix') config.ci_economy.attested_rc.tag_prefix = 'other/';
    const root = fixture(config);
    expect(readAttestedRcConfig(root)).toEqual({
      errors: ['ci_economy.attested_rc does not match the protected-tag-v1 contract'],
    });
  });

  it('rejects a non-object attested_rc value before contract inspection', () => {
    const root = fixture({ ci_economy: { attested_rc: 'enabled' } });
    expect(readAttestedRcConfig(root)).toEqual({
      errors: ['ci_economy.attested_rc must be an object'],
    });
  });

  it('does not treat a flagged pnpm option as a script descriptor', () => {
    const root = fixture(validConfig(['node-ci']));
    put(root, 'test-tasks.json', {
      tasks: [{ nodeId: 'node-ci', argv: ['pnpm', '--silent'] }],
    });
    const result = inspectRemoteLocalOnlyNodes(root, [
      { file: 'ci.yml', text: 'run: pnpm run ci:remote\n' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.forbiddenScripts).toEqual(['node-ci', 'test:mutation']);
    expect(result.violations).toEqual([]);
  });

  it('reports malformed workflow YAML as a workflow violation', () => {
    const root = fixture();
    const result = inspectRemoteLocalOnlyNodes(root, [
      { file: 'ci.yml', text: 'jobs:\n  test: [\n' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.violations).toEqual(['ci.yml: workflow YAML cannot be parsed']);
  });
});
