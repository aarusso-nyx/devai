import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveImmutability, decisionRecordIntegrity } from '../../src/governance-ledger/index.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const base = mkdtempSync(join(tmpdir(), 'devai-governance-population-'));
  roots.push(base);
  return base;
}
function write(base: string, rel: string, content: string) {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function manifest(base: string, files: readonly unknown[], dir = 'law/adr/archive') {
  return write(base, dir + '/MANIFEST.json', JSON.stringify({ files }));
}
const invalidEntry = {
  code: 'ARCHIVE_MANIFEST_INVALID',
  message: 'Every manifest entry requires a unique canonical member path and lowercase SHA-256.',
  path: 'law/adr/archive/MANIFEST.json',
};

describe('archived governance evidence has an exact canonical population', () => {
  it.each([
    '',
    '.',
    '..',
    '/outside.md',
    '../outside.md',
    'nested/../x.md',
    'nested/./x.md',
    'nested//x.md',
    'nested/',
    'C:drive.md',
    'C:/drive.md',
    'back\\slash.md',
    'line\nfeed.md',
    'tab\tname.md',
    'null\0name.md',
    'MANIFEST.json',
  ])(
    'refuses invalid declared path %j as a manifest defect without trying to create that path',
    (path) => {
      const base = root();
      const file = manifest(base, [{ path, sha256: digest('data') }]);
      const before = readFileSync(file);
      expect(archiveImmutability({ repoRoot: base })).toEqual({
        ok: false,
        findings: [invalidEntry],
      });
      expect(readFileSync(file)).toEqual(before);
    },
  );
  it.each([
    null,
    4,
    'entry',
    {},
    { path: 'good.md' },
    { path: 'good.md', sha256: 42 },
    { path: 42, sha256: 'a'.repeat(64) },
    { path: 'good.md', sha256: 'A'.repeat(64) },
    { path: 'good.md', sha256: 'a'.repeat(63) },
    { path: 'good.md', sha256: 'g'.repeat(64) },
  ])('rejects malformed member %j with an explicit finding', (entry) => {
    const base = root();
    manifest(base, [entry]);
    expect(archiveImmutability({ repoRoot: base })).toEqual({
      ok: false,
      findings: [invalidEntry],
    });
  });
  it('reports missing, altered and undeclared members independently with exact locations', () => {
    const base = root();
    write(base, 'law/adr/archive/altered.md', 'actual bytes');
    write(base, 'law/adr/archive/nested/unlisted.md', 'unlisted');
    manifest(base, [
      { path: 'missing.md', sha256: digest('missing') },
      { path: 'altered.md', sha256: digest('expected bytes') },
    ]);
    expect(archiveImmutability({ repoRoot: base })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_FILE_MISSING',
          message: 'missing.md is declared but absent.',
          path: 'law/adr/archive/missing.md',
        },
        {
          code: 'ARCHIVE_HASH_MISMATCH',
          message: 'altered.md does not match its frozen SHA-256.',
          path: 'law/adr/archive/altered.md',
        },
        {
          code: 'ARCHIVE_FILE_UNDECLARED',
          message: 'nested/unlisted.md is not pinned by MANIFEST.json.',
          path: 'law/adr/archive/nested/unlisted.md',
        },
      ],
    });
  });
  it('accepts nested Unicode members and distinguishes member paths before checking duplicates', () => {
    const base = root();
    const data = 'ação\n';
    const members = ['one/ação.md', 'two/ação.md'];
    for (const member of members) write(base, 'custom/' + member, data);
    const entries = members.map((path) => ({ path, sha256: digest(data) }));
    manifest(base, entries, 'custom');
    expect(archiveImmutability({ repoRoot: base, archiveDir: 'custom' })).toEqual({
      ok: true,
      findings: [],
    });
    manifest(base, [...entries, entries[0]], 'custom');
    expect(archiveImmutability({ repoRoot: base, archiveDir: 'custom' })).toEqual({
      ok: false,
      findings: [{ ...invalidEntry, path: 'custom/MANIFEST.json' }],
    });
  });
  it('rejects an archive root link before reading its target manifest', () => {
    const base = root();
    manifest(base, [], 'outside');
    mkdirSync(join(base, 'law/adr'), { recursive: true });
    symlinkSync(join(base, 'outside'), join(base, 'law/adr/archive'));
    expect(archiveImmutability({ repoRoot: base })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'Archive root must be a directory, not a link.',
          path: 'law/adr/archive',
        },
      ],
    });
  });
  it('rejects a manifest symlink even when its target contains a valid empty archive', () => {
    const base = root();
    const outside = write(base, 'outside.json', '{"files":[]}');
    mkdirSync(join(base, 'law/adr/archive'), { recursive: true });
    symlinkSync(outside, join(base, 'law/adr/archive/MANIFEST.json'));
    expect(archiveImmutability({ repoRoot: base })).toEqual({
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'MANIFEST.json must be a regular JSON file containing a files array.',
          path: 'law/adr/archive/MANIFEST.json',
        },
      ],
    });
  });
});

function record(
  id: string,
  supersedes: readonly string[] = [],
  supersededBy: string | null = null,
) {
  return [
    '---',
    `id: ${id}`,
    'title: Reviewed decision',
    'type: adr',
    'status: draft',
    'date: 2026-09-08',
    'authority: Architect',
    `supersedes: ${JSON.stringify(supersedes)}`,
    `superseded_by: ${JSON.stringify(supersededBy)}`,
    '---',
    '# Decision',
    '',
  ].join('\n');
}
const noHistory = {
  code: 'DECISION_HISTORY_UNAVAILABLE',
  message: 'Sealed decision history requires Git, but repository state could not be queried.',
  path: 'law/adr',
};
describe('decision supersession resolves exact live record identities', () => {
  it('accepts symmetric live links while reporting unavailable history separately', () => {
    const base = root();
    write(base, 'law/adr/ADR-001.md', record('ADR-001', [], 'ADR-002'));
    write(base, 'law/adr/ADR-002-reviewed.md', record('ADR-002', ['ADR-001']));
    expect(decisionRecordIntegrity({ repoRoot: base })).toEqual({
      ok: false,
      findings: [noHistory],
    });
  });
  it.each(['missing', 'wrong', 'empty'] as const)(
    'reports a %s forward reverse-link without inventing a match',
    (kind) => {
      const base = root();
      write(base, 'law/adr/ADR-002.md', record('ADR-002', ['ADR-001']));
      if (kind !== 'missing')
        write(
          base,
          'law/adr/ADR-001.md',
          record('ADR-001', [], kind === 'wrong' ? 'ADR-003' : null),
        );
      const findings = decisionRecordIntegrity({ repoRoot: base }).findings;
      expect(findings).toContainEqual({
        code: 'DECISION_SUPERSESSION_ASYMMETRIC',
        message: 'ADR-002 supersedes ADR-001, but the reverse link does not resolve.',
        path: 'law/adr/ADR-002.md',
      });
      expect(
        findings.filter((finding) => finding.code === 'DECISION_SUPERSESSION_ASYMMETRIC'),
      ).toHaveLength(kind === 'wrong' ? 2 : 1);
    },
  );
  it.each(['missing', 'wrong', 'empty'] as const)('reports a %s successor declaration', (kind) => {
    const base = root();
    write(base, 'law/adr/ADR-001.md', record('ADR-001', [], 'ADR-002'));
    if (kind !== 'missing')
      write(base, 'law/adr/ADR-002.md', record('ADR-002', kind === 'wrong' ? ['ADR-003'] : []));
    expect(decisionRecordIntegrity({ repoRoot: base }).findings).toContainEqual({
      code: 'DECISION_SUPERSESSION_ASYMMETRIC',
      message: 'ADR-001 is superseded by ADR-002, but the reverse link does not resolve.',
      path: 'law/adr/ADR-001.md',
    });
  });
  it('keeps archived source provenance outside live-record reverse symmetry', () => {
    const base = root();
    write(base, 'law/adr/ADR-002.md', record('ADR-002', ['codex-pre-v1.md']));
    expect(decisionRecordIntegrity({ repoRoot: base })).toEqual({
      ok: false,
      findings: [noHistory],
    });
  });
});
