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

describe('repository detection contracts', () => {
  it('counts source extensions across packages and omits generated and dependency trees', () => {
    for (const path of [
      'src/main.ts',
      'src/view.tsx',
      'src/common.cts',
      'src/module.mts',
      'lib/one.js',
      'lib/two.jsx',
      'lib/three.cjs',
      'tools/a.py',
      'tools/b.py',
      'tools/main.go',
      'README.md',
      'node_modules/dependency/index.ts',
      'dist/index.ts',
      '.git/internal.py',
      'coverage/index.js',
      'target/main.rs',
      '.venv/helper.py',
    ])
      file(path);
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.languages).toEqual([
      { name: 'typescript', file_count: 4 },
      { name: 'javascript', file_count: 3 },
      { name: 'python', file_count: 2 },
      { name: 'go', file_count: 1 },
    ]);
    expect(result.source_globs).toEqual(['lib/**', 'src/**']);
    expect(result.target_root).toBe(root);
    expect(result.generated_at).toBe(now);
    expect(result.schemaVersion).toBe('1.0.0');
  });

  it('combines dependency sections without duplicating framework evidence', () => {
    file(
      'package.json',
      JSON.stringify({
        dependencies: { react: '1', express: '1' },
        devDependencies: { react: '2', vite: '1' },
        peerDependencies: { react: '3' },
      }),
    );
    file('apps/frontend/package.json', JSON.stringify({ dependencies: { react: '4' } }));
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.frameworks).toEqual([
      { name: 'express', evidence: 'package.json dep: express' },
      { name: 'react', evidence: 'apps/frontend/package.json dep: react; package.json dep: react' },
      { name: 'vite', evidence: 'package.json dep: vite' },
    ]);
    expect(result.proposed_project_type).toBe('runtime-host');
    expect(result.notes).toContain(
      'Multiple frameworks detected (express, react, vite); review proposed_project_type',
    );
  });

  it('keeps concrete app and package roots and both named test conventions', () => {
    file('apps/web/src/main.ts');
    file('packages/core/src/main.ts');
    file('packages/core/testing/main.spec.mjs');
    file('app/page.jsx');
    file('__tests__/page.test.cjs');
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.source_globs).toEqual(['apps/web/src/**', 'packages/core/src/**', 'app/**']);
    expect(result.test_globs).toEqual([
      '__tests__/**',
      'packages/core/testing/**',
      '**/__tests__/**',
      '**/*.spec.*',
      '**/*.test.*',
    ]);
    expect(result.notes).toContain(
      'Both packages/*/src and apps/*/src detected — monorepo with apps; source_globs covers both',
    );
  });

  it('reports protected paths once and excludes names that merely resemble protected files', () => {
    const protectedPaths = [
      '.env',
      '.env.production',
      'config/CREDENTIALS.local.json',
      'config/secret.yaml',
      'config/secrets.json',
      'keys/id_rsa',
      'keys/id_rsa.pub',
      'keys/server.key',
      'keys/server.pem',
    ];
    for (const path of [
      ...protectedPaths,
      'environment.ts',
      'config/credentials.txt',
      'keys/server.pem.txt',
      'keys/id_rsa.pub.txt',
      'config/secretary.txt',
    ])
      file(path);
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.protected_surfaces).toEqual([...protectedPaths].sort());
    expect(result.existing_devai_config).toBe(false);
  });

  it('returns a reviewable empty-repository proposal without spurious notes or detected frameworks', () => {
    expect(introspectRepo({ targetRoot: root, now })).toEqual({
      schemaVersion: '1.0.0',
      target_root: root,
      generated_at: now,
      package_manager: 'unknown',
      languages: [],
      frameworks: [],
      source_globs: ['src/**'],
      test_globs: ['**/*.test.*'],
      protected_surfaces: [],
      existing_devai_config: false,
      proposed_project_type: 'docs-archive',
    });
  });
});
