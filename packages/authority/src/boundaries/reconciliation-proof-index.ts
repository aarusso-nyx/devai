import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { canonicalJson } from '@devai-nyx/utils';
import { parseProofIndex, planProofIndexUpdate } from './proof-index-codec.js';
import { parseReconciliationChain, type ReconciliationPlan } from './reconciliation-plan.js';
import { provisionBytesSha, provisionSha } from './reconciliation-host-namespace.js';

function fail(): never {
  throw new Error('PROOF_INDEX_REPLACEMENT_REFUSED');
}

/** Pure byte plan only. A caller must independently prove native checkpoint and write authority. */
export function buildReconciliationProofIndex(
  plan: ReconciliationPlan,
  beforeIndexBytes: Uint8Array,
  finalChainBytes: Uint8Array,
  existingLooseObject?: Uint8Array,
  archivedSourceChains: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  const before = Buffer.from(beforeIndexBytes),
    chainBytes = Buffer.from(finalChainBytes),
    recipe = plan.effect_plan.proof_index;
  if (
    provisionSha(plan.source_manifest) !== plan.source_manifest_sha256 ||
    provisionSha(plan.effect_plan) !== plan.effect_plan_sha256 ||
    chainBytes.length > 33554432 ||
    provisionBytesSha(before) !== recipe.before_index_sha256
  )
    fail();
  const chain = parseReconciliationChain(chainBytes);
  // Both pre-existing recovery operations must have completed before staging.
  // No recovery, evidence append or proof rewrite is performed by this planner.
  for (const obligation of plan.source_manifest.recovery_obligations) {
    const matches = chain.records.filter(
      (record) =>
        record.proof_path === obligation.proof_path &&
        record.proof_sequence === obligation.proof_sequence &&
        record.proof_sha256 === obligation.proof_sha256,
    );
    if (matches.length !== 1) fail();
    const record = matches[0];
    if (!record) fail();
    if (obligation.mode === 'divergent') {
      if (
        !record.recovered_from ||
        record.recovered_from.source_chain_sha256 !== obligation.source_chain_sha256 ||
        record.recovered_from.source_entry_manifest_hash !==
          obligation.source_entry_manifest_hash ||
        record.recovered_from.source_chain_path !==
          `${plan.effect_plan.namespace}/objects/${String(obligation.source_chain_sha256)}`
      )
        fail();
      const provenance = record.recovered_from;
      const archived = archivedSourceChains.get(provenance.source_chain_sha256);
      if (!archived || provisionBytesSha(archived) !== provenance.source_chain_sha256) fail();
      const source = parseReconciliationChain(archived);
      let fork = 0;
      while (
        fork < source.records.length &&
        fork < chain.records.length &&
        canonicalJson(source.records[fork]) === canonicalJson(chain.records[fork])
      )
        fork++;
      const original = source.records[provenance.source_entry_sequence - 1];
      if (
        fork < 1 ||
        fork >= source.records.length ||
        fork >= chain.records.length ||
        provenance.fork_sequence !== fork ||
        provenance.source_entry_sequence <= fork ||
        !original ||
        original.recovered_from !== undefined ||
        original.id !== provenance.source_entry_id ||
        original.sequence !== provenance.source_entry_sequence ||
        original.manifest_hash !== provenance.source_entry_manifest_hash ||
        original.action !== record.action ||
        original.proof_path !== record.proof_path ||
        original.proof_sequence !== record.proof_sequence ||
        original.proof_sha256 !== record.proof_sha256
      )
        fail();
    } else if (record.recovered_from !== undefined) fail();
  }
  const snapshot = parseProofIndex(before, recipe.object_format);
  if (
    snapshot.other_entries_sha256 !== recipe.unchanged_other_entries_sha256 ||
    canonicalJson(snapshot) !== canonicalJson(plan.source_manifest.index)
  )
    fail();
  const rawObject = Buffer.concat([Buffer.from(`blob ${String(chainBytes.length)}\0`), chainBytes]);
  const oid = createHash(recipe.object_format).update(rawObject).digest('hex');
  const loose =
    existingLooseObject === undefined ? deflateSync(rawObject) : Buffer.from(existingLooseObject);
  if (
    loose.length > recipe.object_bytes_limit ||
    !inflateSync(loose, { maxOutputLength: rawObject.length }).equals(rawObject)
  )
    fail();
  const update = planProofIndexUpdate(before, recipe.object_format, {
    path: 'record/proofs/chain.json',
    mode: '100644',
    oid,
  });
  const indexBytes = Buffer.from(update.bytes_base64, 'base64');
  if (
    update.before.raw_sha256 !== recipe.before_index_sha256 ||
    update.before.other_entries_sha256 !== update.after.other_entries_sha256
  )
    fail();
  const outputs = [
    {
      path: `trusted-common-dir/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
      sha256: provisionBytesSha(loose),
      bytes: loose.length,
    },
    {
      path: 'trusted-worktree/index',
      sha256: provisionBytesSha(indexBytes),
      bytes: indexBytes.length,
    },
  ];
  return Object.freeze({
    kind: 'reconciliation-proof-index-plan',
    verified_chain_sha256: provisionBytesSha(chainBytes),
    canonical_head: chain.head,
    canonical_records: chain.records.length,
    blob_oid: oid,
    loose_object_base64: loose.toString('base64'),
    index_bytes_base64: indexBytes.toString('base64'),
    before: update.before,
    after: update.after,
    outputs: Object.freeze(outputs.map((value) => Object.freeze(value))),
    outputs_manifest_sha256: provisionSha({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-domain-outputs',
      phase: '03',
      outputs,
    }),
    grants_authority: false,
  });
}
