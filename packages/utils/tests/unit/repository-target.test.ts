import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRepositoryTarget } from '../../src/repository-target.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-target-ç '));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository-relative evidence targets', () => {
  it.each(['test.ts', 'spec.ts', 'test.mjs', 'spec.mjs'])(
    'accepts an existing %s test in a Unicode path',
    (suffix) => {
      const root = fixture();
      mkdirSync(join(root, 'tests'));
      const name = `tests/ação com espaço.${suffix}`;
      writeFileSync(join(root, name), 'export {};\n');
      expect(validateRepositoryTarget(root, name, 'test')).toEqual({
        ok: true,
        absolutePath: resolve(root, name),
        repositoryPath: name,
      });
    },
  );

  it.each(['code.ts', 'a.test.js', 'a.spec.tsx', 'a.test.ts.backup', 'a.TEST.ts', 'a.testjson'])(
    'refuses a non-executable test name %s but accepts it as an ordinary file',
    (name) => {
      const root = fixture();
      writeFileSync(join(root, name), 'data');
      expect(validateRepositoryTarget(root, name, 'test')).toEqual({
        ok: false,
        absolutePath: resolve(root, name),
        repositoryPath: name,
        reason: 'path is not an executable test filename',
      });
      expect(validateRepositoryTarget(root, name, 'file')).toEqual({
        ok: true,
        absolutePath: resolve(root, name),
        repositoryPath: name,
      });
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../escape.test.ts',
    'nested/../../escape.test.ts',
    'nested\\case.test.ts',
  ])('refuses an uncontained or non-relative target %s', (name) => {
    const root = fixture();
    const absolutePath = resolve(root, name);
    expect(validateRepositoryTarget(root, name, 'file')).toEqual({
      ok: false,
      absolutePath,
      repositoryPath: relative(root, absolutePath),
      reason: 'path is not repository-relative and contained',
    });
  });

  it('rejects absolute paths even when they designate a file inside the repository', () => {
    const root = fixture();
    const path = join(root, 'inside.test.ts');
    writeFileSync(path, 'export {};');
    expect(validateRepositoryTarget(root, path, 'test')).toMatchObject({
      ok: false,
      reason: 'path is not repository-relative and contained',
    });
  });

  it('rejects missing files and directories named like executable tests', () => {
    const root = fixture();
    mkdirSync(join(root, 'directory.test.ts'));
    for (const name of ['missing.test.ts', 'directory.test.ts']) {
      expect(validateRepositoryTarget(root, name, 'test')).toEqual({
        ok: false,
        absolutePath: resolve(root, name),
        repositoryPath: name,
        reason: 'path does not resolve to a regular file',
      });
    }
  });

  it('returns the canonical relative path for a contained lexical alias', () => {
    const root = fixture();
    writeFileSync(join(root, 'case.test.ts'), 'export {};');
    expect(validateRepositoryTarget(root, './nested/../case.test.ts', 'test')).toEqual({
      ok: true,
      absolutePath: join(root, 'case.test.ts'),
      repositoryPath: 'case.test.ts',
    });
  });
});
