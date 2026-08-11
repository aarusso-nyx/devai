import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRecord,
  initChain,
  loadChain,
  verifyChain,
  type DraftEvidence,
  type EvidenceContext,
} from '../../packages/evidence/src/evidence/chain.js';
import { deriveEvidenceId } from '../../packages/evidence/src/evidence/id-generator.js';
import { withAuthorityHostTestScope } from '../../packages/authority/tests/unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

// Evidence-chain regression contract:
//   "Evidence chain can record and verify a sequence of 100+ events without drift."
//
// This is the first inhabitant of the regression suite convention; subsequent
// bug-fix regressions land alongside.

let tempDir = '';
let chainPath = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-soak-'));
  chainPath = join(tempDir, 'evidence-chain.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseContext: EvidenceContext = {
  repo_root: '/test',
  git: { head_sha: null, dirty_files: [] },
};

describe('100-event soak', () => {
  it('appends 100 records and verifyChain returns valid', () => {
    initChain(chainPath);
    const ids: string[] = [];
    let previousHash: string | null = null;

    for (let i = 0; i < 100; i++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const id = deriveEvidenceId({
        timestamp,
        actor: 'soaker',
        actor_role: 'harness',
        action: `soak.event.${String(i).padStart(3, '0')}`,
        status: 'completed',
        git_head_sha: null,
        artifact_sha256s: [],
        previous_run_hash: previousHash,
      });
      const draft: DraftEvidence = {
        id,
        timestamp,
        actor: 'soaker',
        actor_role: 'harness',
        action: `soak.event.${String(i).padStart(3, '0')}`,
        status: 'completed',
        context: baseContext,
        artifacts: [],
      };
      const record = appendRecord(chainPath, draft);
      previousHash = record.manifest_hash;
      ids.push(record.id);
    }

    const result = verifyChain(chainPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);

    const chain = loadChain(chainPath);
    expect(chain.records).toHaveLength(100);
    expect(chain.head).toBe(previousHash);
    // Spot-check: all ids are unique.
    expect(new Set(ids).size).toBe(100);
  });

  it('appends 100 records and remains valid after a redaction in the middle', async () => {
    initChain(chainPath);
    let previousHash: string | null = null;
    const ids: string[] = [];

    for (let i = 0; i < 100; i++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const id = deriveEvidenceId({
        timestamp,
        actor: 'soaker',
        actor_role: 'harness',
        action: `soak.event.${String(i).padStart(3, '0')}`,
        status: 'completed',
        git_head_sha: null,
        artifact_sha256s: [],
        previous_run_hash: previousHash,
      });
      const record = appendRecord(chainPath, {
        id,
        timestamp,
        actor: 'soaker',
        actor_role: 'harness',
        action: `soak.event.${String(i).padStart(3, '0')}`,
        status: 'completed',
        context: baseContext,
        artifacts: [],
      });
      previousHash = record.manifest_hash;
      ids.push(record.id);
    }

    // Redact a middle record's actor (which IS in the canonical hash).
    const target = ids[42];
    if (!target) throw new Error('expected ids[42] to exist');
    const { redactRecord } = await import('../../packages/evidence/src/evidence/redact.js');
    const result = redactRecord({
      chainPath,
      targetId: target,
      policy: { patterns: [], fields: ['actor'] },
    });
    // 100 records, target at index 42 → 57 downstream re-links.
    expect(result.relinkedCount).toBe(57);

    const verify = verifyChain(chainPath);
    expect(verify.valid).toBe(true);
  });
});
// Invariants: INV-DEVAI-001
