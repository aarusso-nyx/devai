import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConstitutionVersion } from '@devai-nyx/skills';

// ADR-GOV-0024 IA-001 and IA-004: the constitution advances to 1.0.2 by amending two
// passages of Article 6 only, and the framework's own pin equals the source.
const ROOT = resolve(import.meta.dirname, '../../../..');
const SOURCE = 'law/constitution.md';
const PIN = '.devai/pin/constitution.md';
const RECORD = 'law/adr/ADR-GOV-0024-article-6-client-extensions-by-root-and-class.md';

// SHA-256 of law/constitution.md at 1.0.1 (commit 42244e93), the last version before
// the amendment.
const CONSTITUTION_1_0_1_SHA256 =
  'ff8c4f099a284b1b42f980742b20c849379ba4e3f357905f36a87648ae3fdeae';

// Every Article 6 core row of 1.0.1, byte for byte.
const CORE_ROWS = [
  '- `law/` — Architect (F1-law: constitution, register, ADRs, schemas, invariants, trace, policy sources; `law/glossary/` joint with Owner).',
  '- `product/` — Owner (F1-business: journeys, use-cases, stories, rules, mandates).',
  '- `.devai/local/rounds/` — role-bounded runtime round state; each role writes only its declared task or audit output through an authorized action.',
  '- `docs/` — Architect (published human documentation).',
  '- `record/` — machine only: `record/derived/` (F4) is written only by the regeneration subsystem; `record/proofs/` is appended only by executing verbs, hash-linked, attributed to the verb and committed by the session that produced it. A human edit under `record/` is an authority violation regardless of role.',
  '- `.devai/pin/` and `.devai/config/` — modified only through registered `init apply` or `init bind` actions, materialized from canonical package or policy sources; a checker never writes its own inputs.',
  '- `.devai/state/` — mutable head state written by executing verbs; never hand-edited.',
  '- `packages/` and root workspace configuration — Engineer (F2).',
  '- `tests/` and `packages/*/tests/` — Inspector (F3).',
  '- `scratch/` — ephemeral; never committed beyond its README; content graduates only by an explicit role-authored commit to a governed tree.',
  '- Root prose files (`README.md`, `CLAUDE.md`, `AGENTS.md`) — Architect.',
  '- Host-tool configuration directories (`.changeset/`, `.claude/`, and peers) — path fixed by the toolchain; contents classified by this table per content class (agent permission policy is F5-host under Architect authority; runtime directories are scratch-class).',
] as const;

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

function article6(text: string): string {
  const start = text.indexOf('### Article 6.');
  const end = text.indexOf('### Article 7.');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('constitution 1.0.2 Article 6 amendment (ADR-GOV-0024)', () => {
  it('parses the source and the pin as 1.0.2 and keeps them byte-identical', () => {
    const source = read(SOURCE);
    const pin = read(PIN);
    expect(parseConstitutionVersion(source)).toBe('1.0.2');
    expect(parseConstitutionVersion(pin)).toBe('1.0.2');
    expect(pin).toBe(source);
  });

  it('carries 1.0.2 in the frontmatter title, the heading, and the Status block', () => {
    const source = read(SOURCE);
    expect(source).toContain('\ntitle: DEVAI Constitution 1.0.2\n');
    expect(source).toContain('\n# DEVAI Constitution — 1.0.2\n');
    expect(source).toContain('\n**Version:** 1.0.2\n');
    expect(source).not.toMatch(/1\.0\.1/u);
  });

  it('carries every Article 6 core row verbatim and in order', () => {
    const article = article6(read(SOURCE));
    const rows = article.split('\n').filter((line) => line.startsWith('- '));
    expect(rows).toEqual([...CORE_ROWS]);
  });

  it('carries the two amended passages of ADR-GOV-0024 verbatim in place of the 1.0.1 text', () => {
    const quotes = decisionQuotes();
    expect(quotes).toHaveLength(4);
    const [oldSentence, newSentence, oldParagraph, newParagraph] = quotes as [
      string,
      string,
      string,
      string,
    ];
    const article = article6(read(SOURCE));
    const paragraphs = article.split('\n');
    expect(paragraphs).toContain(newSentence);
    expect(paragraphs).toContain(newParagraph);
    expect(paragraphs).not.toContain(oldSentence);
    expect(paragraphs).not.toContain(oldParagraph);
    expect(newSentence.startsWith('Core authority is decided by a fixed path prefix')).toBe(true);
    expect(newParagraph).toContain(
      'two extension rules that would grant different roles at the same precedence are ambiguous: the write is refused.',
    );
  });

  it('differs from 1.0.1 only in the version markers, the date, and the two Article 6 passages', () => {
    const [oldSentence, newSentence, oldParagraph, newParagraph] = decisionQuotes() as [
      string,
      string,
      string,
      string,
    ];
    const reverted = read(SOURCE)
      .replace('\ntitle: DEVAI Constitution 1.0.2\n', '\ntitle: DEVAI Constitution 1.0.1\n')
      .replace('\ndate: 2026-09-30\n', '\ndate: 2026-07-25\n')
      .replace('\n# DEVAI Constitution — 1.0.2\n', '\n# DEVAI Constitution — 1.0.1\n')
      .replace('\n**Version:** 1.0.2\n', '\n**Version:** 1.0.1\n')
      .replace(`\n${newSentence}\n`, `\n${oldSentence}\n`)
      .replace(`\n${newParagraph}\n`, `\n${oldParagraph}\n`);
    expect(sha256(reverted)).toBe(CONSTITUTION_1_0_1_SHA256);
  });

  it('binds the framework authority policy to the 1.0.2 pin digest', () => {
    const policy = JSON.parse(read('.devai/config/authority-policy.json')) as {
      constitution: { version: string; digest_sha256: string };
    };
    expect(policy.constitution).toEqual({
      version: '1.0.2',
      digest_sha256: sha256(read(PIN)),
    });
  });
});
