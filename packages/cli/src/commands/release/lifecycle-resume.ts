import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import {
  ReleaseLifecycleFileStore,
  resumeReleaseLifecycleExecution,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
} from '../../services/release-lifecycle-execution.js';
import { resolvePolicyFor, commandAdapters } from './lifecycle-adapters.js';
import {
  fail,
  readPinnedJson,
  inputFailureCode,
  localResolvers,
  type ResumeOptions,
} from './lifecycle-inputs.js';

export const releaseResume = defineCommand({
  name: 'release resume',
  description: 'Observe and reconcile the release lifecycle without executing the next action.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-resume', 'Emit a pure release lifecycle observation')
      .option(
        '--request <path>',
        'Exact release resume request (required for an empty state chain)',
      )
      .option('--repo-root <path>', 'Repository root containing bound receipt inputs')
      .option('--state-root <path>', 'Protected append-only release state root')
      .option('--state-chain <path>', 'JSON array containing the persisted state chain')
      .option(
        '--store-records <path>',
        'Optional JSON array containing append-only execution records',
      )
      .option('--store-head <path>', 'Optional canonical v2 store head')
      .option('--receipts <path>', 'Optional JSON array of plan/offline receipt documents')
      .option('--publication-receipt <path>', 'Signed external publication receipt')
      .option('--human', 'Human-readable output')
      .action(async (options: ResumeOptions) => {
        if (options.stateChain === undefined && options.request === undefined) {
          fail(
            'release resume',
            'RELEASE_RESUME_USAGE',
            '--state-chain or --request is required',
            EXIT_USAGE,
          );
          return;
        }
        try {
          const request =
            options.request === undefined
              ? undefined
              : validateReleaseLifecycleRequest(readPinnedJson(options.request), 'release resume');
          const root = resolve(options.repoRoot ?? process.cwd());
          const useBuiltInStore =
            request !== undefined &&
            options.stateChain === undefined &&
            options.storeRecords === undefined &&
            options.storeHead === undefined;
          const store =
            useBuiltInStore && request !== undefined
              ? new ReleaseLifecycleFileStore(
                  resolve(options.stateRoot ?? join(root, '.devai/state/release-lifecycle')),
                  request,
                )
              : undefined;
          const states =
            store === undefined
              ? options.stateChain === undefined
                ? []
                : readPinnedJson(options.stateChain)
              : store.readStateRecords();
          if (!Array.isArray(states)) throw new Error('state chain must be a JSON array');
          const first = states.length === 0 ? undefined : verifyReleaseStateIdentity(states[0]);
          if (first === undefined && request === undefined) {
            throw new Error('an empty state chain requires an exact release resume request');
          }
          const repository = request?.repository_locator ?? first?.repository;
          const firstUnit = request?.candidate_locator.release_units[0];
          const requestedCandidate =
            request === undefined || firstUnit === undefined
              ? undefined
              : {
                  release_unit: firstUnit.release_unit,
                  version: firstUnit.version,
                  commit: request.candidate_locator.commit,
                  tree: request.candidate_locator.tree,
                };
          const candidate = requestedCandidate ?? first?.candidate;
          if (repository === undefined || candidate === undefined) {
            throw new Error('release resume identity is unavailable');
          }
          const storeRecords =
            store === undefined
              ? options.storeRecords === undefined
                ? []
                : readPinnedJson(options.storeRecords)
              : store.readStoreRecords();
          if (!Array.isArray(storeRecords)) throw new Error('store records must be a JSON array');
          const receipts = options.receipts === undefined ? [] : readPinnedJson(options.receipts);
          if (!Array.isArray(receipts)) throw new Error('receipts must be a JSON array');
          const currentPlan = receipts.some(
            (receipt: unknown) =>
              receipt !== null &&
              typeof receipt === 'object' &&
              'receipt_kind' in receipt &&
              receipt.receipt_kind === 'release-plan-receipt' &&
              'schemaVersion' in receipt &&
              receipt.schemaVersion === '2.0.0',
          );
          const resolvers = localResolvers(
            root,
            currentPlan
              ? (
                  request?.candidate_locator.release_units ??
                  first?.release_units ?? [candidate]
                ).map((unit) =>
                  resolvePolicyFor({
                    repository_id: repository.id,
                    candidate: { commit: candidate.commit, tree: candidate.tree },
                    release_unit: unit.release_unit,
                  }),
                )
              : undefined,
          );
          const observation = await resumeReleaseLifecycleExecution({
            states,
            store_records: storeRecords,
            ...(store === undefined
              ? options.storeHead === undefined
                ? {}
                : { store_head: readPinnedJson(options.storeHead) }
              : { store_head: store.readHead() }),
            repository,
            candidate,
            ...(request === undefined ? {} : { candidate_locator: request.candidate_locator }),
            receipt_documents: receipts,
            resolve_plan_input: resolvers.plan,
            ...(request === undefined
              ? {}
              : {
                  offline_receipt_verifier: commandAdapters?.offline_receipt_verifier(request),
                }),
            ...(options.publicationReceipt === undefined
              ? {}
              : {
                  publication_receipt: readPinnedJson(options.publicationReceipt),
                  // Only trusted host code supplies verification against external
                  // trust. Receipt bytes and CLI locators never choose a verifier.
                  verify_signature:
                    (request === undefined
                      ? undefined
                      : commandAdapters?.publication_signature_verifier?.(request)) ??
                    (() => false),
                }),
          });
          process.stdout.write(
            options.human === true
              ? `release resume: ${String(observation['observation_id'])} -> ${String(observation['next_outcome'])}\n`
              : `${JSON.stringify(observation)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          fail(
            'release resume',
            'RELEASE_RESUME_FAILED',
            inputFailureCode(error, 'release-request-projection-invalid'),
            EXIT_REVIEW,
          );
        }
      });
  },
});
