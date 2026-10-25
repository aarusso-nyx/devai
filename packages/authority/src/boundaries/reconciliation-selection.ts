import { canonicalJson, buildEvidenceRecord } from '@devai-nyx/utils';
import { validators } from '@devai-nyx/schemas';
import {
  validateReconciliationClockObservation,
  type ReconciliationClockObservation,
} from '../runtime/reconciliation-clock.js';
import type { ReconciliationOwnerState } from '../runtime/reconciliation-owner-state.js';
import { parseReconciliationChain, type ReconciliationPlan } from './reconciliation-plan.js';
import { createReconciliationEffectPlan } from './reconciliation-effect-plan.js';
import { provisionBytesSha, provisionSha } from './reconciliation-host-namespace.js';

/** Pure candidate construction. No filesystem, signing, invocation or effect authority. */
export function buildReconciliationSelection(
  plan: ReconciliationPlan,
  state: ReconciliationOwnerState,
  clock: ReconciliationClockObservation,
  nonce: string,
  repositoryRoot: string,
  selectedOriginalBytes: Uint8Array,
) {
  const fail = (): never => {
    throw new Error('RECONCILIATION_SELECTION_INVALID');
  };
  const recipe = plan.effect_plan.selection;
  if (
    !/^[a-f0-9]{64}$/u.test(nonce) ||
    repositoryRoot.length === 0 ||
    provisionSha(plan.source_manifest) !== plan.source_manifest_sha256 ||
    provisionSha(plan.effect_plan) !== plan.effect_plan_sha256 ||
    provisionSha(createReconciliationEffectPlan(plan)) !== plan.effect_plan_sha256 ||
    provisionBytesSha(Buffer.from(`${canonicalJson(plan)}\n`)) !== state.plan_sha256 ||
    state.binding_sha256 !== plan.binding_sha256 ||
    state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
    state.repository_id !== plan.identity.repository_id ||
    state.worktree_id !== plan.identity.worktree_id ||
    state.host_identity_sha256 !== plan.identity.host_identity_sha256 ||
    provisionBytesSha(selectedOriginalBytes) !== recipe.selected_chain_sha256 ||
    selectedOriginalBytes.byteLength > recipe.candidate_bytes_limit
  )
    fail();
  const selected = parseReconciliationChain(selectedOriginalBytes);
  const receipt = {
    schemaVersion: '1.0.0',
    kind: 'reconciliation-selection',
    plan_sha256: state.plan_sha256,
    source_manifest_sha256: plan.source_manifest_sha256,
    effect_plan_sha256: plan.effect_plan_sha256,
    binding_sha256: plan.binding_sha256,
    approval_id: state.approval_id,
    approval_sha256: state.approval_sha256,
    scope_sha256: state.scope_sha256,
    identity: plan.identity,
    selected_parent: recipe.selected_parent,
    selected_chain_sha256: recipe.selected_chain_sha256,
    selected_chain_records: selected.records.length,
    selected_chain_head: selected.head,
    custody_manifest: plan.effect_plan.custody.manifest,
    clock: validateReconciliationClockObservation(clock),
    nonce,
    grants_authority: false,
  } as const;
  const receiptText = `${canonicalJson(receipt)}\n`;
  const receiptSha = provisionBytesSha(Buffer.from(receiptText));
  const event = buildEvidenceRecord(
    {
      id: `EV-${receiptSha.slice(0, 16)}`,
      timestamp: new Date(clock.wall_ms).toISOString(),
      actor: 'devai.evidence-reconciliation',
      actor_role: 'human:inspector',
      action: recipe.event_action,
      status: 'completed',
      context: {
        repo_root: repositoryRoot,
        git: { head_sha: plan.identity.head, dirty_files: [recipe.active_path] },
      },
      artifacts: [
        {
          path: plan.effect_plan.custody.manifest.path,
          sha256: plan.effect_plan.custody.manifest.sha256,
          kind: 'reconciliation-custody',
        },
        {
          path: recipe.selected_object_path,
          sha256: recipe.selected_chain_sha256,
          kind: 'selected-original-chain',
        },
        { path: recipe.receipt_path, sha256: receiptSha, kind: 'reconciliation-selection' },
      ],
    },
    selected.head,
    selected.records.length + 1,
  );
  if (!validators.evidence(event)) fail();
  // Keep the complete parent prefix and its top-level key order. No rehashing,
  // renumbering, normalization or synthetic recovery of historical entries.
  const candidate = { ...selected, records: [...selected.records, event] };
  candidate.head = event.manifest_hash;
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  const outputs = [
    { path: recipe.receipt_path, sha256: receiptSha, bytes: Buffer.byteLength(receiptText) },
    {
      path: recipe.active_path,
      sha256: provisionBytesSha(Buffer.from(candidateText)),
      bytes: Buffer.byteLength(candidateText),
    },
  ];
  const receiptOutput = outputs[0],
    candidateOutput = outputs[1];
  if (
    !receiptOutput ||
    !candidateOutput ||
    receiptOutput.bytes > recipe.receipt_bytes_limit ||
    candidateOutput.bytes > recipe.candidate_bytes_limit
  )
    fail();
  parseReconciliationChain(Buffer.from(candidateText));
  return Object.freeze({
    receipt_text: receiptText,
    candidate_text: candidateText,
    event,
    outputs: Object.freeze(outputs.map((output) => Object.freeze(output))),
    outputs_manifest_sha256: provisionSha({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-domain-outputs',
      phase: '02',
      outputs,
    }),
    grants_authority: false,
  });
}
