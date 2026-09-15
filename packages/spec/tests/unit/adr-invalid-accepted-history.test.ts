import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAdrs } from '../../src/adr/index.js';

const ROOT = process.cwd();
const temporaryRoots: string[] = [];

function fixture(): { readonly adrsDir: string; readonly policyPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-adr-history-'));
  temporaryRoots.push(root);
  const law = join(root, 'law');
  cpSync(join(ROOT, 'law', 'adr'), join(law, 'adr'), { recursive: true });
  cpSync(join(ROOT, 'law', 'policy'), join(law, 'policy'), { recursive: true });
  return {
    adrsDir: join(law, 'adr'),
    policyPath: join(law, 'policy', 'adr-validation.json'),
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() ?? '', { recursive: true, force: true });
  }
});

describe('digest-bound invalid accepted ADR history', () => {
  it('materializes only the restored historical bytes and resolves the forward successor', () => {
    const result = validateAdrs({ adrsDir: join(ROOT, 'law', 'adr') });

    expect(result.ok).toBe(true);
    expect(result.adrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adr_id: 'ADR-MUT-0005',
          format: 'legacy-catalog',
          effective: false,
        }),
        expect.objectContaining({
          adr_id: 'ADR-MUT-0006',
          format: 'v2',
          effective: true,
        }),
      ]),
    );
  });

  it('rejects any edit to the classified accepted bytes', () => {
    const { adrsDir, policyPath } = fixture();
    const record = join(adrsDir, 'ADR-MUT-0005-unambiguous-mutation-digest-boundaries.md');
    writeFileSync(record, `${readFileSync(record, 'utf8')}\n## Inspector Adversarial Acceptance\n`);

    const result = validateAdrs({ adrsDir, policyPath });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'adr-superseded-record-edited',
          file: record,
        }),
      ]),
    );
    expect(result.effective_authorities).toEqual([]);
  });

  it('requires the special catalog and allowlist dispositions to agree exactly', () => {
    const { adrsDir, policyPath } = fixture();
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
      semantic_resolver: {
        resolvable_legacy_references: Array<{ reference: string; disposition: string }>;
      };
    };
    const special = policy.semantic_resolver.resolvable_legacy_references.find(
      (entry) => entry.reference === 'ADR-MUT-0005',
    );
    if (special === undefined)
      throw new Error('special legacy allowlist entry missing from fixture');
    special.disposition = 'preserved-pre-v2-record';
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

    const result = validateAdrs({ adrsDir, policyPath });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'adr-legacy-reference-allowlist-mismatch' }),
      ]),
    );
    expect(result.effective_authorities).toEqual([]);
  });

  it('does not create a generic repair path for a new invalid v2 record', () => {
    const { adrsDir, policyPath } = fixture();
    const invalid = join(adrsDir, 'ADR-GOV-9999-new-invalid-record.md');
    writeFileSync(
      invalid,
      `---
id: ADR-GOV-9999
title: New invalid record
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance: []
affected_rules:
  - law/policy/adr-validation.json
inspector_acceptance: []
---

# New invalid record

## Status

Accepted.

## Context

Fixture.

## Decision

Fixture.

## Consequences

Fixture.

## Alternatives Considered

Fixture.

## Affected Rules

- law/policy/adr-validation.json
`,
    );

    const result = validateAdrs({ adrsDir, policyPath });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'adr-semantic-resolution-not-performed',
          file: invalid,
          message: "missing section '## Inspector Adversarial Acceptance'",
        }),
      ]),
    );
    expect(result.effective_authorities).toEqual([]);
  });
});
