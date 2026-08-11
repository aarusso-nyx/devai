import { writeFileSync } from '@devai-nyx/authority';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { buildRtdManifest, persistRtdManifest } from '#runtime-core';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = process.cwd();

interface BundleOptions {
  readonly repoRoot?: string;
  readonly output?: string;
  readonly strict?: boolean;
  readonly noGit?: boolean;
  readonly human?: boolean;
}

export const rtdBundle = defineCommand({
  name: 'rtd bundle',
  description: 'Build a hash-stamped RTD manifest aggregating the current specification contract.',
  authority: 'specifier',
  register(cli: CAC): void {
    cli
      .command('rtd-bundle', 'Build an RTD manifest aggregate')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option(
        '--output <path>',
        'Write the manifest JSON to this path in addition to .devai/state/rtd-manifests/',
      )
      .option(
        '--no-git',
        'Use the 40-char zero sentinel as integration_head instead of `git rev-parse HEAD`',
      )
      .option('--strict', 'Exit non-zero when readiness.ok is false (default: always exit 0)')
      .option('--human', 'Human-readable summary')
      .action((options: BundleOptions) => {
        try {
          const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
          const manifest = buildRtdManifest({
            repoRoot,
            ...(options.noGit === true && { integrationHead: '0'.repeat(40) }),
          });
          const persistedPath = persistRtdManifest(manifest, repoRoot);
          if (options.output !== undefined) {
            writeFileSync(options.output, JSON.stringify(manifest, null, 2) + '\n');
          }
          if (options.human === true) {
            const lines: string[] = [];
            lines.push(
              `rtd bundle: ${manifest.id}  readiness=${manifest.readiness.ok ? 'ok' : 'FAIL'}  hash=${manifest.manifest_hash.slice(0, 12)}…`,
            );
            for (const v of manifest.readiness.sub_verdicts) {
              const tag = v.ok ? '✓' : '✗';
              const ec = v.error_count !== undefined ? ` (${String(v.error_count)} error(s))` : '';
              lines.push(`  ${tag} ${v.component}${ec}`);
            }
            lines.push(`  persisted: ${persistedPath}`);
            process.stdout.write(lines.join('\n') + '\n');
          } else {
            process.stdout.write(JSON.stringify(manifest) + '\n');
          }
          process.exitCode =
            options.strict === true && !manifest.readiness.ok ? EXIT_FAIL : EXIT_PASS;
        } catch (err) {
          process.stderr.write(
            `devai evidence record --kind rtd: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(EXIT_FAIL);
        }
      });
  },
});
