import {
  closeReadOnlySync,
  fstatSync,
  lstatSync,
  openReadOnlyNoFollowSync,
  readFileSync,
} from '@devai-nyx/authority';
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
  type PublicationSignatureVerifier,
  type ReleaseLifecycleRequest,
  type ReleasePlanInputResolver,
  type ReleaseProvider,
  type TrustedArtifactReader,
  type TrustedOfflineReceiptVerifier,
} from '../../services/release-lifecycle-execution.js';
import { buildResolvedReleasePlanReceipt } from '../../services/release-lifecycle.js';
import {
  createResolvedReleasePlanInputResolver,
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from '../../services/release-policy-resolution.js';
import { builtInReleaseLifecycleLocalProvider } from '../../services/release-lifecycle-local-adapters.js';
import { createReleaseCertificationProvider } from '../../services/release-lifecycle-certification.js';
import {
  createReleasePrepareProvider,
  type ImmutableReleaseContentSource,
  type TrustedArtifactSink,
} from '../../services/release-prepare-kernel.js';

interface PlanOptions {
  readonly repoRoot?: string;
  readonly intent?: string;
  readonly repository?: string;
  readonly human?: boolean;
}

interface ResumeOptions {
  readonly request?: string;
  readonly repoRoot?: string;
  readonly stateRoot?: string;
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
  readonly policy_resolution?: (input: {
    readonly repository_id: string;
    readonly candidate: { readonly commit: string; readonly tree: string };
    readonly release_unit: string;
  }) => VerifiedReleasePolicyResolution | undefined;
  readonly preflight_provider?: (request: ReleaseLifecycleRequest) => ReleaseProvider | undefined;
  readonly certification_provider?: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof createReleaseCertificationProvider>[0] | undefined;
  readonly provider: (
    action: PersistedReleaseAction,
    request: ReleaseLifecycleRequest,
  ) => ReleaseProvider | undefined;
  readonly offline_verification_provider: (
    request: ReleaseLifecycleRequest,
  ) => OfflineVerificationProvider | undefined;
  readonly offline_policy_closures?: (
    request: ReleaseLifecycleRequest,
  ) => Parameters<typeof executeOfflineVerification>[0]['policyClosures'];
  readonly authorization: (request: ReleaseLifecycleRequest) => AuthorizationBridge | undefined;
  readonly offline_receipt_verifier: (
    request: ReleaseLifecycleRequest,
  ) => TrustedOfflineReceiptVerifier | undefined;
  readonly publication_controls: (
    request: ReleaseLifecycleRequest,
  ) => PublicationControls | undefined;
  readonly publication_signature_verifier?: (
    request: ReleaseLifecycleRequest,
  ) => PublicationSignatureVerifier | undefined;
  readonly prepare_content_source?: (
    request: ReleaseLifecycleRequest,
  ) => ImmutableReleaseContentSource | undefined;
  readonly artifact_sink?: (request: ReleaseLifecycleRequest) => TrustedArtifactSink | undefined;
  readonly artifact_reader?: (
    request: ReleaseLifecycleRequest,
  ) => TrustedArtifactReader | undefined;
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

function sameFileSnapshot(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readPinnedBytes(path: string): Buffer {
  const absolute = resolve(path);
  const before = lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('release-receipt-path-unsafe');
  }
  const descriptor = openReadOnlyNoFollowSync(absolute);
  try {
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || !sameFileSnapshot(before, openedBefore)) {
      throw new Error('release-receipt-path-unsafe');
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(absolute);
    if (!sameFileSnapshot(openedBefore, openedAfter) || !sameFileSnapshot(openedAfter, after)) {
      throw new Error('release-receipt-path-unsafe');
    }
    return bytes;
  } finally {
    closeReadOnlySync(descriptor);
  }
}

function assertDirectoryChain(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const relativePath = relative(absoluteRoot, candidate);
  let cursor = absoluteRoot;
  for (const part of relativePath.split(sep).slice(0, -1)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('release-receipt-path-unsafe');
    }
  }
}

function readContainedBytes(root: string, path: string): Buffer {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, path);
  const escaped = relative(absoluteRoot, candidate);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error('release-receipt-path-unsafe');
  }
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('release-receipt-path-unsafe');
  }
  assertDirectoryChain(absoluteRoot, candidate);
  return readPinnedBytes(candidate);
}

function readPinnedJson(path: string): unknown {
  return JSON.parse(readPinnedBytes(path).toString('utf8')) as unknown;
}

function readContainedJson(root: string, path: string): unknown {
  return JSON.parse(readContainedBytes(root, path).toString('utf8')) as unknown;
}

function localResolvers(
  root: string,
  resolution?: VerifiedReleasePolicyResolution | readonly VerifiedReleasePolicyResolution[],
): {
  readonly receipt: (
    locator: NonNullable<ReleaseLifecycleRequest['receipt_locators']>[number],
  ) => unknown;
  readonly plan: ReleasePlanInputResolver;
} {
  return {
    receipt: (locator) => readContainedJson(root, locator.path),
    plan:
      resolution === undefined
        ? () => {
            throw new Error('rpl-policy-source-unresolved');
          }
        : createResolvedReleasePlanInputResolver(resolution),
  };
}

function resolvePolicyFor(input: {
  readonly repository_id: string;
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly release_unit: string;
}): VerifiedReleasePolicyResolution {
  const resolution = commandAdapters?.policy_resolution?.(input);
  if (!isVerifiedReleasePolicyResolution(resolution))
    throw new Error('rpl-policy-source-unresolved');
  if (
    resolution.repository.id !== input.repository_id ||
    resolution.repository.commit !== input.candidate.commit ||
    resolution.repository.tree !== input.candidate.tree ||
    resolution.release_unit !== input.release_unit
  )
    throw new Error('rpl-policy-resolution-mismatch');
  return resolution;
}

function requestPolicy(
  request: ReleaseLifecycleRequest,
): readonly VerifiedReleasePolicyResolution[] {
  return request.candidate_locator.release_units.map((unit) =>
    resolvePolicyFor({
      repository_id: request.repository_locator.id,
      candidate: {
        commit: request.candidate_locator.commit,
        tree: request.candidate_locator.tree,
      },
      release_unit: unit.release_unit,
    }),
  );
}

function fail(action: string, code: string, detail: string, exit = EXIT_FAIL): void {
  process.stderr.write(`devai ${action}: ${code}: ${detail}\n`);
  process.exitCode = exit;
}

/** Never echo native read/JSON errors: their messages may include host paths or input bytes. */
function inputFailureCode(error: unknown, fallback: string): string {
  const codes = new Set([
    'rpl-policy-source-unresolved',
    'rpl-package-identity-mismatch',
    'rpl-adopter-binding-mismatch',
    'rpl-policy-resolution-mismatch',
    'rpl-legacy-plan-non-authoritative',
    'rpl-input-unresolved',
    'release-receipt-path-unsafe',
    'release-request-projection-invalid',
    'release-request-action-mismatch',
    'release-request-identity-mismatch',
    'release-request-receipt-order-invalid',
    'release-receipt-identity-mismatch',
    'release-release-unit-bijection-invalid',
    'release-offline-state-missing',
    'release-offline-state-mismatch',
    'release-state-store-unsafe',
  ]);
  return error instanceof Error && codes.has(error.message) ? error.message : fallback;
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
        try {
          const intent = readPinnedJson(resolve(options.intent));
          if (
            intent === null ||
            typeof intent !== 'object' ||
            !('candidate' in intent) ||
            intent.candidate === null ||
            typeof intent.candidate !== 'object' ||
            !('commit' in intent.candidate) ||
            typeof intent.candidate.commit !== 'string' ||
            !('tree' in intent.candidate) ||
            typeof intent.candidate.tree !== 'string' ||
            !('release_unit' in intent) ||
            typeof intent.release_unit !== 'string'
          )
            throw new Error('rpl-input-unresolved');
          const resolution = resolvePolicyFor({
            repository_id: options.repository,
            candidate: { commit: intent.candidate.commit, tree: intent.candidate.tree },
            release_unit: intent.release_unit,
          });
          const receipt = buildResolvedReleasePlanReceipt({ intent, resolution });
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
            inputFailureCode(error, 'rpl-policy-resolution-mismatch'),
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
              readPinnedJson(options.request),
              name,
            ) as ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction };
            const root = resolve(options.repoRoot ?? process.cwd());
            const resolvers = localResolvers(root, requestPolicy(request));
            const adapters = commandAdapters;
            const remote = name === 'release evidence-publish' || name === 'release publish';
            const store = new ReleaseLifecycleFileStore(
              resolve(options.stateRoot ?? join(root, '.devai/state/release-lifecycle')),
              request,
            );
            let provider: ReleaseProvider | undefined;
            if (name === 'release certify') {
              const certification = adapters?.certification_provider?.(request);
              if (certification === undefined)
                throw new Error('release-certification-provider-unavailable');
              provider = createReleaseCertificationProvider(certification);
            } else if (name === 'release prepare') {
              const contentSource = adapters?.prepare_content_source?.(request);
              const artifactSink = adapters?.artifact_sink?.(request);
              if (contentSource !== undefined && artifactSink !== undefined) {
                const certifiedState = store.readStateRecords().at(-1);
                if (certifiedState === undefined || certifiedState.state !== 'certified') {
                  throw new Error('release-prepare-certification-manifest-invalid');
                }
                provider = createReleasePrepareProvider({
                  certified_state: certifiedState,
                  content_source: contentSource,
                  artifact_sink: artifactSink,
                });
              }
            } else {
              provider =
                (name === 'release preflight'
                  ? adapters?.preflight_provider?.(request)
                  : undefined) ??
                adapters?.provider(name, request) ??
                builtInReleaseLifecycleLocalProvider(
                  {
                    repo_root: root,
                    resolve_receipt: resolvers.receipt,
                    resolve_plan_input: resolvers.plan,
                    read_contained_bytes: (path) => readContainedBytes(root, path),
                  },
                  name,
                );
            }
            const authorization = remote ? adapters?.authorization(request) : undefined;
            const offlineReceiptVerifier =
              name === 'release evidence-publish'
                ? adapters?.offline_receipt_verifier(request)
                : undefined;
            const requiresArtifactReader =
              name === 'release export' ||
              name === 'release evidence-publish' ||
              name === 'release publish';
            const artifactReader = requiresArtifactReader
              ? adapters?.artifact_reader?.(request)
              : undefined;
            if (
              provider === undefined ||
              (remote && authorization === undefined) ||
              (name === 'release evidence-publish' && offlineReceiptVerifier === undefined) ||
              (requiresArtifactReader && artifactReader === undefined)
            ) {
              fail(
                name,
                name === 'release prepare'
                  ? 'RELEASE_ARTIFACT_SINK_UNAVAILABLE'
                  : remote && authorization === undefined
                    ? 'RELEASE_AUTHORIZATION_PROVIDER_UNAVAILABLE'
                    : 'RELEASE_ACTION_PROVIDER_UNAVAILABLE',
                'the exact lifecycle adapter set is not installed; no store or provider effect occurred',
                EXIT_REVIEW,
              );
              return;
            }
            const authority = declaredInvocationAuthority();
            if (authority === undefined) throw new Error('release-authority-context-invalid');
            const result = await executeReleaseLifecycleAction({
              request,
              action: name,
              store,
              provider,
              authority,
              resolveReceipt: resolvers.receipt,
              resolvePlanInput: resolvers.plan,
              ...(authorization === undefined ? {} : { authorization }),
              ...(offlineReceiptVerifier === undefined ? {} : { offlineReceiptVerifier }),
              ...(artifactReader === undefined ? {} : { artifactReader }),
              ...(name === 'release publish'
                ? { publication_controls: adapters?.publication_controls(request) }
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
              inputFailureCode(error, 'release-request-projection-invalid'),
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
              : verifyReleaseStateIdentity(readPinnedJson(options.exportedState));
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
            readPinnedJson(options.request),
            'release offline-verify',
          );
          if (state === undefined) throw new Error('release-offline-state-missing');
          if (state.state !== 'exported') throw new Error('release-offline-state-mismatch');
          const provider = commandAdapters?.offline_verification_provider(request);
          const artifactReader = commandAdapters?.artifact_reader?.(request);
          if (provider === undefined || artifactReader === undefined) {
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
            artifactReader,
            policyClosures: commandAdapters?.offline_policy_closures?.(request),
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
            inputFailureCode(error, 'release-request-projection-invalid'),
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
