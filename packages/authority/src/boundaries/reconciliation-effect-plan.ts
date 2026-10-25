import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import type { ReconciliationPlan } from './reconciliation-plan.js';

/** Data construction only: no authority, path resolution, reads or writes. */
const CHAIN = 'record/proofs/chain.json';
const CATALOGUE = 'law/security/authorization.json';
const BLOB_LIMIT = 32 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const ENTRY_LIMIT = 100000;
const BODY_LIMIT = 32 * 1024 * 1024;
const BODY_TOTAL_LIMIT = 128 * 1024 * 1024;
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const canonicalBytes = (value: unknown): string => `${canonicalJson(value)}\n`;

const BODIES = [
  ['inventory_api/api-map.json', 'senseInventoryApi', 'api-map.schema.json'],
  ['inventory_routes/routes-angular.json', 'senseInventoryRoutes', 'routes-inventory.schema.json'],
  [
    'inventory_data_model/data-model.json',
    'senseInventoryDataModel',
    'data-model-inventory.schema.json',
  ],
  [
    'inventory_data_handling/data-model-pii.json',
    'senseInventoryDataHandling',
    'data-model-inventory.schema.json',
  ],
  ['inventory_rbac/rbac.json', 'senseInventoryRbac', 'rbac-inventory.schema.json'],
  ['inventory_dep_graph/dep-graph.json', 'senseInventoryDepGraph', 'dep-graph.schema.json'],
  [
    'inventory_coverage/coverage-matrix.json',
    'senseInventoryCoverage',
    'coverage-matrix.schema.json',
  ],
] as const;

type Source = Pick<ReconciliationPlan, 'source_manifest' | 'source_manifest_sha256' | 'selection'>;

/** Fixed canonical bytes can be regenerated before approval and must be read back after custody. */
export function reconciliationCustodyManifest(source: Source): string {
  const namespace = `record/proofs/reconciliation/${source.source_manifest_sha256}`;
  return canonicalBytes({
    schemaVersion: '1.0.0',
    kind: 'reconciliation-custody',
    source_manifest_sha256: source.source_manifest_sha256,
    files: source.source_manifest.files.map((file) => ({
      ...file,
      object_path: `${namespace}/objects/${file.sha256}`,
    })),
  });
}

/** Freeze every domain target and publication method before any Owner grant. */
export function createReconciliationEffectPlan(source: Source) {
  const manifest = source.source_manifest;
  if (sha(canonicalJson(manifest)) !== source.source_manifest_sha256)
    throw new Error('RECONCILIATION_PLAN_INVALID');
  const namespace = `record/proofs/reconciliation/${source.source_manifest_sha256}`;
  const diagnosticRoot = `.devai/state/reconciliation/${source.source_manifest_sha256}/inventory`;
  const unique = new Map<string, number>();
  for (const file of manifest.files) {
    const previous = unique.get(file.sha256);
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > BLOB_LIMIT ||
      (previous !== undefined && previous !== file.bytes)
    )
      throw new Error('RECONCILIATION_PLAN_LIMIT');
    unique.set(file.sha256, file.bytes);
  }
  const total = [...unique.values()].reduce((a, b) => a + b, 0);
  if (unique.size > ENTRY_LIMIT || total > TOTAL_LIMIT)
    throw new Error('RECONCILIATION_PLAN_LIMIT');
  const custody = reconciliationCustodyManifest(source);
  if (Buffer.byteLength(custody) > BLOB_LIMIT) throw new Error('RECONCILIATION_PLAN_LIMIT');
  const selected = manifest.files.find(
    (file) =>
      file.commit === source.selection.parent && file.path === CHAIN && file.kind === 'chain',
  );
  if (!selected) throw new Error('RECONCILIATION_PLAN_SOURCE_INVALID');
  // The index codec uses this exact key order and Git entry order. Filtering keeps that order.
  const sourceEntries = manifest.index.entries
    .filter((entry) => entry.stage === 0 && entry.path !== CHAIN && entry.path !== CATALOGUE)
    .map((entry) => ({
      assume_valid: entry.assume_valid,
      mode: entry.mode,
      oid: entry.oid,
      path: entry.path,
      stage: entry.stage,
    }));
  return {
    schemaVersion: '1.0.0' as const,
    kind: 'reconciliation-effect-plan' as const,
    namespace,
    publication_contract: {
      directory_mode: '0700' as const,
      directory_creation: 'one-level-exclusive-no-symlink-no-existing-chmod' as const,
      directory_durability: 'fsync-created-directory-and-parent' as const,
      file_mode: '0600-before-first-byte' as const,
      scratch_name: '.<exact-target-basename>.<actual-pid>-<uuid-v4>.publish-staged' as const,
      scratch_count_per_target: 1 as const,
      scratch_bytes_limit: BLOB_LIMIT,
      scratch_preparation:
        'owner-preview-or-authenticated-live-lease-derived-name-before-create' as const,
      file_publication:
        'exclusive-scratch-write-fsync-link-no-replace-unlink-scratch-fsync-parent' as const,
      existing_target: 'exact-complete-bytes-and-approved-custody-or-refuse' as const,
      cleanup: 'owned-dev-ino-birthtime-only-preserve-foreign-or-uncertain' as const,
      partial_failure: 'indeterminate-no-new-domain-effect' as const,
    },
    phase_scratch_derivation: {
      domain: 'devai.reconciliation.phase-scratch.v1' as const,
      hash: 'sha256-jcs-utf8-object-domain-lease_sha256-target-purpose' as const,
      lease_sha256: 'sha256-exact-authenticated-lease-record-bytes' as const,
      uuid: 'first16-digest-bytes-set-byte6-high-nibble4-byte8-high-bits10-lowercase-rfc4122' as const,
      pid: 'authenticated-live-lease-pid-equals-actual-process-pid' as const,
      purpose: 'publication' as const,
      target: 'exact-recipe-file-target-only' as const,
      old_attempt_cleanup:
        'requires-authenticated-owned-dev-ino-birthtime-otherwise-preserve-refuse' as const,
      output_plan: 'domain-output-paths-bytes-and-digests-independent-of-attempt-scratch' as const,
    },
    settlement_scratch_derivation: {
      domain: 'devai.reconciliation.settlement-scratch.v1' as const,
      hash: 'sha256-jcs-utf8-object-domain-completion_sha256-target-purpose' as const,
      completion_sha256: 'sha256-exact-native-signed-completion-record-bytes' as const,
      uuid: 'first16-digest-bytes-set-byte6-high-nibble4-byte8-high-bits10-lowercase-rfc4122' as const,
      pid: 'actual-process-pid' as const,
      purpose: 'private-completion-publication' as const,
      target: 'exact-private-phase-completion-file-only' as const,
      domain_output_creation: false as const,
    },
    removal_contract: {
      target: 'exact-authenticated-owned-lease-or-normal-append-lock-only' as const,
      quarantine_name:
        '.<exact-target-basename>.<actual-pid>-<fresh-uuid-v4>.remove-quarantine' as const,
      quarantine_count: 1 as const,
      nonce_policy: 'fresh-native-unexposed-until-rename-not-prepared-or-caller-selected' as const,
      operations:
        'identity-precheck-rename-recheck-owned-unlink-or-no-replace-restore-fsync-parent' as const,
      collision_bound: 'cryptographic-freshness-not-atomic-no-replace-destination' as const,
      unknown_or_crashed_quarantine:
        'preserve-and-report-indeterminate-no-automatic-resume-or-prune' as const,
    },
    private_state: {
      resolver: 'trusted-worktree-host-only' as const,
      approval_directory: 'approvals/<approval_id>' as const,
      immutable_files: [
        'approval.json',
        'grant-<six-digit-sequence>.json',
        'intent-<phase>.json',
        'phase-<phase>.json',
      ],
      lease_file: 'lease.json' as const,
      mode: '0600' as const,
      max_record_bytes: 1048576,
      max_records: 4096,
      publication: 'exclusive-no-replace-owned-identity' as const,
      directories: ['approvals', 'approvals/<approval_id>'] as const,
      lease_lifecycle: 'exclusive-create-identity-guarded-remove-no-age-takeover' as const,
    },
    custody: {
      phase: '01' as const,
      publication: 'exclusive-no-replace-owned-identity' as const,
      object_count_limit: ENTRY_LIMIT,
      object_bytes_limit: BLOB_LIMIT,
      aggregate_bytes_limit: TOTAL_LIMIT,
      objects: [...unique]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([digest, bytes]) => ({
          path: `${namespace}/objects/${digest}`,
          sha256: digest,
          bytes,
        })),
      manifest: {
        path: `${namespace}/custody.json`,
        sha256: sha(custody),
        bytes: Buffer.byteLength(custody),
      },
      overwrite: false as const,
      directories: ['record/proofs/reconciliation', namespace, `${namespace}/objects`],
    },
    selection: {
      phase: '02' as const,
      selected_parent: source.selection.parent,
      selected_chain_sha256: selected.sha256,
      selected_object_path: `${namespace}/objects/${selected.sha256}`,
      active_path: CHAIN,
      append_lock_path: `${CHAIN}.append.lock`,
      candidate_path: `${CHAIN}.reconciliation.tmp`,
      receipt_path: `${namespace}/selection.json`,
      record_construction: 'shared-normal-evidence-record-kernel-v1' as const,
      event_action: 'evidence.reconcile.canonical-selection' as const,
      hashed_artifacts: [
        'custody-manifest',
        'selected-original-chain',
        'selection-receipt',
      ] as const,
      publication: 'complete-candidate-atomic-replace-under-normal-append-lock' as const,
      candidate_bytes_limit: BLOB_LIMIT,
      receipt_bytes_limit: 1048576,
      intent_freezes: [
        'receipt-sha256-and-bytes',
        'event-and-final-chain-sha256-and-bytes',
        'before-chain-sha256-and-identity',
      ] as const,
      stale_lock_takeover: false as const,
      candidate_publication:
        'exclusive-0600-write-fsync-revalidate-before-chain-rename-fsync-parent' as const,
      append_lock_record: 'normal-evidence-chain-append-path-pid-nonce' as const,
      append_lock_cleanup: 'owned-dev-ino-birthtime-only' as const,
    },
    recovery: {
      separate_events: true as const,
      current_expected_head_each: true as const,
      obligations: manifest.recovery_obligations.map((item) => ({
        ...item,
        source_chain_path:
          item.source_chain_sha256 === null
            ? null
            : `${namespace}/objects/${item.source_chain_sha256}`,
        command:
          item.mode === 'divergent'
            ? ('evidence record --recover-divergent-anchor' as const)
            : ('evidence record --recover-newest-line' as const),
      })),
    },
    proof_index: {
      phase: '03' as const,
      proof_path: CHAIN,
      operation: 'chain-cas' as const,
      before_index_sha256: manifest.index.raw_sha256,
      unchanged_other_entries_sha256: manifest.index.other_entries_sha256,
      lock: 'trusted-worktree-index.lock' as const,
      object_publication: 'trusted-common-objects-content-addressed-verified-blob' as const,
      intent_freezes: [
        'verified-final-chain-sha256-and-bytes',
        'blob-oid-and-loose-object-bytes',
        'after-index-sha256-and-bytes',
      ] as const,
      other_entry_changes: false as const,
      index_publication:
        'exclusive-index.lock-write-fsync-revalidate-rename-index-fsync-parent' as const,
      index_mode: 'preserve-before-index-mode' as const,
      object_format: manifest.index.object_format,
      object_path: 'trusted-common-dir/objects/<oid[0:2]>/<oid[2:]>' as const,
      object_directory: 'trusted-common-dir/objects/<oid[0:2]>' as const,
      object_scratch:
        'trusted-common-dir/objects/<oid[0:2]>/.<oid[2:]>.reconciliation.tmp' as const,
      object_scratch_count: 1 as const,
      object_bytes_limit: BLOB_LIMIT + 65536,
      object_publication_steps:
        'exclusive-0600-scratch-write-fsync-verify-object-chmod0444-link-no-replace-owned-unlink-fsync-shard' as const,
      object_existing: 'inflate-type-size-and-full-oid-verify-or-refuse' as const,
    },
    inventory: {
      phase: '04' as const,
      source_projection:
        'sha256-json-utf8-index-entry-keys-assume_valid-mode-oid-path-stage-in-git-order-v1' as const,
      excluded_paths: [CHAIN, CATALOGUE] as const,
      stage: 0 as const,
      source_sha256: sha(JSON.stringify(sourceEntries)),
      unchanged_other_entries_sha256: manifest.index.other_entries_sha256,
      publication: 'exclusive-no-replace-owned-identity' as const,
      output_count: 7 as const,
      body_bytes_limit: BODY_LIMIT,
      aggregate_bytes_limit: BODY_TOTAL_LIMIT,
      routes_framework: 'angular' as const,
      outputs: BODIES.map(([path, producer, schema]) => ({
        path: `${diagnosticRoot}/${path}`,
        producer,
        schema,
      })),
      intent_freezes: [
        'all-seven-body-sha256-and-bytes',
        'actual-stage0-source-projection',
      ] as const,
      grants_readiness: false as const,
      publishes_readings: false as const,
      publishes_canonical_pointer: false as const,
      directories: [
        '.devai/state',
        '.devai/state/reconciliation',
        `.devai/state/reconciliation/${source.source_manifest_sha256}`,
        diagnosticRoot,
        ...BODIES.map(([path]) => `${diagnosticRoot}/${path.split('/')[0]}`),
      ],
    },
  };
}

export type ReconciliationEffectPlan = ReturnType<typeof createReconciliationEffectPlan>;
