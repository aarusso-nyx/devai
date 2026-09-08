import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionCitationResolution } from '../../src/governance-ledger/index.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-citation-boundaries-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function write(path: string, body: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}
function record(id: string) {
  return `---\nid: ${id}\ntitle: Fixture decision\ntype: adr\nstatus: draft\ndate: 2026-09-08\nauthority: Architect\n---\n# Decision\n`;
}

describe('decision citation resolution population', () => {
  it('accepts an empty repository and explicit empty roots', () => {
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({ ok: true, findings: [] });
    write('README.md', 'ADR-404');
    expect(decisionCitationResolution({ repoRoot: root, roots: [] })).toEqual({
      ok: true,
      findings: [],
    });
  });
  it('resolves canonical record IDs and anchored decision-register headings', () => {
    write('law/adr/ADR-001.md', record('ADR-001'));
    write(
      'law/register/DECISIONS.md',
      '### DII-42 — Approved\n#### DII-43 — Not a register entry\nInline ### DII-44\n',
    );
    write('README.md', 'ADR-001 DII-42 DII-43 DII-44');
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'README.md cites missing DII-43.',
          path: 'README.md',
        },
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'README.md cites missing DII-44.',
          path: 'README.md',
        },
      ],
    });
  });
  it('uses a custom record directory and never derives identity from a filename', () => {
    write('selected/ADR-404.md', record('ADR-001'));
    write('docs/reference.md', 'ADR-001 ADR-404');
    expect(
      decisionCitationResolution({ repoRoot: root, recordsDir: 'selected', roots: ['docs'] }),
    ).toEqual({
      ok: false,
      findings: [
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing ADR-404.',
          path: 'docs/reference.md',
        },
      ],
    });
  });
  it('does not let malformed records or non-string IDs resolve a citation', () => {
    write('law/adr/ADR-001.md', '# ADR-001\n');
    write('law/adr/ADR-002.md', record('42'));
    write('README.md', 'ADR-001 ADR-002');
    expect(decisionCitationResolution({ repoRoot: root }).findings.map((f) => f.message)).toEqual([
      'README.md cites missing ADR-001.',
      'README.md cites missing ADR-002.',
    ]);
  });
  it.each([
    'README.md',
    'law/policy/example.json',
    'product/requirement.md',
    'docs/reference.md',
    'packages/loop/src/fixture.ts',
    'work/notes.md',
  ])('checks default active input %s', (path) => {
    write(path, 'ADR-404 ADR-404 DII-999');
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({
      ok: false,
      findings: [
        { code: 'DECISION_CITATION_UNRESOLVED', message: `${path} cites missing ADR-404.`, path },
        { code: 'DECISION_CITATION_UNRESOLVED', message: `${path} cites missing DII-999.`, path },
      ],
    });
  });
  it.each([
    'law/adr/ADR-002.md',
    'law/register/notes.md',
    'law/adr/archive/old.md',
    'docs/site/versioned_docs/old.md',
    'docs/adopters/consumer.md',
    'work/rounds/R-0001/record.md',
    'packages/loop/tests/case.ts',
    'packages/loop/test/case.ts',
    'packages/loop/fixtures/data.json',
    'packages/loop/CHANGELOG.md',
    'packages/schemas/src/generated/example.ts',
  ])(
    'excludes historical or fixture input %s by default, but checks it when explicitly selected',
    (path) => {
      write('law/adr/ADR-002.md', record('ADR-002'));
      write(path, record('ADR-002') + '\nADR-404\n');
      expect(decisionCitationResolution({ repoRoot: root })).toEqual({ ok: true, findings: [] });
      expect(decisionCitationResolution({ repoRoot: root, roots: [path] })).toEqual({
        ok: false,
        findings: [
          { code: 'DECISION_CITATION_UNRESOLVED', message: `${path} cites missing ADR-404.`, path },
        ],
      });
    },
  );
  it.each([
    'packages/x/node_modules/pkg/index.ts',
    'packages/x/dist/index.js',
    'docs/image.svg',
    'docs/notes.txt',
  ])('always ignores unsupported or generated input %s', (path) => {
    write(path, 'ADR-404');
    expect(decisionCitationResolution({ repoRoot: root, roots: [path] })).toEqual({
      ok: true,
      findings: [],
    });
  });
  it.each(['md', 'ts', 'mts', 'js', 'mjs', 'json', 'yaml', 'yml'])(
    'checks supported .%s files recursively',
    (extension) => {
      const path = `docs/nested/reference.${extension}`;
      write(path, 'ADR-404');
      expect(decisionCitationResolution({ repoRoot: root, roots: ['docs'] }).findings).toEqual([
        { code: 'DECISION_CITATION_UNRESOLVED', message: `${path} cites missing ADR-404.`, path },
      ]);
    },
  );
  it.each(['docs/distribution.md', 'docs/node_modules-notes.md', 'law/adr-reference.md'])(
    'checks an active path %s whose name only resembles an excluded directory',
    (path) => {
      write(path, 'ADR-404');
      expect(decisionCitationResolution({ repoRoot: root })).toEqual({
        ok: false,
        findings: [
          { code: 'DECISION_CITATION_UNRESOLVED', message: `${path} cites missing ADR-404.`, path },
        ],
      });
    },
  );
  it('defers noncanonical ADR families in default roots but checks explicit strict roots', () => {
    write('docs/reference.md', 'ADR-MUT-0004');
    expect(decisionCitationResolution({ repoRoot: root })).toEqual({ ok: true, findings: [] });
    expect(decisionCitationResolution({ repoRoot: root, roots: ['docs'] })).toEqual({
      ok: false,
      findings: [
        {
          code: 'DECISION_CITATION_UNRESOLVED',
          message: 'docs/reference.md cites missing ADR-MUT-0004.',
          path: 'docs/reference.md',
        },
      ],
    });
  });
});
