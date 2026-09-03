import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CAC } from 'cac';
import { resumeReleaseLifecycle, type ReleaseLifecycleStateRecord } from '@devai-nyx/loop';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand, type CommandDefinition } from '../../define-command.js';
import { buildReleasePlanReceipt } from '../../services/release-lifecycle.js';

interface PlanOptions {
  readonly repoRoot?: string;
  readonly intent?: string;
  readonly repository?: string;
  readonly human?: boolean;
}

interface ResumeOptions {
  readonly stateChain?: string;
  readonly publicationReceipt?: string;
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
        .action(() => {
          fail(
            name,
            'RELEASE_ACTION_PROVIDER_UNAVAILABLE',
            'no protected injectable action provider is installed; no state was appended',
          );
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
      .option('--exported-state <path>', 'Exact exported lifecycle state record')
      .option('--human', 'Human-readable output')
      .action(() => {
        fail(
          'release offline-verify',
          'OFFLINE_VERIFIER_PROVIDER_UNAVAILABLE',
          'canonical verifier source is not installed; no receipt or state was written',
        );
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
      .option('--state-chain <path>', 'JSON array containing the exact persisted state chain')
      .option('--publication-receipt <path>', 'Signed external publication receipt')
      .option('--human', 'Human-readable output')
      .action(async (options: ResumeOptions) => {
        if (options.stateChain === undefined) {
          fail('release resume', 'RELEASE_RESUME_USAGE', '--state-chain is required', EXIT_USAGE);
          return;
        }
        try {
          const records = readJson(options.stateChain);
          if (!Array.isArray(records) || records.length === 0) {
            throw new Error('state chain must be a non-empty JSON array');
          }
          const first = records[0] as ReleaseLifecycleStateRecord;
          const observation = await resumeReleaseLifecycle({
            records,
            repository: first.repository,
            candidate: first.candidate,
            ...(options.publicationReceipt === undefined
              ? {}
              : { publication_receipt: readJson(options.publicationReceipt) }),
            // External trust material is intentionally not vendored. Until an
            // exact trust provider is injected, no receipt derives published.
            verifySignature: () => false,
          });
          process.stdout.write(
            options.human === true
              ? `release resume: ${observation.observation_id} -> ${String(observation.published['observed'])}\n`
              : `${JSON.stringify(observation)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          fail(
            'release resume',
            'RELEASE_RESUME_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      });
  },
});
