import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { introspectRepo } from '../../src/bootstrap/introspect.js';

let root: string;
const now = '2026-09-08T09:15:00.000Z';
const DIR = 'we\\ird';
const expectedDir = DIR.split(sep).join('/');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-introspection-backslash-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, content = ''): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(): ReturnType<typeof introspectRepo> {
  file(`${DIR}/src/index.ts`);
  file(`${DIR}/.env`);
  file(`${DIR}/package.json`, JSON.stringify({ dependencies: { react: '18' } }));
  return introspectRepo({ targetRoot: root, now });
}

it('keeps a backslash-bearing directory name intact in source globs', () => {
  expect(fixture().source_globs).toEqual([`${expectedDir}/src/**`]);
});

it('keeps a backslash-bearing directory name intact in protected surfaces', () => {
  expect(fixture().protected_surfaces).toEqual([`${expectedDir}/.env`]);
});

it('still reads the manifest of a backslash-bearing package directory', () => {
  expect(fixture().frameworks).toEqual([
    { name: 'react', evidence: `${expectedDir}/package.json dep: react` },
  ]);
});
