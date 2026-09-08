import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderDecisionIndex,
  renderDecisionRecords,
  renderRoundRecords,
} from '../../src/governance-ledger/index.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-render-'));
  roots.push(path);
  return path;
}
function record(id: string, title: string, body: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    'type: adr',
    'status: draft',
    'round: R-0007',
    'date: 2026-09-08',
    'authority: Architect',
    'supersedes: []',
    'superseded_by: null',
    '---',
    '',
    body,
    '',
  ].join('\n');
}
function write(base: string, rel: string, source: string): string {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}
const HEADER =
  '# Governance decision records\n\n<!-- generated from canonical record frontmatter; do not edit -->\n\n| ID | Title | Status | Round | Date |\n|---|---|---|---|---|\n';
describe('derived governance views preserve canonical identities and content', () => {
  it('links to an accepted suffixed filename rather than inventing an ID-only path', () => {
    const base = root();
    const file = write(
      base,
      'law/adr/ADR-001-reviewed.md',
      record('ADR-001', 'Reviewed decision', '# Canonical body'),
    );
    const before = readFileSync(file);
    expect(renderDecisionIndex({ repoRoot: base })).toBe(
      HEADER +
        '| [ADR-001](./ADR-001-reviewed.md) | Reviewed decision | draft | R-0007 | 2026-09-08 |\n',
    );
    expect(readFileSync(file)).toEqual(before);
  });
  it('encodes spaces, Unicode and parentheses in the actual filename', () => {
    const base = root();
    write(base, 'law/adr/ADR-002-ação (review).md', record('ADR-002', 'Ação', '# Body'));
    expect(renderDecisionIndex({ repoRoot: base })).toContain(
      '[ADR-002](./ADR-002-a%C3%A7%C3%A3o%20%28review%29.md)',
    );
  });
  it('keeps pipe and multiline title content inside one metadata cell', () => {
    const base = root();
    write(base, 'law/adr/ADR-003.md', record('ADR-003', 'Read | write\nSecond line', '# Body'));
    expect(renderDecisionIndex({ repoRoot: base })).toBe(
      HEADER +
        '| [ADR-003](./ADR-003.md) | Read \\| write<br>Second line | draft | R-0007 | 2026-09-08 |\n',
    );
  });
  it('renders exact bodies in filename order without frontmatter or recursive archives', () => {
    const base = root();
    write(base, 'law/adr/ADR-010.md', record('ADR-010', 'Tenth', '# Tenth\n\nKeep **markdown**.'));
    write(base, 'law/adr/ADR-002.md', record('ADR-002', 'Second', '# Second\n\nKeep | body text.'));
    write(base, 'law/adr/archive/ADR-001.md', record('ADR-001', 'Archived', '# Excluded archive'));
    write(base, 'law/adr/notes.txt', 'not a record');
    expect(renderDecisionRecords({ repoRoot: base })).toBe(
      '# Design Decisions\n\n<!-- generated from canonical records; do not edit -->\n\n# Second\n\nKeep | body text.\n\n# Tenth\n\nKeep **markdown**.\n',
    );
    const index = renderDecisionIndex({ repoRoot: base });
    expect(index).toBe(
      HEADER +
        '| [ADR-002](./ADR-002.md) | Second | draft | R-0007 | 2026-09-08 |\n| [ADR-010](./ADR-010.md) | Tenth | draft | R-0007 | 2026-09-08 |\n',
    );
  });
  it('honors custom decision roots and leaves absent roots empty', () => {
    const base = root();
    write(base, 'custom/ADR-001.md', record('ADR-001', 'Custom', '# Custom'));
    expect(renderDecisionIndex({ repoRoot: base })).toBe(HEADER);
    expect(renderDecisionIndex({ repoRoot: base, recordsDir: 'custom' })).toContain('| Custom |');
    expect(renderDecisionRecords({ repoRoot: base, recordsDir: 'custom' })).toContain('# Custom');
  });
  it('uses blank cells for absent optional metadata while retaining the source filename', () => {
    const base = root();
    write(base, 'law/adr/empty.md', '---\nother: data\n---\n# Body\n');
    expect(renderDecisionIndex({ repoRoot: base })).toBe(
      HEADER + '| [](./empty.md) |  |  |  |  |\n',
    );
  });
  it('refuses malformed frontmatter rather than silently omitting the record', () => {
    const base = root();
    write(base, 'law/adr/ADR-001.md', '# Missing frontmatter');
    expect(() => renderDecisionIndex({ repoRoot: base })).toThrow();
    expect(() => renderDecisionRecords({ repoRoot: base })).toThrow();
  });
  it('orders round directories numerically and ignores those without records', () => {
    const base = root();
    for (const id of ['R-10', 'R-2'])
      write(base, `work/rounds/${id}/record.md`, record(id, id, `# ${id}\n\nExact round body.`));
    mkdirSync(join(base, 'work/rounds/R-1'), { recursive: true });
    expect(renderRoundRecords({ repoRoot: base })).toBe(
      '# Governed Rounds\n\n<!-- generated from sealed round records -->\n\n# R-2\n\nExact round body.\n\n# R-10\n\nExact round body.\n',
    );
    expect(renderRoundRecords({ repoRoot: base, roundsDir: 'absent' })).toBe('# Governed Rounds\n');
  });
  it('honors a custom round population without reading the default directory', () => {
    const base = root();
    write(base, 'custom/R-1/record.md', record('R-1', 'Custom round', '# Custom round'));
    expect(renderRoundRecords({ repoRoot: base, roundsDir: 'custom' })).toBe(
      '# Governed Rounds\n\n<!-- generated from sealed round records -->\n\n# Custom round\n',
    );
  });
});
