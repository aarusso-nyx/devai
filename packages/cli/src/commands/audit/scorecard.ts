import { spawnSync } from '@devai-nyx/authority';
import {
  computeScorecard,
  loadReadingsFromDir,
  loadScorecardFailureMaxAgeMs,
  loadScorecardNaConfig,
  resolveScorecardNaPath,
  scorecardNaCellSet,
} from '@devai-nyx/loop';
import { validators } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import type { CAC } from 'cac';
import { join, resolve } from 'node:path';
import { defineCommand } from '../../define-command.js';

interface AuditScorecardOptions {
  readonly repoRoot?: string;
  readonly at?: string;
  readonly human?: boolean;
}

const FULL_SHA = /^[0-9a-f]{40}$/u;

function git(repoRoot: string, args: readonly string[], code: string): string {
  const result = spawnSync('git', [...args], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${code}:${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/** Compute the exact-HEAD scorecard without persisting any audit or evidence artifact. */
export const auditScorecard = defineCommand({
  name: 'audit scorecard',
  description: 'Compute the deterministic scorecard for the exact current repository commit.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('audit-scorecard', 'Compute the read-only exact-HEAD scorecard')
      .option('--repo-root <path>', 'Repository root (required)')
      .option('--at <full-sha>', 'Mandatory exact 40-character current commit SHA')
      .option('--human', 'Human-readable summary')
      .action((options: AuditScorecardOptions) => {
        if (options.repoRoot === undefined) {
          process.stderr.write('devai audit scorecard: --repo-root is required\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        if (options.at === undefined || !FULL_SHA.test(options.at)) {
          process.stderr.write('devai audit scorecard: --at requires a full 40-character SHA\n');
          process.exitCode = EXIT_USAGE;
          return;
        }
        const repoRoot = resolve(options.repoRoot);
        try {
          const head = git(repoRoot, ['rev-parse', 'HEAD'], 'AUDIT_SCORECARD_HEAD_UNAVAILABLE');
          if (head !== options.at) throw new Error('AUDIT_SCORECARD_EXACT_HEAD_REQUIRED');
          const timestamp = git(
            repoRoot,
            ['show', '-s', '--format=%cI', options.at],
            'AUDIT_SCORECARD_TIMESTAMP_UNAVAILABLE',
          );
          const readings = loadReadingsFromDir(join(repoRoot, 'record/proofs/freshness/readings'));
          const scorecard = computeScorecard({
            timestamp,
            integrationHead: options.at,
            readings,
            naCells: scorecardNaCellSet(
              loadScorecardNaConfig(resolveScorecardNaPath(repoRoot)),
            ),
            staleFailAfterMs: loadScorecardFailureMaxAgeMs(repoRoot),
          });
          if (!validators.scorecard(scorecard)) {
            throw new Error(`AUDIT_SCORECARD_INVALID:${JSON.stringify(validators.scorecard.errors)}`);
          }
          process.stdout.write(
            options.human === true
              ? `audit scorecard: ${scorecard.overall.verdict} ${options.at}\n`
              : `${JSON.stringify(scorecard)}\n`,
          );
          process.exitCode = EXIT_PASS;
        } catch (error) {
          process.stderr.write(
            `devai audit scorecard: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_FAIL;
        }
      });
  },
});
