import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand, type CommandDefinition } from '../../define-command.js';
import { declaredInvocationAuthority } from '../../authority/index.js';
import {
  ReleaseLifecycleFileStore,
  executeOfflineVerification,
  executeReleaseLifecycleAction,
  resumeReleaseLifecycleExecution,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
  type AuthorizationBridge,
  type OfflineVerificationProvider,
  type PersistedReleaseAction,
  type PublicationControls,
  type ReleaseLifecycleRequest,
  type ReleasePlanInputResolver,
  type ReleaseProvider,
  type TrustedOfflineReceiptVerifier,
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
  readonly repoRoot?: string;
  readonly stateChain?: string;
  readonly storeRecords?: string;
  readonly storeHead?: string;
  readonly receipts?: string;
  readonly publicationReceipt?: string;
  readonly human?: boolean;
}

interface ActionOptions {
  readonly request?: string;
  readonly repoRoot?: string;
  readonly stateRoot?: string;
  readonly human?: boolean;
}

interface OfflineVerifyOptions {
  readonly request?: string;
  readonly exportedState?: string;
  readonly repoRoot?: string;
  readonly human?: boolean;
}

export interface ReleaseLifecycleCommandAdapters {
  readonly provider: (
    action: PersistedReleaseAction,
    request: ReleaseLifecycleRequest,
  ) => ReleaseProvider | undefined;
  readonly offline_verification_provider: (
    request: ReleaseLifecycleRequest,
  ) => OfflineVerificationProvider | undefined;
  readonly authorization: (request: ReleaseLifecycleRequest) => AuthorizationBridge | undefined;
  readonly offline_receipt_verifier: (
    request: ReleaseLifecycleRequest,
  ) => TrustedOfflineReceiptVerifier | undefined;
  readonly publication_controls: (
    request: ReleaseLifecycleRequest,
  ) => PublicationControls | undefined;
}

let commandAdapters: ReleaseLifecycleCommandAdapters | undefined;

/** Installed only by the trusted host composition root; CLI requests cannot select code. */
export function installReleaseLifecycleCommandAdapters(
  adapters: ReleaseLifecycleCommandAdapters,
): () => void {
  if (commandAdapters !== undefined) throw new Error('release-command-adapters-already-installed');
  const installed = Object.freeze({ ...adapters });
  commandAdapters = installed;
  return () => {
    if (commandAdapters === installed) commandAdapters = undefined;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function containedFile(root: string, path: string): string {
  const absoluteRoot = realpathSync(resolve(root));
  const candidate = resolve(absoluteRoot, path);
  const escaped = relative(absoluteRoot, candidate);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error('release-receipt-path-unsafe');
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(candidate) !== candidate) {
    throw new Error('release-receipt-path-unsafe');
  }
  return candidate;
}

function localResolvers(root: string): {
  readonly receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly plan: ReleasePlanInputResolver;
} {
  return {
    receipt: (locator) => readJson(containedFile(root, locator.path)),
    plan: (input) => {
      if (typeof input['path'] !== 'string') throw new Error('rpl-input-unresolved');
      return readJson(containedFile(root, input['path']));
    },
  };
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

function lifecycleAction(
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
        .option('--repo-root <path>', 'Repository root containing bound receipt inputs')
        .option('--state-root <path>', 'Protected append-only release state root')
        .option('--human', 'Human-readable output')
        .action(async (options: ActionOptions) => {
          if (options.request === undefined) {
            fail(name, 'RELEASE_ACTION_USAGE', '--request is required', EXIT_USAGE);
            return;
          }
          try {
            const request = validateReleaseLifecycleRequest(
              readJson(options.request),
              name,
            ) as ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction };
            const adapters = commandAdapters;
            const provider = adapters?.provider(name, request);
            const remote = name === 'release evidence-publish' || name === 'release publish';
            const authorization = remote ? adapters?.authorization(request) : undefined;
            const offlineReceiptVerifier =
              name === 'release evidence-publish'
                ? adapters?.offline_receipt_verifier(request)
                : undefined;
            if (
              adapters === undefined ||
              provider === undefined ||
              (remote && authorization === undefined) ||
              (name === 'release evidence-publish' && offlineReceiptVerifier === undefined)
            ) {
              fail(
                name,
                remote
                  ? 'RELEASE_AUTHORIZATION_PROVIDER_UNAVAILABLE'
                  : 'RELEASE_ACTION_PROVIDER_UNAVAILABLE',
                'the exact lifecycle adapter set is not installed; no store or provider effect occurred',
                EXIT_REVIEW,
              );
              return;
            }
            const actor = declaredInvocationAuthority();
            if (actor === undefined) throw new Error('release-authority-context-invalid');
            const root = resolve(options.repoRoot ?? process.cwd());
            const resolvers = localResolvers(root);
            const result = await executeReleaseLifecycleAction({
              request,
              action: name,
              store: new ReleaseLifecycleFileStore(
                resolve(options.stateRoot ?? join(root, '.devai/state/release-lifecycle')),
                request,
              ),
              provider,
              authority: {
                actor,
                consent: {
                  write: true,
                  allow_publish: remote,
                  experimental: false,
                },
              },
              resolveReceipt: resolvers.receipt,
              resolvePlanInput: resolvers.plan,
              ...(authorization === undefined ? {} : { authorization }),
              ...(offlineReceiptVerifier === undefined ? {} : { offlineReceiptVerifier }),
              ...(name === 'release publish'
                ? { publication_controls: adapters.publication_controls(request) }
                : {}),
              recorded_at: new Date().toISOString(),
            });
            if (!result.ok) {
              fail(name, result.code, result.phase, EXIT_REVIEW);
              return;
            }
            process.stdout.write(
              options.human === true
                ? `devai ${name}: ${result.state.state_id} -> ${result.state.state}\n`
                : `${JSON.stringify(result.state)}\n`,
            );
            process.exitCode = EXIT_PASS;
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

export const releasePreflight = lifecycleAction(
  'release preflight',
  'Run the cheap mandatory floor and bind a passing plan receipt.',
);
export const releaseCertify = lifecycleAction(
  'release certify',
  'Run the selected candidate-bound certification DAG.',
);
export const releasePrepare = lifecycleAction(
  'release prepare',
  'Prepare deterministic packages, manifests, and software bills of materials.',
);
export const releaseExport = lifecycleAction(
  'release export',
  'Export release evidence through the authorized verifier-provider boundary.',
);
export const releaseEvidencePublish = lifecycleAction(
  'release evidence-publish',
  'Publish exact offline-verified evidence with one-time Owner authorization.',
);
export const releasePublish = lifecycleAction(
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
      .option('--repo-root <path>', 'Repository root containing bound inputs')
      .option('--human', 'Human-readable output')
      .action(async (options: OfflineVerifyOptions) => {
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
          const state =
            options.exportedState === undefined
              ? undefined
              : verifyReleaseStateIdentity(readJson(options.exportedState));
          if (options.request === undefined || options.exportedState === undefined) {
            fail(
              'release offline-verify',
              'RELEASE_OFFLINE_VERIFY_USAGE',
              '--request and --exported-state are required for semantic verification',
              EXIT_USAGE,
            );
            return;
          }
          const request = validateReleaseLifecycleRequest(
            readJson(options.request),
            'release offline-verify',
          );
          if (state === undefined) throw new Error('release-offline-state-missing');
          if (state.state !== 'exported') throw new Error('release-offline-state-mismatch');
          const provider = commandAdapters?.offline_verification_provider(request);
          if (provider === undefined) {
            fail(
              'release offline-verify',
              'OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE',
              'the trusted offline verifier adapter is not installed; no receipt was emitted',
              EXIT_REVIEW,
            );
            return;
          }
          const result = await executeOfflineVerification({
            request,
            exported_state: state,
            provider,
          });
          if (!result.ok) {
            fail('release offline-verify', result.code, result.phase, EXIT_REVIEW);
            return;
          }
          process.stdout.write(
            options.human === true
              ? `release offline-verify: ${String(result.receipt['receipt_id'])} -> pass\n`
              : `${JSON.stringify(result.receipt)}\n`,
          );
          process.exitCode = EXIT_PASS;
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
      .option('--repo-root <path>', 'Repository root containing bound receipt inputs')
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
          const root = resolve(options.repoRoot ?? process.cwd());
          const resolvers = localResolvers(root);
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
            resolve_plan_input: resolvers.plan,
            ...(request === undefined
              ? {}
              : {
                  offline_receipt_verifier: commandAdapters?.offline_receipt_verifier(request),
                }),
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
