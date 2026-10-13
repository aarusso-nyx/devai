// Invariants: INV-DEVAI-002, INV-DEVAI-012
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestCoherence } from '../../src/test-coherence.js';

let root: string;
const vitestTest = "import { it } from 'vitest'; it('ordinary unit', () => {});\n";
const nodeTest = "import test from 'node:test'; test('contract', () => {});\n";

function write(path: string, contents: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function pair(
  left: string,
  right: string,
  leftPath = 'packages/contracts/test/contracts.test.mjs',
): void {
  write('packages/contracts/src/contract.ts', 'export const contract = 1;\n');
  write(leftPath, left);
  write('packages/units/src/unit.ts', 'export const unit = 1;\n');
  write('packages/units/test/unit.spec.ts', right);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-coherence-runner-family-ç '));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('test coherence measures naming within proven runner families', () => {
  it.each([
    ['default Node test', nodeTest],
    [
      'named Node test alias',
      "import { test as contract } from 'node:test'; contract('contract', () => {});\n",
    ],
    ['Node suite', "import { describe } from 'node:test'; describe('contract', () => {});\n"],
    ['Node namespace', "import * as node from 'node:test'; node.test('contract', () => {});\n"],
  ])('allows %s .test.mjs beside Vitest .spec.ts', (_description, content) => {
    pair(content, vitestTest);
    const reading = senseTestCoherence({ repoRoot: root });
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toMatchObject({ source_files: 2, test_files: 2, naming_consistent: 1 });
  });

  it.each([
    ['Vitest', vitestTest, vitestTest],
    ['Node test', nodeTest, nodeTest],
    [
      'Jest imports',
      "import { test } from '@jest/globals'; test('a', () => {});",
      "import { it } from '@jest/globals'; it('b', () => {});",
    ],
  ])('retains mixed naming review within the %s runner family', (_family, left, right) => {
    pair(left, right);
    const reading = senseTestCoherence({ repoRoot: root });
    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({
      naming_uses_test: 1,
      naming_uses_spec: 1,
      naming_consistent: 0,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'TEST_COHERENCE_NAMING_MIXED' }),
    );
  });

  it.each([
    ['comment', "// import test from 'node:test'; test('fake', () => {});\nexport {};"],
    ['string', "const fake = \"import test from 'node:test'; test('fake', () => {});\";"],
    ['unused import', "import test from 'node:test'; export const value = 1;"],
    ['type-only import', "import type { test } from 'node:test'; test('fake', () => {});"],
    ['type-only named binding', "import { type test } from 'node:test'; test('fake', () => {});"],
    [
      'conflicting families',
      "import test from 'node:test'; import { it } from 'vitest'; test('a', () => {}); it('b', () => {});",
    ],
    [
      'shadowed parameter',
      "import test from 'node:test'; function fake(test) { test('fake', () => {}); }",
    ],
    [
      'shadowed block',
      "import test from 'node:test'; { const test = () => {}; test('fake', () => {}); }",
    ],
    [
      'shadowed namespace',
      "import * as node from 'node:test'; function fake(node) { node.test('fake', () => {}); }",
    ],
    ['malformed source', "import test from 'node:test'; test('contract', () => {"],
    ['unknown runner', "import { test } from 'custom-runner'; test('fake', () => {});"],
    ['CommonJS diagnostic', "const test = require('node:test'); test('contract', () => {});"],
  ])(
    'keeps unknown %s naming conservative against a proven other family',
    (_description, content) => {
      pair(content, vitestTest);
      const reading = senseTestCoherence({ repoRoot: root });
      expect(reading.status).toBe('review');
      expect(reading.metrics).toMatchObject({ test_files: 2, naming_consistent: 0 });
      expect(reading.findings).toContainEqual(
        expect.objectContaining({ code: 'TEST_COHERENCE_NAMING_MIXED' }),
      );
    },
  );

  it('does not turn filename differences alone into runner-family separation', () => {
    pair('export {};', 'export {};');
    const reading = senseTestCoherence({ repoRoot: root });
    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ naming_consistent: 0 });
  });

  it.each(['vitest', '@jest/globals'])(
    'does not grant %s an unsupported suite API naming exemption',
    (module) => {
      pair(`import { suite } from '${module}'; suite('fake', () => {});`, nodeTest);
      const named = senseTestCoherence({ repoRoot: root });
      expect(named.status).toBe('review');
      expect(named.metrics).toMatchObject({ naming_consistent: 0 });
      expect(named.findings).toContainEqual(
        expect.objectContaining({ code: 'TEST_COHERENCE_NAMING_MIXED' }),
      );

      write(
        'packages/contracts/test/contracts.test.mjs',
        `import * as runner from '${module}'; runner.suite('fake', () => {});`,
      );
      const namespace = senseTestCoherence({ repoRoot: root });
      expect(namespace.status).toBe('review');
      expect(namespace.metrics).toMatchObject({ naming_consistent: 0 });
      expect(namespace.findings).toContainEqual(
        expect.objectContaining({ code: 'TEST_COHERENCE_NAMING_MIXED' }),
      );
    },
  );

  it('preserves the global test/source ratio failure for different proven families', () => {
    pair(nodeTest, vitestTest);
    for (let index = 0; index < 25; index += 1) {
      write(`packages/contracts/src/source${String(index)}.ts`, 'export const value = 1;');
    }
    const reading = senseTestCoherence({ repoRoot: root });
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({
      source_files: 27,
      test_files: 2,
      naming_consistent: 1,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'TEST_COHERENCE_PACKAGE_BELOW_MIN' }),
    );
  });
});
