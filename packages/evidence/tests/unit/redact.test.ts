import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRecord,
  computeManifestHash,
  extractManifestInputs,
  initChain,
  loadChain,
  verifyChain,
  type DraftEvidence,
  type EvidenceContext,
} from '../../src/evidence/chain.js';
import { redactRecord } from '../../src/evidence/redact.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

let tempDir = '';
let chainPath = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-redact-'));
  chainPath = join(tempDir, 'evidence-chain.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseContext: EvidenceContext = {
  repo_root: '/secret/path',
  git: { head_sha: null, dirty_files: [] },
};

function draft(id: string, overrides: Partial<DraftEvidence> = {}): DraftEvidence {
  return {
    id,
    timestamp: '2026-05-11T00:00:00.000Z',
    actor: 'alice',
    actor_role: 'harness',
    action: 'task.spawn',
    status: 'completed',
    context: baseContext,
    notes: ['credential is sk-secret123'],
    ...overrides,
  };
}

describe('redactRecord', () => {
  it('redacts pattern matches inside notes (notes are not in the hash; manifest unchanged)', () => {
    initChain(chainPath);
    const first = appendRecord(chainPath, draft('EV-0000000000000001'));
    const policy = { patterns: [/sk-[a-z0-9]+/g], fields: [] };

    const result = redactRecord({ chainPath, targetId: first.id, policy });

    expect(result.target.notes).toEqual(['credential is [REDACTED]']);
    // notes are NOT in the canonical hash inputs — hash stays the same.
    expect(result.target.manifest_hash).toBe(first.manifest_hash);
    const expected = computeManifestHash(extractManifestInputs(result.target));
    expect(expected).toBe(result.target.manifest_hash);
  });

  it("redacts the 'actor' field wholesale via policy.fields (actor IS hashed; hash changes)", () => {
    initChain(chainPath);
    const first = appendRecord(chainPath, draft('EV-0000000000000001'));
    const policy = { patterns: [], fields: ['actor'] };

    const result = redactRecord({ chainPath, targetId: first.id, policy });

    expect(result.target.actor).toBe('[REDACTED]');
    expect(result.target.manifest_hash).not.toBe(first.manifest_hash);
    const expected = computeManifestHash(extractManifestInputs(result.target));
    expect(expected).toBe(result.target.manifest_hash);
  });

  it('re-links downstream when a hashed field changes and chain stays valid', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    const second = appendRecord(
      chainPath,
      draft('EV-0000000000000002', {
        action: 'task.complete',
        timestamp: '2026-05-11T00:00:01.000Z',
        notes: ['nothing sensitive'],
      }),
    );
    const third = appendRecord(
      chainPath,
      draft('EV-0000000000000003', {
        action: 'task.merge',
        timestamp: '2026-05-11T00:00:02.000Z',
        notes: ['nothing sensitive'],
      }),
    );

    // Redact 'actor' on the FIRST record — affects hash, cascades downstream.
    const result = redactRecord({
      chainPath,
      targetId: 'EV-0000000000000001',
      policy: { patterns: [], fields: ['actor'] },
    });
    expect(result.relinkedCount).toBe(2);

    const chain = loadChain(chainPath);
    const [r1, r2, r3] = chain.records;
    if (!r1 || !r2 || !r3) throw new Error('expected three records');
    expect(r1.actor).toBe('[REDACTED]');
    expect(r2.previous_run_hash).toBe(r1.manifest_hash);
    expect(r2.manifest_hash).not.toBe(second.manifest_hash);
    expect(r3.previous_run_hash).toBe(r2.manifest_hash);
    expect(r3.manifest_hash).not.toBe(third.manifest_hash);
    expect(chain.head).toBe(r3.manifest_hash);

    expect(verifyChain(chainPath).valid).toBe(true);
  });

  it('chain stays valid after redacting notes only (no hash change, no downstream effect)', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    appendRecord(
      chainPath,
      draft('EV-0000000000000002', {
        timestamp: '2026-05-11T00:00:01.000Z',
        notes: ['another sk-token here'],
      }),
    );
    redactRecord({
      chainPath,
      targetId: 'EV-0000000000000001',
      policy: { patterns: [/sk-[a-z0-9]+/g], fields: [] },
    });
    expect(verifyChain(chainPath).valid).toBe(true);
  });

  it('throws when the target id does not exist in the chain', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    expect(() => {
      redactRecord({
        chainPath,
        targetId: 'EV-deadbeefdeadbeef',
        policy: { patterns: [], fields: ['actor'] },
      });
    }).toThrow(/not found/);
  });

  it('throws if the redacted target would violate the schema (defense in depth)', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    // Corrupt the on-disk record so its actor is an empty string (schema
    // requires minLength 1). loadChain doesn't validate per-record, so the
    // corruption is loaded as-is; redactRecord must catch it.
    const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as {
      records: Array<{ actor: string }>;
    };
    const [first] = chain.records;
    if (!first) throw new Error('expected one record');
    first.actor = '';
    writeFileSync(chainPath, JSON.stringify(chain, null, 2));

    expect(() => {
      redactRecord({
        chainPath,
        targetId: 'EV-0000000000000001',
        policy: { patterns: [/sk-[a-z0-9]+/g], fields: [] },
      });
    }).toThrow(/does not validate/);
  });

  it('throws if a re-linked downstream record would violate the schema', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    appendRecord(
      chainPath,
      draft('EV-0000000000000002', {
        timestamp: '2026-05-11T00:00:01.000Z',
        actor: 'bob',
      }),
    );
    // Corrupt the SECOND record's actor — first record stays valid, but
    // when we redact the first (which forces re-link of the second),
    // the second is re-validated and the corruption surfaces.
    const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as {
      records: Array<{ actor: string }>;
    };
    const second = chain.records[1];
    if (!second) throw new Error('expected two records');
    second.actor = '';
    writeFileSync(chainPath, JSON.stringify(chain, null, 2));

    expect(() => {
      redactRecord({
        chainPath,
        targetId: 'EV-0000000000000001',
        policy: { patterns: [], fields: ['actor'] },
      });
    }).toThrow(/does not validate/);
  });

  it('multiple redactions leave the chain valid', () => {
    initChain(chainPath);
    appendRecord(chainPath, draft('EV-0000000000000001'));
    appendRecord(
      chainPath,
      draft('EV-0000000000000002', {
        timestamp: '2026-05-11T00:00:01.000Z',
        actor: 'bob',
        notes: ['another sk-token here'],
      }),
    );
    redactRecord({
      chainPath,
      targetId: 'EV-0000000000000001',
      policy: { patterns: [/sk-[a-z0-9]+/g], fields: [] },
    });
    redactRecord({
      chainPath,
      targetId: 'EV-0000000000000002',
      policy: { patterns: [], fields: ['actor'] },
    });
    expect(verifyChain(chainPath).valid).toBe(true);
  });
});
// Invariants: INV-DEVAI-001
