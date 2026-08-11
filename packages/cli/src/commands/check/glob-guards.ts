import { join } from 'node:path';
import type { CAC } from 'cac';
import { evaluateGlobGuards, type GlobGuardResult } from '#runtime-core';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

/**
 * Glob-guard validation behind the canonical `check` facade: every
 * guard in `.devai/config/glob-guards.json` must still match at least
 * its declared `min_matches`. Unlike `check forbidden-actions`
 * (D-123, item 6), there is no legacy caller to stay backward
 * compatible with — a registered guard failing IS the point, so the
 * default (non-`--strict`) exit already fails when any guard fails.
 * An absent or empty registry is valid: 0 guards declared, 0 checked,
 * exits PASS.
 */
const DEFAULT_REPO_ROOT = '.';
const DEFAULT_REGISTRY_RELATIVE = '.devai/config/glob-guards.json';

export interface CheckGlobGuardsReport {
  readonly registry_entries: number;
  readonly results: readonly GlobGuardResult[];
  readonly failing: readonly string[];
  readonly ok: boolean;
}

export interface CheckGlobGuardsOptions {
  readonly repoRoot: string;
  readonly registryPath?: string;
}

export function checkGlobGuards(options: CheckGlobGuardsOptions): CheckGlobGuardsReport {
  const registryPath = options.registryPath ?? join(options.repoRoot, DEFAULT_REGISTRY_RELATIVE);
  const results = evaluateGlobGuards(options.repoRoot, registryPath);
  const failing = results.filter((r) => !r.ok).map((r) => r.id);
  return { registry_entries: results.length, results, failing, ok: failing.length === 0 };
}

export const checkGlobGuardsCmd = defineCommand({
  name: 'check glob-guards',
  description:
    'Evaluate .devai/config/glob-guards.json: every registered pattern must still match at least min_matches files. Catches a CI trigger path, generator input dir, or validation-loop target silently degrading to zero matches after a rename or format migration.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command('check-glob-guards', 'Evaluate the glob-guards registry against the real tree')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option(
        '--registry <path>',
        `Registry path (default: <repo-root>/${DEFAULT_REGISTRY_RELATIVE})`,
      )
      .option('--human', 'Human-readable output')
      .action((options: { repoRoot?: string; registry?: string; human?: boolean }) => {
        const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
        const report = checkGlobGuards({
          repoRoot,
          ...(options.registry !== undefined && { registryPath: options.registry }),
        });

        if (options.human === true) {
          const lines: string[] = [
            `check glob-guards: ${report.ok ? 'OK' : 'FAIL'} (${String(report.registry_entries)} guard(s), ${String(report.failing.length)} failing)`,
          ];
          for (const r of report.results) {
            const mark = r.ok ? '✓' : '✗';
            lines.push(
              `  [${mark}] ${r.id}: '${r.pattern}' matched ${String(r.match_count)} (need ≥${String(r.min_matches)})`,
            );
            if (!r.ok && r.sample_matches.length > 0) {
              lines.push(`      sample matches: ${r.sample_matches.join(', ')}`);
            }
          }
          process.stdout.write(lines.join('\n') + '\n');
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }

        process.exitCode = report.ok ? EXIT_PASS : EXIT_FAIL;
      });
  },
});
