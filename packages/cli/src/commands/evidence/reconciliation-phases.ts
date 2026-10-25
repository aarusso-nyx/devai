import { realpathSync } from 'node:fs';
import type { CAC } from 'cac';
import {
  requireReconciliationPhaseOutput,
  refuseReconciliationPhaseOutput,
} from '../../reconciliation-phase-output.js';
import {
  materializeReconciliationCustody,
  materializeReconciliationSelection,
  stageReconciliationProof,
  type ReconciliationCustodyResult,
} from '@devai-nyx/authority/reconciliation-native';
import { defineCommand } from '../../define-command.js';
import { cliError, renderCliError } from '../../cli-error.js';
function options(command: ReturnType<CAC['command']>): ReturnType<CAC['command']> {
  return command
    .option('--repo-root <path>', 'Canonical repository root (required)')
    .option('--plan <path>', 'Saved canonical plan path (required)')
    .option('--plan-sha256 <sha256>', 'Exact saved plan digest (required)')
    .option('--approval <sha256>', 'Exact Owner approval id (required)')
    .option('--as-role <role>', 'Inspector initiation (required)')
    .option('--write', 'Explicit write consent (required)');
}
export function emitReconciliationRefusal(error: unknown, custody?: unknown): void {
  const candidate = error instanceof Error ? error.message.split(':')[0] : undefined,
    code =
      candidate?.startsWith('RECONCILIATION_') ||
      candidate?.startsWith('AUTHORITY_') ||
      candidate?.startsWith('PROOF_INDEX_')
        ? candidate
        : 'RECONCILIATION_PHASE_HELD';
  const refusal = cliError({
    code,
    class: custody ? 'infrastructure' : 'precondition',
    exit: custody ? 6 : 5,
    message: code,
    remediation:
      'Inspect the exact phase receipts and preserved owned entries before retrying; retain all historical evidence.',
    ...(custody ? { context: { reconciliation: custody } } : {}),
  });
  if (!refuseReconciliationPhaseOutput(refusal))
    process.stderr.write(renderCliError(refusal, true));
  process.exitCode = custody ? 6 : 5;
}
export const evidenceReconcileMaterialize = defineCommand({
  name: 'evidence reconcile materialize',
  description: 'Preserve source histories and select the complete approved canonical parent.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    options(
      cli.command(
        'evidence-reconcile-materialize',
        'Preserve custody and select the canonical proof chain',
      ),
    ).action((input: { repoRoot?: string }) => {
      let custody: ReconciliationCustodyResult | undefined,
        output: ReturnType<typeof requireReconciliationPhaseOutput> | undefined;
      try {
        output = requireReconciliationPhaseOutput();
        if (!input.repoRoot) throw new Error('RECONCILIATION_PHASE_HELD');
        const root = realpathSync(input.repoRoot);
        custody = materializeReconciliationCustody(root);
        const selection =
            custody.outcome === 'indeterminate' ? null : materializeReconciliationSelection(root),
          result = {
            kind: 'reconciliation-materialize-result',
            outcome:
              !selection || selection.outcome === 'indeterminate'
                ? 'indeterminate'
                : custody.outcome === 'existing' && selection.outcome === 'existing'
                  ? 'existing'
                  : 'completed',
            approval_id: custody.approval_id,
            plan_sha256: custody.plan_sha256,
            custody,
            selection,
            grants_authority: false,
          };
        output.finishReconciliationPhase(result);
        process.exitCode = 0;
      } catch (error) {
        if (custody && output) {
          // Phase 01 may already own outputs even if selection never returns.
          try {
            output.finishReconciliationPhase({
              kind: 'reconciliation-materialize-result',
              outcome: 'indeterminate',
              approval_id: custody.approval_id,
              plan_sha256: custody.plan_sha256,
              custody,
              selection: null,
              grants_authority: false,
            });
          } catch {
            /* A prior terminal capture remains authoritative for diagnostics. */
          }
        }
        emitReconciliationRefusal(error, custody);
      }
    });
  },
});
export const evidenceReconcileStageProof = defineCommand({
  name: 'evidence reconcile stage-proof',
  description: 'Stage exactly the recovered proof-chain entry under the real Git index lock.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    options(
      cli.command('evidence-reconcile-stage-proof', 'Stage the exact canonical proof-chain entry'),
    ).action((input: { repoRoot?: string }) => {
      try {
        const output = requireReconciliationPhaseOutput();
        if (!input.repoRoot) throw new Error('RECONCILIATION_PHASE_HELD');
        const result = stageReconciliationProof(realpathSync(input.repoRoot));
        output.finishReconciliationPhase(result);
        process.exitCode = 0;
      } catch (error) {
        emitReconciliationRefusal(error);
      }
    });
  },
});
