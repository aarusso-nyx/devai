import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand, type CommandDefinition } from '../../define-command.js';
import {
  resumeReleaseLifecycleExecution,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
} from '../../services/release-lifecycle-execution.js';
import { buildReleasePlanReceipt } from '../../services/release-lifecycle.js';

interface PlanOptions {
  readonly repoRoot?: string;
  readonly intent?: string;
  readonly repository?: string;
  readonly human?: boolean;
}

interface ResumeOptions {
  readonly request?: string;
  readonly stateChain?: string;
  readonly storeRecords?: string;
  readonly storeHead?: string;
  readonly receipts?: string;
  readonly publicationReceipt?: string;
  readonly human?: boolean;
}

interface ActionOptions {
  readonly request?: string;
  readonly human?: boolean;
}

interface OfflineVerifyOptions {
  readonly request?: string;
  readonly exportedState?: string;
  readonly human?: boolean;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function fail(action: string, code: string, detail: string, exit = EXIT_FAIL): void {
  process.stderr.write(`devai ${action}: ${code}: ${detail}\n`);
  process.exitCode = exit;
}

export const releasePlan = defineCommand({
  name: 'release plan',
  description: 'Resolve the deterministic nine-action release plan and emit its receipt.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-plan', 'Emit a deterministic release plan receipt')
      .option('--repo-root <path>', 'Repository root containing the bound policies')
      .option('--intent <path>', 'Release intent JSON (required)')
      .option('--repository <id>', 'Exact repository identity (required)')
      .option('--human', 'Human-readable output')
      .action((options: PlanOptions) => {
        if (options.intent === undefined || options.repository === undefined) {
          fail(
            'release plan',
            'RELEASE_PLAN_USAGE',
            '--intent and --repository are required',
            EXIT_USAGE,
          );
          return;
        }
        const root = options.repoRoot ?? process.cwd();
        try {
          const receipt = buildReleasePlanReceipt({
            repository_id: options.repository,
            intent_path: relative(root, resolve(options.intent)).replaceAll('\\', '/'),
            intent: readJson(options.intent),
            release_verification_profile: readJson(
              join(root, 'law/policy/release-verification.json'),
            ),
            release_lifecycle_policy: readJson(join(root, 'law/policy/release-lifecycle.json')),
            action_registry: readJson(join(root, 'law/policy/action-registry.json')),
          });
          process.stdout.write(
            options.human === true
              ? `release plan: ${receipt.receipt_id} -> ${receipt.verdict}\n`
              : `${JSON.stringify(receipt)}\n`,
          );
          process.exitCode = receipt.verdict === 'pass' ? EXIT_PASS : EXIT_FAIL;
        } catch (error) {
          fail(
            'release plan',
            'RELEASE_PLAN_FAILED',
            error instanceof Error ? error.message : String(error),
            EXIT_REVIEW,
          );
        }
      });
  },
});

function unavailableAction(
  name:
    | 'release preflight'
    | 'release certify'
    | 'release prepare'
    | 'release export'
    | 'release evidence-publish'
    | 'release publish',
  description: string,
): CommandDefinition {
  return defineCommand({
    name,
    description,
    authority: 'release_controller',
    register(cli: CAC): void {
      cli
        .command(name.replace(' ', '-'), description)
        .option('--request <path>', 'Exact candidate-bound action request JSON')
        .option('--human', 'Human-readable output')
        .action((options: ActionOptions) => {
          if (options.request === undefined) {
            fail(name, 'RELEASE_ACTION_USAGE', '--request is required', EXIT_USAGE);
            return;
          }
          try {
            validateReleaseLifecycleRequest(readJson(options.request), name);
            const remote = name === 'release evidence-publish' || name === 'release publish';
            fail(
              name,
              remote
                ? 'RELEASE_AUTHORIZATION_PROVIDER_UNAVAILABLE'
                : 'RELEASE_ACTION_PROVIDER_UNAVAILABLE',
              remote
                ? 'no protected authorization ledger provider is installed; the action provider was not consulted'
                : 'no protected injectable action provider is installed; no state was appended',
              EXIT_REVIEW,
            );
          } catch (error) {
            fail(
              name,
              'RELEASE_ACTION_REQUEST_INVALID',
              error instanceof Error ? error.message : String(error),
              EXIT_REVIEW,
            );
          }
        });
    },
  });
}

export const releasePreflight = unavailableAction(
  'release preflight',
  'Run the cheap mandatory floor and bind a passing plan receipt.',
);
export const releaseCertify = unavailableAction(
  'release certify',
  'Run the selected candidate-bound certification DAG.',
);
export const releasePrepare = unavailableAction(
  'release prepare',
  'Prepare deterministic packages, manifests, and software bills of materials.',
);
export const releaseExport = unavailableAction(
  'release export',
  'Export release evidence through the authorized verifier-provider boundary.',
);
export const releaseEvidencePublish = unavailableAction(
  'release evidence-publish',
  'Publish exact offline-verified evidence with one-time Owner authorization.',
);
export const releasePublish = unavailableAction(
  'release publish',
  'Dispatch publication through the protected workflow boundary.',
);

export const releaseOfflineVerify = defineCommand({
  name: 'release offline-verify',
  description: 'Verify exported artifacts without network access and emit a deterministic receipt.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-offline-verify', 'Verify exported release artifacts without network access')
      .option('--request <path>', 'Exact candidate-bound offline verification request JSON')
      .option('--exported-state <path>', 'Exact exported lifecycle state record')
      .option('--human', 'Human-readable output')
      .action((options: OfflineVerifyOptions) => {
        if (options.request === undefined && options.exportedState === undefined) {
          fail(
            'release offline-verify',
            'RELEASE_OFFLINE_VERIFY_USAGE',
            '--request or the deprecated --exported-state alias is required',
            EXIT_USAGE,
          );
          return;
        }
        try {
          if (options.request !== undefined) {
            validateReleaseLifecycleRequest(readJson(options.request), 'release offline-verify');
          }
          if (options.exportedState !== undefined) {
            const state = verifyReleaseStateIdentity(readJson(options.exportedState));
            if (state.state !== 'exported') throw new Error('release-offline-state-mismatch');
          }
          fail(
            'release offline-verify',
            'OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE',
            'canonical verifier source is not installed; no receipt or state was written',
            EXIT_REVIEW,
          );
        } catch (error) {
          fail(
            'release offline-verify',
            'RELEASE_OFFLINE_VERIFY_INPUT_INVALID',
            error instanceof Error ? error.message : String(error),
            EXIT_REVIEW,
          );
        }
      });
  },
});

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
          const states = options.stateChain === undefined ? [] : readJson(options.stateChain);
          if (!Array.isArray(states)) throw new Error('state chain must be a JSON array');
          const first = states.length === 0 ? undefined : verifyReleaseStateIdentity(states[0]);
          const request =
            options.request === undefined
              ? undefined
              : validateReleaseLifecycleRequest(readJson(options.request), 'release resume');
          if (first === undefined && request === undefined) {
            throw new Error('an empty state chain requires an exact release resume request');
          }
          const repository = first?.repository ?? request?.repository_locator;
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
          const candidate = first?.candidate ?? requestedCandidate;
          if (repository === undefined || candidate === undefined) {
            throw new Error('release resume identity is unavailable');
          }
          const storeRecords =
            options.storeRecords === undefined ? [] : readJson(options.storeRecords);
          if (!Array.isArray(storeRecords)) throw new Error('store records must be a JSON array');
          const receipts = options.receipts === undefined ? [] : readJson(options.receipts);
          if (!Array.isArray(receipts)) throw new Error('receipts must be a JSON array');
          const observation = await resumeReleaseLifecycleExecution({
            states,
            store_records: storeRecords,
            ...(options.storeHead === undefined ? {} : { store_head: readJson(options.storeHead) }),
            repository,
            candidate,
            ...(request === undefined ? {} : { candidate_locator: request.candidate_locator }),
            receipt_documents: receipts,
            ...(options.publicationReceipt === undefined
              ? {}
              : {
                  publication_receipt: readJson(options.publicationReceipt),
                  // Trust material is deliberately external. The stock CLI
                  // cannot derive published without an injected verifier.
                  verify_signature: () => false,
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
            error instanceof Error ? error.message : String(error),
            EXIT_REVIEW,
          );
        }
      });
  },
});
