// Invariants: INV-DEVAI-001, INV-DEVAI-012
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRepositoryTarget } from '../../src/repository-target.js';

const roots: string[] = [];
const suffixes = ['test', 'spec', 'e2e', 'wiring-spec'] as const;
const extensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;
const filenames = suffixes.flatMap((suffix) =>
  extensions.map((extension) => `tests/ação com espaço.${suffix}.${extension}`),
);

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-target-families-ç '));
  roots.push(root);
  mkdirSync(join(root, 'tests'));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('complete executable test target families', () => {
  it.each(filenames)('accepts the supported executable filename %s', (name) => {
    const root = fixture();
    writeFileSync(join(root, name), 'export {};\n');
    expect(validateRepositoryTarget(root, name, 'test')).toEqual({
      ok: true,
      absolutePath: resolve(root, name),
      repositoryPath: name,
    });
  });

  it.each([
    'tests/source.ts',
    'tests/case.e2e.ts.backup',
    'tests/case.wiring-spec.tsx.map',
    'tests/case.wiring_spec.ts',
    'tests/case.E2E.ts',
    'tests/case.test.mts',
    'tests/case.spec.cts',
  ])('rejects the unsupported or near-miss executable filename %s', (name) => {
    const root = fixture();
    writeFileSync(join(root, name), 'export {};\n');
    expect(validateRepositoryTarget(root, name, 'test')).toMatchObject({
      ok: false,
      reason: 'path is not an executable test filename',
    });
    expect(validateRepositoryTarget(root, name, 'file').ok).toBe(true);
  });

  it.each(['e2e', 'wiring-spec'])('preserves the file-kind boundary for %s', (suffix) => {
    const root = fixture();
    const missing = `tests/missing.${suffix}.ts`;
    const directory = `tests/directory.${suffix}.ts`;
    mkdirSync(join(root, directory));
    for (const name of [missing, directory]) {
      expect(validateRepositoryTarget(root, name, 'test')).toMatchObject({
        ok: false,
        reason: 'path does not resolve to a regular file',
      });
    }
    expect(validateRepositoryTarget(root, `../outside.${suffix}.ts`, 'test')).toMatchObject({
      ok: false,
      reason: 'path is not repository-relative and contained',
    });
  });
});
