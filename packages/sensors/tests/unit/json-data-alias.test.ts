import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isStableJsonDataDirectoryAlias } from '../../src/json-data-alias.js';
import {
  executableTestPopulation,
  expandRepositoryPaths,
  regularFilePopulation,
} from '../../src/test-file-population.js';
import { senseTestCoherence } from '../../src/test-coherence.js';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';
import { senseTestSecurityCoverage } from '../../src/test-security-coverage.js';
import { senseTestPerformanceCoverage } from '../../src/test-performance-coverage.js';
import { senseTestRobustnessCoverage } from '../../src/test-robustness-coverage.js';

let root: string;
const extra: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-json-alias-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const path of extra.splice(0)) rmSync(path, { recursive: true, force: true });
});
function put(path: string, value = '{}'): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}
function alias(target = join(root, 'docs/fixtures')): string {
  const link = join(root, 'packages/api/fixtures');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), target), link, 'dir');
  return link;
}
function sensors() {
  const options = { repoRoot: root, testGlobs: ['packages/api'] };
  return [
    senseTestCoherence({ repoRoot: root, packageRoots: ['packages/api'] }),
    senseTestIdiomaticity(options),
    senseTestSecurityCoverage(options),
    senseTestPerformanceCoverage(options),
    senseTestRobustnessCoverage(options),
  ];
}
function corpus() {
  put('packages/api/src/a.ts', 'export const a = 1;');
  put(
    'packages/api/tests/a.test.ts',
    "import {it,expect} from 'vitest'; it('behavior',()=>expect(1+1).toBe(2));",
  );
  put('docs/fixtures/a.json', '{"fixture":true}');
}

describe('observation-only JSON directory aliases', () => {
  it('preserves all five sensor outcomes, denominators and package boundaries', () => {
    corpus();
    const before = sensors().map(({ status, metrics }) => ({ status, metrics }));
    const link = alias();
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(true);
    const after = sensors();
    expect(after.map(({ status, metrics }) => ({ status, metrics }))).toEqual(before);
    expect(after.every((reading) => reading.status !== 'error')).toBe(true);
  });

  it('keeps generic and default executable admission strictly link-free', () => {
    corpus();
    alias();
    const expanded = expandRepositoryPaths(root, ['packages/api']);
    expect(
      regularFilePopulation(expanded.paths, expanded.physicalRoots).errors.length,
    ).toBeGreaterThan(0);
    expect(executableTestPopulation(root, ['packages/api']).errors.length).toBeGreaterThan(0);
  });

  it('never accepts an alias as an explicitly selected root', () => {
    corpus();
    alias();
    const population = executableTestPopulation(root, ['packages/api/fixtures'], {
      jsonDataAliases: true,
    });
    expect(population.errors.length).toBeGreaterThan(0);
  });

  it.each([
    'hidden.test.ts',
    'hidden.spec.mjs',
    'module.ts',
    'script.js',
    'declarations.d.ts',
    'README.md',
  ])('refuses a non-JSON target entry: %s', (file) => {
    corpus();
    put('docs/fixtures/' + file, 'export const hidden = true;');
    alias();
    expect(sensors().every((reading) => reading.status === 'error')).toBe(true);
  });

  it('refuses executable JSON files', () => {
    corpus();
    chmodSync(join(root, 'docs/fixtures/a.json'), 0o755);
    expect(isStableJsonDataDirectoryAlias(root, alias())).toBe(false);
  });

  it('refuses malformed JSON rather than treating an extension as sufficient', () => {
    corpus();
    put('docs/fixtures/a.json', 'not JSON');
    expect(isStableJsonDataDirectoryAlias(root, alias())).toBe(false);
  });

  it.each(['.devai/state', 'record/proofs', 'node_modules/data', '.aws'])(
    'refuses mutable, dependency or credential target namespaces: %s',
    (namespace) => {
      corpus();
      put(namespace + '/a.json');
      expect(isStableJsonDataDirectoryAlias(root, alias(join(root, namespace)))).toBe(false);
    },
  );

  it('refuses invalid UTF-8 data and link bytes', () => {
    corpus();
    const link = alias();
    writeFileSync(join(root, 'docs/fixtures/a.json'), Buffer.from([0x22, 0xff, 0x22]));
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
    rmSync(link);
    symlinkSync(Buffer.from([0xff]), link);
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
  });

  it('refuses empty and oversized entry populations', () => {
    corpus();
    rmSync(join(root, 'docs/fixtures/a.json'));
    const link = alias();
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
    for (let i = 0; i < 257; i++) put(`docs/fixtures/${i}.json`);
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
  });

  it('refuses external JSON directories', () => {
    corpus();
    const outside = mkdtempSync(join(tmpdir(), 'devai-external-json-'));
    extra.push(outside);
    writeFileSync(join(outside, 'a.json'), '{}');
    expect(isStableJsonDataDirectoryAlias(root, alias(outside))).toBe(false);
    expect(sensors().every((reading) => reading.status === 'error')).toBe(true);
  });

  it('refuses absolute aliases, including internal targets', () => {
    corpus();
    const link = join(root, 'packages/api/fixtures');
    symlinkSync(join(root, 'docs/fixtures'), link, 'dir');
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
  });

  it('refuses chained, nested, cyclic, dangling and file aliases', () => {
    corpus();
    const target = join(root, 'docs/fixtures');
    symlinkSync('fixtures', join(root, 'docs/chain'), 'dir');
    expect(isStableJsonDataDirectoryAlias(root, alias(join(root, 'docs/chain')))).toBe(false);
    rmSync(join(root, 'packages/api/fixtures'));
    const link = alias();
    symlinkSync('../fixtures', join(target, 'cycle'), 'dir');
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
    rmSync(join(target, 'cycle'));
    rmSync(link);
    symlinkSync('missing', link, 'dir');
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
    rmSync(link);
    symlinkSync(relative(dirname(link), join(target, 'a.json')), link);
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
  });

  it('refuses oversized data and overdeep trees', () => {
    corpus();
    const link = alias();
    put('docs/fixtures/large.json', JSON.stringify('a'.repeat(4 * 1024 * 1024)));
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
    rmSync(join(root, 'docs/fixtures/large.json'));
    put('docs/fixtures/' + 'nested/'.repeat(17) + 'a.json');
    expect(isStableJsonDataDirectoryAlias(root, link)).toBe(false);
  });
});
