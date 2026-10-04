import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand, type CommandDefinition } from '../../define-command.js';
import { declaredInvocationAuthority } from '../../authority/index.js';
import {
  ReleaseLifecycleFileStore,
  executeOfflineVerification,
  executeReleaseLifecycleAction,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
  type PersistedReleaseAction,
  type ReleaseLifecycleRequest,
  type ReleaseProvider,
} from '../../services/release-lifecycle-execution.js';
import { buildResolvedReleasePlanReceipt } from '../../services/release-lifecycle.js';
import type { TrustedReleaseAuthority } from '../../services/release-lifecycle-execution-types.js';

import { builtInReleaseLifecycleLocalProvider } from '../../services/release-lifecycle-local-adapters.js';
import { createReleaseCertificationProvider } from '../../services/release-lifecycle-certification.js';
import { createReleasePrepareProvider } from '../../services/release-prepare-kernel.js';

import { resolvePolicyFor, requestPolicy, commandAdapters } from './lifecycle-adapters.js';
import {
  type PlanOptions,
  fail,
  readPinnedJson,
  inputFailureCode,
  type ActionOptions,
  localResolvers,
  readContainedBytes,
  type OfflineVerifyOptions,
} from './lifecycle-inputs.js';
export { releaseResume } from './lifecycle-resume.js';
export {
  type ReleaseLifecycleCommandAdapters,
  installReleaseLifecycleCommandAdapters,
} from './lifecycle-adapters.js';

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
              provider = createReleaseCertificationProvider({
                ...certification,
                resolve_receipt: resolvers.receipt,
                resolve_plan_input: resolvers.plan,
              });
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
                  resolve_receipt: resolvers.receipt,
                  resolve_plan_input: resolvers.plan,
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
            const declared = declaredInvocationAuthority();
            // Release actions never carry experimental consent; the front door refuses it.
            if (
              declared === undefined ||
              (declared.consent as { experimental?: boolean } | undefined)?.experimental === true
            ) {
              throw new Error('release-authority-context-invalid');
            }
            const authority = declared as TrustedReleaseAuthority;
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
              ...(requiresArtifactReader
                ? { exportLimits: adapters?.export_limits?.(request) }
                : {}),
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
            exportLimits: commandAdapters?.export_limits?.(request),
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
