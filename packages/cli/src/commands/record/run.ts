import { spawnSync } from '@devai-nyx/authority';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS, EXIT_USAGE } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { isActionOutputExit } from '../../action-output.js';

const DEFAULT_OUT_DIR = '.devai/state/test-results';
const VALID_TIERS = new Set([
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

interface Options {
  readonly tier?: string;
  readonly cmd?: string;
  readonly scope?: string;
  readonly repo?: string;
  readonly out?: string;
  readonly repoRoot?: string;
  readonly human?: boolean;
  readonly timestamp?: string;
}

function ulidLike(): string {
  // Crockford base32 ULID-shape identifier (TR-<26 chars>). Time-prefix
  // (10 chars) + random suffix (16 chars). Sufficient for in-repo
  // uniqueness — collision probability is negligible for human-paced
  // emission rates. We deliberately don't pull in a `ulid` dep.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ms = Date.now();
  let time = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    time = (alphabet[n % 32] as string) + time;
    n = Math.floor(n / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += alphabet[Math.floor(Math.random() * 32)] as string;
  }
  return `TR-${time}${rand}`;
}

function deriveStatus(exitCode: number): 'pass' | 'fail' | 'error' {
  if (exitCode === 0) return 'pass';
  if (exitCode === 1 || exitCode === 2) return 'fail';
  return 'error';
}

function gitBranchAndCommit(repoRoot: string): { branch: string; commit: string } {
  const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const commitR = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    branch: branchR.status === 0 ? branchR.stdout.trim() : 'detached',
    commit:
      commitR.status === 0 ? commitR.stdout.trim() : '0000000000000000000000000000000000000000',
  };
}

interface RunResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly log: string;
}

function runChild(cmd: string, repoRoot: string): RunResult {
  const start = Date.now();
  const r = spawnSync('sh', ['-c', cmd], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const end = Date.now();
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  return {
    exitCode: r.status ?? 1,
    signal: r.signal ?? null,
    durationMs: end - start,
    log: combined,
  };
}

export const recordRun = defineCommand({
  name: 'record run',
  description:
    'Run a test command, capture stdout/stderr + exit code, and emit a test-result.schema.json record under .devai/state/test-results/. Example: `devai evidence test record --tier unit --scope @my/pkg --cmd "pnpm --filter @my/pkg test:unit"`.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('record-run', 'Run a test command and emit a canonical test-result record')
      .option(
        '--tier <tier>',
        'Tier: unit|api|db|e2e|mutation|perf|lint|typecheck|coverage (required)',
      )
      .option('--cmd <command>', 'Shell command to run (required). Quoted; runs via `sh -c`.')
      .option('--scope <scope>', 'Optional sub-scope (e.g. package name)')
      .option('--repo <slug>', 'Repo slug (default: directory name)')
      .option(
        '--out <path>',
        `Output file path (default: ${DEFAULT_OUT_DIR}/<scope-or-repo>/<tier>.json)`,
      )
      .option('--repo-root <path>', 'Repo root (default: cwd)')
      .option('--timestamp <iso>', 'Override timestamp (default: now)')
      .option('--human', 'Human-readable banner; otherwise emits the record JSON to stdout')
      .action(async (options: Options) => {
        try {
          if (options.tier === undefined || !VALID_TIERS.has(options.tier)) {
            process.stderr.write(
              `devai evidence test record: --tier must be one of: ${[...VALID_TIERS].join(', ')}\n`,
            );
            process.exit(EXIT_USAGE);
          }
          if (options.cmd === undefined || options.cmd.length === 0) {
            process.stderr.write('devai evidence test record: --cmd is required\n');
            process.exit(EXIT_USAGE);
          }
          const repoRoot = resolve(options.repoRoot ?? process.cwd());
          const repoSlug = (options.repo ?? repoRoot.split('/').pop() ?? 'unknown')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-');
          const scope = options.scope;
          const tier = options.tier;
          const ts = options.timestamp ?? new Date().toISOString();

          const child = runChild(options.cmd, repoRoot);
          const status = deriveStatus(child.exitCode);

          // Write a log artifact alongside the record.
          const slug = (scope ?? repoSlug).replace(/[^A-Za-z0-9._-]/g, '-');
          const outPath = options.out
            ? resolve(repoRoot, options.out)
            : resolve(repoRoot, DEFAULT_OUT_DIR, slug, `${tier}.json`);
          const outDir = dirname(outPath);
          mkdirSync(outDir, { recursive: true });
          const logPath = join(outDir, `${tier}.log`);
          writeFileSync(logPath, child.log);

          const git = gitBranchAndCommit(repoRoot);

          const record = {
            schemaVersion: '1.0.0',
            id: ulidLike(),
            repo: repoSlug,
            ...(scope !== undefined && { scope }),
            tier,
            timestamp: ts,
            status,
            command: options.cmd,
            env: {
              node: process.version,
              os: `${process.platform}-${process.arch}`,
              branch: git.branch,
              commit: git.commit,
              ci: process.env['CI'] === 'true' || process.env['CI'] === '1',
            },
            metrics: {
              duration_ms: child.durationMs,
            },
            evidence: {
              log_path:
                outPath === options.out ? logPath : `${DEFAULT_OUT_DIR}/${slug}/${tier}.log`,
            },
            exit_code: child.exitCode,
            signal: child.signal,
          };

          writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

          if (options.human === true) {
            const host = hostname();
            process.stdout.write(
              `devai evidence test record: ${status.toUpperCase()} ${tier} ${slug} (${String(child.durationMs)}ms) on ${host}\n  → ${outPath}\n`,
            );
          } else {
            process.stdout.write(JSON.stringify(record) + '\n');
          }

          // Forward the child's exit code so callers can react. record
          // run is a wrapper, not a swallower.
          process.exit(child.exitCode === 0 ? EXIT_PASS : child.exitCode);
        } catch (err) {
          if (isActionOutputExit(err)) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`devai evidence test record: ${msg}\n`);
          process.exit(EXIT_FAIL);
        }
      });
  },
});
