import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { senseHarnessSecurity } from '../../src/harness-security.js';
import { loadWorkflows } from '../../src/harness/workflow-parser.js';

const NOW = '2026-09-08T12:00:00.000Z';
const SHA = 'a'.repeat(8) + 'b'.repeat(8) + '0'.repeat(8) + 'f'.repeat(8) + '9'.repeat(8);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round26-red-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): void {
  const path = resolve(root, rel);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`fixture writer refused a path outside ${root}: ${rel}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('D1 harness_security: job-level permissions satisfy the top-level check', () => {
  it('reports a workflow with no top-level permissions block', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      [
        'name: ci',
        'on:',
        '  push:',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    permissions:',
        '      contents: read',
        '    steps:',
        `      - uses: actions/checkout@${SHA}`,
        '',
      ].join('\n'),
    );

    // The shared parser agrees there is no top-level permissions block.
    expect(loadWorkflows(root)[0]?.hasPermissionsBlock).toBe(false);

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(perFile[0]?.missingPermissionsBlock).toBe(true);
    expect(reading.metrics?.missing_permissions_block_count).toBe(1);
    expect(reading.status).toBe('review');
  });
});

describe('D2 harness_security: a quoted uses: scalar is invisible to the scanner', () => {
  it.each(["'", '"'])('reports an unpinned action written using %s quotes', (quote) => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      [
        'name: ci',
        'on:',
        '  push:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${quote}actions/checkout@v4${quote}`,
        '',
      ].join('\n'),
    );

    // The shared parser reads the same line as actions/checkout@v4.
    expect(loadWorkflows(root)[0]?.actionUses).toEqual([
      { owner: 'actions', repo: 'checkout', ref: 'v4', line: 10 },
    ]);

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(perFile[0]?.unpinnedActions).toEqual([{ line: 10, ref: 'actions/checkout@v4' }]);
    expect(reading.metrics?.unpinned_action_count).toBe(1);
    expect(reading.status).toBe('review');
  });
});
