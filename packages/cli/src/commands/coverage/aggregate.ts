import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, relative, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_IN = 'coverage';
const DEFAULT_OUT = '.devai/state/coverage/summary.json';

interface Options {
  readonly in?: string;
  readonly out?: string;
  readonly repoRoot?: string;
  readonly perPackage?: boolean;
  readonly human?: boolean;
  /**
   * Switch input/output shape to Istanbul's coverage-final.json (per-file
   * raw counters) instead of the default coverage-summary.json (totals).
   * Matches STYNX's scripts/aggregate-coverage.mjs output for downstream
   * F3×T2 sensor consumption.
   */
  readonly final?: boolean;
}

interface Pct {
  readonly lines: number;
  readonly branches: number;
  readonly functions: number;
  readonly statements: number;
}

interface CountedPct {
  readonly lines: { total: number; covered: number };
  readonly branches: { total: number; covered: number };
  readonly functions: { total: number; covered: number };
  readonly statements: { total: number; covered: number };
}

interface CoverageSummaryFile {
  readonly total: CountedPct;
  readonly [path: string]: unknown;
}

function findFiles(dir: string, filename: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      findFiles(full, filename, out);
    } else if (st.isFile() && name === filename) {
      out.push(full);
    }
  }
}

function safePct(covered: number, total: number): number {
  if (total === 0) return 0;
  return (covered / total) * 100;
}

function totalsToPct(t: CountedPct): Pct {
  return {
    lines: safePct(t.lines.covered, t.lines.total),
    branches: safePct(t.branches.covered, t.branches.total),
    functions: safePct(t.functions.covered, t.functions.total),
    statements: safePct(t.statements.covered, t.statements.total),
  };
}

interface AggregateResult {
  readonly schemaVersion: '1.0.0';
  readonly generated_at: string;
  readonly inputs: readonly string[];
  readonly scopes?: Record<string, Pct>;
  readonly total: Pct;
  readonly counts: CountedPct;
}

function deriveScopeName(repoRoot: string, summaryPath: string): string {
  // Walk up from `coverage-summary.json` until we hit a `package.json`
  // or the repo root. The scope is the last directory before that.
  const rel = relative(repoRoot, summaryPath);
  const parts = rel.split('/');
  // Common shapes:
  //   packages/<name>/coverage/coverage-summary.json
  //   apps/<name>/coverage/coverage-summary.json
  //   coverage/coverage-summary.json (root-only)
  // Pick the segment immediately before "coverage" if it exists.
  const covIdx = parts.indexOf('coverage');
  if (covIdx > 0) {
    const upTo = parts.slice(0, covIdx);
    return upTo.join('/');
  }
  return rel;
}

function mergeCounts(into: CountedPct, from: CountedPct): CountedPct {
  return {
    lines: {
      total: into.lines.total + from.lines.total,
      covered: into.lines.covered + from.lines.covered,
    },
    branches: {
      total: into.branches.total + from.branches.total,
      covered: into.branches.covered + from.branches.covered,
    },
    functions: {
      total: into.functions.total + from.functions.total,
      covered: into.functions.covered + from.functions.covered,
    },
    statements: {
      total: into.statements.total + from.statements.total,
      covered: into.statements.covered + from.statements.covered,
    },
  };
}

const EMPTY_COUNTS: CountedPct = {
  lines: { total: 0, covered: 0 },
  branches: { total: 0, covered: 0 },
  functions: { total: 0, covered: 0 },
  statements: { total: 0, covered: 0 },
};

export const coverageAggregate = defineCommand({
  name: 'coverage aggregate',
  description:
    'Aggregate per-package Istanbul coverage-summary.json files into one composite summary feeding `render matrix` and `score compute`. Example: `devai evidence coverage aggregate --in coverage --out .devai/state/coverage/summary.json --per-package`.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('coverage-aggregate', 'Aggregate per-package Istanbul coverage summaries into a composite')
      .option('--repo-root <path>', 'Repo root (default: cwd)')
      .option('--in <dir>', `Root dir to search for coverage-summary.json / coverage-final.json (default: ${DEFAULT_IN})`)
      .option('--out <path>', `Output composite path (default: ${DEFAULT_OUT})`)
      .option('--per-package', 'Include per-scope breakdown under `scopes` in the output (default: off)')
      .option('--final', 'STYNX-parity mode: walk for coverage-final.json (per-file raw counters) and emit a merged istanbul-shape coverage-final.json. Input + output shape change.')
      .option('--human', 'Human-readable banner; otherwise the composite JSON goes to stdout')
      .action(async (options: Options) => {
        try {
          const repoRoot = resolve(options.repoRoot ?? process.cwd());
          const inDir = resolve(repoRoot, options.in ?? DEFAULT_IN);

          if (options.final === true) {
            await runFinalMode(repoRoot, inDir, options);
            process.exitCode = EXIT_PASS;
            return;
          }

          const found: string[] = [];
          if (existsSync(inDir)) findFiles(inDir, 'coverage-summary.json', found);

          let counts = EMPTY_COUNTS;
          const scopes: Record<string, Pct> = {};
          for (const f of found) {
            try {
              const parsed = JSON.parse(readFileSync(f, 'utf8')) as CoverageSummaryFile;
              if (parsed.total !== undefined) {
                counts = mergeCounts(counts, parsed.total);
                if (options.perPackage === true) {
                  const scope = deriveScopeName(repoRoot, f);
                  scopes[scope] = totalsToPct(parsed.total);
                }
              }
            } catch {
              // Skip malformed files. The aggregator is permissive — a
              // hard validation belongs to the canonical check facade.
            }
          }

          const result: AggregateResult = {
            schemaVersion: '1.0.0',
            generated_at: new Date().toISOString(),
            inputs: found.map((f) => relative(repoRoot, f)),
            ...(options.perPackage === true && Object.keys(scopes).length > 0 && { scopes }),
            total: totalsToPct(counts),
            counts,
          };

          const outPath = resolve(repoRoot, options.out ?? DEFAULT_OUT);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

          if (options.human === true) {
            const t = result.total;
            process.stdout.write(
              `devai evidence coverage aggregate: ${String(found.length)} summary file(s) → ${options.out ?? DEFAULT_OUT}\n` +
                `  lines ${t.lines.toFixed(1)}%  branches ${t.branches.toFixed(1)}%  functions ${t.functions.toFixed(1)}%  statements ${t.statements.toFixed(1)}%\n`,
            );
          } else {
            process.stdout.write(JSON.stringify(result) + '\n');
          }
          process.exitCode = EXIT_PASS;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`devai evidence coverage aggregate: ${msg}\n`);
          process.exit(EXIT_FAIL);
        }
      });
  },
});

/**
 * STYNX-parity mode. Walks for per-package coverage-final.json files
 * (Istanbul's raw per-file counters), merges them via istanbul-lib-
 * coverage's CoverageMap, and emits a single composite coverage-final
 * .json keyed by source file path. Matches stynx/scripts/aggregate-
 * coverage.mjs output shape for downstream F3×T2 sensor consumption.
 *
 * Default mode (the caller) sums coverage-summary.json totals only.
 * `--final` swaps both input shape and output shape.
 */
async function runFinalMode(
  repoRoot: string,
  inDir: string,
  options: Options,
): Promise<void> {
  // Lazy import so the default-mode path doesn't pay the istanbul-lib
  // load cost.
  const libCoverage = (await import('istanbul-lib-coverage')).default;

  const found: string[] = [];
  if (existsSync(inDir)) findFiles(inDir, 'coverage-final.json', found);

  const map = libCoverage.createCoverageMap({});
  for (const f of found) {
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8'));
      // CoverageMap.merge accepts CoverageMapData (a record of per-file
      // coverage entries). Cast through unknown — Istanbul's typings
      // are strict but the on-disk shape is the same.
      map.merge(parsed as never);
    } catch {
      // Skip malformed inputs; the canonical check facade owns validation.
    }
  }

  const composite = map.toJSON();
  const outRel = options.out ?? 'coverage/coverage-final.json';
  const outPath = resolve(repoRoot, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(composite) + '\n');

  if (options.human === true) {
    const summary = map.getCoverageSummary();
    const data = summary.data;
    process.stdout.write(
      `devai evidence coverage aggregate (--final): ${String(found.length)} coverage-final.json file(s) → ${outRel}\n` +
        `  lines ${data.lines.pct.toFixed(1)}%  branches ${data.branches.pct.toFixed(1)}%  functions ${data.functions.pct.toFixed(1)}%  statements ${data.statements.pct.toFixed(1)}%\n`,
    );
  } else {
    const summary = map.getCoverageSummary();
    process.stdout.write(
      JSON.stringify({
        schemaVersion: '1.0.0',
        generated_at: new Date().toISOString(),
        mode: 'final',
        inputs: found.map((f) => relative(repoRoot, f)),
        out: outRel,
        files: Object.keys(composite).length,
        summary: summary.toJSON(),
      }) + '\n',
    );
  }
}
