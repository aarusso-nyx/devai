import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { readTaskDescriptor } from './policy.js';

export interface DeclaredCheckTaskProcess {
  readonly nodeId: string;
  readonly cwd: string;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function matchDeclaredCheckTaskProcess(
  repoRoot: string,
  invocationArgv: readonly string[],
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskProcess | undefined {
  if (request.kind !== 'process' || request.symbol !== 'spawnSync') return undefined;
  const targets = ['--affected', '--local', '--rc'].filter((flag) => invocationArgv.includes(flag));
  const suiteIndex = invocationArgv.indexOf('--suite');
  const suite = suiteIndex < 0 ? undefined : invocationArgv[suiteIndex + 1];
  const onlyIndex = invocationArgv.indexOf('--only');
  const only = onlyIndex < 0 ? undefined : invocationArgv[onlyIndex + 1];
  const suiteRun =
    only === undefined &&
    targets.length === 0 &&
    (suite === undefined || ['quick', 'standard', 'full', 'release'].includes(suite));
  const ledgerOnlyRun = ['ledger-local', 'ledger-rc'].includes(only ?? '');
  const explicitTaskRun = invocationArgv.includes('--run') && targets.length === 1;
  if (!explicitTaskRun && !suiteRun && !ledgerOnlyRun) return undefined;
  const executable = request.arguments[0];
  const argv = request.arguments[1];
  const rawOptions = request.arguments[2];
  if (
    typeof executable !== 'string' ||
    !Array.isArray(argv) ||
    argv.some((argument) => typeof argument !== 'string') ||
    rawOptions === null ||
    typeof rawOptions !== 'object' ||
    Array.isArray(rawOptions)
  ) {
    return undefined;
  }
  if (!['node', 'pnpm'].includes(executable)) return undefined;
  if (
    executable === 'node' &&
    !(
      argv.length === 2 &&
      argv[0] === '-e' &&
      argv[1] === "process.stdout.write('local test dependency closure complete\\n')"
    )
  ) {
    return undefined;
  }
  if (
    executable === 'pnpm' &&
    !(
      (argv.length === 2 && argv[0] === 'run' && typeof argv[1] === 'string') ||
      (argv.length === 2 && argv[0] === '-r' && argv[1] === 'build')
    )
  ) {
    return undefined;
  }
  const options = rawOptions as Readonly<Record<string, unknown>>;
  if (options.shell !== undefined && options.shell !== false) return undefined;
  if (typeof options.cwd !== 'string') return undefined;
  const root = realpathSync(resolve(repoRoot));
  if (!existsSync(resolve(options.cwd))) return undefined;
  const cwd = realpathSync(resolve(options.cwd));
  if (!within(root, cwd)) return undefined;
  const descriptor = readTaskDescriptor(resolve(root, 'test-tasks.json'));
  const task = descriptor.tasks.find(
    (candidate) =>
      candidate.argv[0] === executable &&
      JSON.stringify(candidate.argv.slice(1)) === JSON.stringify(argv) &&
      existsSync(resolve(root, candidate.cwd)) &&
      realpathSync(resolve(root, candidate.cwd)) === cwd,
  );
  return task === undefined ? undefined : { nodeId: task.nodeId, cwd };
}
