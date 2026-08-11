import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveImmutability,
  decisionCitationResolution,
  decisionRecordIntegrity,
  governanceLedger,
  parseGovernanceRecord,
  renderDecisionIndex,
  renderDecisionRecords,
  renderRoundRecords,
  roundRecordIntegrity,
} from '../../src/governance-ledger/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-governance-ledger-'));
  roots.push(root);
  return root;
}

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function recordSource(
  options: {
    id?: string;
    status?: string;
    title?: string;
    supersedes?: string;
    supersededBy?: string;
    body?: string;
  } = {},
): string {
  const id = options.id ?? 'ADR-001';
  return [
    '---',
    `id: ${id}`,
    `title: ${options.title ?? 'Fixture decision'}`,
    'type: adr',
    `status: ${options.status ?? 'draft'}`,
    'date: 2026-07-24',
    'authority: Architect',
    `supersedes: ${options.supersedes ?? '[]'}`,
    `superseded_by: ${options.supersededBy ?? 'null'}`,
    'provenance: [fixture, source-7]',
    'affected_rules:',
    '  - id: RULE-1',
    '    enabled: true',
    '---',
    '',
    options.body ?? `# ${id}. Fixture decision`,
    '',
  ].join('\n');
}

function writeRecord(root: string, name: string, source = recordSource()): string {
  const path = join(root, 'law/adr', name);
  write(path, source);
  return path;
}

function initGit(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', message],
    { cwd: root },
  );
}

describe('governance record parsing and integrity', () => {
  it('parses the supported YAML subset and rejects missing frontmatter', () => {
    const root = fixtureRoot();
    const path = writeRecord(root, 'ADR-001.md');
    const parsed = parseGovernanceRecord(path);

    expect(parsed.frontmatter).toMatchObject({
      id: 'ADR-001',
      status: 'draft',
      provenance: ['fixture', 'source-7'],
      affected_rules: [{ id: 'RULE-1', enabled: true }],
    });
    expect(parsed.body).toContain('# ADR-001');

    const invalid = join(root, 'invalid.md');
    write(invalid, '# no frontmatter\n');
    expect(() => parseGovernanceRecord(invalid)).toThrow('frontmatter is required');
  });

  it('KR-R5-029 parses validator-accepted semicolon inline arrays for supersession', () => {
    const root = fixtureRoot();
    const path = writeRecord(
      root,
      'ADR-003.md',
      recordSource({ id: 'ADR-003', status: 'active', supersedes: '[ADR-001; ADR-002]' }),
    );

    expect(parseGovernanceRecord(path).frontmatter['supersedes']).toEqual(['ADR-001', 'ADR-002']);
  });

  it('accepts valid records and reports malformed, schema, filename, duplicate, and link defects', () => {
    const root = fixtureRoot();
    writeRecord(root, 'README.md', '# ignored\n');
    writeRecord(root, 'codex-pre-v1.md', '# ignored\n');
    writeRecord(root, 'broken.md', '# no frontmatter\n');
    writeRecord(root, 'wrong-name.md', recordSource({ id: 'ADR-001' }));
    writeRecord(root, 'duplicate.md', recordSource({ id: 'ADR-001', title: '' }));
    writeRecord(root, 'ADR-002.md', recordSource({ id: 'ADR-002', supersedes: '[ADR-404]' }));
    writeRecord(root, 'ADR-003.md', recordSource({ id: 'ADR-003', supersededBy: '[ADR-404]' }));

    const report = decisionRecordIntegrity({ repoRoot: root });
    const codes = report.findings.map((finding) => finding.code);

    expect(report.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        'DECISION_FRONTMATTER_INVALID',
        'DECISION_SCHEMA_INVALID',
        'DECISION_ID_FILENAME_MISMATCH',
        'DECISION_ID_DUPLICATE',
        'DECISION_SUPERSESSION_ASYMMETRIC',
      ]),
    );
  });

  it('detects mutation after a record is sealed in git history', () => {
    const root = fixtureRoot();
    const path = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'active', body: '# ADR-001. Sealed' }),
    );
    initGit(root);
    commitAll(root, 'seal');
    writeFileSync(path, recordSource({ status: 'active', body: '# ADR-001. Mutated' }));
    commitAll(root, 'mutate');

    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
    );
  });

  it('fails sealed-history verification closed in a shallow clone', () => {
    const source = fixtureRoot();
    writeRecord(source, 'ADR-001.md', recordSource({ status: 'active' }));
    initGit(source);
    commitAll(source, 'activate');

    const cloneParent = fixtureRoot();
    const shallow = join(cloneParent, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallow]);

    expect(decisionRecordIntegrity({ repoRoot: shallow }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_HISTORY_SHALLOW' }),
    );
  });

  it('reports malformed post-seal history instead of throwing', () => {
    const root = fixtureRoot();
    const path = writeRecord(root, 'ADR-001.md', recordSource({ status: 'active' }));
    initGit(root);
    commitAll(root, 'activate');
    writeFileSync(path, '---\nid: ADR-001\n# missing closing frontmatter\n');
    commitAll(root, 'malformed');
    writeFileSync(path, recordSource({ status: 'active' }));
    commitAll(root, 'restore');

    expect(() => decisionRecordIntegrity({ repoRoot: root })).not.toThrow();
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_HISTORY_PARSE_INVALID' }),
    );
  });

  it('detects a sealed-body mutation hidden inside a rename commit', () => {
    const root = fixtureRoot();
    const oldPath = writeRecord(
      root,
      'ADR-001-original.md',
      recordSource({ status: 'active', body: '# ADR-001. Sealed before rename' }),
    );
    initGit(root);
    commitAll(root, 'activate old path');
    const currentPath = join(root, 'law/adr/ADR-001.md');
    execFileSync('git', ['mv', oldPath, currentPath], { cwd: root });
    writeFileSync(
      currentPath,
      recordSource({ status: 'active', body: '# ADR-001. Mutated during rename' }),
    );
    commitAll(root, 'rename and mutate');

    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
    );
  });

  it('treats a copied successor as a new sealed-history boundary', () => {
    const root = fixtureRoot();
    const first = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'active', body: '# Shared doctrine\n\nOriginal active record.' }),
    );
    initGit(root);
    commitAll(root, 'activate original');

    writeFileSync(
      first,
      recordSource({
        status: 'superseded',
        supersededBy: 'ADR-002',
        body: '# Shared doctrine\n\nOriginal active record.',
      }),
    );
    const second = writeRecord(
      root,
      'ADR-002.md',
      recordSource({
        id: 'ADR-002',
        status: 'active',
        supersedes: '[ADR-001]',
        body: '# Shared doctrine\n\nOriginal active record with one successor clarification.',
      }),
    );
    commitAll(root, 'copy into successor');

    writeFileSync(
      second,
      recordSource({
        id: 'ADR-002',
        status: 'superseded',
        supersedes: '[ADR-001]',
        supersededBy: 'ADR-003',
        body: '# Shared doctrine\n\nOriginal active record with one successor clarification.',
      }),
    );
    writeRecord(
      root,
      'ADR-003.md',
      recordSource({ id: 'ADR-003', status: 'active', supersedes: '[ADR-002]' }),
    );
    commitAll(root, 'supersede copied successor');

    expect(
      decisionRecordIntegrity({ repoRoot: root }).findings.filter(
        (finding) =>
          finding.code === 'DECISION_LOCKED_BODY_MUTATED' &&
          finding.path?.endsWith('ADR-002.md') === true,
      ),
    ).toEqual([]);
  });

  it('fails sealed-history verification closed when Git is unavailable', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-001.md', recordSource({ status: 'active' }));
    initGit(root);
    commitAll(root, 'activate');
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
        expect.objectContaining({ code: 'DECISION_HISTORY_UNAVAILABLE' }),
      );
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });

  it('fails sealed-history verification closed without Git metadata', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-001.md', recordSource({ status: 'active' }));
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_HISTORY_UNAVAILABLE' }),
    );
  });

  it('treats superseded records as terminal', () => {
    const root = fixtureRoot();
    const path = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'superseded', supersededBy: 'ADR-002' }),
    );
    initGit(root);
    commitAll(root, 'supersede');
    writeFileSync(path, recordSource({ status: 'active', supersededBy: 'ADR-002' }));
    commitAll(root, 'illegal-terminal-transition');

    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
    );
  });

  it('permits one active-to-superseded scalar replacement transition', () => {
    const root = fixtureRoot();
    const path = writeRecord(root, 'ADR-001.md', recordSource({ status: 'active' }));
    initGit(root);
    commitAll(root, 'activate');
    writeFileSync(path, recordSource({ status: 'superseded', supersededBy: 'ADR-002' }));
    writeRecord(root, 'ADR-002.md', recordSource({ id: 'ADR-002', supersedes: '[ADR-001]' }));
    commitAll(root, 'supersede');

    expect(decisionRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });

  it('accepts a pre-merge body restoration followed by canonical supersession', () => {
    const root = fixtureRoot();
    const originalBody = '# ADR-001. Sealed';
    const path = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'active', body: originalBody }),
    );
    initGit(root);
    commitAll(root, 'activate');
    writeFileSync(path, recordSource({ status: 'active', body: '# ADR-001. Invalid edit' }));
    commitAll(root, 'invalid intermediate edit');
    writeFileSync(
      path,
      recordSource({ status: 'superseded', supersededBy: 'ADR-002', body: originalBody }),
    );
    writeRecord(root, 'ADR-002.md', recordSource({ id: 'ADR-002', supersedes: '[ADR-001]' }));
    commitAll(root, 'restore and supersede');

    expect(
      decisionRecordIntegrity({ repoRoot: root }).findings.filter(
        (finding) => finding.code === 'DECISION_LOCKED_BODY_MUTATED',
      ),
    ).toEqual([]);
  });

  it('rejects replacement changes after supersession and returns to draft', () => {
    const supersededRoot = fixtureRoot();
    const supersededPath = writeRecord(
      supersededRoot,
      'ADR-001.md',
      recordSource({ status: 'active' }),
    );
    initGit(supersededRoot);
    commitAll(supersededRoot, 'activate');
    writeFileSync(supersededPath, recordSource({ status: 'superseded', supersededBy: 'ADR-002' }));
    commitAll(supersededRoot, 'supersede');
    writeFileSync(supersededPath, recordSource({ status: 'superseded', supersededBy: 'ADR-003' }));
    commitAll(supersededRoot, 'replace-link');

    const draftRoot = fixtureRoot();
    const draftPath = writeRecord(draftRoot, 'ADR-001.md', recordSource({ status: 'active' }));
    initGit(draftRoot);
    commitAll(draftRoot, 'activate');
    writeFileSync(draftPath, recordSource({ status: 'draft' }));
    commitAll(draftRoot, 'return-to-draft');

    for (const root of [supersededRoot, draftRoot]) {
      expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
        expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
      );
    }
  });
});

describe('citation and archive integrity', () => {
  it('resolves known decision citations and reports missing ones in explicit roots', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-001-runtime-authority.md');
    write(join(root, 'law/register/DECISIONS.md'), '### DII-101 — A registered decision\n');
    write(
      join(root, 'docs/reference.md'),
      'ADR-001 and DII-101 are valid; ADR-404 and DII-999 are missing.\n',
    );

    const report = decisionCitationResolution({ repoRoot: root, roots: ['docs'] });
    expect(report).toEqual({
      ok: false,
      findings: [
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing ADR-404.',
          path: 'docs/reference.md',
        },
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing DII-999.',
          path: 'docs/reference.md',
        },
      ],
    });
  });

  it('treats an absent archive as valid and requires a parseable manifest when present', () => {
    const root = fixtureRoot();
    expect(archiveImmutability({ repoRoot: root })).toEqual({ ok: true, findings: [] });

    const archive = join(root, 'law/adr/archive');
    mkdirSync(archive, { recursive: true });
    expect(archiveImmutability({ repoRoot: root }).findings[0]?.code).toBe(
      'ARCHIVE_MANIFEST_MISSING',
    );
    write(join(archive, 'MANIFEST.json'), '{bad');
    expect(archiveImmutability({ repoRoot: root }).findings[0]?.code).toBe(
      'ARCHIVE_MANIFEST_INVALID',
    );
  });

  it('reports malformed entries, missing files, hash mismatches, and undeclared files', () => {
    const root = fixtureRoot();
    const archive = join(root, 'law/adr/archive');
    write(join(archive, 'present.md'), 'present\n');
    write(join(archive, 'extra.md'), 'extra\n');
    write(
      join(archive, 'MANIFEST.json'),
      JSON.stringify({
        files: [
          {},
          { path: 'missing.md', sha256: 'a'.repeat(64) },
          { path: 'present.md', sha256: 'b'.repeat(64) },
        ],
      }),
    );

    const codes = archiveImmutability({ repoRoot: root }).findings.map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'ARCHIVE_MANIFEST_INVALID',
        'ARCHIVE_FILE_MISSING',
        'ARCHIVE_HASH_MISMATCH',
        'ARCHIVE_FILE_UNDECLARED',
      ]),
    );
  });

  it('accepts a completely pinned archive', () => {
    const root = fixtureRoot();
    const archive = join(root, 'law/adr/archive');
    const content = 'frozen\n';
    write(join(archive, 'frozen.md'), content);
    write(
      join(archive, 'MANIFEST.json'),
      JSON.stringify({
        files: [
          {
            path: 'frozen.md',
            sha256: createHash('sha256').update(content).digest('hex'),
          },
        ],
      }),
    );

    expect(archiveImmutability({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });
});

describe('round and generated governance views', () => {
  it('reports missing and malformed round records while ignoring ordinary files', () => {
    const root = fixtureRoot();
    mkdirSync(join(root, 'work/rounds/R-0001'), { recursive: true });
    mkdirSync(join(root, 'work/rounds/R-0002'), { recursive: true });
    write(join(root, 'work/rounds/R-0002/record.md'), '# invalid\n');
    write(join(root, 'work/rounds/README.md'), '# ignored file\n');

    const codes = roundRecordIntegrity({ repoRoot: root }).findings.map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining(['ROUND_RECORD_MISSING', 'ROUND_RECORD_SCHEMA_INVALID']),
    );
  });

  it('renders decision bodies, a metadata index, and available round bodies', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-010.md', recordSource({ id: 'ADR-010', title: 'Tenth' }));
    writeRecord(root, 'ADR-002.md', recordSource({ id: 'ADR-002', title: 'Second' }));
    const roundBody = '# R-0002\n\nFixture round.\n';
    write(
      join(root, 'work/rounds/R-0002/record.md'),
      `${recordSource({ id: 'R-0002', title: 'Round two', body: roundBody })}`,
    );

    const decisions = renderDecisionRecords({ repoRoot: root });
    const index = renderDecisionIndex({ repoRoot: root });
    const rounds = renderRoundRecords({ repoRoot: root });

    expect(decisions).toContain('<!-- generated from canonical records; do not edit -->');
    expect(decisions.indexOf('# ADR-002')).toBeLessThan(decisions.indexOf('# ADR-010'));
    expect(index).toContain('| [ADR-002](./ADR-002.md) | Second | draft |');
    expect(rounds).toContain('<!-- generated from sealed round records -->');
    expect(rounds).toContain('Fixture round.');
    expect(renderRoundRecords({ repoRoot: fixtureRoot() })).toBe('# Governed Rounds\n');
    expect(governanceLedger.renderDecisionIndex({ repoRoot: root })).toBe(index);
  });
});
