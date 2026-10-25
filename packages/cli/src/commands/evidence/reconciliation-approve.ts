import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CAC } from 'cac';
import {
  createReconciliationApprovalReview,
  createReconciliationGrantReview,
  createReconciliationDeadLeaseReview,
  type ReconciliationApprovalReview,
  type ReconciliationGrantReview,
  type ReconciliationDeadLeaseReview,
} from '@devai-nyx/authority/reconciliation-native';
import { defineCommand } from '../../define-command.js';
import { cliError, renderCliError } from '../../cli-error.js';
import { requireReconciliationOwnerOutput } from '../../reconciliation-owner-output.js';
type Review =
  ReconciliationApprovalReview | ReconciliationGrantReview | ReconciliationDeadLeaseReview;
interface Options {
  repoRoot?: string;
  renew?: boolean;
  revoke?: boolean;
  recoverOwnedLease?: boolean;
}
function confirmation(): Promise<string | undefined> {
  const terminal = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', cancel);
      terminal.removeListener('SIGINT', cancel);
    };
    const cancel = () => {
      cleanup();
      resolve(undefined);
      terminal.close();
    };
    const timeout = setTimeout(cancel, 300000);
    process.once('SIGINT', cancel);
    terminal.once('SIGINT', cancel);
    terminal.once('line', (line) => {
      cleanup();
      resolve(line);
      terminal.close();
    });
    terminal.once('close', () => {
      cleanup();
      resolve(undefined);
    });
    terminal.once('error', (error) => {
      cleanup();
      reject(error);
      terminal.close();
    });
  });
}
export const evidenceReconcileApprove = defineCommand({
  name: 'evidence reconcile approve',
  description: 'Review one exact Owner reconciliation grant or recovery operation.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-reconcile-approve', 'Review exact Owner reconciliation authority')
      .option('--repo-root <path>', 'Canonical repository root (required)')
      .option('--plan <path>', 'Saved repository-relative canonical plan (required)')
      .option('--plan-sha256 <sha256>', 'Exact saved-plan bytes digest (required)')
      .option('--as-role <role>', 'Direct human initiation: owner (required)')
      .option('--write', 'Explicit write consent (required)')
      .option('--approval <sha256>', 'Existing approval id for a lifecycle mode')
      .option('--renew', 'Renew the same scope')
      .option('--revoke', 'Revoke the same scope')
      .option(
        '--recover-owned-lease',
        'Recover one authenticated lease after actual exited-process observation',
      )
      .option('--expected-grant-sha256 <sha256>', 'Exact current grant for renew/revoke')
      .option('--expected-lease-sha256 <sha256>', 'Exact lease digest or ABSENT for recovery')
      .action(async (options: Options) => {
        let review: Review | undefined,
          output: ReturnType<typeof requireReconciliationOwnerOutput> | undefined;
        try {
          if (!options.repoRoot) throw new Error('RECONCILIATION_APPROVAL_INVALID');
          output = requireReconciliationOwnerOutput();
          const root = realpathSync(options.repoRoot);
          review = options.recoverOwnedLease
            ? createReconciliationDeadLeaseReview(root)
            : options.renew || options.revoke
              ? createReconciliationGrantReview(root)
              : createReconciliationApprovalReview(root);
          const preview = review.preview();
          await output.ready(preview);
          const token = await confirmation();
          const result =
            token === preview.confirmation ? review.confirm(token) : review.interrupt();
          output.finishOwnerReconciliation(result);
          review = undefined;
          process.exitCode = result.outcome === 'indeterminate' ? 6 : 0;
        } catch (error) {
          if (review) {
            const custody = review.interrupt();
            if (custody.outcome === 'indeterminate' && output) {
              output.finishOwnerReconciliation(custody);
              process.exitCode = 6;
              return;
            }
          }
          const candidate = error instanceof Error ? error.message.split(':')[0] : undefined,
            code =
              candidate?.startsWith('RECONCILIATION_') || candidate?.startsWith('AUTHORITY_')
                ? candidate
                : 'RECONCILIATION_APPROVAL_INVALID';
          const refusal = cliError({
            code,
            class: 'precondition',
            exit: 5,
            message: code,
            remediation:
              'Inspect the exact saved plan, native bindings and current Owner state, then begin a fresh review.',
          });
          if (output) output.refuse(refusal);
          else process.stderr.write(renderCliError(refusal, true));
          process.exitCode = 5;
        }
      });
  },
});
