// ADR-SCR-0017 IA-004/IA-005; Constitution Articles 17, 29 and 39.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestCoherence } from '../../src/test-coherence.js';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';

const SUFFIXES = ['test', 'spec', 'e2e', 'wiring-spec'];
const EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'];
const CLEAN_TEST = "it('observes real behavior', () => expect(1 + 1).toBe(2));\n";
let root: string;
const external: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-census ação '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const path of external.splice(0)) rmSync(path, { recursive: true, force: true });
});
function put(path: string, body = CLEAN_TEST): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}
function sense(testGlobs?: readonly string[]) {
  return senseTestIdiomaticity({
    repoRoot: root,
    ...(testGlobs === undefined ? {} : { testGlobs }),
  });
}

describe('complete executable census', () => {
  it.each(
    SUFFIXES.flatMap((suffix) => EXTENSIONS.map((extension) => [suffix, extension] as const)),
  )('includes the executable .%s.%s suffix', (suffix, extension) => {
    put(`packages/api/tests/case.${suffix}.${extension}`);
    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(1);
  });

  it('unifies singular, plural, colocated and root default populations without mirrors', () => {
    const selected = [
      'packages/a/test/a.test.ts',
      'packages/b/tests/b.spec.mjs',
      'packages/c/src/c.e2e.ts',
      'test/d.wiring-spec.cjs',
      'tests/integration/e.test.ts',
    ];
    for (const path of selected) put(path);
    for (const dir of ['.git', 'node_modules', 'dist', 'build'])
      put(`packages/a/test/${dir}/ignored.test.ts`);
    put('.devai/worktrees/mirror/tests/ignored.test.ts');
    put('packages/a/tests/notes.test.ts.md');
    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(selected.length);
  });

  it('expands multiple wildcard segments and arbitrary-depth globs with deterministic deduplication', () => {
    put('packages/alpha/features/one/tests/deep/a.test.ts');
    put('packages/beta/features/two/tests/b.spec.mjs');
    put('packages/beta/features/two/not-tests/ignored.test.ts');
    const reading = sense([
      'packages/*/features/*/tests/**',
      'packages/**/tests/**/*.test.ts',
      'packages/alpha/features/one/tests',
    ]);
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(2);
  });

  it('excludes output and worktree mirror directories even under an explicit repository-wide root', () => {
    put('tests/real.test.ts');
    put('apps/graft/tests/legitimate.test.ts');
    for (const dir of ['.git', 'node_modules', 'dist', 'build', '.devai/worktrees/mirror'])
      put(`${dir}/tests/ignored.test.ts`);
    const reading = sense(['.']);
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(2);
  });

  it('preserves an explicitly declared external absolute direct-read population', () => {
    const outside = mkdtempSync(join(tmpdir(), 'devai-external census ç '));
    external.push(outside);
    writeFileSync(join(outside, 'external.test.ts'), CLEAN_TEST);
    const reading = sense([outside]);
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(1);
  });

  it.each([false, true])(
    'canonicalizes an explicit external alias root while retaining glob selection=%s',
    (glob) => {
      const holder = mkdtempSync(join(tmpdir(), 'devai external alias ç '));
      external.push(holder);
      const physical = join(holder, 'physical');
      mkdirSync(join(physical, 'nested'), { recursive: true });
      writeFileSync(join(physical, 'one.test.ts'), CLEAN_TEST);
      writeFileSync(join(physical, 'nested/two.wiring-spec.mjs'), CLEAN_TEST);
      const alias = join(holder, 'alias');
      symlinkSync(physical, alias, 'dir');
      const reading = sense([glob ? join(alias, '**/*.test.ts') : alias]);
      expect(reading.status).toBe('pass');
      expect(reading.metrics?.test_files).toBe(glob ? 1 : 2);
      expect(reading.metrics?.candidate_commit).toBeUndefined();
    },
  );

  it('preserves the original external alias path in package findings', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external display ç '));
    external.push(holder);
    const physical = join(holder, 'physical');
    mkdirSync(physical);
    for (let index = 0; index < 10; index += 1)
      writeFileSync(join(physical, `source-${index}.ts`), 'export const value = 1;\n');
    writeFileSync(join(physical, 'one.test.ts'), CLEAN_TEST);
    const alias = join(holder, 'requested-package');
    symlinkSync(physical, alias, 'dir');
    const reading = senseTestCoherence({
      repoRoot: root,
      packageRoots: [alias],
      minPerPackageRatio: 0.25,
    });
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({ source_files: 10, test_files: 1 });
    expect(reading.findings).toEqual([
      expect.objectContaining({
        code: 'TEST_COHERENCE_PACKAGE_BELOW_MIN',
        file: alias,
        message: `Package ${alias} has test/source ratio 0.10 (< 0.25).`,
      }),
    ]);
    expect(reading.metrics?.candidate_commit).toBeUndefined();
  });

  it('counts a physical package once across aliases while preserving distinct package roots', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external package identity ç '));
    external.push(holder);
    const physical = join(holder, 'physical');
    const distinct = join(holder, 'distinct');
    for (const directory of [physical, distinct]) {
      mkdirSync(directory);
      for (let index = 0; index < 10; index += 1)
        writeFileSync(join(directory, `source-${index}.ts`), 'export const value = 1;\n');
      writeFileSync(join(directory, 'one.test.ts'), CLEAN_TEST);
    }
    const firstAlias = join(holder, 'first-requested-package');
    const secondAlias = join(holder, 'second-requested-package');
    symlinkSync(physical, firstAlias, 'dir');
    symlinkSync(physical, secondAlias, 'dir');
    const observe = (packageRoots: readonly string[]) =>
      senseTestCoherence({ repoRoot: root, packageRoots, minPerPackageRatio: 0.25 });
    const first = observe([firstAlias]);
    const overlapping = observe([firstAlias, physical, secondAlias]);
    expect(first.status).toBe('fail');
    expect(overlapping.status).toBe(first.status);
    expect(overlapping.metrics).toEqual(first.metrics);
    expect(overlapping.findings).toEqual(first.findings);
    expect(overlapping.findings?.[0]?.file).toBe(firstAlias);
    const withDistinct = observe([firstAlias, physical, secondAlias, distinct]);
    expect(withDistinct.status).toBe('fail');
    expect(withDistinct.metrics).toMatchObject({
      packages_scanned: 2,
      source_files: 20,
      test_files: 2,
      packages_below_min_ratio: 2,
    });
    expect(withDistinct.findings?.map((finding) => finding.file)).toEqual([firstAlias, distinct]);
  });

  it('deduplicates overlapping physical, external alias and glob populations', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external overlap ç '));
    external.push(holder);
    const physical = join(holder, 'physical');
    mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, 'one.test.ts'), CLEAN_TEST);
    writeFileSync(join(physical, 'two.spec.mjs'), CLEAN_TEST);
    const alias = join(holder, 'alias');
    symlinkSync(physical, alias, 'dir');
    const reading = sense([physical, alias, join(alias, '**/*'), join(physical, 'one.test.ts')]);
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.test_files).toBe(2);
  });

  it('refuses nested links below a canonical external root rather than crediting its readable subset', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external nested link ç '));
    external.push(holder);
    const physical = join(holder, 'physical');
    const escaped = join(holder, 'escaped');
    mkdirSync(physical);
    mkdirSync(escaped);
    writeFileSync(join(physical, 'safe.test.ts'), CLEAN_TEST);
    writeFileSync(join(escaped, 'escaped.test.ts'), CLEAN_TEST);
    symlinkSync(escaped, join(physical, 'linked'), 'dir');
    const alias = join(holder, 'alias');
    symlinkSync(physical, alias, 'dir');
    const reading = sense([alias]);
    expect(reading.status).not.toBe('pass');
    expect(reading.findings?.some((finding) => /link|symbolic/iu.test(finding.message))).toBe(true);
  });

  it('refuses a linked literal external file after canonicalizing only its parent root', () => {
    const holder = mkdtempSync(join(tmpdir(), 'devai external file link ç '));
    external.push(holder);
    const actual = join(holder, 'actual.test.ts');
    writeFileSync(actual, CLEAN_TEST);
    const alias = join(holder, 'alias.test.ts');
    symlinkSync(actual, alias, 'file');
    const reading = sense([alias]);
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.test_files).toBe(0);
    expect(reading.findings?.some((finding) => /link|symbolic/iu.test(finding.message))).toBe(true);
  });

  it('refuses a missing explicit population rather than crediting a convenient existing subset', () => {
    put('tests/present.test.ts');
    const reading = sense(['tests', 'missing-tests']);
    expect(reading.status).not.toBe('pass');
    expect(
      reading.findings?.some((finding) =>
        /missing-tests|missing|not found/iu.test(finding.message),
      ),
    ).toBe(true);
  });

  it('refuses linked population paths and does not traverse their executable files', () => {
    const outside = mkdtempSync(join(tmpdir(), 'devai-linked census ç '));
    external.push(outside);
    writeFileSync(join(outside, 'linked.test.ts'), CLEAN_TEST);
    symlinkSync(outside, join(root, 'linked-tests'));
    const reading = sense(['linked-tests']);
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.test_files).toBe(0);
    expect(reading.findings?.some((finding) => /link|symbolic/iu.test(finding.message))).toBe(true);
  });

  it('uses the same complete suffix census for coherence without treating tests as production source', () => {
    put('packages/api/src/service.ts', 'export const service = () => 42;\n');
    for (const suffix of SUFFIXES)
      for (const extension of EXTENSIONS) put(`packages/api/tests/case.${suffix}.${extension}`);
    const reading = senseTestCoherence({ repoRoot: root });
    expect(reading.metrics?.test_files).toBe(24);
    expect(reading.metrics?.source_files).toBe(1);
  });
});
