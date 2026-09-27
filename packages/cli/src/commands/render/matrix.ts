import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import {
  buildMatrix,
  DEFAULT_CONFIG_PATH,
  DEFAULT_THRESHOLDS_PATH,
  type Options,
  parseFilter,
  loadConfig,
  loadThresholds,
  readAllResults,
} from './matrix-build.js';
import { renderHtml, renderMarkdown, checkStrict } from './matrix-render.js';

const DEFAULT_REPO_ROOT = process.cwd();
const DEFAULT_INPUT_DIR = '.devai/state/test-results';

const RENDER_MATRIX_EXTENDED_DOC = `### Options

| Flag | Default | Description |
|---|---|---|
| \`--repo-root <path>\` | \`cwd\` | Repository root to resolve all relative paths against. |
| \`--in <dir>\` | \`.devai/state/test-results\` | Input directory of test-result JSON records. |
| \`--out <path>\` | stdout | Output path. Directories are created automatically. |
| \`--format md\\|html\` | \`md\` | Output format. |
| \`--filter <expr>\` | — | Comma-separated filter: e.g. \`tier=unit\\|e2e,status=pass\\|fail\`. |
| \`--config <path>\` | \`.devai/config/test-matrix.json\` if present | Test-matrix config (tiers, scopes_include, scopes_exclude, na_overrides). |
| \`--view timings\` | — | Named view preset: \`timings\` enables duration display (alias for \`--include-duration\`). |
| \`--include-duration\` | off | Show \`duration_ms\` from each record in human format (ms / s / m s). |
| \`--include-thresholds\` | off | Annotate coverage/mutation cells with threshold values from \`.devai/config/thresholds.json\`. |
| \`--thresholds-path <path>\` | \`.devai/config/thresholds.json\` | Override path to thresholds config (used with \`--include-thresholds\` or \`--strict\`). |
| \`--strict\` | off | Exit non-zero if any required tier/scope record is missing, stale, or below threshold. |
| \`--format human\` | off | Emit a human-readable banner when writing to \`--out\`. |

### Worked examples

#### 1. Default view (basic grid)

\`\`\`sh
devai evidence test matrix --repo-root . --format md
\`\`\`

Produces a plain Markdown grid using all observed scopes and tiers:

\`\`\`markdown
# Test matrix

| Scope | unit | e2e | coverage | mutation |
|---|---|---|---|---|
| teat-workspace | PASS 5/5 | PASS 3/3 | PASS 80.2% | PASS 92.0% |
\`\`\`

#### 2. Timings view

\`\`\`sh
devai evidence test matrix --repo-root . --view timings
\`\`\`

Appends human-readable duration to each cell (ms / s / m s):

\`\`\`markdown
# Test matrix

| Scope | unit | e2e | coverage |
|---|---|---|---|
| teat-workspace | PASS 350ms | PASS 2.5s | PASS 1m 12s |
\`\`\`

#### 3. Strict mode with threshold annotations

\`\`\`sh
devai evidence test matrix --repo-root . --include-thresholds --strict
\`\`\`

Annotates coverage and mutation cells with the configured threshold from \`.devai/config/thresholds.json\`, then exits non-zero if any required record is missing, stale, or below threshold. The matrix is always rendered to stdout before any strict-mode exit.

\`\`\`markdown
# Test matrix

| Scope | unit | coverage | mutation |
|---|---|---|---|
| teat-workspace | PASS 5/5 | PASS 80.2% / req 75.0% | PASS 92.0% / req 60.0% |
\`\`\`

Violations are written to stderr:

\`\`\`
devai evidence test matrix: strict mode — 1 violation(s):
  [pkg-internal/coverage] below threshold: coverage 50.0% < required 75.0%
\`\`\`
`;

export const renderMatrix = defineCommand({
  name: 'render matrix',
  description:
    'Render a (scope × tier) test-result matrix as Markdown or HTML. Reads test-result.schema.json-conformant records under .devai/state/test-results/. Example: `devai evidence test matrix --format md --out reports/matrix.md`.',
  authority: 'mesh_controller',
  extended_doc: RENDER_MATRIX_EXTENDED_DOC,
  register(cli: CAC): void {
    cli
      .command(
        'render-matrix',
        'Render a (scope × tier) test-result matrix from test-result records',
      )
      .option('--repo-root <path>', `Repo root (default: cwd)`)
      .option('--in <dir>', `Input dir of test-result records (default: ${DEFAULT_INPUT_DIR})`)
      .option('--out <path>', 'Output path (default: stdout)')
      .option('--format <fmt>', 'Output format: md|html (default: md)')
      .option(
        '--filter <expr>',
        'Filter expression, comma-separated. e.g. tier=unit|e2e,status=pass|fail',
      )
      .option(
        '--config <path>',
        `Optional test-matrix.config.json (per law/schemas/test-matrix.schema.json). Default: ${DEFAULT_CONFIG_PATH} if present, otherwise no config.`,
      )
      .option('--view <name>', 'Named view preset: timings (alias for --include-duration)')
      .option(
        '--include-duration',
        'Show duration_ms from each test-result record in human-readable format',
      )
      .option(
        '--include-thresholds',
        'Annotate coverage/mutation cells with configured thresholds from .devai/config/thresholds.json',
      )
      .option(
        '--thresholds-path <path>',
        `Path to thresholds config (default: ${DEFAULT_THRESHOLDS_PATH})`,
      )
      .option(
        '--strict',
        'Exit non-zero if any required tier/scope record is missing, stale, or below threshold',
      )
      .option('--human', 'Human-readable banner; otherwise emits the raw format')
      .action(async (options: Options) => {
        try {
          const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
          const inDir = resolve(repoRoot, options.in ?? DEFAULT_INPUT_DIR);
          const format = (options.format ?? 'md').toLowerCase();
          if (format !== 'md' && format !== 'html') {
            process.stderr.write(
              `devai evidence test matrix: --format must be md|html (got '${format}')\n`,
            );
            process.exit(EXIT_USAGE);
          }

          // Resolve view presets.
          const viewName = options.view?.toLowerCase();
          if (viewName !== undefined && viewName !== 'timings') {
            process.stderr.write(
              `devai evidence test matrix: --view must be 'timings' (got '${viewName}')\n`,
            );
            process.exit(EXIT_USAGE);
          }
          const showDuration = options.includeDuration === true || viewName === 'timings';
          const showThresholds = options.includeThresholds === true;

          const filter = parseFilter(options.filter);
          const config = loadConfig(repoRoot, options.config);
          const thresholds =
            showThresholds || options.strict === true
              ? loadThresholds(repoRoot, options.thresholdsPath)
              : undefined;

          const results = readAllResults(inDir);
          const matrix = buildMatrix(results, filter, config, {
            showDuration,
            showThresholds,
            thresholds,
          });
          const body = format === 'html' ? renderHtml(matrix) : renderMarkdown(matrix);

          if (options.out !== undefined) {
            const { dirname } = await import('node:path');
            mkdirSync(dirname(resolve(repoRoot, options.out)), { recursive: true });
            writeFileSync(resolve(repoRoot, options.out), body);
            if (options.human === true) {
              process.stdout.write(
                `devai evidence test matrix: wrote ${String(matrix.scopes.length)} scope(s) × ${String(matrix.tiers.length)} tier(s) → ${options.out}\n`,
              );
            }
          } else {
            process.stdout.write(body);
            if (!body.endsWith('\n')) process.stdout.write('\n');
          }

          // Strict-mode check — runs after rendering so the matrix is always emitted.
          if (options.strict === true) {
            const violations = checkStrict(matrix, { config, thresholds, results });
            if (violations.length > 0) {
              process.stderr.write(
                `devai evidence test matrix: strict mode — ${String(violations.length)} violation(s):\n`,
              );
              for (const v of violations) {
                process.stderr.write(`  [${v.scope}/${v.tier}] ${v.reason}\n`);
              }
              process.exitCode = EXIT_FAIL;
              return;
            }
          }

          process.exitCode = EXIT_PASS;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`devai evidence test matrix: ${msg}\n`);
          process.exit(EXIT_FAIL);
        }
      });
  },
});
