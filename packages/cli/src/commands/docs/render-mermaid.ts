import type { CAC } from 'cac';
import { findMmdc, renderMermaidInDocs } from '#runtime-core';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = '.';

/**
 * Phase 17.F gap-5 close: `devai docs render mermaid` — scan
 * <repoRoot>/docs/ for *.md files, extract every ```mermaid fenced
 * block, render each to <outDir>/<source-stem>[-<index>].<format>.
 *
 * Graceful absence: when `mmdc` is not on PATH, the scan still
 * runs and reports blocks_found; rendering is skipped without
 * surfacing as a hard fail. Exit-code policy:
 *   EXIT_PASS    everything rendered (and no errors)
 *   EXIT_REVIEW  mmdc absent → blocks reported but unrendered
 *   EXIT_FAIL    mmdc present but some renders errored
 */

interface Options {
  readonly repoRoot?: string;
  readonly scanDir?: string;
  readonly outDir?: string;
  readonly format?: 'png' | 'svg' | 'pdf';
  readonly human?: boolean;
}

export const docsRenderMermaid = defineCommand({
  name: 'docs render-mermaid',
  description: 'Extract ```mermaid blocks from docs/*.md and render each to PNG/SVG/PDF via mmdc',
  authority: 'host_tooling',
  register(cli: CAC): void {
    cli
      .command(
        'docs-render-mermaid',
        'Render every Mermaid block under docs/ (graceful when mmdc absent)',
      )
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--scan-dir <path>', 'Subdirectory under repo-root to scan (default: docs)')
      .option('--out-dir <path>', 'Output directory (default: docs/diagrams)')
      .option('--format <fmt>', 'Output format: png | svg | pdf (default: png)')
      .option('--human', 'Human-readable summary')
      .action((options: Options) => {
        const detection = findMmdc();
        const result = renderMermaidInDocs({
          repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
          ...(options.scanDir !== undefined && { scanDir: options.scanDir }),
          ...(options.outDir !== undefined && { outDir: options.outDir }),
          ...(options.format !== undefined && { format: options.format }),
        });

        if (options.human === true) {
          const lines: string[] = [
            `docs render-mermaid: ${detection.available ? `mmdc ${detection.version ?? 'present'} @ ${detection.path ?? '?'}` : 'mmdc NOT FOUND (skipping render)'}`,
            `  files scanned: ${String(result.files_scanned)}`,
            `  blocks found:  ${String(result.blocks_found)}`,
            `  rendered:      ${String(result.rendered)}`,
            ...(result.skipped_no_mmdc > 0
              ? [`  skipped (no mmdc): ${String(result.skipped_no_mmdc)}`]
              : []),
            ...(result.errors.length > 0
              ? [
                  `  errors:        ${String(result.errors.length)}`,
                  ...result.errors.map(
                    (e) => `    ${e.file}#${String(e.index)}: ${e.message.slice(0, 200)}`,
                  ),
                ]
              : []),
            ...result.outputs.map((o) => `  -> ${o.out_path}`),
          ];
          process.stdout.write(lines.join('\n') + '\n');
        } else {
          process.stdout.write(JSON.stringify({ ...result, mmdc: detection }) + '\n');
        }

        if (result.errors.length > 0) process.exit(EXIT_FAIL);
        process.exitCode =
          !detection.available && result.blocks_found > 0 ? EXIT_REVIEW : EXIT_PASS;
      });
  },
});
