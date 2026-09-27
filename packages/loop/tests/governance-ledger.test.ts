// ADR-SCR-0006 IA-001 to IA-004: the governance ledger sensors judge decision records by the
// second-generation contract in law/schemas/adr-v2.schema.json and report zero findings on
// the repository's own law/adr tree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decisionCitationResolution,
  decisionRecordIntegrity,
} from '../src/governance-ledger/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Unresolved citations that sit outside TASK-0241's boundary. Each names one of the retired
// identities and is reported for a follow-up change; no other citation may be unresolved.
const RETIRED_IDENTITIES = new Set(['ADR-001', 'ADR-003', 'DII-103', 'DII-104']);
const OUT_OF_BOUNDARY_CITATIONS = new Set([
  'docs/dev/operations/self-scorecard-campaign/README.md',
  'packages/skills/src/inv-override/index.ts',
  'product/campaigns/CMP-0002-self-scorecard/campaign.json',
  'product/campaigns/CMP-0002-self-scorecard/prompts/TASK-0241.md',
]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-governance-ledger-v2-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function write(root: string, path: string, source: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function commitAll(root: string): void {
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
      'fixture',
    ],
    { cwd: root },
  );
}

function v2Record(
  id: string,
  options: { status?: string; supersedes?: readonly string[]; omit?: string } = {},
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'title: Fixture decision',
    'type: adr',
    `status: ${options.status ?? 'accepted'}`,
    'date: 2026-09-27',
    'authority: Architect',
    options.supersedes === undefined || options.supersedes.length === 0
      ? 'supersedes: []'
      : ['supersedes:', ...options.supersedes.map((target) => `  - ${target}`)].join('\n'),
    'provenance:',
    '  - law/constitution.md',
    'affected_rules:',
    `  - law/policy/${id.toLowerCase()}.json`,
    'inspector_acceptance:',
    '  - IA-001 -- A fixture obligation: colons inside an entry stay part of the text.',
    '---',
    '',
    `# ${id}`,
    '',
  ];
  return lines
    .filter((line) => options.omit === undefined || !line.startsWith(options.omit))
    .join('\n');
}

const firstGenerationRecord = [
  '---',
  'id: ADR-001',
  'title: First-generation fixture',
  'type: adr',
  'status: draft',
  'date: 2026-07-24',
  'authority: Architect',
  'supersedes: []',
  'superseded_by: null',
  'provenance: [fixture]',
  'affected_rules: []',
  '---',
  '',
  '# ADR-001',
  '',
].join('\n');

function policy(entries: readonly { path: string; sha256: string; reference: string }[]): string {
  return JSON.stringify({
    record_schema: 'law/schemas/adr-v2.schema.json',
    scan: { root: 'law/adr' },
    semantic_resolver: {
      resolvable_legacy_references: entries.map(({ reference, path }) => ({ reference, path })),
    },
    exception_catalog: {
      entries: entries.map(({ path, sha256, reference }) => ({
        path,
        sha256,
        legacy_record: { reference, supersedes: [] },
      })),
    },
  });
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

describe('decision_record_integrity on second-generation records (ADR-SCR-0006)', () => {
  it('IA-001: a tree of v2-valid records has zero findings; each invalid record has exactly one', () => {
    const root = fixtureRoot();
    write(root, 'law/adr/ADR-GOV-0001-valid.md', v2Record('ADR-GOV-0001'));
    write(root, 'law/adr/ADR-GOV-0002-valid.md', v2Record('ADR-GOV-0002', { status: 'proposed' }));
    commitAll(root);
    expect(decisionRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });

    write(
      root,
      'law/adr/ADR-GOV-0003-lifecycle.md',
      v2Record('ADR-GOV-0003', { status: 'active' }),
    );
    write(
      root,
      'law/adr/ADR-GOV-0004-unaccepted.md',
      v2Record('ADR-GOV-0004', { omit: 'inspector_acceptance' }).replace(
        /^ {2}- IA-001 .*\n/mu,
        '',
      ),
    );
    commitAll(root);
    const report = decisionRecordIntegrity({ repoRoot: root });
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'DECISION_SCHEMA_INVALID',
        path: 'law/adr/ADR-GOV-0003-lifecycle.md',
        message: expect.stringContaining('adr-v2.schema.json'),
      }),
      expect.objectContaining({
        code: 'DECISION_SCHEMA_INVALID',
        path: 'law/adr/ADR-GOV-0004-unaccepted.md',
      }),
    ]);
  });

  it('IA-001: a bound ADR validation policy judges every uncatalogued record by adr-v2', () => {
    const root = fixtureRoot();
    const legacy = firstGenerationRecord.replace(/ADR-001/gu, 'ADR-014');
    write(root, 'law/adr/ADR-014-legacy.md', legacy);
    write(root, 'law/adr/ADR-001-first.md', firstGenerationRecord);
    write(root, 'law/adr/ADR-GOV-0001-valid.md', v2Record('ADR-GOV-0001'));
    write(
      root,
      'law/policy/adr-validation.json',
      policy([{ path: 'ADR-014-legacy.md', sha256: sha256(legacy), reference: 'ADR-014' }]),
    );
    commitAll(root);
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toEqual([
      expect.objectContaining({
        code: 'DECISION_SCHEMA_INVALID',
        path: 'law/adr/ADR-001-first.md',
      }),
    ]);

    write(root, 'law/adr/ADR-014-legacy.md', `${legacy}\nEdited after cataloguing.\n`);
    commitAll(root);
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toContainEqual(
      expect.objectContaining({
        code: 'DECISION_SCHEMA_INVALID',
        path: 'law/adr/ADR-014-legacy.md',
        message: expect.stringContaining('law/policy/adr-validation.json'),
      }),
    );
  });

  it('IA-002: supersession is judged from the supersedes array alone', () => {
    const root = fixtureRoot();
    write(root, 'law/adr/ADR-GOV-0001-original.md', v2Record('ADR-GOV-0001'));
    write(
      root,
      'law/adr/ADR-GOV-0002-successor.md',
      v2Record('ADR-GOV-0002', { supersedes: ['ADR-GOV-0001'] }),
    );
    commitAll(root);
    // The superseded record keeps its accepted bytes and carries no reverse link.
    expect(decisionRecordIntegrity({ repoRoot: root })).toEqual({ ok: true, findings: [] });

    write(
      root,
      'law/adr/ADR-GOV-0003-dangling.md',
      v2Record('ADR-GOV-0003', { supersedes: ['ADR-GOV-0404'] }),
    );
    commitAll(root);
    expect(decisionRecordIntegrity({ repoRoot: root }).findings).toEqual([
      {
        code: 'DECISION_SUPERSESSION_ASYMMETRIC',
        message: 'ADR-GOV-0003 supersedes ADR-GOV-0404, which resolves to no decision record.',
        path: 'law/adr/ADR-GOV-0003-dangling.md',
      },
    ]);
  });
});

describe('decision_citation_resolution on scoped identities (ADR-SCR-0006)', () => {
  it('IA-003: resolves ADR-SCOPE-NNNN citations and reports each identity with no file', () => {
    const root = fixtureRoot();
    write(root, 'law/adr/ADR-GOV-0001-valid.md', v2Record('ADR-GOV-0001'));
    write(
      root,
      'docs/reference.md',
      'See ADR-GOV-0001, law/adr/ADR-GOV-0001-valid.md, ADR-REL-0404 and ADR-GOV-0404.\n',
    );
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing ADR-REL-0404.',
          path: 'docs/reference.md',
        },
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing ADR-GOV-0404.',
          path: 'docs/reference.md',
        },
      ],
    });
  });

  it('IA-003: a catalogued legacy identity resolves through the ADR validation policy', () => {
    const root = fixtureRoot();
    write(root, 'law/adr/ADR-GOV-0001-valid.md', v2Record('ADR-GOV-0001'));
    write(
      root,
      'law/policy/adr-validation.json',
      policy([{ path: 'ADR-014-legacy.md', sha256: '0'.repeat(64), reference: 'ADR-014' }]),
    );
    write(root, 'docs/reference.md', 'ADR-014 and ADR-015\n');
    expect(decisionCitationResolution({ repoRoot: root }).findings).toEqual([
      expect.objectContaining({ message: 'docs/reference.md cites missing ADR-015.' }),
    ]);
  });
});

describe('the governance ledger sensors on the repository (ADR-SCR-0006 IA-004)', () => {
  it('decision_record_integrity reports zero findings over the real law/adr tree', () => {
    expect(decisionRecordIntegrity({ repoRoot: REPO_ROOT })).toEqual({ ok: true, findings: [] });
  });

  it('decision_citation_resolution resolves every citation inside the task boundary', () => {
    const report = decisionCitationResolution({ repoRoot: REPO_ROOT });
    const inBoundary = report.findings.filter(
      (finding) => !OUT_OF_BOUNDARY_CITATIONS.has(finding.path ?? ''),
    );
    expect(inBoundary).toEqual([]);
    for (const finding of report.findings) {
      const cited = /cites missing (\S+)\.$/u.exec(finding.message)?.[1] ?? finding.message;
      expect(RETIRED_IDENTITIES.has(cited), finding.message).toBe(true);
    }
  });

  it('the repointed schema examples and scorecard notes cite no retired identity', () => {
    for (const path of [
      'law/schemas/adr.schema.json',
      'law/schemas/invariant.schema.json',
      'packages/loop/src/loop/scorecard.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const retired of RETIRED_IDENTITIES) {
        expect(source.includes(retired), `${path} cites ${retired}`).toBe(false);
      }
    }
  });
});
