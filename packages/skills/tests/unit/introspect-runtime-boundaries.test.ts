import { createHash } from 'node:crypto';
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import { introspectRepo, type RepoIntrospection } from '../../src/bootstrap/introspect.js';

const NO_FRAMEWORK_NOTE =
  'No recognized framework dependency in any discovered package manifest; project_type may be platform-package or framework';

let root: string;
const now = '2026-09-08T09:15:00.000Z';
const validateRecord = getValidator('repo-introspection.schema.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-introspection-runtime-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, content = ''): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Every record this lane observes must also satisfy the published schema. */
function introspect(): RepoIntrospection {
  const record = introspectRepo({ targetRoot: root, now });
  expect(validateRecord(record), JSON.stringify(validateRecord.errors)).toBe(true);
  return record;
}

function tree(base: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      out.push(
        `${relative(base, full)} ${stat.isDirectory() ? 'dir' : `sha256:${createHash('sha256').update(readFileSync(full)).digest('hex')}`}`,
      );
      if (stat.isDirectory()) visit(full);
    }
  };
  visit(base);
  return out.sort();
}

describe('workspace structure detection', () => {
  it('keeps bin and lib beside src as first-class source roots', () => {
    file('bin/cli.js');
    file('lib/index.js');
    file('src/index.ts');
    file('scripts/release.js');
    const result = introspect();
    expect(result.source_globs).toEqual(['bin/**', 'lib/**', 'src/**']);
  });

  it('emits source globs, test globs and protected surfaces in a stable sorted order', () => {
    for (const owner of ['a', 'a-b', 'm', 'n']) {
      file(`${owner}/src/index.ts`);
      file(`${owner}/tests/case.ts`);
      file(`${owner}/.env`);
    }
    const result = introspect();
    expect(result.source_globs).toEqual(['a-b/src/**', 'a/src/**', 'm/src/**', 'n/src/**']);
    expect(result.test_globs).toEqual(['a-b/tests/**', 'a/tests/**', 'm/tests/**', 'n/tests/**']);
    expect(result.protected_surfaces).toEqual(['a-b/.env', 'a/.env', 'm/.env', 'n/.env']);
  });

  it('keeps test roots within the nesting bound and drops deeper ones', () => {
    file('l1/l2/l3/l4/tests/case.ts');
    file('m1/m2/m3/m4/m5/tests/case.ts');
    const result = introspect();
    expect(result.test_globs).toEqual(['l1/l2/l3/l4/tests/**']);
  });

  it('does not read a generated apps directory as an application source root', () => {
    file('packages/core/src/index.ts');
    file('apps/web/src-gen/index.ts');
    const result = introspect();
    expect(result.source_globs).toEqual(['packages/core/src/**']);
    expect(result.notes).toBeUndefined();
  });

  it('treats only a repository-root app directory as the framework app folder', () => {
    file('src/index.ts');
    file('packages/web/app/page.tsx');
    const result = introspect();
    expect(result.source_globs).toEqual(['src/**']);
  });
});

describe('package and runtime identity', () => {
  it('reads an npm lockfile as the package identity without a manifest and over a bun lockfile', () => {
    file('package-lock.json', '{}');
    file('bun.lockb');
    const result = introspect();
    expect(result.package_manager).toBe('npm');
  });

  it('reports both dependencies of one framework as sorted evidence', () => {
    file(
      'package.json',
      JSON.stringify({
        dependencies: { '@nestjs/core': '^11', '@nestjs/common': '^11' },
        devDependencies: { '@nestjs/common': '^11' },
      }),
    );
    const result = introspect();
    expect(result.frameworks).toEqual([
      {
        name: 'nestjs',
        evidence: 'package.json dep: @nestjs/common; package.json dep: @nestjs/core',
      },
    ]);
  });

  it('does not call a repository with a nested framework manifest a docs archive', () => {
    file('modules/app/package.json', JSON.stringify({ dependencies: { react: '18' } }));
    file('modules/app/src/index.ts');
    const result = introspect();
    expect(result.package_manager).toBe('unknown');
    expect(result.frameworks).toEqual([
      { name: 'react', evidence: 'modules/app/package.json dep: react' },
    ]);
    expect(Object.keys(result)).not.toContain('proposed_project_type');
    expect(result.notes).toBeUndefined();
  });

  it('omits proposed_project_type instead of carrying an undefined key', () => {
    file('package.json', '{}');
    file('src/index.ts');
    const result = introspect();
    expect(result).toStrictEqual({
      schemaVersion: '1.0.0',
      target_root: root,
      generated_at: now,
      package_manager: 'npm',
      languages: [{ name: 'typescript', file_count: 1 }],
      frameworks: [],
      source_globs: ['src/**'],
      test_globs: ['**/*.test.*'],
      protected_surfaces: [],
      existing_devai_config: false,
      notes: [NO_FRAMEWORK_NOTE],
    });
    expect(Object.keys(result)).not.toContain('proposed_project_type');
  });
});

describe('ambiguous and malformed workspace configuration', () => {
  function pnpmWorkspace(yaml: string): void {
    file('package.json', '{"private":true}');
    file('pnpm-lock.yaml');
    file('pnpm-workspace.yaml', yaml);
  }

  function member(path: string): void {
    file(`${path}/package.json`, '{}');
    file(`${path}/src/index.ts`);
  }

  it.each([
    ['a catalog-only workspace file', 'catalog:\n  react: ^18.0.0\n'],
    ['a scalar packages value', 'packages: modules/*\n'],
    ['a mapping packages value', 'packages:\n  include: modules/*\n'],
  ])('reports no workspace patterns for %s', (_label, yaml) => {
    pnpmWorkspace(yaml);
    member('modules/core');
    const result = introspect();
    expect(result.notes?.filter((note) => note.includes('pnpm-workspace.yaml'))).toEqual([]);
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
  });

  it.each([
    ['an empty workspace file', ''],
    ['an unterminated flow sequence', "packages: ['modules/*'\n"],
    ['tab-indented entries', "packages:\n\t- 'modules/*'\n"],
  ])('reports no workspace patterns for %s', (_label, yaml) => {
    pnpmWorkspace(yaml);
    member('modules/core');
    const result = introspect();
    expect(result.notes?.filter((note) => note.includes('pnpm-workspace.yaml'))).toEqual([]);
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
  });

  it('does not turn overlapping inclusion patterns into exclusions', () => {
    pnpmWorkspace("packages:\n  - 'packages/*'\n  - '**/packages/*'\n");
    member('packages/core');
    member('vendor/packages/tool');
    const result = introspect();
    expect(result.notes).toContain(
      'Parsed pnpm-workspace.yaml: 2 pattern(s), 2 matching manifest(s)',
    );
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
  });

  it('applies a contradictory exclusion to hidden and visible members alike', () => {
    pnpmWorkspace("packages:\n  - 'modules/*'\n  - '!modules/*'\n");
    member('modules/core');
    member('modules/.internal');
    const result = introspect();
    expect(result.notes).toContain(
      'Parsed pnpm-workspace.yaml: 2 pattern(s), 0 matching manifest(s)',
    );
    expect(result.notes).toContain(
      'Discovered 2 package manifest(s) outside pnpm workspace patterns; retained their source/test roots as repository evidence',
    );
  });

  it('reads a doubly negated pattern literally instead of excluding every other member', () => {
    pnpmWorkspace("packages:\n  - 'modules/*'\n  - '!!modules/core'\n");
    member('modules/core');
    member('modules/edge');
    const result = introspect();
    expect(result.notes).toContain(
      'Parsed pnpm-workspace.yaml: 2 pattern(s), 2 matching manifest(s)',
    );
    expect(result.notes?.filter((note) => note.includes('outside pnpm workspace'))).toEqual([]);
  });
});

describe('write-free diagnosis', () => {
  it('leaves the inspected repository byte-identical and unconfigured', () => {
    file('package.json', JSON.stringify({ dependencies: { react: '18' } }));
    file('pnpm-lock.yaml');
    file('pnpm-workspace.yaml', "packages:\n  - 'modules/*'\n");
    file('modules/core/package.json', '{}');
    file('modules/core/src/index.ts');
    file('modules/core/tests/core.test.ts');
    file('.env', 'TOKEN=1');
    const before = tree(root);
    const result = introspect();
    expect(tree(root)).toEqual(before);
    expect(result.existing_devai_config).toBe(false);
  });
});
