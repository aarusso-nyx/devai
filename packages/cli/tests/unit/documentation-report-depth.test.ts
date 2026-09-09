import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalDescriptorHandoffReport } from '../../src/commands/check/documentation-report.js';

const roots: string[] = [];
const SOURCE_ROOT = resolve(import.meta.dirname, '../../../..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-documentation-report-depth-'));
  roots.push(root);
  cpSync(join(SOURCE_ROOT, 'law'), join(root, 'law'), { recursive: true, dereference: true });
  assertOwned(root, join(root, 'law'));
  return root;
}

function assertOwned(root: string, directory: string): void {
  if (!roots.includes(root)) throw new Error('unowned fixture');
  const path = relative(realpathSync(root), realpathSync(directory));
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('fixture path escaped owned root');
  }
}

function put(root: string, relativePath: string, value: unknown): void {
  const path = join(root, relativePath);
  assertOwned(root, dirname(path));
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function architecture(root: string, value: unknown): void {
  put(root, 'law/policy/documentation-information-architecture.json', value);
}

describe('canonical documentation descriptor report boundaries', () => {
  it('builds the complete current descriptor population from real policy and schema files', () => {
    const root = fixture();
    const report = buildCanonicalDescriptorHandoffReport(root);
    const categories = Object.values(report.categories);

    expect(report.scope).toBe('current-canonical-descriptors');
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((category) => category.missing.length === 0)).toBe(true);
    expect(categories.every((category) => category.extra.length === 0)).toBe(true);
    expect(categories.every((category) => category.duplicates.length === 0)).toBe(true);
    expect(
      categories.every(
        (category) => category.expected_ids.length === category.documented_ids.length,
      ),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['string', 'invalid architecture'],
    ['array', []],
  ] as const)(
    'rejects a non-object architecture root (%s) with the source-invalid error',
    (_label, value) => {
      const root = fixture();
      architecture(root, value);
      expect(() => buildCanonicalDescriptorHandoffReport(root)).toThrow(
        'CHECK_DESCRIPTOR_SOURCE_INVALID:law/policy/documentation-information-architecture.json',
      );
    },
  );

  it('rejects a category population containing a non-object entry before category traversal', () => {
    const root = fixture();
    architecture(root, {
      categories: [
        { category_id: 'check-suites', canonical_source: 'law/policy/check-suites.json' },
        'invalid category entry',
      ],
    });
    expect(() => buildCanonicalDescriptorHandoffReport(root)).toThrow(
      'CHECK_DESCRIPTOR_CATEGORIES_INVALID: expected object array',
    );
  });
});
