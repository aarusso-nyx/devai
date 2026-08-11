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
  type ManifestHashInputs,
} from '../../src/evidence/chain.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

let tempDir = '';
let chainPath = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-evidence-'));
  chainPath = join(tempDir, 'evidence-chain.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseContext: EvidenceContext = {
  repo_root: '/dev/null',
  git: { head_sha: null, dirty_files: [] },
};

function genesisDraft(id: string, overrides: Partial<DraftEvidence> = {}): DraftEvidence {
  return {
    id,
    timestamp: '2026-05-11T00:00:00.000Z',
    actor: 'harness',
    actor_role: 'harness',
    action: 'harness.bootstrap',
    status: 'completed',
    context: baseContext,
    ...overrides,
  };
}

function baseHashInputs(): ManifestHashInputs {
  return {
    id: 'EV-aaaaaaaaaaaaaaaa',
    timestamp: '2026-05-11T00:00:00.000Z',
    actor: 'harness',
    actor_role: 'harness',
    action: 'harness.bootstrap',
    status: 'completed',
    git_head_sha: null,
    artifact_sha256s: [],
    previous_run_hash: null,
  };
}

describe('computeManifestHash', () => {
  it('is deterministic for the same inputs', () => {
    const inputs = baseHashInputs();
    expect(computeManifestHash(inputs)).toBe(computeManifestHash(inputs));
  });

  it('changes when any input changes', () => {
    const base = baseHashInputs();
    const baseHash = computeManifestHash(base);
    expect(computeManifestHash({ ...base, action: 'task.spawn' })).not.toBe(baseHash);
    expect(computeManifestHash({ ...base, actor: 'alice' })).not.toBe(baseHash);
    expect(computeManifestHash({ ...base, previous_run_hash: '0'.repeat(64) })).not.toBe(baseHash);
    expect(computeManifestHash({ ...base, timestamp: '2026-05-11T00:00:01.000Z' })).not.toBe(
      baseHash,
    );
  });

  it('is insensitive to artifact order (sorts before hashing)', () => {
    const inputs = baseHashInputs();
    const a = computeManifestHash({
      ...inputs,
      artifact_sha256s: ['a'.repeat(64), 'b'.repeat(64)],
    });
    const b = computeManifestHash({
      ...inputs,
      artifact_sha256s: ['b'.repeat(64), 'a'.repeat(64)],
    });
    expect(a).toBe(b);
  });

  it('emits a 64-char hex string', () => {
    expect(computeManifestHash(baseHashInputs())).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('initChain', () => {
  it('creates an empty chain at the given path', () => {
    const chain = initChain(chainPath);
    expect(chain.head).toBeNull();
    expect(chain.records).toEqual([]);
  });

  it('is idempotent if the chain already exists', () => {
    initChain(chainPath);
    const second = initChain(chainPath);
    expect(second.head).toBeNull();
    expect(second.records).toEqual([]);
  });

  it('persists the empty chain to disk', () => {
    initChain(chainPath);
    const text = readFileSync(chainPath, 'utf8');
    const parsed = JSON.parse(text) as { head: unknown; records: unknown };
    expect(parsed.head).toBeNull();
    expect(parsed.records).toEqual([]);
  });
});

describe('appendRecord', () => {
  it('first record has previous_run_hash null and a hash matching its extracted inputs', () => {
    initChain(chainPath);
    const record = appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    expect(record.previous_run_hash).toBeNull();
    expect(record.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(computeManifestHash(extractManifestInputs(record))).toBe(record.manifest_hash);
  });

  it('second record links to first via previous_run_hash', () => {
    initChain(chainPath);
    const first = appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const second = appendRecord(
      chainPath,
      genesisDraft('EV-0000000000000002', {
        action: 'task.spawn',
        timestamp: '2026-05-11T00:00:01.000Z',
      }),
    );
    expect(second.previous_run_hash).toBe(first.manifest_hash);
  });

  it('persists chain.head as the latest manifest_hash', () => {
    initChain(chainPath);
    const record = appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const persisted = loadChain(chainPath);
    expect(persisted.head).toBe(record.manifest_hash);
    expect(persisted.records).toHaveLength(1);
  });

  it('rejects a draft that produces an invalid record (bad id pattern)', () => {
    initChain(chainPath);
    expect(() => {
      appendRecord(chainPath, genesisDraft('not-a-valid-id'));
    }).toThrow(/does not validate/);
  });
});

describe('verifyChain', () => {
  it('reports a clean chain as valid', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    appendRecord(
      chainPath,
      genesisDraft('EV-0000000000000002', {
        action: 'task.spawn',
        timestamp: '2026-05-11T00:00:01.000Z',
      }),
    );
    const result = verifyChain(chainPath);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('detects field tampering (changed action)', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const chain = loadChain(chainPath);
    const [first] = chain.records;
    if (!first) throw new Error('expected one record');
    first.action = 'tampered.action';
    writeFileSync(chainPath, JSON.stringify(chain, null, 2));
    const result = verifyChain(chainPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('manifest_hash mismatch'))).toBe(true);
  });

  it('detects a broken link (changed previous_run_hash)', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    appendRecord(
      chainPath,
      genesisDraft('EV-0000000000000002', {
        action: 'task.spawn',
        timestamp: '2026-05-11T00:00:01.000Z',
      }),
    );
    const chain = loadChain(chainPath);
    const [, second] = chain.records;
    if (!second) throw new Error('expected two records');
    second.previous_run_hash = '0'.repeat(64);
    writeFileSync(chainPath, JSON.stringify(chain, null, 2));
    const result = verifyChain(chainPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('previous_run_hash mismatch'))).toBe(true);
  });

  it('detects a stale head pointer', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const chain = loadChain(chainPath);
    chain.head = '0'.repeat(64);
    writeFileSync(chainPath, JSON.stringify(chain, null, 2));
    const result = verifyChain(chainPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('chain head mismatch'))).toBe(true);
  });
});
// Invariants: INV-DEVAI-001
