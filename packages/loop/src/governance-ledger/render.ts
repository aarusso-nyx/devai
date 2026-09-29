import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseGovernanceRecord } from './records.js';

export const DEFAULT_RECORDS_DIR = 'law/adr';
export const DEFAULT_ROUNDS_DIR = 'work/rounds';

export function markdownFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md' && name !== 'codex-pre-v1.md')
    .map((name) => join(dir, name))
    .sort((left, right) =>
      basename(left).localeCompare(basename(right), undefined, { numeric: true }),
    );
}

export function renderDecisionRecords(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
}): string {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const bodies = markdownFiles(recordsDir).map((path) => parseGovernanceRecord(path).body);
  return [
    '# Design Decisions',
    '',
    '<!-- generated from canonical records; do not edit -->',
    '',
    ...bodies,
  ].join('\n');
}

const DECISION_INDEX_PREAMBLE =
  'This catalogue lists every decision record in this directory. An adopter adds its own records here as `ADR-<SCOPE>-<NNNN>-<slug>.md` files with the canonical frontmatter, then regenerates this file instead of editing it.';

function markdownTableText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

export function renderDecisionIndex(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
}): string {
  const recordsDir = resolve(options.repoRoot, options.recordsDir ?? DEFAULT_RECORDS_DIR);
  const rows = markdownFiles(recordsDir).map((path) => {
    const record = parseGovernanceRecord(path);
    return [
      String(record.frontmatter['id'] ?? ''),
      String(record.frontmatter['title'] ?? ''),
      String(record.frontmatter['status'] ?? ''),
      String(record.frontmatter['round'] ?? ''),
      String(record.frontmatter['date'] ?? ''),
      encodeURIComponent(basename(path)).replace(/[()]/g, (character) =>
        character === '(' ? '%28' : '%29',
      ),
    ];
  });
  const header = ['ID', 'Title', 'Status', 'Round', 'Date'];
  const body = rows.map(
    ([id = '', title = '', status = '', round = '', date = '', filename = '']) => [
      `[${markdownTableText(id)}](./${filename})`,
      markdownTableText(title),
      markdownTableText(status),
      markdownTableText(round),
      markdownTableText(date),
    ],
  );
  // Column widths follow prettier's markdown table layout so the bytes are format-stable.
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...body.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [
    '# Governance decision records',
    '',
    DECISION_INDEX_PREAMBLE,
    '',
    '<!-- generated from canonical record frontmatter; do not edit -->',
    '',
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...body.map(line),
    '',
  ].join('\n');
}

/**
 * True when the bytes at `indexPath` (default `<recordsDir>/README.md`) differ from the
 * rendered decision index, or the file is absent.
 */
export function isDecisionIndexStale(options: {
  readonly repoRoot: string;
  readonly recordsDir?: string;
  readonly indexPath?: string;
}): boolean {
  const recordsDir = options.recordsDir ?? DEFAULT_RECORDS_DIR;
  const indexPath = resolve(options.repoRoot, options.indexPath ?? join(recordsDir, 'README.md'));
  if (!existsSync(indexPath)) return true;
  const rendered = renderDecisionIndex({
    repoRoot: options.repoRoot,
    recordsDir,
  });
  return readFileSync(indexPath, 'utf8') !== rendered;
}

export function renderRoundRecords(options: {
  readonly repoRoot: string;
  readonly roundsDir?: string;
}): string {
  const roundsDir = resolve(options.repoRoot, options.roundsDir ?? DEFAULT_ROUNDS_DIR);
  if (!existsSync(roundsDir)) return '# Governed Rounds\n';
  const bodies = readdirSync(roundsDir)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => join(roundsDir, name, 'record.md'))
    .filter(existsSync)
    .map((path) => parseGovernanceRecord(path).body);
  return [
    '# Governed Rounds',
    '',
    '<!-- generated from sealed round records -->',
    '',
    ...bodies,
  ].join('\n');
}
