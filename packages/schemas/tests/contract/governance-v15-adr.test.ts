import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';
import {
  isCanonicalAffectedRuleSubject,
  matchesAdrSemantics,
  resolveAdrFixture,
  validateAdrResult,
  type AdrRecordFixture,
  type AdrValidationResultFixture,
} from '../fixtures/adr-v3.js';
import {
  ROOT,
  canonicalSha256,
  readJson,
  schemaExample,
  sha256,
} from '../fixtures/governance-v15.js';

interface LegacyRecord {
  readonly reference: string;
  readonly title: string;
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  readonly date: string | null;
  readonly source_format:
    | 'numeric-id-frontmatter'
    | 'date-id-frontmatter'
    | 'scoped-id-frontmatter'
    | 'no-frontmatter'
    | 'adr_id-frontmatter';
  readonly supersedes: readonly string[];
  readonly affected_rules: readonly string[];
}

interface CatalogEntry {
  readonly path: string;
  readonly sha256: string;
  readonly disposition: 'preserved-pre-v2-record' | 'non-record';
  readonly reason: string;
  readonly legacy_record?: LegacyRecord;
}

interface AdrPolicy {
  readonly body: { readonly required_sections: readonly string[] };
  readonly semantic_resolver: {
    readonly resolvable_legacy_references: ReadonlyArray<{
      readonly reference: string;
      readonly path: string;
      readonly disposition: 'preserved-pre-v2-record';
    }>;
  };
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
  return match === null ? undefined : (parseYaml(match[1] ?? '') as Record<string, unknown>);
}

function catalogDigest(entries: readonly CatalogEntry[]): string {
  const ordered = [...entries].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  return canonicalSha256(ordered);
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

function record(
  id: string,
  affectedRules: readonly string[],
  supersedes: readonly string[] = [],
): AdrRecordFixture {
  return {
    file: `law/adr/${id}-fixture.md`,
    adr_id: id,
    title: `${id} fixture`,
    status: 'accepted',
    date: '2026-09-03',
    format: 'v2',
    supersedes,
    affected_rules: affectedRules,
  };
}

function failedResult(
  source: AdrValidationResultFixture,
  semanticResolutionPerformed: boolean,
): AdrValidationResultFixture {
  return {
    ...source,
    ok: false,
    semantic_resolution_performed: semanticResolutionPerformed,
    errors: [
      semanticResolutionPerformed
        ? { file: 'law/adr/invalid.md', message: 'invalid ADR' }
        : {
            file: 'law/adr',
            message: 'semantic resolution was not performed',
            code: 'adr-semantic-resolution-not-performed',
            pointer: '/semantic_resolution_performed',
          },
    ],
    adrs: source.adrs.map((adr) => ({
      ...adr,
      effective: false,
      effective_affected_rules: [],
    })),
    effective_authorities: [],
    subject_authorities: [],
  };
}

function currentRecordFixtures(policy: AdrPolicy, adrRoot: string): AdrRecordFixture[] {
  const catalog = new Map(policy.exception_catalog.entries.map((entry) => [entry.path, entry]));
  const records: AdrRecordFixture[] = [];
  for (const path of markdownFiles(adrRoot)) {
    const name = relative(adrRoot, path);
    const exception = catalog.get(name);
    if (exception?.disposition === 'non-record') continue;
    if (exception?.legacy_record !== undefined) {
      const legacy = exception.legacy_record;
      records.push({
        file: relative(ROOT, path),
        adr_id: legacy.reference,
        title: legacy.title,
        status: legacy.status,
        date: legacy.date,
        format: 'legacy-catalog',
        supersedes: legacy.supersedes,
        affected_rules: legacy.affected_rules,
      });
      continue;
    }
    const metadata = frontmatter(readFileSync(path, 'utf8'));
    if (metadata === undefined) throw new Error(`${name} is neither v2 nor catalogued`);
    records.push({
      file: relative(ROOT, path),
      adr_id: String(metadata.id),
      title: String(metadata.title),
      status: metadata.status as AdrRecordFixture['status'],
      date: metadata.date === null ? null : String(metadata.date),
      format: 'v2',
      supersedes: (metadata.supersedes ?? []) as readonly string[],
      affected_rules: (metadata.affected_rules ?? []) as readonly string[],
    });
  }
  return records;
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

  it('binds the exception catalog digest to every full entry through RFC8785 JCS', () => {
    const paths = policy.exception_catalog.entries.map((entry) => entry.path);
    expect(paths).toEqual(
      [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    );
    expect(catalogDigest(policy.exception_catalog.entries)).toBe(
      policy.exception_catalog.catalog_digest_sha256,
    );

    const changed = structuredClone([...policy.exception_catalog.entries]);
    changed[0] = { ...changed[0], reason: `${changed[0]?.reason ?? ''} changed` } as CatalogEntry;
    expect(catalogDigest(changed)).not.toBe(policy.exception_catalog.catalog_digest_sha256);
  });

  it('fails closed for unclassified Markdown and byte-drifted catalog entries', () => {
    expect(
      classify('ADR-UNKNOWN.md', '# Unclassified\n', catalog, policy.body.required_sections),
    ).toBe('invalid');
    const legacy = policy.exception_catalog.entries[0];
    expect(legacy).toBeDefined();
    expect(
      classify(
        legacy?.path ?? '',
        '# rewritten legacy record\n',
        catalog,
        policy.body.required_sections,
      ),
    ).toBe('invalid');
  });

  it('represents numeric, date, scoped, no-frontmatter, and adr_id legacy forms', () => {
    const formats: LegacyRecord['source_format'][] = [
      'numeric-id-frontmatter',
      'date-id-frontmatter',
      'scoped-id-frontmatter',
      'no-frontmatter',
      'adr_id-frontmatter',
    ];
    const references = [
      'ADR-900',
      'LEGACY:date-2020-01-01',
      'LEGACY:scoped-ADR-GOV-0042',
      'LEGACY:no-frontmatter',
      'LEGACY:adr_id-era',
    ];
    const entries: CatalogEntry[] = formats.map((sourceFormat, index) => ({
      path: `legacy/${String(index)}.md`,
      sha256: String(index + 1).repeat(64),
      disposition: 'preserved-pre-v2-record',
      reason: `${sourceFormat} fixture`,
      legacy_record: {
        reference: references[index] ?? '',
        title: `${sourceFormat} fixture`,
        status: 'accepted',
        date: sourceFormat === 'no-frontmatter' ? null : '2020-01-01',
        source_format: sourceFormat,
        supersedes: [],
        affected_rules: [`law/legacy/${String(index)}.json`],
      },
    }));
    const candidate = structuredClone(
      readJson<Record<string, unknown>>('law/policy/adr-validation.json'),
    );
    const candidateCatalog = candidate.exception_catalog as Record<string, unknown>;
    candidateCatalog.entries = entries;
    candidateCatalog.catalog_digest_sha256 = catalogDigest(entries);
    const semanticResolver = candidate.semantic_resolver as Record<string, unknown>;
    semanticResolver.resolvable_legacy_references = entries.map((entry) => ({
      reference: entry.legacy_record?.reference,
      path: entry.path,
      disposition: 'preserved-pre-v2-record',
    }));
    const validate = getValidator('adr-validation-policy.schema.json');
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);

    const invalid = structuredClone(candidate);
    const invalidEntries = (
      invalid.exception_catalog as { entries: Array<Record<string, unknown>> }
    ).entries;
    const firstInvalidEntry = invalidEntries[0] ?? {};
    invalidEntries[0] = {
      ...firstInvalidEntry,
      legacy_record: {
        ...(firstInvalidEntry.legacy_record as Record<string, unknown>),
        source_format: 'unknown-era',
      },
    };
    expect(validate(invalid)).toBe(false);
  });

  it('requires an exact legacy reference/path allowlist bijection', () => {
    const materialized = policy.exception_catalog.entries
      .filter((entry) => entry.legacy_record !== undefined)
      .map((entry) => `${entry.legacy_record?.reference ?? ''}\u0000${entry.path}`)
      .sort();
    const allowlisted = policy.semantic_resolver.resolvable_legacy_references
      .map((entry) => `${entry.reference}\u0000${entry.path}`)
      .sort();
    expect(allowlisted).toEqual(materialized);
    expect([...allowlisted, 'LEGACY:invented\u0000invented.md']).not.toEqual(materialized);
  });

  it('rejects unscoped ids, missing canonical id, unknown status, and derived fields', () => {
    const valid = schemaExample<Record<string, unknown>>('adr-v2.schema.json');
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
    const valid = schemaExample<Record<string, unknown>>('adr-v2.schema.json');
    expect(getValidator('adr-v2.schema.json')({ ...valid, id: 'ADR-RELEASE-9001' })).toBe(true);
  });

  it('enforces canonical NFC repository-relative affected-rule subjects', () => {
    for (const subject of ['a.txt', 'scripts/check-workflows.mjs', 'law/policy/é.json']) {
      expect(isCanonicalAffectedRuleSubject(subject), subject).toBe(true);
    }
    for (const subject of [
      '',
      '/absolute',
      'C:/absolute',
      'a\\b',
      'a//b',
      'a/./b',
      'a/../b',
      'a/',
      'a*.txt',
      'a?.txt',
      'a[0].txt',
      'a{b}.txt',
      'a\u0000b',
      'law/policy/e\u0301.json',
    ]) {
      expect(isCanonicalAffectedRuleSubject(subject), JSON.stringify(subject)).toBe(false);
    }
  });
});

describe('ADR-v3 public result and semantic authority', () => {
  const simpleRecords = [record('ADR-TST-0001', ['law/a.txt'])];
  const success = resolveAdrFixture(simpleRecords);

  it('validates the exact closed public result, error, and ADR row shapes', () => {
    expect(validateAdrResult(success), JSON.stringify(validateAdrResult.errors)).toBe(true);
    const topFields = [
      'ok',
      'kernel_id',
      'semantic_resolution_performed',
      'files_scanned',
      'errors',
      'adrs',
      'effective_authorities',
      'subject_authorities',
    ];
    for (const field of topFields) {
      const invalid = structuredClone(success) as unknown as Record<string, unknown>;
      Reflect.deleteProperty(invalid, field);
      expect(validateAdrResult(invalid), `missing ${field}`).toBe(false);
    }
    expect(validateAdrResult({ ...success, unexpected: true })).toBe(false);

    const failure = failedResult(success, false);
    expect(validateAdrResult(failure), JSON.stringify(validateAdrResult.errors)).toBe(true);
    expect(
      validateAdrResult({
        ...failure,
        errors: [{ file: 'law/adr', message: 'failed', code: 'failure', pointer: '/id' }],
        semantic_resolution_performed: true,
      }),
    ).toBe(true);
    expect(validateAdrResult({ ...failure, errors: [{ file: 'law/adr' }] })).toBe(false);
    expect(
      validateAdrResult({
        ...failure,
        errors: [{ file: 'law/adr', message: 'failed', extra: true }],
      }),
    ).toBe(false);

    const rowFields = Object.keys(success.adrs[0] ?? {});
    for (const field of rowFields) {
      const invalid = structuredClone(success) as unknown as {
        adrs: Array<Record<string, unknown>>;
      };
      Reflect.deleteProperty(invalid.adrs[0] ?? {}, field);
      expect(validateAdrResult(invalid), `missing ADR row ${field}`).toBe(false);
    }
    const extraRow = structuredClone(success) as unknown as {
      adrs: Array<Record<string, unknown>>;
    };
    (extraRow.adrs[0] ?? {}).unexpected = true;
    expect(validateAdrResult(extraRow)).toBe(false);
  });

  it('accepts only v2 and legacy-catalog row provenance formats', () => {
    const legacy = structuredClone(success) as unknown as {
      adrs: Array<Record<string, unknown>>;
    };
    (legacy.adrs[0] ?? {}).format = 'legacy-catalog';
    expect(validateAdrResult(legacy)).toBe(true);
    for (const format of ['', 'legacy', 'numeric-id-frontmatter', 'invented-format']) {
      const invalid = structuredClone(success) as unknown as {
        adrs: Array<Record<string, unknown>>;
      };
      (invalid.adrs[0] ?? {}).format = format;
      expect(validateAdrResult(invalid), format).toBe(false);
    }
  });

  it('binds ok exactly to completed semantics and an empty error set', () => {
    expect(validateAdrResult(success)).toBe(true);
    expect(validateAdrResult(failedResult(success, false))).toBe(true);
    expect(validateAdrResult(failedResult(success, true))).toBe(true);
    expect(validateAdrResult({ ...success, errors: [{ file: 'x', message: 'failed' }] })).toBe(
      false,
    );
    expect(validateAdrResult({ ...failedResult(success, false), ok: true })).toBe(false);
    expect(
      validateAdrResult({
        ...failedResult(success, false),
        semantic_resolution_performed: true,
        errors: [],
      }),
    ).toBe(false);
    expect(
      validateAdrResult({
        ...failedResult(success, false),
        errors: [{ file: 'x', message: 'semantic resolution missing' }],
      }),
    ).toBe(false);
  });

  it('requires zero authority and zero effective row state on every failure', () => {
    const failure = failedResult(success, false);
    const liveAuthority = success.subject_authorities[0];
    expect(liveAuthority).toBeDefined();
    for (const invalid of [
      { ...failure, adrs: [{ ...failure.adrs[0], effective: true }] },
      {
        ...failure,
        adrs: [{ ...failure.adrs[0], effective_affected_rules: ['law/a.txt'] }],
      },
      { ...failure, effective_authorities: ['ADR-TST-0001'] },
      { ...failure, subject_authorities: [liveAuthority] },
    ]) {
      expect(validateAdrResult(invalid)).toBe(false);
    }
  });

  it('resolves disjoint lineages and partial per-subject effectiveness deterministically', () => {
    const records = [
      record('ADR-TST-0001', ['law/a.txt', 'law/b.txt']),
      record('ADR-TST-0002', ['law/a.txt'], ['ADR-TST-0001']),
      record('ADR-TST-0003', ['law/a.txt']),
    ];
    const result = resolveAdrFixture(records);
    expect(result.effective_authorities).toEqual(['ADR-TST-0001', 'ADR-TST-0002', 'ADR-TST-0003']);
    expect(result.adrs[0]).toMatchObject({
      adr_id: 'ADR-TST-0001',
      effective: true,
      effective_affected_rules: ['law/b.txt'],
    });
    expect(result.subject_authorities).toEqual([
      {
        subject: 'law/a.txt',
        lineage_members: ['ADR-TST-0001', 'ADR-TST-0002'],
        effective_head: 'ADR-TST-0002',
      },
      {
        subject: 'law/a.txt',
        lineage_members: ['ADR-TST-0003'],
        effective_head: 'ADR-TST-0003',
      },
      {
        subject: 'law/b.txt',
        lineage_members: ['ADR-TST-0001'],
        effective_head: 'ADR-TST-0001',
      },
    ]);
    expect(validateAdrResult(result), JSON.stringify(validateAdrResult.errors)).toBe(true);
    expect(matchesAdrSemantics(records, result)).toBe(true);
  });

  it('rejects orphan, omitted, invented, duplicated, misheaded, and reordered authority', () => {
    const records = [
      record('ADR-TST-0001', ['law/a.txt', 'law/b.txt']),
      record('ADR-TST-0002', ['law/a.txt'], ['ADR-TST-0001']),
    ];
    const valid = resolveAdrFixture(records);
    const firstAuthority = valid.subject_authorities[0];
    if (firstAuthority === undefined) throw new Error('fixture has no subject authority');
    const adversaries: AdrValidationResultFixture[] = [
      {
        ...valid,
        subject_authorities: [
          ...valid.subject_authorities,
          {
            subject: 'law/a.txt',
            lineage_members: ['ADR-TST-9999'],
            effective_head: 'ADR-TST-9999',
          },
        ],
        effective_authorities: [...valid.effective_authorities, 'ADR-TST-9999'],
      },
      { ...valid, subject_authorities: valid.subject_authorities.slice(1) },
      {
        ...valid,
        adrs: valid.adrs.map((adr) =>
          adr.adr_id === 'ADR-TST-0001'
            ? { ...adr, effective_affected_rules: ['law/b.txt', 'law/invented.txt'] }
            : adr,
        ),
      },
      {
        ...valid,
        subject_authorities: [firstAuthority, ...valid.subject_authorities],
      },
      {
        ...valid,
        subject_authorities: valid.subject_authorities.map((authority, index) =>
          index === 0 ? { ...authority, effective_head: 'ADR-TST-0001' } : authority,
        ),
      },
      { ...valid, subject_authorities: [...valid.subject_authorities].reverse() },
      { ...valid, effective_authorities: valid.effective_authorities.slice(1) },
      {
        ...valid,
        adrs: valid.adrs.map((adr, index) =>
          index === 0 ? { ...adr, effective: !adr.effective } : adr,
        ),
      },
    ];
    for (const adversary of adversaries)
      expect(matchesAdrSemantics(records, adversary)).toBe(false);
  });

  it('rejects global cycles before subject projection and malformed graph references', () => {
    expect(() =>
      resolveAdrFixture([
        record('ADR-TST-0001', ['law/a.txt'], ['ADR-TST-0002']),
        record('ADR-TST-0002', ['law/b.txt'], ['ADR-TST-0001']),
      ]),
    ).toThrow('adr-supersession-cycle');
    expect(() =>
      resolveAdrFixture([record('ADR-TST-0001', ['law/a.txt'], ['ADR-TST-9999'])]),
    ).toThrow('adr-unresolved-supersedes-reference');
    expect(() =>
      resolveAdrFixture([record('ADR-TST-0001', ['law/a.txt'], ['ADR-TST-0001'])]),
    ).toThrow('adr-self-supersedes-reference');
    expect(() =>
      resolveAdrFixture([
        record('ADR-TST-0001', ['law/a.txt']),
        record('ADR-TST-0002', ['law/a.txt'], ['ADR-TST-0001']),
        record('ADR-TST-0003', ['law/a.txt'], ['ADR-TST-0001']),
      ]),
    ).toThrow('adr-multiple-effective-accepted-heads');
  });

  it('permits a converged branch only when it has one effective accepted head', () => {
    const result = resolveAdrFixture([
      record('ADR-TST-0001', ['law/a.txt']),
      record('ADR-TST-0002', ['law/a.txt'], ['ADR-TST-0001']),
      record('ADR-TST-0003', ['law/a.txt'], ['ADR-TST-0001']),
      record('ADR-TST-0004', ['law/a.txt'], ['ADR-TST-0002', 'ADR-TST-0003']),
    ]);
    expect(result.subject_authorities).toEqual([
      {
        subject: 'law/a.txt',
        lineage_members: ['ADR-TST-0001', 'ADR-TST-0002', 'ADR-TST-0003', 'ADR-TST-0004'],
        effective_head: 'ADR-TST-0004',
      },
    ]);
  });

  it('freezes the current 17-record authority graph and complete result instance', () => {
    const policy = readJson<AdrPolicy>('law/policy/adr-validation.json');
    const adrRoot = resolve(ROOT, 'law/adr');
    const records = currentRecordFixtures(policy, adrRoot);
    const result = resolveAdrFixture(records, markdownFiles(adrRoot).length);
    expect(records).toHaveLength(17);
    expect(result.files_scanned).toBe(18);
    expect(result.subject_authorities).toHaveLength(25);
    expect(result.effective_authorities).toEqual([
      'ADR-014',
      'ADR-AUT-0001',
      'ADR-GOV-0002',
      'ADR-GOV-0004',
      'ADR-GOV-0005',
      'ADR-GOV-0007',
      'ADR-GOV-0011',
      'ADR-REL-0002',
    ]);
    expect(validateAdrResult(result), JSON.stringify(validateAdrResult.errors)).toBe(true);
    expect(matchesAdrSemantics(records, result, markdownFiles(adrRoot).length)).toBe(true);
  });
});
