import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { CAC } from 'cac';
import { spawnSync } from '@devai-nyx/authority';
import {
  ActionsEvidenceError,
  appendVerbEvidence,
  appendProofEpochRecord,
  collectLocalEvidence,
  validateActionsEvidenceShadowTuple,
  type ActionsEvidenceShadowDecision,
} from '#runtime-core';
import { validators } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { coverageAggregate } from '../coverage/aggregate.js';
import { mutationRun } from '../mutation/run.js';
import { recordRun } from '../record/run.js';
import { rtdBundle } from '../rtd/index.js';
import { invokeCommandService, type DirectCommandResult } from './direct-command.js';
import { type JsonRecord, toArray, usage, message, parseJson } from './facade-shared.js';

const TUPLE_FILES = ['manifest.json', 'full-result.json', 'decision.json'] as const;
const RECORD_KINDS = new Set(['generic', 'historical-gap', 'coverage', 'test', 'mutation', 'rtd']);
const validateHistoricalGap = validators.proofOrphanDeclaration;

/**
 * ADR-EVI-0002: the second step of the two-step writer. The chain entry anchors the proof line by
 * the digest of its bytes on disk (`proof_path`, `proof_sequence`, `proof_sha256`) and keeps the
 * historical `notes` form for readers.
 */
function anchorProofLine(
  repoRoot: string,
  action: string,
  status: 'completed' | 'failed',
  roundId: string,
  kind: string,
  sequence: number,
): ReturnType<typeof appendVerbEvidence> {
  const chain = appendVerbEvidence({
    repoRoot,
    action,
    status,
    notes: [`round_id=${roundId}`, `proof_sequence=${String(sequence)}`],
    proofAnchor: { path: `record/proofs/work/${kind}/${roundId}.jsonl`, sequence },
  });
  if (!chain.ok) {
    throw new Error(`EVIDENCE_CHAIN_APPEND_FAILED:${chain.error ?? 'unknown error'}`);
  }
  return chain;
}
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
  const chain = anchorProofLine(
    repoRoot,
    'evidence.collect.actions',
    'completed',
    options.round,
    'actions',
    proof.sequence,
  );
  return { source: 'actions', observation, artifacts, proof, chain };
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
  throw new Error(
    `--payload <json> or --input <path> is required for --kind ${options.kind ?? 'generic'}`,
  );
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
      return invokeCommandService(mutationRun, [{}]);
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
      .option(
        '--kind <kind>',
        'generic | historical-gap | coverage | test | mutation | rtd (required)',
      )
      .option('--round <round-id>', 'Owning round for the append-only proof epoch (required)')
      .option('--repo-root <path>', 'Repository root (default: cwd)')
      .option('--payload <json>', 'Generic or historical-gap evidence JSON object')
      .option('--input <path>', 'Generic or historical-gap evidence JSON file')
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
          usage(
            'evidence record',
            '--kind must be generic, historical-gap, coverage, test, mutation, or rtd',
          );
          return;
        }
        if (options.kind === 'mutation') {
          const result = await invokeCommandService(mutationRun, [{}]);
          process.stdout.write(result.stdout);
          process.exitCode = EXIT_PASS;
          return;
        }
        if (options.round === undefined) {
          usage('evidence record', '--round R-NNNN is required');
          return;
        }
        const repoRoot = resolve(options.repoRoot ?? process.cwd());
        try {
          if (options.kind === 'generic' || options.kind === 'historical-gap') {
            const kind = options.kind;
            const payload = genericPayload(options, repoRoot);
            if (kind === 'historical-gap' && !validateHistoricalGap(payload)) {
              throw new Error(
                `historical-gap payload does not validate against proof-orphan-declaration.schema.json: ${JSON.stringify(validateHistoricalGap.errors)}`,
              );
            }
            const proof = appendProofEpochRecord({
              repoRoot,
              roundId: options.round,
              kind,
              payload,
            });
            const chain = anchorProofLine(
              repoRoot,
              `evidence.record.${kind}`,
              'completed',
              options.round,
              kind,
              proof.sequence,
            );
            process.stdout.write(
              options.human === true
                ? `evidence record: ${kind} sequence ${String(proof.sequence)}\n`
                : `${JSON.stringify({ kind, round_id: options.round, result: payload, proof, chain })}\n`,
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
          const failed = service.exitCode !== 0 || service.stderr.length > 0;
          const chain = anchorProofLine(
            repoRoot,
            `evidence.record.${options.kind}`,
            failed ? 'failed' : 'completed',
            options.round,
            options.kind,
            proof.sequence,
          );
          if (failed) {
            process.stderr.write(
              `devai evidence record: ${options.kind} exited ${String(service.exitCode)}; governed proof sequence ${String(proof.sequence)}${service.stderr.trim().length > 0 ? `: ${service.stderr.trim()}` : ''}\n`,
            );
            process.exitCode = service.exitCode === 0 ? EXIT_FAIL : service.exitCode;
            return;
          }
          process.stdout.write(
            options.human === true
              ? `evidence record: ${options.kind} sequence ${String(proof.sequence)}\n`
              : `${JSON.stringify({ kind: options.kind, round_id: options.round, result, proof, chain })}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(`devai evidence record: ${message(error)}\n`);
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
