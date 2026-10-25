import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  createReconciliationHostProvisionReview,
  interruptReconciliationHostProvisionReview,
  type ReconciliationHostProvisionReview,
} from '@devai-nyx/authority';
import { requireReconciliationProvisionOutput } from '../../reconciliation-provision-output.js';
import { cliError, renderCliError } from '../../cli-error.js';
import type { InitBindOptions } from './shared.js';

function confirmation(): Promise<string | undefined> {
  const terminal = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', cancel);
      terminal.removeListener('SIGINT', cancel);
    };
    const cancel = (): void => {
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

/** Only native branded handles can provision; output projections are never executable. */
export async function bindReconciliationHost(options: InitBindOptions): Promise<void> {
  let handle: ReconciliationHostProvisionReview | undefined;
  let output: ReturnType<typeof requireReconciliationProvisionOutput> | undefined;
  try {
    if (
      options.reconciliationHost !== true ||
      options.write !== true ||
      options.target === undefined ||
      options.human === true ||
      options.full === true ||
      options.constitution === true ||
      options.operationalLaw === true ||
      options.subprocessEffects === true ||
      options.adopterPolicy !== undefined ||
      options.hostAdapter !== undefined ||
      options.trackingAdapter !== undefined ||
      options.trackingRepository !== undefined ||
      options.tier !== undefined ||
      options.reviewAuthorityPolicy === true ||
      options.afterConstitution === true
    )
      throw new Error('RECONCILIATION_PROVISION_REVIEW_INVALID');
    if (
      process.stdin.isTTY !== true ||
      process.stdout.isTTY !== true ||
      process.stderr.isTTY !== true
    )
      throw new Error('RECONCILIATION_PROVISION_REVIEW_INVALID');
    output = requireReconciliationProvisionOutput();
    handle = createReconciliationHostProvisionReview(realpathSync(options.target));
    let projection = handle.start();
    while (projection.kind === 'reconciliation-provision-review') {
      await output.ready(projection);
      const line = await confirmation();
      projection =
        line === projection.confirmation
          ? handle.confirm(line)
          : interruptReconciliationHostProvisionReview(handle);
    }
    output.complete(projection);
    handle = undefined;
    process.exitCode = projection.outcome === 'indeterminate' ? 6 : 0;
  } catch (error) {
    if (handle !== undefined) {
      const custody = interruptReconciliationHostProvisionReview(handle);
      if (custody.outcome === 'indeterminate' && output !== undefined) {
        output.complete(custody);
        process.exitCode = 6;
        return;
      }
    }
    const candidate = error instanceof Error ? error.message.split(':')[0] : undefined;
    const code =
      candidate?.startsWith('RECONCILIATION_') || candidate?.startsWith('AUTHORITY_')
        ? candidate
        : 'RECONCILIATION_PROVISION_REVIEW_INVALID';
    const refusal = cliError({
      code,
      class: 'routing-authority',
      exit: 2,
      message: code,
      remediation:
        'Inspect the exact native host and bindings, then start a fresh provisioning review.',
    });
    if (output) output.refuse(refusal);
    else process.stderr.write(renderCliError(refusal, true));
    process.exitCode = 2;
  }
}
