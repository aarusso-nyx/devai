import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CAC } from 'cac';
import {
  listReleases,
  runPostdeployVerify,
  runPostdeployVerifyFromCharter,
  runReleaseGate,
  runRuntimeDrift,
  runRuntimeDriftFromCharter,
  type ReleaseKind,
  type ReleaseRecord,
} from '@devai-nyx/loop';
import { validators } from '@devai-nyx/schemas';
import { executeRuntimeProbe, type RuntimeProbeCharter } from '@devai-nyx/sensors';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = process.cwd();
const KNOWN_ENVS = ['dev', 'staging', 'stage', 'prod', 'preview', 'other'] as const;
const RELEASE_KINDS = ['gate', 'postdeploy-verify', 'runtime-drift'] as const;

type Environment = NonNullable<ReleaseRecord['environment']>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(json: unknown, human: boolean, humanText: string): void {
  process.stdout.write(human ? `${humanText.replace(/\n$/u, '')}\n` : `${JSON.stringify(json)}\n`);
}

function usage(action: string, detail: string): void {
  process.stderr.write(`devai ${action}: ${detail}\n`);
  process.exitCode = EXIT_USAGE;
}

function failure(action: string, error: unknown): void {
  process.stderr.write(`devai ${action}: ${message(error)}\n`);
  process.exitCode = EXIT_FAIL;
}

function environment(value: string | undefined): Environment | undefined {
  return value === undefined || !KNOWN_ENVS.includes(value as Environment)
    ? undefined
    : (value as Environment);
}

function validateEnvironment(action: string, value: string | undefined): value is Environment {
  if (value === undefined || environment(value) !== undefined) return true;
  usage(action, `--environment must be one of ${KNOWN_ENVS.join(', ')}`);
  return false;
}

function loadAndValidateCharter(
  path: string,
  expected: readonly RuntimeProbeCharter['kind'][],
): RuntimeProbeCharter {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!validators.runtimeCharter(parsed)) {
    throw new Error(
      `charter failed runtime-charter.schema.json validation: ${JSON.stringify(validators.runtimeCharter.errors)}`,
    );
  }
  const charter = parsed as RuntimeProbeCharter;
  if (!expected.includes(charter.kind)) {
    throw new Error(
      `charter kind '${charter.kind}' does not match expected ${expected.join(' or ')} for this action`,
    );
  }
  return charter;
}

export interface ReleaseCheckOptions {
  readonly repoRoot?: string;
  readonly scorecard?: string;
  readonly readingsDir?: string;
  readonly invariantsDir?: string;
  readonly artifact?: string;
  readonly environment?: string;
  readonly auditChainHead?: string;
  readonly human?: boolean;
  readonly strict?: boolean;
}

export const releaseCheck = defineCommand({
  name: 'release check',
  description: 'Evaluate release eligibility without granting publication authority.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-check', 'Evaluate and record release eligibility')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--scorecard <path>', 'Scorecard JSON to consume')
      .option(
        '--readings-dir <path>',
        'Directory of SensorReading records (default: .devai/state/sensor-readings)',
      )
      .option('--invariants-dir <path>', 'Invariant catalog directory (default: law/invariants)')
      .option('--artifact <ref>', 'Artifact-of-record (digest / tag / image)')
      .option('--environment <kind>', `Target environment. One of: ${KNOWN_ENVS.join(', ')}`)
      .option('--audit-chain-head <sha>', 'Audit chain head (sha-256) at check time')
      .option('--strict', 'Exit non-zero on verdict != pass')
      .option('--human', 'Human-readable output')
      .action((options: ReleaseCheckOptions) => {
        if (!validateEnvironment('release check', options.environment)) return;
        try {
          const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
          const record = runReleaseGate({
            repoRoot,
            ...(options.scorecard !== undefined && { scorecardRef: options.scorecard }),
            sensorReadingsDir:
              options.readingsDir ?? join(repoRoot, '.devai/state/sensor-readings'),
            invariantsDir: options.invariantsDir ?? join(repoRoot, 'law/invariants'),
            ...(options.artifact !== undefined && { artifactRef: options.artifact }),
            ...(options.environment !== undefined && {
              environment: options.environment as Environment,
            }),
            ...(options.auditChainHead !== undefined && { auditChainHead: options.auditChainHead }),
          });
          emit(
            record,
            options.human === true,
            `release check: ${record.id} -> ${record.verdict}` +
              (record.reasons !== undefined && record.reasons.length > 0
                ? `\n  reasons:\n${record.reasons.map((reason) => `    - ${reason}`).join('\n')}`
                : ''),
          );
          process.exitCode =
            options.strict === true && record.verdict !== 'pass' ? EXIT_FAIL : EXIT_PASS;
        } catch (error) {
          failure('release check', error);
        }
      });
  },
});

export interface ReleaseStatusOptions {
  readonly repoRoot?: string;
  readonly kind?: string;
  readonly human?: boolean;
}

export const releaseStatus = defineCommand({
  name: 'release status',
  description: 'Read release-control status without persisting evidence or state.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-status', 'Read release-control status')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--kind <kind>', `Filter by kind (${RELEASE_KINDS.join(' | ')})`)
      .option('--human', 'Human-readable output')
      .action((options: ReleaseStatusOptions) => {
        if (
          options.kind !== undefined &&
          !RELEASE_KINDS.includes(options.kind as (typeof RELEASE_KINDS)[number])
        ) {
          usage('release status', `--kind must be one of ${RELEASE_KINDS.join(', ')}`);
          return;
        }
        try {
          const records = listReleases(options.repoRoot ?? DEFAULT_REPO_ROOT).filter(
            (record) => options.kind === undefined || record.kind === (options.kind as ReleaseKind),
          );
          emit(
            { count: records.length, releases: records },
            options.human === true,
            `release status: ${String(records.length)} record(s)` +
              (records.length === 0
                ? ''
                : `\n${records
                    .map(
                      (record) =>
                        `  ${record.id}  ${record.kind.padEnd(20)}  ${record.verdict.padEnd(12)}  ${record.environment ?? '-'}  ${record.decided_at}`,
                    )
                    .join('\n')}`),
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          failure('release status', error);
        }
      });
  },
});

export interface ReleaseVerifyOptions {
  readonly repoRoot?: string;
  readonly artifact?: string;
  readonly artifactChainHead?: string;
  readonly auditChainHead?: string;
  readonly runtimeCharter?: string;
  readonly environment?: string;
  readonly strict?: boolean;
  readonly human?: boolean;
}

export const releaseVerify = defineCommand({
  name: 'release verify',
  description: 'Verify post-deployment release state under the release controller.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-verify', 'Verify and record post-deployment release state')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--artifact <ref>', 'Artifact-of-record (required)')
      .option('--artifact-chain-head <sha>', 'sha-256 chain head baked into the artifact')
      .option('--audit-chain-head <sha>', 'sha-256 chain head observed in the runtime')
      .option('--runtime-charter <path>', 'API runtime charter for detector mode')
      .option('--environment <kind>', `Target environment. One of: ${KNOWN_ENVS.join(', ')}`)
      .option('--strict', 'Exit non-zero on verdict != pass')
      .option('--human', 'Human-readable output')
      .action(async (options: ReleaseVerifyOptions) => {
        if (options.artifact === undefined) {
          usage('release verify', '--artifact is required');
          return;
        }
        if (!validateEnvironment('release verify', options.environment)) return;
        const detector = options.runtimeCharter !== undefined;
        const recordMode = options.auditChainHead !== undefined;
        if (detector === recordMode) {
          usage(
            'release verify',
            detector
              ? '--runtime-charter and --audit-chain-head are mutually exclusive'
              : 'either --runtime-charter or --audit-chain-head is required',
          );
          return;
        }
        if (recordMode && options.artifactChainHead === undefined) {
          usage('release verify', '--artifact-chain-head is required in record mode');
          return;
        }
        try {
          const common = {
            repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
            artifactRef: options.artifact,
            ...(options.environment !== undefined && {
              environment: options.environment as Environment,
            }),
          };
          const record = detector
            ? await (async () => {
                const charterPath = options.runtimeCharter as string;
                const charter = loadAndValidateCharter(charterPath, ['api']);
                const { summary } = await executeRuntimeProbe({ charter });
                return runPostdeployVerifyFromCharter({
                  ...common,
                  charterPath,
                  probeAggregate: {
                    summary_verdict: summary.verdict,
                    pass: summary.pass,
                    fail: summary.fail,
                    error: summary.error,
                    review: summary.review,
                    skipped: summary.skipped,
                    findings: summary.outcomes.flatMap((outcome) =>
                      outcome.failed_expectations.map((finding) => ({
                        code: outcome.verdict === 'error' ? 'PROBE_ERROR' : 'EXPECT_FAILED',
                        message: `[${outcome.pid}] ${outcome.name}: ${finding}`,
                      })),
                    ),
                  },
                  ...(options.artifactChainHead !== undefined && {
                    artifactChainHead: options.artifactChainHead,
                  }),
                });
              })()
            : runPostdeployVerify({
                ...common,
                artifactChainHead: options.artifactChainHead as string,
                auditChainHead: options.auditChainHead as string,
              });
          emit(
            record,
            options.human === true,
            `release verify: ${record.id} -> ${record.verdict}` +
              (record.rollback_recommended === true ? ' (rollback recommended)' : '') +
              (detector ? ` (detector: charter=${String(options.runtimeCharter)})` : ''),
          );
          process.exitCode =
            options.strict === true && record.verdict !== 'pass' ? EXIT_FAIL : EXIT_PASS;
        } catch (error) {
          failure('release verify', error);
        }
      });
  },
});

export interface ReleaseDriftOptions {
  readonly repoRoot?: string;
  readonly observation?: string | readonly string[];
  readonly runtimeCharter?: string;
  readonly artifact?: string;
  readonly environment?: string;
  readonly strict?: boolean;
  readonly human?: boolean;
}

function observations(value: ReleaseDriftOptions['observation']): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

export const releaseDrift = defineCommand({
  name: 'release drift',
  description: 'Inspect and record release-runtime drift under the release controller.',
  authority: 'release_controller',
  register(cli: CAC): void {
    cli
      .command('release-drift', 'Inspect and record release-runtime drift')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--observation <surface=delta>', 'Drift observation (repeatable; record mode)')
      .option('--runtime-charter <path>', 'API or auth runtime charter for detector mode')
      .option('--artifact <ref>', 'Artifact-of-record')
      .option('--environment <kind>', `Target environment. One of: ${KNOWN_ENVS.join(', ')}`)
      .option('--strict', 'Exit non-zero when drift is present')
      .option('--human', 'Human-readable output')
      .action(async (options: ReleaseDriftOptions) => {
        if (!validateEnvironment('release drift', options.environment)) return;
        const supplied = observations(options.observation);
        const detector = options.runtimeCharter !== undefined;
        if (detector && supplied.length > 0) {
          usage('release drift', '--runtime-charter and --observation are mutually exclusive');
          return;
        }
        try {
          const common = {
            repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
            ...(options.artifact !== undefined && { artifactRef: options.artifact }),
            ...(options.environment !== undefined && {
              environment: options.environment as Environment,
            }),
          };
          const record = detector
            ? await (async () => {
                const charterPath = options.runtimeCharter as string;
                const charter = loadAndValidateCharter(charterPath, ['api', 'auth']);
                const { summary } = await executeRuntimeProbe({ charter });
                return runRuntimeDriftFromCharter({
                  ...common,
                  charterPath,
                  outcomes: summary.outcomes.map((outcome) => ({
                    pid: outcome.pid,
                    name: outcome.name,
                    verdict: outcome.verdict,
                    failed_expectations: outcome.failed_expectations,
                  })),
                });
              })()
            : runRuntimeDrift({
                ...common,
                observations: supplied.map((value) => {
                  const separator = value.indexOf('=');
                  if (separator <= 0) {
                    throw new Error(`--observation expects 'surface=delta' (got '${value}')`);
                  }
                  return { surface: value.slice(0, separator), delta: value.slice(separator + 1) };
                }),
              });
          const count = record.drift_observations?.length ?? 0;
          emit(
            record,
            options.human === true,
            `release drift: ${record.id} -> ${record.verdict} (${String(count)} observation(s)` +
              (detector ? `, detector: charter=${String(options.runtimeCharter)})` : ')'),
          );
          process.exitCode =
            options.strict === true && record.verdict !== 'pass' ? EXIT_FAIL : EXIT_PASS;
        } catch (error) {
          failure('release drift', error);
        }
      });
  },
});
