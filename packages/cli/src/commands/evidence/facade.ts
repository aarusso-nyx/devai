import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { spawnSync, writeGovernanceProjectionSync } from '@devai-nyx/authority';
import {
  LocalEvidenceError,
  appendProofEpochErrata,
  loadChain,
  normalizeActorList,
  verifyChain,
  verifyLocalEvidence,
  verifyProofEpoch,
  type VerifyContext,
  type VerifyMode,
} from '#runtime-core';
import { renderDecisionRecords, renderRoundRecords } from '@devai-nyx/loop';
import { EXIT_FAIL, EXIT_PASS, redact } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

import { renderMatrix } from '../render/matrix.js';

import { invokeCommandService } from './direct-command.js';
import { toArray, usage, message, jsonRecord } from './facade-shared.js';
export { evidenceCollect, evidenceRecord } from './facade-collect-record.js';

const DEFAULT_CHAIN_PATH = 'record/proofs/chain.json';
const RENDER_KINDS = new Set(['decisions', 'rounds', 'test-matrix']);

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
