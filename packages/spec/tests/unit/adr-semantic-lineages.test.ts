import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { parseAdrFrontMatter, validateAdrs } from '../../src/adr/index.js';

const roots: string[] = [];
const A = 'ADR-GOV-9901';
const B = 'ADR-GOV-9902';
const C = 'ADR-GOV-9903';
const D = 'ADR-GOV-9904';
const X = 'fixture/subject-x';
const Y = 'fixture/subject-y';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai adr lineage ç '));
  roots.push(root);
  const adrsDir = join(root, 'law/adr');
  cpSync(join(process.cwd(), 'law/adr'), adrsDir, { recursive: true });
  cpSync(join(process.cwd(), 'law/policy'), join(root, 'law/policy'), { recursive: true });
  const template = readFileSync(
    join(process.cwd(), 'law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md'),
    'utf8',
  );
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(template);
  if (!match?.[1] || !match[2]) throw new Error('approved ADR template missing');
  const initial = parseAdrFrontMatter(match[1]);
  const body = match[2];
  return {
    adrsDir,
    add(id: string, subjects: string[], supersedes: string[] = [], status = 'accepted') {
      const record = {
        ...initial,
        id,
        title: `Fixture ${id}`,
        status,
        affected_rules: subjects,
        supersedes,
      };
      expect(validators.adrV2(record)).toBe(true);
      const front = Object.entries(record)
        .map(([key, value]) =>
          Array.isArray(value)
            ? `${key}:${value.length ? '\n' + value.map((entry) => `  - ${String(entry)}`).join('\n') : ' []'}`
            : `${key}: ${String(value)}`,
        )
        .join('\n');
      expect(parseAdrFrontMatter(front)).toEqual(record);
      writeFileSync(join(adrsDir, `${id}-fixture.md`), `---\n${front}\n---\n${body}`);
    },
    validate() {
      return validateAdrs({ adrsDir });
    },
  };
}
function noAuthority(result: ReturnType<typeof validateAdrs>, code: string) {
  expect(result.ok).toBe(false);
  expect(result.semantic_resolution_performed).toBe(true);
  expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  expect(result.effective_authorities).toEqual([]);
  expect(result.subject_authorities).toEqual([]);
  expect(
    result.adrs.every(
      (record) => !record.effective && record.effective_affected_rules.length === 0,
    ),
  ).toBe(true);
}

it('supersedes only shared subjects and retains the predecessor authority on its other subject', () => {
  const f = fixture();
  f.add(A, [X, Y]);
  f.add(B, [X], [A]);
  const result = f.validate();
  expect(result.ok).toBe(true);
  expect(
    result.subject_authorities.filter((entry) => entry.subject.startsWith('fixture/')),
  ).toEqual([
    { subject: X, lineage_members: [A, B], effective_head: B },
    { subject: Y, lineage_members: [A], effective_head: A },
  ]);
  expect(result.adrs.find((record) => record.adr_id === A)?.effective_affected_rules).toEqual([Y]);
  expect(result.adrs.find((record) => record.adr_id === B)?.effective_affected_rules).toEqual([X]);
});

it('does not grant a proposed successor authority over an accepted predecessor', () => {
  const f = fixture();
  f.add(A, [X]);
  f.add(B, [X], [A], 'proposed');
  const result = f.validate();
  expect(result.ok).toBe(true);
  expect(result.subject_authorities.find((entry) => entry.subject === X)).toEqual({
    subject: X,
    lineage_members: [A],
    effective_head: A,
  });
  expect(result.effective_authorities).not.toContain(B);
});

it('refuses a supersession cycle without leaking other valid authority results', () => {
  const f = fixture();
  f.add(A, [X], [B]);
  f.add(B, [X], [A]);
  noAuthority(f.validate(), 'adr-supersession-cycle');
});

it('refuses competing accepted direct successors for the same subject', () => {
  const f = fixture();
  f.add(A, [X]);
  f.add(B, [X], [A]);
  f.add(C, [X], [A]);
  noAuthority(f.validate(), 'adr-multiple-accepted-direct-successors');
});

it('allows successors to resolve different subjects independently', () => {
  const f = fixture();
  f.add(A, [X, Y]);
  f.add(B, [X], [A]);
  f.add(C, [Y], [A]);
  const result = f.validate();
  expect(result.ok).toBe(true);
  expect(
    result.subject_authorities.filter((entry) => entry.subject.startsWith('fixture/')),
  ).toEqual([
    { subject: X, lineage_members: [A, B], effective_head: B },
    { subject: Y, lineage_members: [A, C], effective_head: C },
  ]);
  expect(result.effective_authorities).not.toContain(A);
});

it('resolves a converged diamond to its sole effective head independent of file insertion order', () => {
  const f = fixture();
  f.add(D, [X], [C, B]);
  f.add(C, [X], [A]);
  f.add(A, [X]);
  f.add(B, [X], [A]);
  const result = f.validate();
  expect(result.ok).toBe(true);
  expect(result.subject_authorities.find((entry) => entry.subject === X)).toEqual({
    subject: X,
    lineage_members: [A, B, C, D],
    effective_head: D,
  });
  for (const id of [A, B, C]) expect(result.effective_authorities).not.toContain(id);
});

it('refuses multiple effective heads even when neither is a direct successor of the shared ancestor', () => {
  const f = fixture();
  const e = 'ADR-GOV-9905';
  f.add(A, [X]);
  f.add(B, [X], [A]);
  f.add(C, [X], [B]);
  f.add(D, [X], [A]);
  f.add(e, [X], [D]);
  noAuthority(f.validate(), 'adr-multiple-effective-accepted-heads');
});

it.each([
  ['one code point', 'x'],
  ['200 BMP code points', 'é'.repeat(200)],
  ['200 astral code points', '😀'.repeat(200)],
  ['embedded drive-like segment', 'docs/a:/rule'],
  ['non-drive prefix', '1:/rule'],
])(
  'retains canonical subject boundaries without requiring a filesystem path: %s',
  (_label, subject) => {
    const f = fixture();
    f.add(A, [subject]);
    const result = f.validate();
    expect(result.ok).toBe(true);
    expect(result.subject_authorities.find((entry) => entry.subject === subject)).toEqual({
      subject,
      lineage_members: [A],
      effective_head: A,
    });
    expect(result.adrs.find((record) => record.adr_id === A)?.effective_affected_rules).toEqual([
      subject,
    ]);
  },
);

it('refuses decomposed Unicode subjects without silently normalizing authority', () => {
  const f = fixture();
  const subject = 'fixture/cafe\u0301';
  expect(subject.normalize('NFC')).not.toBe(subject);
  f.add(A, [subject]);
  const result = f.validate();
  expect(result.ok).toBe(false);
  expect(result.semantic_resolution_performed).toBe(true);
  expect(result.effective_authorities).toEqual([]);
  expect(result.subject_authorities).toEqual([]);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'adr-affected-rule-subject-invalid' }),
    ]),
  );
});

it('does not interpret frontmatter preceded by arbitrary document text', () => {
  const f = fixture();
  f.add(A, [X]);
  const path = join(f.adrsDir, `${A}-fixture.md`);
  const before = `# Introductory text\n${readFileSync(path, 'utf8')}`;
  writeFileSync(path, before);
  const result = f.validate();
  expect(result.ok).toBe(false);
  // The resolver runs on the other parsed records, but grants no authority.
  expect(result.semantic_resolution_performed).toBe(true);
  expect(result.effective_authorities).toEqual([]);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: path, code: 'adr-semantic-resolution-not-performed' }),
    ]),
  );
  expect(readFileSync(path, 'utf8')).toBe(before);
});
