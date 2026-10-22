import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConstitutionVersion } from '@devai-nyx/skills';

// ADR-GOV-0026: the constitution advances to 1.1.0 by amending the Article 6 test row and
// extension paragraph, the Article 7 Inspector and Engineer bullets, and Article 10, and the
// framework's own pin equals the source. Successor of the ADR-GOV-0024 1.0.2 test.
const ROOT = resolve(import.meta.dirname, '../../../..');
const SOURCE = 'law/constitution.md';
const PIN = '.devai/pin/constitution.md';
const RECORD = 'law/adr/ADR-GOV-0026-engineer-authors-focused-regression-tests.md';

// SHA-256 of law/constitution.md at 1.0.2 (commit a1521a78), the last version before
// the amendment.
const CONSTITUTION_1_0_2_SHA256 =
  'd7f8791f1d00a7247bced66bdcdf8b1af431bb57e49d03b6ddd7024cb52f957d';

// The Article 6 test row at 1.0.2; every other core row stays byte-identical.
const TEST_ROW_1_0_2 = '- `tests/` and `packages/*/tests/` — Inspector (F3).';

// Every Article 6 core row of 1.1.0, byte for byte, in order.
const CORE_ROWS = [
  '- `law/` — Architect (F1-law: constitution, register, ADRs, schemas, invariants, trace, policy sources; `law/glossary/` joint with Owner).',
  '- `product/` — Owner (F1-business: journeys, use-cases, stories, rules, mandates).',
  '- `.devai/local/rounds/` — role-bounded runtime round state; each role writes only its declared task or audit output through an authorized action.',
  '- `docs/` — Architect (published human documentation).',
  '- `record/` — machine only: `record/derived/` (F4) is written only by the regeneration subsystem; `record/proofs/` is appended only by executing verbs, hash-linked, attributed to the verb and committed by the session that produced it. A human edit under `record/` is an authority violation regardless of role.',
  '- `.devai/pin/` and `.devai/config/` — modified only through registered `init apply` or `init bind` actions, materialized from canonical package or policy sources; a checker never writes its own inputs.',
  '- `.devai/state/` — mutable head state written by executing verbs; never hand-edited.',
  '- `packages/` and root workspace configuration — Engineer (F2).',
  '- `tests/` and `packages/*/tests/` — Inspector (F3); the Engineer holds on these paths only the focused-regression verb of Article 7.',
  '- `scratch/` — ephemeral; never committed beyond its README; content graduates only by an explicit role-authored commit to a governed tree.',
  '- Root prose files (`README.md`, `CLAUDE.md`, `AGENTS.md`) — Architect.',
  '- Host-tool configuration directories (`.changeset/`, `.claude/`, and peers) — path fixed by the toolchain; contents classified by this table per content class (agent permission policy is F5-host under Architect authority; runtime directories are scratch-class).',
] as const;

// The 1.0.2 text of the three passages the record replaces whole.
const INSPECTOR_1_0_2 =
  '- **Inspector.** Sensor authority. Authors and modifies tests under F3 paths.';
const ENGINEER_1_0_2 = '- **Engineer.** Plant authority. Authors and modifies code under F2 paths.';
const ARTICLE_10_1_0_2 =
  'Within a single human-directed work iteration, no discipline may both set its own reference and actuate against it. Architect may not edit code; Engineer may not edit tests; Inspector may not edit specifications. Cross-substrate work in a single role session is therefore impossible by design; coordinated work traverses the authority chain via coupled task triplets (Article 24).';

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The unwrapped blockquotes of the record's Decision section, in order. */
function decisionQuotes(): string[] {
  const record = read(RECORD);
  const decision = record.slice(record.indexOf('## Decision'), record.indexOf('## Consequences'));
  const quotes: string[] = [];
  let current: string[] = [];
  for (const line of decision.split('\n')) {
    if (line.startsWith('> ')) {
      current.push(line.slice(2));
    } else if (current.length > 0) {
      quotes.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) quotes.push(current.join(' '));
  return quotes;
}

type Quotes = [string, string, string, string, string, string, string];

function quotes(): Quotes {
  const all = decisionQuotes();
  expect(all).toHaveLength(7);
  return all as Quotes;
}

function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('constitution 1.1.0 Articles 6, 7 and 10 amendment (ADR-GOV-0026)', () => {
  it('parses the source and the pin as 1.1.0 and keeps them byte-identical', () => {
    const source = read(SOURCE);
    const pin = read(PIN);
    expect(parseConstitutionVersion(source)).toBe('1.1.0');
    expect(parseConstitutionVersion(pin)).toBe('1.1.0');
    expect(pin).toBe(source);
  });

  it('carries 1.1.0 in the frontmatter title, the heading, and the Status block', () => {
    const source = read(SOURCE);
    expect(source).toContain('\ntitle: DEVAI Constitution 1.1.0\n');
    expect(source).toContain('\n# DEVAI Constitution — 1.1.0\n');
    expect(source).toContain('\n**Version:** 1.1.0\n');
    expect(source).not.toMatch(/1\.0\.2/u);
  });

  it('carries every Article 6 core row verbatim and in order, changing only the test row', () => {
    const article = section(read(SOURCE), '### Article 6.', '### Article 7.');
    const rows = article.split('\n').filter((line) => line.startsWith('- '));
    expect(rows).toEqual([...CORE_ROWS]);
    expect(rows).not.toContain(TEST_ROW_1_0_2);
  });

  it('carries the amended passages of ADR-GOV-0026 verbatim in place of the 1.0.2 text', () => {
    const [oldRow, newRow, oldClass, newClass, inspector, engineer, article10] = quotes();
    expect(oldRow).toBe(TEST_ROW_1_0_2);
    const source = read(SOURCE);
    const article6 = section(source, '### Article 6.', '### Article 7.');
    expect(article6.split('\n')).toContain(newRow);
    expect(article6.split('\n')).not.toContain(oldRow);
    expect(article6).toContain(newClass);
    expect(article6).not.toContain(`${oldClass} every remaining path`);
    const article7 = section(source, '### Article 7.', '### Article 8.').split('\n');
    expect(article7).toContain(inspector);
    expect(article7).toContain(engineer);
    expect(article7).not.toContain(INSPECTOR_1_0_2);
    expect(article7).not.toContain(ENGINEER_1_0_2);
    const separation = section(source, '### Article 10.', '### Article 11.').split('\n');
    expect(separation).toContain(article10);
    expect(separation).not.toContain(ARTICLE_10_1_0_2);
    expect(engineer).toContain(
      'The Engineer may not delete a test, change an assertion of a test the task did not add, or lower a coverage or mutation threshold.',
    );
    expect(engineer).toContain(
      'A round or task designated independent-assurance withholds this verb.',
    );
    expect(article10).toContain(
      'In a round or task designated independent-assurance the Engineer may not edit tests at all.',
    );
  });

  it('differs from 1.0.2 only in the version markers, the date, and the amended passages', () => {
    const [oldRow, newRow, oldClass, newClass, inspector, engineer, article10] = quotes();
    const reverted = read(SOURCE)
      .replace('\ntitle: DEVAI Constitution 1.1.0\n', '\ntitle: DEVAI Constitution 1.0.2\n')
      .replace('\ndate: 2026-10-21\n', '\ndate: 2026-09-30\n')
      .replace('\n# DEVAI Constitution — 1.1.0\n', '\n# DEVAI Constitution — 1.0.2\n')
      .replace('\n**Version:** 1.1.0\n', '\n**Version:** 1.0.2\n')
      .replace(`\n${newRow}\n`, `\n${oldRow}\n`)
      .replace(newClass, oldClass)
      .replace(`\n${inspector}\n`, `\n${INSPECTOR_1_0_2}\n`)
      .replace(`\n${engineer}\n`, `\n${ENGINEER_1_0_2}\n`)
      .replace(`\n${article10}\n`, `\n${ARTICLE_10_1_0_2}\n`);
    expect(sha256(reverted)).toBe(CONSTITUTION_1_0_2_SHA256);
  });

  it('binds the framework authority policy to the 1.1.0 pin digest', () => {
    const policy = JSON.parse(read('.devai/config/authority-policy.json')) as {
      constitution: { version: string; digest_sha256: string };
    };
    expect(policy.constitution).toEqual({
      version: '1.1.0',
      digest_sha256: sha256(read(PIN)),
    });
  });
});
