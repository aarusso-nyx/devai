import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { introspectRepo } from '../../src/bootstrap/introspect.js';

let root: string;
const now = '2026-09-07T18:40:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-introspection-contract-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, content = ''): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function workspace(): void {
  file('package.json', '{"private":true}');
  file('pnpm-lock.yaml');
  file('pnpm-workspace.yaml', "packages:\n  - 'modules/*'\n");
  file('modules/core/package.json', '{}');
  file('modules/core/src/index.ts');
}

describe('workspace introspection evidence', () => {
  it('does not report the workspace root manifest as an outside workspace package', () => {
    workspace();
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.notes).toContain(
      'Parsed pnpm-workspace.yaml: 1 pattern(s), 1 matching manifest(s)',
    );
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
    expect(result.source_globs).toEqual(['modules/core/src/**']);
  });

  it('counts only actual outside packages and retains their detected roots', () => {
    workspace();
    file('examples/demo/package.json', '{}');
    file('examples/demo/lib/index.js');
    file('examples/demo/tests/example.test.js');
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.notes).toContain(
      'Discovered 1 package manifest(s) outside pnpm workspace patterns; retained their source/test roots as repository evidence',
    );
    expect(result.source_globs).toEqual(['examples/demo/lib/**', 'modules/core/src/**']);
    expect(result.test_globs).toEqual(['examples/demo/tests/**', '**/*.test.*']);
  });

  it('does not include the root in package counts even for a recursive workspace pattern', () => {
    workspace();
    file('pnpm-workspace.yaml', "packages:\n  - '**'\n");
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.notes).toContain(
      'Parsed pnpm-workspace.yaml: 1 pattern(s), 1 matching manifest(s)',
    );
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
  });
});
