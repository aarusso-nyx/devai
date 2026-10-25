import { requireAuthorityPolicyReviewOutput } from '../../action-output.js';
import { createInterface } from 'node:readline';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import type { AuthorityPolicyReview } from '../../authority/policy-review.js';
import { cliError, renderCliError } from '../../cli-error.js';
import type { InitBindOptions } from './shared.js';

export async function reviewAuthorityPolicy(options: InitBindOptions): Promise<void> {
  let handle: AuthorityPolicyReview | undefined;
  let output: ReturnType<typeof requireAuthorityPolicyReviewOutput> | undefined;
  try {
    if (
      options.reviewAuthorityPolicy !== true ||
      options.reconciliationHost === true ||
      options.afterConstitution !== true ||
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
      options.tier !== undefined
    )
      throw new Error('AUTHORITY_POLICY_REVIEW_SELECTION_INVALID');
    if (
      process.stdin.isTTY !== true ||
      process.stderr.isTTY !== true ||
      process.stdout.isTTY !== true
    )
      throw new Error('AUTHORITY_POLICY_REVIEW_TERMINAL_REQUIRED');
    output = requireAuthorityPolicyReviewOutput();
    handle = executeAuthorityPolicyMaterialization() as AuthorityPolicyReview;
    const ready = handle.start();
    output.ready(ready);
    output.prompt(
      `Type CREATE ${String(ready['plan_sha256'])} ${String((ready['artifact'] as Record<string, unknown>)['sha256'])} to create the reviewed policy; EOF cancels.\n`,
    );
    const terminal = createInterface({ input: process.stdin, terminal: false });
    const confirmation = await new Promise<string | undefined>((resolve, reject) => {
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
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('AUTHORITY_POLICY_REVIEW_EXPIRED'));
        terminal.close();
      }, 300_000);
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
    const result = confirmation === undefined ? handle.cancel() : handle.confirm(confirmation);
    handle = undefined;
    output.complete(result as Readonly<Record<string, unknown>>);
    process.exitCode = 0;
  } catch (error) {
    try {
      handle?.cancel();
    } catch {
      /* Already consumed; no cleanup effects. */
    }
    // Capture the trusted publisher's post-link ownership BEFORE the ordinary
    // authority boundary can normalize this exceptional outcome as a refusal.
    if (output !== undefined && output.publicationFailure(error)) {
      process.exitCode = 6;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = message.split(':')[0] ?? message;
    if (!code.startsWith('AUTHORITY_POLICY_REVIEW_')) throw error;
    const refusal = cliError({
      code,
      class: 'routing-authority',
      exit: 2,
      message,
      remediation: 'Review the exact admitted inputs and start a fresh invocation.',
    });
    if (output !== undefined) output.refuse(refusal);
    else process.stdout.write(renderCliError(refusal, true));
    process.exitCode = 2;
  }
}
