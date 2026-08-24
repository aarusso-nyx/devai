import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { readTaskDescriptor } from './policy.js';

export interface DeclaredCheckTaskProcess {
  readonly nodeId: string;
  readonly cwd: string;
}

export interface DeclaredCheckTaskRefusal {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly descriptor_path: string;
  readonly closest_declared_node?: string;
  readonly reason: string;
}

function distance(left: readonly string[], right: readonly string[]): number {
  const width = right.length + 1;
  let prior = Array.from({ length: width }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const next = [row];
    for (let column = 1; column < width; column += 1) {
      next[column] = Math.min(
        (prior[column] ?? 0) + 1,
        (next[column - 1] ?? 0) + 1,
        (prior[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    prior = next;
  }
  return prior[right.length] ?? Math.max(left.length, right.length);
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

export function describeDeclaredCheckTaskRefusal(
  repoRoot: string,
  request: AuthorityHostEffectRequest,
): DeclaredCheckTaskRefusal {
  const descriptorPath = resolve(realpathSync(resolve(repoRoot)), 'test-tasks.json');
  const executable = typeof request.arguments[0] === 'string' ? request.arguments[0] : '<invalid>';
  const argv = Array.isArray(request.arguments[1]) ? request.arguments[1].map(String) : [];
  const rawOptions = request.arguments[2];
  const options =
    rawOptions !== null && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
      ? (rawOptions as Readonly<Record<string, unknown>>)
      : {};
  let reason = 'process is not an exact declared task';
  if (options.shell !== undefined && options.shell !== false) reason = 'shell must be false';
  else if (typeof options.cwd !== 'string') reason = 'cwd must be declared';
  else if (!existsSync(resolve(options.cwd))) reason = 'cwd does not exist';
  else if (!within(realpathSync(resolve(repoRoot)), realpathSync(resolve(options.cwd))))
    reason = 'cwd escapes the repository';
  let closest: string | undefined;
  try {
    const requested = [executable, ...argv];
    closest = [...readTaskDescriptor(descriptorPath).tasks].sort(
      (left, right) => distance(requested, left.argv) - distance(requested, right.argv),
    )[0]?.nodeId;
  } catch {
    // The descriptor loader reports malformed or absent descriptors elsewhere.
  }
  return {
    executable,
    argv,
    descriptor_path: descriptorPath,
    ...(closest === undefined ? {} : { closest_declared_node: closest }),
    reason,
  };
}
