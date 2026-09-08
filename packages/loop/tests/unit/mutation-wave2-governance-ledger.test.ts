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
  parseGovernanceRecord,
  renderDecisionRecords,
  roundRecordIntegrity,
} from '../../src/governance-ledger/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-governance-ledger-wave2-'));
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
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message,
    ],
    { cwd: root },
  );
}

describe('governance-ledger mutation wave 2', () => {
  it('keeps single-quoted values literal and double-quoted values JSON-unescaped', () => {
    const path = writeRecord(
      fixtureRoot(),
      'scalar-quotes.md',
      [
        '---',
        "literal: 'raw \\n stays'",
        'escaped: "line \\"break\\""',
        '---',
        '',
        'Body',
        '',
      ].join('\n'),
    );
    const parsed = parseGovernanceRecord(path);
    expect(parsed.frontmatter['literal']).toBe('raw \\n stays');
    expect(parsed.frontmatter['escaped']).toBe('line "break"');
  });

  it('resolves a valueless nested key followed by a same-indent sibling to an empty object', () => {
    const path = writeRecord(
      fixtureRoot(),
      'empty-nested.md',
      ['---', 'id: ADR-001', 'extra:', 'sibling: value', '---', '', 'Body', ''].join('\n'),
    );
    const parsed = parseGovernanceRecord(path);
    expect(parsed.frontmatter['extra']).toEqual({});
    expect(parsed.frontmatter['sibling']).toBe('value');
  });

  it('closes a nested list-item mapping to an empty object when the next line dedents', () => {
    const path = writeRecord(
      fixtureRoot(),
      'nested-list-empty.md',
      [
        '---',
        'id: ADR-001',
        'items:',
        '  - name: alpha',
        '    meta:',
        '  - name: beta',
        '---',
        '',
        'Body',
        '',
      ].join('\n'),
    );
    const parsed = parseGovernanceRecord(path);
    expect(parsed.frontmatter['items']).toEqual([{ name: 'alpha', meta: {} }, { name: 'beta' }]);
  });

  it('orders rendered records by numeric filename comparison rather than lexicographic order', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-2.md', recordSource({ id: 'ADR-2', title: 'Two' }));
    writeRecord(root, 'ADR-10.md', recordSource({ id: 'ADR-10', title: 'Ten' }));
    const decisions = renderDecisionRecords({ repoRoot: root });
    expect(decisions.indexOf('# ADR-2')).toBeLessThan(decisions.indexOf('# ADR-10'));
  });

  it('treats an empty superseded_by value as no replacement for sealed transitions', () => {
    const root = fixtureRoot();
    const path = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'active', supersededBy: "''" }),
    );
    initGit(root);
    commitAll(root, 'seal');
    writeFileSync(path, recordSource({ status: 'superseded', supersededBy: "''" }));
    commitAll(root, 'invalid-terminal-without-replacement');
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
    );
  });

  it('locks arbitrary sealed frontmatter fields such as supersedes, not just status', () => {
    const root = fixtureRoot();
    const path = writeRecord(
      root,
      'ADR-001.md',
      recordSource({ status: 'active', supersedes: '[]' }),
    );
    initGit(root);
    commitAll(root, 'seal');
    writeFileSync(path, recordSource({ status: 'active', supersedes: '[ADR-099]' }));
    commitAll(root, 'mutate-supersedes');
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({ code: 'DECISION_LOCKED_BODY_MUTATED' }),
    );
  });

  it('accepts a closed round record sealed on its very first commit', () => {
    const root = fixtureRoot();
    write(join(root, 'record/derived/indexes/rounds.md'), 'phase-closure-marker\n');
    const recordPath = join(root, 'work/rounds/R-0001/record.md');
    write(
      recordPath,
      recordSource({ id: 'R-0001', status: 'closed', title: 'Round one' }).replace(
        'superseded_by: null',
        'superseded_by: null\nphase_closure: phase-closure-marker',
      ),
    );
    initGit(root);
    commitAll(root, 'close round');
    const codes = roundRecordIntegrity({ repoRoot: root }).findings.map((finding) => finding.code);
    expect(codes).not.toContain('ROUND_HISTORY_UNAVAILABLE');
    expect(codes).not.toContain('ROUND_ARCHIVE_MUTATED');
  });

  it('rejects an uppercase manifest hash even when it matches the file contents', () => {
    const root = fixtureRoot();
    const archive = join(root, 'law/adr/archive');
    const content = 'frozen\n';
    write(join(archive, 'frozen.md'), content);
    const hash = createHash('sha256').update(content).digest('hex').toUpperCase();
    write(
      join(archive, 'MANIFEST.json'),
      JSON.stringify({ files: [{ path: 'frozen.md', sha256: hash }] }),
    );
    expect(archiveImmutability({ repoRoot: root })).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'ARCHIVE_MANIFEST_INVALID' }),
      ]),
    });
  });

  it('ignores citation-like text inside default test and fixture directories', () => {
    const root = fixtureRoot();
    writeRecord(root, 'ADR-001-runtime-authority.md');
    write(join(root, 'packages/example/tests/unit/scratch.md'), 'Cites missing ADR-404 here.\n');
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({ ok: true, findings: [] });
  });

  it('only requires resolution for three-digit ADR mentions outside explicit roots', () => {
    const root = fixtureRoot();
    write(join(root, 'product/notes.md'), 'See ADR-4 for background; ADR-004 must resolve.\n');
    const report = decisionCitationResolution({ repoRoot: root });
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'DECISION_CITATION_UNRESOLVED',
        message: expect.stringContaining('ADR-004'),
      }),
    ]);
  });
});
