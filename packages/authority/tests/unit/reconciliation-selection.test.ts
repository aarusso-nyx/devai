import { describe, expect, it } from 'vitest';
import { buildEvidenceRecord, canonicalJson } from '@devai-nyx/utils';
import { buildReconciliationSelection } from '../../src/boundaries/reconciliation-selection.js';
import { createReconciliationEffectPlan } from '../../src/boundaries/reconciliation-effect-plan.js';
import {
  provisionBytesSha,
  provisionSha,
} from '../../src/boundaries/reconciliation-host-namespace.js';
import type { ReconciliationPlan } from '../../src/boundaries/reconciliation-plan.js';
import type { ReconciliationOwnerState } from '../../src/runtime/reconciliation-owner-state.js';

const digest = 'b'.repeat(64);
const parent = 'a'.repeat(40);
const clock = {
  clock_source: 'node-uv-hrtime-ns-v1',
  boot_id: '12345678-1234-1234-1234-123456789abc',
  monotonic_ns: '123456789',
  wall_ms: 1792890000000,
} as const;
function fixture() {
  const original = buildEvidenceRecord(
    {
      id: 'EV-0123456789abcdef',
      timestamp: '2026-10-24T00:00:00.000Z',
      actor: 'historical-fixture',
      actor_role: 'harness',
      action: 'historical.fixture',
      status: 'completed',
      context: { repo_root: '/historical/repository', git: { head_sha: parent, dirty_files: [] } },
      notes: ['Original optional metadata must remain unchanged.'],
    },
    null,
    1,
  );
  // Historical key order and whitespace are deliberately different from the
  // candidate serializer. Every original record value must still be retained.
  const bytes = Buffer.from(JSON.stringify({ records: [original], head: original.manifest_hash }));
  const manifest = {
    files: [
      {
        commit: parent,
        path: 'record/proofs/chain.json',
        mode: '100644',
        blob_oid: 'c'.repeat(40),
        sha256: provisionBytesSha(bytes),
        bytes: bytes.length,
        kind: 'chain' as const,
      },
    ],
    staged_files: [],
    index: {
      version: 2 as const,
      object_format: 'sha1' as const,
      raw_sha256: digest,
      semantic_sha256: digest,
      other_entries_sha256: digest,
      entries: [],
      has_tree_extension: false,
    },
    recovery_obligations: [],
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
      worktree_id: `wt-${'d'.repeat(48)}`,
      host_identity_sha256: digest,
      head: 'e'.repeat(40),
      object_format: 'sha1',
      merge_heads: [parent],
    },
    binding_sha256: digest,
    ...source,
    bases: [],
    effect_plan: effect,
    effect_plan_sha256: provisionSha(effect),
    grants_authority: false,
  };
  const state: ReconciliationOwnerState = {
    kind: 'reconciliation-owner-state',
    repository_id: plan.identity.repository_id,
    worktree_id: plan.identity.worktree_id,
    host_identity_sha256: plan.identity.host_identity_sha256,
    binding_sha256: digest,
    source_manifest_sha256: plan.source_manifest_sha256,
    plan_sha256: provisionBytesSha(Buffer.from(`${canonicalJson(plan)}\n`)),
    approval_id: digest,
    issuer_sha256: digest,
    approval_sha256: digest,
    scope_sha256: digest,
    grant_sha256: digest,
    grant_sequence: 1,
    grant_kind: 'approval',
    lease_sha256: null,
    phases: [],
    grants_authority: false,
  };
  return { plan, state, bytes, original };
}
describe('pure whole-parent selection construction', () => {
  it('keeps every original field and appends one normal event with exact predecessor and ordinal', () => {
    const f = fixture();
    const result = buildReconciliationSelection(
      f.plan,
      f.state,
      clock,
      digest,
      '/fixture',
      f.bytes,
    );
    const chain = JSON.parse(result.candidate_text) as { records: unknown[]; head: string };
    expect(chain.records).toHaveLength(2);
    expect(chain.records[0]).toEqual(f.original);
    expect(result.event.previous_run_hash).toBe(f.original.manifest_hash);
    expect(result.event.sequence).toBe(2);
    expect(chain.head).toBe(result.event.manifest_hash);
    expect(result.event.proof_path).toBeUndefined();
    expect(result.event.recovered_from).toBeUndefined();
    expect(Object.keys(chain)).toEqual(['records', 'head']);
    expect(result.grants_authority).toBe(false);
  });
  it('binds selected original bytes, custody and receipt as three ordinary hashed artifacts', () => {
    const f = fixture();
    const result = buildReconciliationSelection(
      f.plan,
      f.state,
      clock,
      digest,
      '/fixture',
      f.bytes,
    );
    expect(result.event.artifacts.map((a) => a.sha256)).toEqual([
      f.plan.effect_plan.custody.manifest.sha256,
      provisionBytesSha(f.bytes),
      provisionBytesSha(Buffer.from(result.receipt_text)),
    ]);
    const receipt = JSON.parse(result.receipt_text) as Record<string, unknown>;
    expect(receipt['approval_sha256']).toBe(f.state.approval_sha256);
    expect(receipt['plan_sha256']).toBe(f.state.plan_sha256);
    expect(receipt['identity']).toEqual(f.plan.identity);
    expect(receipt['intent_sha256']).toBeUndefined();
    expect(receipt['event_sha256']).toBeUndefined();
    expect(result.receipt_text).toBe(`${canonicalJson(receipt)}\n`);
  });
  for (const field of [
    'plan_sha256',
    'binding_sha256',
    'source_manifest_sha256',
    'worktree_id',
  ] as const)
    it(`refuses a foreign ${field}`, () => {
      const f = fixture();
      expect(() =>
        buildReconciliationSelection(
          f.plan,
          { ...f.state, [field]: 'f'.repeat(64) },
          clock,
          digest,
          '/fixture',
          f.bytes,
        ),
      ).toThrow('RECONCILIATION_SELECTION_INVALID');
    });
  it('refuses changed original bytes, malformed clock and malformed intent nonce', () => {
    const f = fixture();
    expect(() =>
      buildReconciliationSelection(f.plan, f.state, clock, digest, '/fixture', Buffer.from('{}')),
    ).toThrow();
    expect(() =>
      buildReconciliationSelection(
        f.plan,
        f.state,
        { ...clock, monotonic_ns: '0' },
        digest,
        '/fixture',
        f.bytes,
      ),
    ).toThrow();
    expect(() =>
      buildReconciliationSelection(f.plan, f.state, clock, 'x', '/fixture', f.bytes),
    ).toThrow();
  });
  it('is reproducible from an authenticated intent clock and nonce without circular event digests', () => {
    const f = fixture();
    const a = buildReconciliationSelection(f.plan, f.state, clock, digest, '/fixture', f.bytes);
    const b = buildReconciliationSelection(f.plan, f.state, clock, digest, '/fixture', f.bytes);
    expect(a).toEqual(b);
    const changed = buildReconciliationSelection(
      f.plan,
      f.state,
      clock,
      'f'.repeat(64),
      '/fixture',
      f.bytes,
    );
    expect(changed.event.manifest_hash).not.toBe(a.event.manifest_hash);
    expect(changed.outputs_manifest_sha256).not.toBe(a.outputs_manifest_sha256);
    expect(a.outputs.map((o) => o.path)).toEqual([
      f.plan.effect_plan.selection.receipt_path,
      'record/proofs/chain.json',
    ]);
  });
});
