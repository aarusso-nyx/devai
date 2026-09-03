import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import { ROOT, readJson, sha256 } from '../fixtures/governance-v15.js';

interface CatalogEntry {
  readonly path: string;
  readonly sha256: string;
}

interface AdrPolicy {
  readonly body: { readonly required_sections: readonly string[] };
  readonly exception_catalog: {
    readonly catalog_digest_sha256: string;
    readonly entries: readonly CatalogEntry[];
  };
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlinked ADR surface: ${path}`);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [path] : [];
    })
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function frontmatter(source: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  return match === null ? undefined : (parseYaml(match[1]) as Record<string, unknown>);
}

function catalogDigest(entries: readonly CatalogEntry[]): string {
  const bytes = [...entries]
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
    .map((entry) => `${entry.path} ${entry.sha256}\n`)
    .join('');
  return createHash('sha256').update(bytes).digest('hex');
}

function classify(
  name: string,
  source: string,
  catalog: ReadonlyMap<string, CatalogEntry>,
  requiredSections: readonly string[],
): 'catalogued' | 'v2' | 'invalid' {
  const exception = catalog.get(name);
  if (exception !== undefined)
    return sha256(source) === exception.sha256 ? 'catalogued' : 'invalid';
  const metadata = frontmatter(source);
  if (metadata === undefined || !getValidator('adr-v2.schema.json')(metadata)) return 'invalid';
  const id = String(metadata.id);
  if (!basename(name).startsWith(`${id}-`)) return 'invalid';
  return requiredSections.every((section) => new RegExp(`^## ${section}$`, 'mu').test(source))
    ? 'v2'
    : 'invalid';
}

describe('ADR-v2 census and legacy catalog', () => {
  const policy = readJson<AdrPolicy>('law/policy/adr-validation.json');
  const adrRoot = resolve(ROOT, 'law/adr');
  const catalog = new Map(policy.exception_catalog.entries.map((entry) => [entry.path, entry]));

  it('accounts for every Markdown byte as a valid v2 record or an exact catalog entry', () => {
    const accounted: string[] = [];

    for (const path of markdownFiles(adrRoot)) {
      expect(lstatSync(path).isFile()).toBe(true);
      const name = relative(adrRoot, path);
      const source = readFileSync(path, 'utf8');
      const exception = catalog.get(name);
      if (exception !== undefined) {
        expect(classify(name, source, catalog, policy.body.required_sections)).toBe('catalogued');
        expect(sha256(source)).toBe(exception.sha256);
        accounted.push(name);
        continue;
      }

      expect(classify(name, source, catalog, policy.body.required_sections)).toBe('v2');
      const metadata = frontmatter(source);
      expect(metadata, `${name} must be v2 or catalogued`).toBeDefined();
      expect(getValidator('adr-v2.schema.json')(metadata)).toBe(true);
      const id = String(metadata?.id);
      expect(basename(name).startsWith(`${id}-`)).toBe(true);
      for (const section of policy.body.required_sections) {
        expect(source).toMatch(new RegExp(`^## ${section}$`, 'mu'));
      }
      accounted.push(name);
    }

    expect(accounted).toHaveLength(markdownFiles(adrRoot).length);
    expect(new Set(accounted).size).toBe(accounted.length);
  });

  it('binds the exception catalog digest to its exact sorted content', () => {
    expect(catalogDigest(policy.exception_catalog.entries)).toBe(
      policy.exception_catalog.catalog_digest_sha256,
    );
  });

  it('fails closed for unclassified Markdown and byte-drifted catalog entries', () => {
    expect(
      classify('ADR-UNKNOWN.md', '# Unclassified\n', catalog, policy.body.required_sections),
    ).toBe('invalid');
    const legacy = policy.exception_catalog.entries[0];
    expect(
      classify(legacy.path, '# rewritten legacy record\n', catalog, policy.body.required_sections),
    ).toBe('invalid');
  });

  it('rejects unscoped ids, missing canonical id, unknown status, and derived fields', () => {
    const valid = readJson<{ examples: Record<string, unknown>[] }>(
      'law/schemas/adr-v2.schema.json',
    ).examples[0];
    for (const invalid of [
      { ...valid, id: 'ADR-001' },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'id')),
      { ...valid, status: 'deprecated' },
      { ...valid, scope: 'GOV' },
      { ...valid, superseded_by: 'ADR-GOV-0002' },
    ]) {
      expect(getValidator('adr-v2.schema.json')(invalid)).toBe(false);
    }
  });

  it('accepts sparse scoped numbering without a global contiguous sequence', () => {
    const valid = readJson<{ examples: Record<string, unknown>[] }>(
      'law/schemas/adr-v2.schema.json',
    ).examples[0];
    expect(getValidator('adr-v2.schema.json')({ ...valid, id: 'ADR-RELEASE-9001' })).toBe(true);
  });
});
