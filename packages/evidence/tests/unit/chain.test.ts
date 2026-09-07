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

describe('chain ordinals and predecessor aliases', () => {
  it('verifies genesis and non-genesis aliases without changing stored bytes', () => {
    initChain(chainPath);
    const first = appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const second = appendRecord(chainPath, genesisDraft('EV-0000000000000002'));
    expect(first).toMatchObject({ sequence: 1, previous_hash: 'GENESIS', previous_run_hash: null });
    expect(second).toMatchObject({
      sequence: 2,
      previous_hash: first.manifest_hash,
      previous_run_hash: first.manifest_hash,
    });
    const before = readFileSync(chainPath);
    expect(verifyChain(chainPath)).toEqual({ valid: true, errors: [] });
    expect(readFileSync(chainPath)).toEqual(before);
  });
  it('reports independent ordinal, predecessor alias and head defects together', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    const second = appendRecord(chainPath, genesisDraft('EV-0000000000000002'));
    const chain = loadChain(chainPath);
    const [first, next] = chain.records;
    if (!first || !next) throw new Error('expected two records');
    first.sequence = 0;
    next.sequence = 3;
    first.previous_hash = 'incorrect-genesis';
    next.previous_hash = 'incorrect-predecessor';
    chain.head = null;
    writeFileSync(chainPath, JSON.stringify(chain));
    const before = readFileSync(chainPath);
    expect(verifyChain(chainPath)).toEqual({
      valid: false,
      errors: [
        'record EV-0000000000000001: sequence mismatch (expected 1, got 0)',
        'record EV-0000000000000001: previous_hash mismatch (expected GENESIS, got incorrect-genesis)',
        'record EV-0000000000000002: sequence mismatch (expected 2, got 3)',
        `record EV-0000000000000002: previous_hash mismatch (expected ${first.manifest_hash}, got incorrect-predecessor)`,
        `chain head mismatch (expected ${second.manifest_hash}, got null)`,
      ],
    });
    expect(readFileSync(chainPath)).toEqual(before);
  });
  it('preserves verification of legacy records without the optional aliases', () => {
    initChain(chainPath);
    appendRecord(chainPath, genesisDraft('EV-0000000000000001'));
    appendRecord(chainPath, genesisDraft('EV-0000000000000002'));
    const chain = loadChain(chainPath);
    for (const record of chain.records) {
      delete record.sequence;
      delete record.previous_hash;
    }
    writeFileSync(chainPath, JSON.stringify(chain));
    expect(verifyChain(chainPath)).toEqual({ valid: true, errors: [] });
  });
  it.each(['null', '42', '{"records":null,"head":null}', '{"records":[],"head":42}'])(
    'refuses malformed chain shape %s without rewriting it',
    (bytes) => {
      writeFileSync(chainPath, bytes);
      expect(() => loadChain(chainPath)).toThrow(/evidence chain at/);
      expect(readFileSync(chainPath, 'utf8')).toBe(bytes);
    },
  );
});

it('matches the legacy chain digest vectors while retaining artifact multiplicity and caller order', () => {
  // Independent SHA-256 vectors over the published JSON tuple (including GENESIS).
  expect(computeManifestHash(baseHashInputs())).toBe(
    'd554c623dbe47accd2ffe7c505f3086811580788678dfe6a4be72029a743609c',
  );
  const artifacts = Object.freeze(['b'.repeat(64), null, 'a'.repeat(64), 'b'.repeat(64)]);
  const input = { ...baseHashInputs(), artifact_sha256s: artifacts };
  expect(computeManifestHash(input)).toBe(
    '08e275e2c5990ecc1a0074bc41aec04849dbf0b73333130be8fd1fddb61e1cd1',
  );
  expect(artifacts).toEqual(['b'.repeat(64), null, 'a'.repeat(64), 'b'.repeat(64)]);
  expect(
    computeManifestHash({ ...input, artifact_sha256s: [null, 'a'.repeat(64), 'b'.repeat(64)] }),
  ).not.toBe(computeManifestHash(input));
});

it('retains explicit finding counts and omits an absent summary when appending', () => {
  initChain(chainPath);
  const findings = { info: 0, warning: 2, error: 1, critical: 0 };
  const first = appendRecord(
    chainPath,
    genesisDraft('EV-0000000000000091', { findings_summary: findings }),
  );
  const second = appendRecord(chainPath, genesisDraft('EV-0000000000000092'));
  expect(first.findings_summary).toEqual(findings);
  expect(Object.hasOwn(second, 'findings_summary')).toBe(false);
  const persisted = loadChain(chainPath);
  expect(persisted.records[0]?.findings_summary).toEqual(findings);
  expect(Object.hasOwn(persisted.records[1] ?? {}, 'findings_summary')).toBe(false);
  expect(verifyChain(chainPath)).toEqual({ valid: true, errors: [] });
});
