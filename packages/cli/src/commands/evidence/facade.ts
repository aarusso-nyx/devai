import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { CAC } from 'cac';
import { spawnSync, writeGovernanceProjectionSync } from '@devai-nyx/authority';
import {
  ActionsEvidenceError,
  LocalEvidenceError,
  appendProofEpochErrata,
  appendProofEpochRecord,
  collectLocalEvidence,
  loadChain,
  normalizeActorList,
  validateActionsEvidenceShadowTuple,
  verifyChain,
  verifyLocalEvidence,
  verifyProofEpoch,
  type ActionsEvidenceShadowDecision,
  type VerifyContext,
  type VerifyMode,
} from '#runtime-core';
import { renderDecisionRecords, renderRoundRecords } from '@devai-nyx/loop';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE, redact } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { coverageAggregate } from '../coverage/aggregate.js';
import { mutationRun } from '../mutation/run.js';
import { recordRun } from '../record/run.js';
import { renderMatrix } from '../render/matrix.js';
import { rtdBundle } from '../rtd/index.js';
import { invokeCommandService, type DirectCommandResult } from './direct-command.js';

const DEFAULT_CHAIN_PATH = 'record/proofs/chain.json';
const TUPLE_FILES = ['manifest.json', 'full-result.json', 'decision.json'] as const;
const RECORD_KINDS = new Set(['generic', 'coverage', 'test', 'mutation', 'rtd']);
const RENDER_KINDS = new Set(['decisions', 'rounds', 'test-matrix']);
const TEST_TIERS = new Set([
  'unit',
  'api',
  'db',
  'e2e',
  'mutation',
  'perf',
  'lint',
  'typecheck',
  'coverage',
]);

type JsonRecord = Record<string, unknown>;

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(command: string, text: string): void {
  process.stderr.write(`devai ${command}: ${text}\n`);
  process.exitCode = EXIT_USAGE;
}

function jsonRecord(value: unknown, diagnostic: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${diagnostic}: expected a JSON object`);
  }
  return value as JsonRecord;
}

function parseJson(text: string, diagnostic: string): JsonRecord {
  return jsonRecord(JSON.parse(text) as unknown, diagnostic);
}

function repoRelative(repoRoot: string, path: string): string {
  const result = relative(repoRoot, path);
  if (result.length === 0 || result === '..' || result.startsWith(`..${sep}`)) {
    throw new Error('evidence source must be contained by --repo-root');
  }
  return result.split(sep).join('/');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mergeParents(repoRoot: string, mergeSha: string): string[] {
  const result = spawnSync('git', ['rev-list', '--parents', '-n', '1', mergeSha], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `cannot resolve imported merge ${mergeSha}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const [resolved, ...parents] = result.stdout.trim().split(/\s+/u);
  if (resolved !== mergeSha) throw new Error(`cannot resolve imported merge ${mergeSha}`);
  return parents;
}

interface CollectOptions {
  readonly source?: string;
  readonly repoRoot?: string;
  readonly round?: string;
  readonly tuple?: string;
  readonly job?: string | string[];
  readonly output?: string;
  readonly human?: boolean;
}

function collectActions(options: CollectOptions, repoRoot: string): JsonRecord {
  if (options.tuple === undefined) throw new Error('--tuple is required for --source actions');
  if (options.round === undefined) {
    throw new Error('--round R-NNNN is required for governed Actions collection');
  }
  const tupleRoot = resolve(repoRoot, options.tuple);
  const tupleRelative = repoRelative(repoRoot, tupleRoot);
  const paths = Object.fromEntries(
    TUPLE_FILES.map((name) => [name, resolve(tupleRoot, name)]),
  ) as Record<(typeof TUPLE_FILES)[number], string>;
  const manifest = JSON.parse(readFileSync(paths['manifest.json'], 'utf8')) as unknown;
  const fullResult = JSON.parse(readFileSync(paths['full-result.json'], 'utf8')) as unknown;
  const decision = JSON.parse(readFileSync(paths['decision.json'], 'utf8')) as unknown;
  const mergeSha = (decision as Partial<ActionsEvidenceShadowDecision>).mergedCommitSha;
  if (typeof mergeSha !== 'string') throw new Error('shadow decision merge SHA is missing');
  const observation = validateActionsEvidenceShadowTuple({
    manifest,
    fullResult,
    decision,
    mergeParents: mergeParents(repoRoot, mergeSha),
  });
  const artifacts = TUPLE_FILES.map((name) => ({
    path: `${tupleRelative}/${name}`,
    sha256: sha256(paths[name]),
  }));
  const proof = appendProofEpochRecord({
    repoRoot,
    roundId: options.round,
    kind: 'actions',
    payload: { source: 'actions', observation, artifacts },
  });
  return { source: 'actions', observation, artifacts, proof };
}

function collectLocal(options: CollectOptions, repoRoot: string): JsonRecord {
  const jobDirs: Record<string, string> = {};
  for (const ref of toArray(options.job)) {
    const colon = ref.indexOf(':');
    if (colon <= 0 || colon === ref.length - 1) {
      throw new Error(`invalid --job ${JSON.stringify(ref)}: expected name:dir`);
    }
    jobDirs[ref.slice(0, colon)] = ref.slice(colon + 1);
  }
  if (Object.keys(jobDirs).length === 0) {
    throw new Error('at least one --job <name:dir> is required for --source local');
  }
  const result = collectLocalEvidence({
    repoRoot,
    jobDirs,
    ...(options.output !== undefined && { outputPath: options.output }),
  });
  return {
    source: 'local',
    output: result.outputPath,
    sourceHash: result.manifest.sourceHash,
    jobs: Object.keys(result.manifest.jobs),
  };
}

export const evidenceCollect = defineCommand({
  name: 'evidence collect',
  description: 'Collect governed evidence from one declared source into harness state.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-collect', 'Collect one governed evidence source')
      .option('--source <source>', 'actions | local (required)')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--round <round-id>', 'Round for the Actions proof epoch')
      .option('--tuple <path>', 'Actions tuple directory containing the three canonical files')
      .option('--job <name:dir>', 'Local job artifact directory (repeatable)')
      .option('--output <path>', 'Override the local evidence manifest output')
      .option('--human', 'Human-readable summary')
      .action((options: CollectOptions) => {
        if (options.source !== 'actions' && options.source !== 'local') {
          usage('evidence collect', '--source must be actions or local');
          return;
        }
        try {
          const repoRoot = resolve(options.repoRoot ?? process.cwd());
          const result =
            options.source === 'actions'
              ? collectActions(options, repoRoot)
              : collectLocal(options, repoRoot);
          process.stdout.write(
            options.human === true
              ? `evidence collect: ${options.source} collected\n`
              : `${JSON.stringify(result)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          const kind = error instanceof ActionsEvidenceError ? 'invalid Actions evidence' : 'error';
          process.stderr.write(`devai evidence collect (${kind}): ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});

interface RecordOptions {
  readonly kind?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly payload?: string;
  readonly input?: string;
  readonly in?: string;
  readonly out?: string;
  readonly output?: string;
  readonly perPackage?: boolean;
  readonly final?: boolean;
  readonly tier?: string;
  readonly cmd?: string;
  readonly scope?: string;
  readonly repo?: string;
  readonly timestamp?: string;
  readonly run?: boolean;
  readonly scenarios?: string;
  readonly mutator?: string;
  readonly external?: string;
  readonly reportPath?: string;
  readonly failOnSurvivors?: boolean;
  readonly strict?: boolean;
  readonly noGit?: boolean;
  readonly human?: boolean;
}

function genericPayload(options: RecordOptions, repoRoot: string): JsonRecord {
  if (options.payload !== undefined && options.input !== undefined) {
    throw new Error('--payload and --input are mutually exclusive');
  }
  if (options.payload !== undefined) return parseJson(options.payload, '--payload');
  if (options.input !== undefined) {
    return parseJson(readFileSync(resolve(repoRoot, options.input), 'utf8'), '--input');
  }
  throw new Error('--payload <json> or --input <path> is required for --kind generic');
}

async function recordService(
  kind: string,
  options: RecordOptions,
  repoRoot: string,
): Promise<DirectCommandResult> {
  switch (kind) {
    case 'coverage':
      return invokeCommandService(coverageAggregate, [
        {
          repoRoot,
          ...(options.in !== undefined && { in: options.in }),
          ...(options.out !== undefined && { out: options.out }),
          ...(options.perPackage === true && { perPackage: true }),
          ...(options.final === true && { final: true }),
          human: false,
        },
      ]);
    case 'test':
      if (options.tier === undefined || !TEST_TIERS.has(options.tier)) {
        throw new Error(`--tier must be one of: ${[...TEST_TIERS].join(', ')}`);
      }
      if (options.cmd === undefined || options.cmd.length === 0) {
        throw new Error('--cmd is required for --kind test');
      }
      return invokeCommandService(recordRun, [
        {
          repoRoot,
          tier: options.tier,
          cmd: options.cmd,
          ...(options.scope !== undefined && { scope: options.scope }),
          ...(options.repo !== undefined && { repo: options.repo }),
          ...(options.out !== undefined && { out: options.out }),
          ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
          human: false,
        },
      ]);
    case 'mutation':
      if (options.run !== true) throw new Error('--run is required for --kind mutation');
      if (options.scenarios === undefined) {
        throw new Error('--scenarios is required for --kind mutation --run');
      }
      return invokeCommandService(mutationRun, [
        {
          repoRoot,
          scenarios: options.scenarios,
          ...(options.out !== undefined && { out: options.out }),
          ...(options.mutator !== undefined && { mutator: options.mutator }),
          ...(options.external !== undefined && { external: options.external }),
          ...(options.reportPath !== undefined && { reportPath: options.reportPath }),
          ...(options.failOnSurvivors === true && { failOnSurvivors: true }),
          human: false,
        },
      ]);
    case 'rtd':
      return invokeCommandService(rtdBundle, [
        {
          repoRoot,
          ...(options.output !== undefined && { output: options.output }),
          ...(options.strict === true && { strict: true }),
          ...(options.noGit === true && { noGit: true }),
          human: false,
        },
      ]);
    default:
      throw new Error(`unsupported evidence record kind: ${kind}`);
  }
}

function servicePayload(kind: string, service: DirectCommandResult): JsonRecord {
  const trimmed = service.stdout.trim();
  if (trimmed.length > 0) {
    try {
      return parseJson(trimmed, `${kind} service output`);
    } catch {
      // A failed service may have emitted a non-JSON preamble; preserve it as a diagnostic below.
    }
  }
  return {
    kind,
    service_exit_code: service.exitCode,
    error: service.stderr.trim() || 'service produced no governed JSON result',
  };
}

export const evidenceRecord = defineCommand({
  name: 'evidence record',
  description: 'Record one governed evidence kind through the append-only evidence boundary.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-record', 'Record one governed evidence kind')
      .option('--kind <kind>', 'generic | coverage | test | mutation | rtd (required)')
      .option('--round <round-id>', 'Owning round for the append-only proof epoch (required)')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--payload <json>', 'Generic evidence JSON object')
      .option('--input <path>', 'Generic evidence JSON file')
      .option('--in <path>', 'Coverage input directory')
      .option('--out <path>', 'Coverage, test, or mutation output path')
      .option('--output <path>', 'Additional RTD manifest output path')
      .option('--per-package', 'Include per-package coverage summaries')
      .option('--final', 'Aggregate Istanbul coverage-final.json inputs')
      .option('--tier <tier>', 'Test result tier')
      .option('--cmd <command>', 'Test command to execute and record')
      .option('--scope <scope>', 'Test result scope')
      .option('--repo <slug>', 'Test result repository slug')
      .option('--timestamp <iso>', 'Test result timestamp')
      .option('--run', 'Execute the governed mutation recorder')
      .option('--scenarios <path>', 'Mutation scenarios path')
      .option('--mutator <module>', 'Mutation adapter module')
      .option('--external <path>', 'Pre-computed mutation reports')
      .option('--report-path <path>', 'Rich mutation report reference')
      .option('--fail-on-survivors', 'Fail after recording surviving mutations')
      .option('--strict', 'Fail when the RTD manifest is not ready')
      .option('--no-git', 'Use the RTD zero integration-head sentinel')
      .option('--human', 'Human-readable summary')
      .action(async (options: RecordOptions) => {
        if (options.kind === undefined || !RECORD_KINDS.has(options.kind)) {
          usage('evidence record', '--kind must be generic, coverage, test, mutation, or rtd');
          return;
        }
        if (options.round === undefined) {
          usage('evidence record', '--round R-NNNN is required');
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        try {
          if (options.kind === 'generic') {
            const payload = genericPayload(options, repoRoot);
            const proof = appendProofEpochRecord({
              repoRoot,
              roundId: options.round,
              kind: 'generic',
              payload,
            });
            process.stdout.write(
              options.human === true
                ? `evidence record: generic sequence ${String(proof.sequence)}\n`
                : `${JSON.stringify({ kind: 'generic', round_id: options.round, result: payload, proof })}\n`,
            );
            process.exitCode = EXIT_PASS;
            return;
          }

          const service = await recordService(options.kind, options, repoRoot);
          const result = servicePayload(options.kind, service);
          const proof = appendProofEpochRecord({
            repoRoot,
            roundId: options.round,
            kind: options.kind,
            payload: {
              result,
              service_exit_code: service.exitCode,
              ...(service.stderr.trim().length > 0 && { service_error: service.stderr.trim() }),
            },
          });
          if (service.exitCode !== 0 || service.stderr.length > 0) {
            process.stderr.write(
              `devai evidence record: ${options.kind} exited ${String(service.exitCode)}; governed proof sequence ${String(proof.sequence)}${service.stderr.trim().length > 0 ? `: ${service.stderr.trim()}` : ''}\n`,
            );
            process.exitCode = service.exitCode === 0 ? EXIT_FAIL : service.exitCode;
            return;
          }
          process.stdout.write(
            options.human === true
              ? `evidence record: ${options.kind} sequence ${String(proof.sequence)}\n`
              : `${JSON.stringify({ kind: options.kind, round_id: options.round, result, proof })}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(`devai evidence record: ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});

interface RedactOptions {
  readonly round?: string;
  readonly kind?: string;
  readonly field?: string | string[];
  readonly pattern?: string | string[];
  readonly reason?: string;
  readonly repoRoot?: string;
  readonly human?: boolean;
}

export const evidenceRedact = defineCommand({
  name: 'evidence redact',
  description: 'Append a governed redaction erratum without rewriting prior proof bytes.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-redact <target-sequence>', 'Redact one proof-epoch record by erratum')
      .option('--round <round-id>', 'Owning proof-epoch round (required)')
      .option('--kind <kind>', 'Owning proof-epoch kind (required)')
      .option('--field <name>', 'Payload field to redact (repeatable)')
      .option('--pattern <regex>', 'Payload string pattern to redact (repeatable)')
      .option('--reason <text>', 'Reason for the immutable erratum (required)')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--human', 'Human-readable summary')
      .action((targetSequence: string, options: RedactOptions) => {
        if (options.round === undefined || options.kind === undefined) {
          usage('evidence redact', '--round and --kind are required');
          return;
        }
        const sequence = Number(targetSequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          usage('evidence redact', '<target-sequence> must be a positive integer');
          return;
        }
        if (options.reason === undefined || options.reason.trim().length === 0) {
          usage('evidence redact', '--reason is required');
          return;
        }
        const fields = toArray(options.field);
        const rawPatterns = toArray(options.pattern);
        if (fields.length === 0 && rawPatterns.length === 0) {
          usage('evidence redact', 'at least one --field or --pattern is required');
          return;
        }
        try {
          const repoRoot = resolve(options.repoRoot ?? process.cwd());
          const epoch = verifyProofEpoch({
            repoRoot,
            roundId: options.round,
            kind: options.kind,
            requireClosed: false,
          });
          if (!epoch.valid) throw new Error(`proof epoch is invalid: ${epoch.errors.join('; ')}`);
          const target = epoch.lines[sequence - 1];
          if (target?.line_type !== 'record') {
            throw new Error(`target sequence ${String(sequence)} is not a proof record`);
          }
          const patterns = rawPatterns.map((pattern) => new RegExp(pattern, 'gu'));
          const payload = jsonRecord(redact(target.payload, { fields, patterns }), 'redaction');
          const proof = appendProofEpochErrata({
            repoRoot,
            roundId: options.round,
            kind: options.kind,
            payload,
            correctsSequence: sequence,
            reason: options.reason,
          });
          process.stdout.write(
            options.human === true
              ? `evidence redact: ${options.kind} sequence ${String(sequence)} corrected by ${String(proof.sequence)}\n`
              : `${JSON.stringify({ kind: options.kind, round_id: options.round, corrected_sequence: sequence, proof })}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(`devai evidence redact: ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});

interface RenderOptions {
  readonly kind?: string;
  readonly repoRoot?: string;
  readonly out?: string;
  readonly in?: string;
  readonly format?: string;
  readonly filter?: string;
  readonly config?: string;
  readonly view?: string;
  readonly includeDuration?: boolean;
  readonly includeThresholds?: boolean;
  readonly thresholdsPath?: string;
  readonly strict?: boolean;
  readonly human?: boolean;
}

function explicitWrite(): boolean {
  return process.argv.includes('--write');
}

export const evidenceRender = defineCommand({
  name: 'evidence render',
  description: 'Render one evidence view from canonical records.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-render', 'Render one canonical evidence view')
      .option('--kind <kind>', 'decisions | rounds | test-matrix (required)')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--out <path>', 'Write the rendered view to this path')
      .option('--in <path>', 'Test-result input directory')
      .option('--format <format>', 'Test matrix format: md | html')
      .option('--filter <expr>', 'Test matrix filter')
      .option('--config <path>', 'Test matrix configuration')
      .option('--view <name>', 'Test matrix named view')
      .option('--include-duration', 'Include test durations')
      .option('--include-thresholds', 'Include test thresholds')
      .option('--thresholds-path <path>', 'Threshold configuration path')
      .option('--strict', 'Fail on test-matrix readiness violations')
      .option('--human', 'Human-readable write receipt')
      .action(async (options: RenderOptions) => {
        if (options.kind === undefined || !RENDER_KINDS.has(options.kind)) {
          usage('evidence render', '--kind must be decisions, rounds, or test-matrix');
          return;
        }
        if (options.out !== undefined && !explicitWrite()) {
          usage('evidence render', '--out requires --write');
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        try {
          if (options.kind === 'test-matrix') {
            const service = await invokeCommandService(renderMatrix, [
              {
                repoRoot,
                ...(options.out !== undefined && { out: options.out }),
                ...(options.in !== undefined && { in: options.in }),
                ...(options.format !== undefined && { format: options.format }),
                ...(options.filter !== undefined && { filter: options.filter }),
                ...(options.config !== undefined && { config: options.config }),
                ...(options.view !== undefined && { view: options.view }),
                ...(options.includeDuration === true && { includeDuration: true }),
                ...(options.includeThresholds === true && { includeThresholds: true }),
                ...(options.thresholdsPath !== undefined && {
                  thresholdsPath: options.thresholdsPath,
                }),
                ...(options.strict === true && { strict: true }),
                human: false,
              },
            ]);
            if (service.exitCode !== 0 || service.stderr.length > 0) {
              process.stderr.write(
                `devai evidence render: ${service.stderr.trim() || `test-matrix exited ${String(service.exitCode)}`}\n`,
              );
              process.exitCode = service.exitCode === 0 ? EXIT_FAIL : service.exitCode;
              return;
            }
            if (options.out !== undefined) {
              process.stdout.write(
                `${JSON.stringify({ kind: 'test-matrix', out: options.out })}\n`,
              );
            } else {
              process.stdout.write(service.stdout);
            }
            process.exitCode = EXIT_PASS;
            return;
          }

          const body =
            options.kind === 'decisions'
              ? renderDecisionRecords({ repoRoot })
              : renderRoundRecords({ repoRoot });
          if (options.out === undefined) {
            process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
          } else {
            writeGovernanceProjectionSync(resolve(repoRoot, options.out), body);
            process.stdout.write(
              options.human === true
                ? `evidence render: wrote ${options.kind} to ${options.out}\n`
                : `${JSON.stringify({ kind: options.kind, out: options.out, bytes: Buffer.byteLength(body) })}\n`,
            );
          }
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(`devai evidence render: ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});

interface VerifyOptions {
  readonly scope?: string;
  readonly showHead?: boolean;
  readonly chain?: string;
  readonly repoRoot?: string;
  readonly mode?: string;
  readonly manifest?: string;
  readonly actor?: string;
  readonly trustedActors?: string;
  readonly eventName?: string;
  readonly ref?: string;
  readonly headMessage?: string;
  readonly changedFiles?: string;
  readonly human?: boolean;
}

interface GithubEvent {
  readonly head_commit?: { readonly message?: string };
  readonly before?: string;
}

function githubEvent(): GithubEvent {
  const path = process.env['GITHUB_EVENT_PATH'];
  if (path === undefined || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GithubEvent;
  } catch {
    return {};
  }
}

function changedFiles(
  repoRoot: string,
  options: VerifyOptions,
  event: GithubEvent,
): string[] | null {
  if (options.changedFiles !== undefined) {
    return readFileSync(resolve(repoRoot, options.changedFiles), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean);
  }
  const declared = process.env['LOCAL_EVIDENCE_CHANGED_FILES'];
  if (declared !== undefined && declared.length > 0)
    return declared.split(/\r?\n/u).filter(Boolean);
  const before = event.before ?? process.env['GITHUB_EVENT_BEFORE'] ?? '';
  const after = process.env['GITHUB_SHA'] ?? '';
  if (before.length === 0 || after.length === 0) return null;
  const args = /^0+$/u.test(before)
    ? ['diff-tree', '--no-commit-id', '--name-only', '-r', after]
    : ['diff', '--name-only', `${before}..${after}`];
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/u).filter(Boolean) : null;
}

export const evidenceVerify = defineCommand({
  name: 'evidence verify',
  description:
    'Verify a declared evidence scope, including optional read-only chain-head inspection.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('evidence-verify', 'Verify one declared evidence scope')
      .option('--scope <scope>', 'local | chain (required)')
      .option('--show-head', 'Include the evidence chain head (chain scope only)')
      .option('--chain <path>', `Evidence chain path (default: ${DEFAULT_CHAIN_PATH})`)
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--mode <mode>', 'Local mode: auto | strict | gate')
      .option('--manifest <path>', 'Local evidence manifest override')
      .option('--actor <github-user>', 'GitHub actor for local verification')
      .option('--trusted-actors <list>', 'Trusted GitHub actor list')
      .option('--event-name <name>', 'GitHub event name override')
      .option('--ref <ref>', 'Git ref override')
      .option('--head-message <text>', 'Head commit message override')
      .option('--changed-files <path>', 'Newline-separated changed-file list')
      .option('--human', 'Human-readable result')
      .action((options: VerifyOptions) => {
        if (options.scope !== 'local' && options.scope !== 'chain') {
          usage('evidence verify', '--scope must be local or chain');
          return;
        }
        if (options.showHead === true && options.scope !== 'chain') {
          usage('evidence verify', '--show-head is valid only with --scope chain');
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        try {
          if (options.scope === 'chain') {
            const chainPath = resolve(repoRoot, options.chain ?? DEFAULT_CHAIN_PATH);
            const verification = verifyChain(chainPath);
            const result = {
              scope: 'chain',
              valid: verification.valid,
              errors: verification.errors,
              ...(options.showHead === true && { head: loadChain(chainPath).head }),
            };
            if (verification.valid) {
              process.stdout.write(
                options.human === true
                  ? `evidence chain: valid${options.showHead === true ? `; head ${String(result.head ?? '')}` : ''}\n`
                  : `${JSON.stringify(result)}\n`,
              );
              process.exitCode = EXIT_PASS;
            } else {
              process.stderr.write(
                `devai evidence verify: invalid chain: ${verification.errors.join('; ')}\n`,
              );
              process.exitCode = EXIT_FAIL;
            }
            return;
          }

          const mode = (options.mode ?? 'auto') as VerifyMode;
          if (!['auto', 'strict', 'gate'].includes(mode)) {
            usage('evidence verify', `unsupported --mode ${mode}`);
            return;
          }
          const event = githubEvent();
          const context: VerifyContext = {
            eventName: options.eventName ?? process.env['GITHUB_EVENT_NAME'] ?? '',
            ref: options.ref ?? process.env['GITHUB_REF'] ?? '',
            actor: options.actor ?? process.env['GITHUB_ACTOR'] ?? '',
            headMessage:
              options.headMessage ??
              process.env['LOCAL_EVIDENCE_HEAD_MESSAGE'] ??
              event.head_commit?.message ??
              '',
            changedFiles: changedFiles(repoRoot, options, event),
          };
          const result = verifyLocalEvidence({
            repoRoot,
            mode,
            context,
            trustedActors: normalizeActorList(
              options.trustedActors ?? process.env['LOCAL_EVIDENCE_TRUSTED_ACTORS'] ?? '',
            ),
            ...(options.manifest !== undefined && { manifestPath: options.manifest }),
          });
          process.stdout.write(
            options.human === true
              ? `${result.message}\n`
              : `${JSON.stringify({ scope: 'local', mode, ...result })}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          const kind = error instanceof LocalEvidenceError ? 'policy failure' : 'error';
          process.stderr.write(`devai evidence verify (${kind}): ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
