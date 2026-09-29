// ADR-GOV-0021: law/adr/README.md is the generated decision catalogue. renderDecisionIndex must
// emit prettier-stable, column-aligned tables plus the adopter preamble, the committed bytes must
// equal that output, and a record added or changed without regenerating the catalogue must be
// detected as stale.
//
// Freshness surface chosen (TASK-0372): an exported comparison in the loop package,
//   isDecisionIndexStale(options: { repoRoot: string; recordsDir?: string; indexPath?: string }): boolean
// exported from src/governance-ledger/render.ts and re-exported from src/governance-ledger/index.ts.
// It renders the index for recordsDir (default 'law/adr') and returns true when the bytes of
// indexPath (default '<recordsDir>/README.md', relative to repoRoot) differ from that output, or
// when the file is absent. The `docs` command may wrap it later; this test pins only the export.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { afterEach, describe, expect, it } from 'vitest';
import * as ledger from '../src/governance-ledger/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMMITTED_INDEX = join(REPO_ROOT, 'law/adr/README.md');

interface FreshnessOptions {
  readonly repoRoot: string;
  readonly recordsDir?: string;
  readonly indexPath?: string;
}
const isDecisionIndexStale = (
  ledger as unknown as {
    isDecisionIndexStale: (options: FreshnessOptions) => boolean;
  }
).isDecisionIndexStale;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch repository whose law/adr is a byte copy of this repository's. */
function copiedRecords(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-adr-catalogue-'));
  roots.push(root);
  mkdirSync(join(root, 'law'), { recursive: true });
  cpSync(join(REPO_ROOT, 'law/adr'), join(root, 'law/adr'), { recursive: true });
  return root;
}

function addRecord(root: string, id: string, title: string): void {
  writeFileSync(
    join(root, `law/adr/${id}-catalogue-probe.md`),
    [
      '---',
      `id: ${id}`,
      `title: ${title}`,
      'type: adr',
      'status: draft',
      'date: 2026-09-29',
      'authority: Architect',
      'supersedes: []',
      'superseded_by: null',
      'provenance: [fixture]',
      'affected_rules:',
      '  - id: RULE-1',
      '    enabled: true',
      '---',
      '',
      `# ${id}`,
      '',
    ].join('\n'),
  );
}

describe('renderDecisionIndex output (ADR-GOV-0021)', () => {
  const rendered = ledger.renderDecisionIndex({ repoRoot: REPO_ROOT });

  it('is byte-identical to the committed law/adr/README.md', () => {
    expect(rendered).toBe(readFileSync(COMMITTED_INDEX, 'utf8'));
  });

  it('is stable under the repository prettier configuration', async () => {
    const config = (await prettier.resolveConfig(COMMITTED_INDEX)) ?? {};
    const formatted = await prettier.format(rendered, { ...config, parser: 'markdown' });
    expect(rendered).toBe(formatted);
  });

  it('aligns every row of the table to one width', () => {
    const rows = rendered.split('\n').filter((line) => line.startsWith('|'));
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    expect(rows[1]).toMatch(/^\| -+ \| -+ \|/u);
  });

  it('carries the adopter preamble, the generated marker, and one row per record', () => {
    const beforeTable = rendered.slice(0, rendered.indexOf('\n| ID'));
    expect(beforeTable).toMatch(/adopter/iu);
    expect(rendered).toContain('<!-- generated from canonical record frontmatter; do not edit -->');
    expect(rendered).toContain('| ID');
    expect(rendered).toContain('[ADR-GOV-0021](./ADR-GOV-0021-workflow-reference-pages.md)');
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('decision catalogue freshness (ADR-GOV-0021)', () => {
  it('exports isDecisionIndexStale from the loop package', () => {
    expect(typeof isDecisionIndexStale).toBe('function');
  });

  it('reports the committed catalogue as fresh', () => {
    expect(isDecisionIndexStale({ repoRoot: REPO_ROOT })).toBe(false);
  });

  it('reports a regenerated catalogue as fresh and a record added without regeneration as stale', () => {
    const root = copiedRecords();
    const index = join(root, 'law/adr/README.md');
    writeFileSync(index, ledger.renderDecisionIndex({ repoRoot: root }));
    expect(isDecisionIndexStale({ repoRoot: root })).toBe(false);

    addRecord(root, 'ADR-ZZZ-9999', 'A record added after the catalogue was generated');
    expect(isDecisionIndexStale({ repoRoot: root })).toBe(true);

    writeFileSync(index, ledger.renderDecisionIndex({ repoRoot: root }));
    expect(isDecisionIndexStale({ repoRoot: root })).toBe(false);
    expect(readFileSync(index, 'utf8')).toContain('ADR-ZZZ-9999');
  });

  it('reports a hand edit of the catalogue and a missing catalogue as stale', () => {
    const root = copiedRecords();
    const index = join(root, 'law/adr/README.md');
    const fresh = ledger.renderDecisionIndex({ repoRoot: root });
    writeFileSync(index, fresh);
    writeFileSync(index, `${fresh}\nHand-written note.\n`);
    expect(isDecisionIndexStale({ repoRoot: root })).toBe(true);
    rmSync(index);
    expect(isDecisionIndexStale({ repoRoot: root })).toBe(true);
  });
});
