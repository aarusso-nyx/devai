import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { buildEvidenceRecord, canonicalJson } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import { buildReconciliationProofIndex } from '../../src/boundaries/reconciliation-proof-index.js';
import { parseProofIndex } from '../../src/boundaries/proof-index-codec.js';
import { createReconciliationEffectPlan } from '../../src/boundaries/reconciliation-effect-plan.js';
import {
  provisionBytesSha,
  provisionSha,
} from '../../src/boundaries/reconciliation-host-namespace.js';
import type { ReconciliationPlan } from '../../src/boundaries/reconciliation-plan.js';

function fixture(format: 'sha1' | 'sha256') {
  const oidSize = format === 'sha1' ? 20 : 32,
    parent = 'a'.repeat(oidSize * 2),
    digest = 'b'.repeat(64);
  const entries = [
    ['README.md', 0],
    ['law/security/authorization.json', 1],
    ['law/security/authorization.json', 2],
    ['law/security/authorization.json', 3],
    ['record/proofs/chain.json', 1],
    ['record/proofs/chain.json', 2],
    ['record/proofs/chain.json', 3],
  ] as const;
  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const raw = entries.map(([name, stage], i) => {
    const path = Buffer.from(name),
      fixed = 42 + oidSize,
      entry = Buffer.alloc(Math.ceil((fixed + path.length + 1) / 8) * 8);
    entry.writeUInt32BE(0o100644, 24);
    Buffer.alloc(oidSize, i + 1).copy(entry, 40);
    entry.writeUInt16BE(path.length | (stage << 12), 40 + oidSize);
    path.copy(entry, fixed);
    return entry;
  });
  const body = Buffer.concat([header, ...raw]),
    index = Buffer.concat([body, createHash(format).update(body).digest()]);
  const first = buildEvidenceRecord(
    {
      id: 'EV-0000000000000001',
      timestamp: '2026-10-24T00:00:00.000Z',
      actor: 'fixture',
      actor_role: 'harness',
      action: 'original',
      status: 'completed',
      context: { repo_root: '/fixture', git: { head_sha: parent, dirty_files: [] } },
    },
    null,
    1,
  );
  const original = Buffer.from(
    JSON.stringify({ head: first.manifest_hash, records: [first] }) + '\n',
  );
  const sourceEntry = buildEvidenceRecord(
    {
      id: 'EV-0000000000000003',
      timestamp: '2026-10-24T00:00:00.500Z',
      actor: 'fixture',
      actor_role: 'human:inspector',
      action: 'proof.divergent',
      status: 'completed',
      context: first.context,
      proof_path: 'record/proofs/work/generic/R-0025.jsonl',
      proof_sequence: 7,
      proof_sha256: 'c'.repeat(64),
    },
    first.manifest_hash,
    2,
  );
  const sourceChain = Buffer.from(
    JSON.stringify({ head: sourceEntry.manifest_hash, records: [first, sourceEntry] }) + '\n',
  );
  const sourceSha = provisionBytesSha(sourceChain);
  const sources = new Map([[sourceSha, sourceChain]]);
  const manifest = {
    files: [
      {
        commit: parent,
        path: 'record/proofs/chain.json',
        mode: '100644',
        blob_oid: parent,
        sha256: provisionBytesSha(original),
        bytes: original.length,
        kind: 'chain' as const,
      },
    ],
    index: parseProofIndex(index, format),
    staged_files: [],
    recovery_obligations: [
      {
        proof_path: 'record/proofs/work/generic/R-0025.jsonl',
        proof_sequence: 7,
        proof_sha256: 'c'.repeat(64),
        source_commit: parent,
        source_chain_sha256: sourceSha,
        source_entry_manifest_hash: sourceEntry.manifest_hash,
        mode: 'divergent' as const,
      },
      {
        proof_path: 'record/proofs/work/generic/R-0025.jsonl',
        proof_sequence: 8,
        proof_sha256: 'f'.repeat(64),
        source_commit: null,
        source_chain_sha256: null,
        source_entry_manifest_hash: null,
        mode: 'newest' as const,
      },
    ],
  };
  const source = {
    source_manifest: manifest,
    source_manifest_sha256: provisionSha(manifest),
    selection: {
      parent,
      published_ref: 'refs/heads/main',
      published_tip: parent,
      origin_config_sha256: digest,
      effective_origin_sha256: digest,
    },
  };
  const effect = createReconciliationEffectPlan(source);
  const plan: ReconciliationPlan = {
    schemaVersion: '1.0.0',
    kind: 'evidence-reconciliation-plan',
    identity: {
      schemaVersion: '1.0.0',
      kind: 'reconciliation-host-context',
      repository_id: 'fixture',
      worktree_id: 'wt-fixture',
      host_identity_sha256: digest,
      head: parent,
      object_format: format,
      merge_heads: ['1'.repeat(oidSize * 2)],
    },
    binding_sha256: digest,
    ...source,
    bases: [],
    effect_plan: effect,
    effect_plan_sha256: provisionSha(effect),
    grants_authority: false,
  };
  const recovered = buildEvidenceRecord(
    {
      id: 'EV-0000000000000002',
      timestamp: '2026-10-24T00:00:01.000Z',
      actor: 'fixture',
      actor_role: 'human:inspector',
      action: 'proof.divergent',
      status: 'completed',
      context: first.context,
      proof_path: 'record/proofs/work/generic/R-0025.jsonl',
      proof_sequence: 7,
      proof_sha256: 'c'.repeat(64),
      recovered_from: {
        source_chain_path: `${effect.namespace}/objects/${sourceSha}`,
        source_chain_sha256: sourceSha,
        source_entry_manifest_hash: sourceEntry.manifest_hash,
        source_entry_id: 'EV-0000000000000003',
        source_entry_sequence: 2,
        fork_sequence: 1,
      },
    },
    first.manifest_hash,
    2,
  );
  const newest = buildEvidenceRecord(
    {
      id: 'EV-0000000000000004',
      timestamp: '2026-10-24T00:00:02.000Z',
      actor: 'fixture',
      actor_role: 'human:inspector',
      action: 'proof.newest',
      status: 'completed',
      context: first.context,
      proof_path: 'record/proofs/work/generic/R-0025.jsonl',
      proof_sequence: 8,
      proof_sha256: 'f'.repeat(64),
    },
    recovered.manifest_hash,
    3,
  );
  const chain = Buffer.from(
    JSON.stringify({ head: newest.manifest_hash, records: [first, recovered, newest] }, null, 2) +
      '\n',
  );
  return { plan, index, chain, original, sources };
}
describe.each(['sha1', 'sha256'] as const)('pure %s proof-index plan', (format) => {
  it('preserves every other index entry and stages exactly the final canonical blob', () => {
    const f = fixture(format),
      before = Buffer.from(f.index),
      result = buildReconciliationProofIndex(f.plan, f.index, f.chain, undefined, f.sources);
    const after = parseProofIndex(Buffer.from(result.index_bytes_base64, 'base64'), format);
    expect(after.entries.filter((e) => e.path === 'record/proofs/chain.json')).toEqual([
      {
        path: 'record/proofs/chain.json',
        mode: '100644',
        oid: result.blob_oid,
        stage: 0,
        assume_valid: false,
      },
    ]);
    expect(after.entries.filter((e) => e.path !== 'record/proofs/chain.json')).toEqual(
      f.plan.source_manifest.index.entries.filter((e) => e.path !== 'record/proofs/chain.json'),
    );
    expect(after.other_entries_sha256).toBe(f.plan.source_manifest.index.other_entries_sha256);
    const raw = inflateSync(Buffer.from(result.loose_object_base64, 'base64'));
    expect(raw).toEqual(Buffer.concat([Buffer.from(`blob ${String(f.chain.length)}\0`), f.chain]));
    expect(createHash(format).update(raw).digest('hex')).toBe(result.blob_oid);
    expect(f.index).toEqual(before);
    expect(result.grants_authority).toBe(false);
  });
  it('refuses staging before the separate recoveries have completed', () => {
    const f = fixture(format);
    expect(() => buildReconciliationProofIndex(f.plan, f.index, f.original)).toThrow(
      'PROOF_INDEX_REPLACEMENT_REFUSED',
    );
  });
  it('freezes an already-existing verified loose representation without overwriting it', () => {
    const f = fixture(format),
      raw = Buffer.concat([Buffer.from(`blob ${String(f.chain.length)}\0`), f.chain]),
      existing = deflateSync(raw, { level: 1 });
    const result = buildReconciliationProofIndex(f.plan, f.index, f.chain, existing, f.sources);
    expect(Buffer.from(result.loose_object_base64, 'base64')).toEqual(existing);
    expect(result.outputs[0]?.sha256).toBe(provisionBytesSha(existing));
    expect(() =>
      buildReconciliationProofIndex(
        f.plan,
        f.index,
        f.chain,
        deflateSync(Buffer.from('blob 1\0x')),
        f.sources,
      ),
    ).toThrow();
  });
  it.each(['source_entry_id', 'source_entry_sequence', 'fork_sequence'] as const)(
    'rejects forged %s even when ordinary chain hashes still verify',
    (field) => {
      const f = fixture(format);
      const chain = JSON.parse(f.chain.toString('utf8')) as {
        records: { recovered_from?: Record<string, unknown> }[];
      };
      const provenance = chain.records[1]?.recovered_from;
      if (!provenance) throw new Error('fixture');
      provenance[field] = field === 'source_entry_id' ? 'EV-ffffffffffffffff' : 99;
      expect(() =>
        buildReconciliationProofIndex(
          f.plan,
          f.index,
          Buffer.from(JSON.stringify(chain) + '\n'),
          undefined,
          f.sources,
        ),
      ).toThrow('PROOF_INDEX_REPLACEMENT_REFUSED');
    },
  );
  it('requires exact archived source bytes for divergent recovery', () => {
    const f = fixture(format);
    expect(() => buildReconciliationProofIndex(f.plan, f.index, f.chain)).toThrow(
      'PROOF_INDEX_REPLACEMENT_REFUSED',
    );
    const bad = new Map([...f.sources].map(([key]) => [key, Buffer.from('wrong')]));
    expect(() => buildReconciliationProofIndex(f.plan, f.index, f.chain, undefined, bad)).toThrow(
      'PROOF_INDEX_REPLACEMENT_REFUSED',
    );
  });
  it('refuses an index changed outside the approved raw and semantic witnesses', () => {
    const f = fixture(format),
      changed = Buffer.from(f.index);
    changed[16] = 99;
    expect(() =>
      buildReconciliationProofIndex(f.plan, changed, f.chain, undefined, f.sources),
    ).toThrow();
    const wrong = {
      ...f.plan,
      effect_plan: {
        ...f.plan.effect_plan,
        proof_index: {
          ...f.plan.effect_plan.proof_index,
          unchanged_other_entries_sha256: '0'.repeat(64),
        },
      },
    };
    wrong.effect_plan_sha256 = provisionSha(wrong.effect_plan);
    expect(() =>
      buildReconciliationProofIndex(wrong, f.index, f.chain, undefined, f.sources),
    ).toThrow();
    expect(canonicalJson(f.plan.effect_plan.proof_index)).not.toContain('0'.repeat(64));
  });
});
