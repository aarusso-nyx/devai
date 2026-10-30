import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConstitutionVersion } from '@devai-nyx/skills';
import {
  frozenReconciliationConstitution,
  projectReconciliationConstitution,
} from '../helpers/constitution-history.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const INSERTIONS = [
  'At an explicitly Owner-approved unresolved Git merge, a registered machine evidence-reconciliation verb may materialize the complete canonical chain of one exact published parent as the active merge result only after it has durably preserved and hash-verified the complete chains, proof epochs and ancestry of every displaced parent and the common base. This is a narrowly declared canonical-selection exception to append-only storage, not permission to edit, truncate, reorder, resequence, splice or re-record any source history or proof epoch. The Inspector-initiated verb must bind the exact parents, semantic index, source manifests, selected canonical prefix and immutable custody receipts, refuse every unapproved delta, and append a distinct canonical-selection evidence entry to the selected prefix through the normal machine writer before publishing the result. Every displaced active event remains explicitly archival; missing proof anchors require their separately authorized supported recovery. No human or client extension may exercise or widen this exception.',
  'Git index mutation is permitted only through a registered machine index boundary for an exact approved reconciliation. The boundary addresses a host-bound repository/worktree identity and one declared proof-chain entry, verifies all other semantic index entries are unchanged, and performs compare-and-swap publication under the real Git index lock. It grants no general filesystem access to Git administration directories, no ref update, commit, push, force operation or business-source staging. Inspector initiation and explicit write consent are required. Linked-worktree administration paths must be resolved and bound by the trusted host; caller-supplied physical paths cannot authorize them.',
] as const;

describe('REC-B1-A canonical-selection contract authoring', () => {
  it('changes only two Article 6 paragraphs, version markers and amendment date', () => {
    const source = projectReconciliationConstitution(read('law/constitution.md'));
    expect(parseConstitutionVersion(source)).toBe('1.2.0');
    let predecessor = source;
    const start = source.indexOf('### Article 6.');
    const end = source.indexOf('### Article 7.');
    for (const [index, paragraph] of INSERTIONS.entries()) {
      expect(source.split(paragraph)).toHaveLength(2);
      expect(source.slice(start, end)).toContain(paragraph);
      predecessor = predecessor.replace(`\n${paragraph}\n${index === 0 ? '\n' : ''}`, '');
    }
    predecessor = predecessor
      .replace('title: DEVAI Constitution 1.2.0', 'title: DEVAI Constitution 1.1.0')
      .replace('# DEVAI Constitution — 1.2.0', '# DEVAI Constitution — 1.1.0')
      .replace('**Version:** 1.2.0', '**Version:** 1.1.0')
      .replace('date: 2026-10-24', 'date: 2026-10-21');
    // This digest freezes every existing row and Article 9 as well as all other articles.
    expect(sha256(predecessor)).toBe(
      '8353c3b81d38e0f9b913cbeb6762bc149605989c1b16f52d2c63ba9892f71270',
    );
  });

  it('requires genuine adopted successor pin and policy parity while retaining the exact historical projection', () => {
    const source = read('law/constitution.md');
    const pin = read('.devai/pin/constitution.md');
    expect(parseConstitutionVersion(pin)).toBe('1.2.1');
    expect(projectReconciliationConstitution(pin)).toBe(frozenReconciliationConstitution());
    expect(pin).toBe(source);
    const policy = JSON.parse(read('.devai/config/authority-policy.json')) as {
      constitution: { version: string; digest_sha256: string };
    };
    expect(policy.constitution).toEqual({ version: '1.2.1', digest_sha256: sha256(source) });
  });
});
