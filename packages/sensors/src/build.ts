import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand } from './run-command.js';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';

export interface BuildOptions {
  /** The repository root. */
  readonly cwd: string;
  /**
   * The declared build argv from `.devai/config/sensor-inputs.json`. It is the command only
   * when `test-tasks.json` has no build node; a different argv beside that node reads
   * `error` with `BUILD_ARGV_CONFLICT` (ADR-AUT-0002).
   */
  readonly argv?: readonly string[];
  /** The declared repository-relative working directory for `argv`; the root when omitted. */
  readonly buildCwd?: string;
  readonly timeoutMs?: number;
}

const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;

interface BuildCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function resolveExecutable(repoRoot: string, executable: string): string | undefined {
  if (!BARE_EXECUTABLE.test(executable)) return undefined;
  const candidates = [
    join(repoRoot, 'node_modules', '.bin', executable),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, executable)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const path = realpathSync(candidate);
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Continue past unreadable or broken PATH entries.
    }
  }
  return undefined;
}

function descriptorBuildCommand(repoRoot: string): BuildCommand | undefined {
  const descriptorPath = join(repoRoot, 'test-tasks.json');
  if (!existsSync(descriptorPath)) return undefined;
  try {
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
      readonly tasks?: readonly {
        readonly nodeId?: unknown;
        readonly runner?: unknown;
        readonly argv?: unknown;
        readonly cwd?: unknown;
      }[];
    };
    const task = descriptor.tasks?.find(
      (candidate) =>
        candidate.nodeId === 'build' ||
        (typeof candidate.runner === 'string' &&
          /(?:^|[-:])build(?:$|[-:])/u.test(candidate.runner)),
    );
    if (
      !Array.isArray(task?.argv) ||
      task.argv.length === 0 ||
      task.argv.some((argument) => typeof argument !== 'string') ||
      typeof task.cwd !== 'string'
    ) {
      return undefined;
    }
    const cwd = resolve(repoRoot, task.cwd);
    if (!existsSync(cwd)) return undefined;
    const canonicalRoot = realpathSync(repoRoot);
    const canonicalCwd = realpathSync(cwd);
    if (!within(canonicalRoot, canonicalCwd)) return undefined;
    return { argv: task.argv as readonly string[], cwd: canonicalCwd };
  } catch {
    return undefined;
  }
}

function declaredInputCommand(
  repoRoot: string,
  argv: readonly string[],
  buildCwd: string | undefined,
): BuildCommand | undefined {
  const cwd = resolve(repoRoot, buildCwd ?? '.');
  if (!existsSync(cwd)) return undefined;
  const canonicalCwd = realpathSync(cwd);
  return within(repoRoot, canonicalCwd) ? { argv, cwd: canonicalCwd } : undefined;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function errorReading(code: string, message: string): SensorReading {
  return buildSensorReading({
    sensorName: 'build',
    sensorKind: 'build',
    command: ['<build-declaration-error>'],
    status: 'error',
    deterministic: true,
    findings: [{ severity: 'error', code, message }],
  });
}

function packageBuildCommand(repoRoot: string): BuildCommand | undefined {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    if (typeof manifest.scripts?.build !== 'string') return undefined;
  } catch {
    return undefined;
  }
  const candidates: readonly (readonly [string, readonly string[]])[] = [
    ['pnpm-lock.yaml', ['pnpm', '-r', 'build']],
    ['package-lock.json', ['npm', 'run', 'build']],
    ['yarn.lock', ['yarn', 'build']],
    ['bun.lockb', ['bun', 'run', 'build']],
  ];
  const selected = candidates.find(([lockfile]) => existsSync(join(repoRoot, lockfile)));
  return selected === undefined ? undefined : { argv: selected[1], cwd: repoRoot };
}

export function senseBuild(opts: BuildOptions): SensorReading {
  const repoRoot = realpathSync(resolve(opts.cwd));
  const descriptor = descriptorBuildCommand(repoRoot);
  if (
    descriptor !== undefined &&
    opts.argv !== undefined &&
    !sameArgv(descriptor.argv, opts.argv)
  ) {
    return errorReading(
      'BUILD_ARGV_CONFLICT',
      `The declared build argv "${opts.argv.join(' ')}" differs from the test-tasks.json build ` +
        `node argv "${descriptor.argv.join(' ')}"; the descriptor node is the build command, ` +
        'so the declaration in .devai/config/sensor-inputs.json must be removed or match it.',
    );
  }
  let declared: BuildCommand | undefined;
  if (descriptor === undefined && opts.argv !== undefined) {
    declared = declaredInputCommand(repoRoot, opts.argv, opts.buildCwd);
    if (declared === undefined) {
      return errorReading(
        'BUILD_CWD_INVALID',
        `The declared build cwd "${opts.buildCwd ?? '.'}" does not name an existing directory ` +
          'inside the repository root.',
      );
    }
  }
  const selected = descriptor ?? declared ?? packageBuildCommand(repoRoot);
  if (selected === undefined) {
    return buildSensorReading({
      sensorName: 'build',
      sensorKind: 'build',
      command: ['<build-not-declared>'],
      status: 'skipped',
      deterministic: true,
      findings: [
        {
          severity: 'info',
          code: 'BUILD_NOT_DECLARED',
          message: 'No build task or package build script is declared for this repository.',
        },
      ],
    });
  }
  const executable = resolveExecutable(repoRoot, selected.argv[0] ?? '');
  const args = executable === undefined ? selected.argv : [executable, ...selected.argv.slice(1)];
  const result = runCommand(args, { cwd: selected.cwd, timeoutMs: opts.timeoutMs ?? 300_000 });
  const emptyPopulation =
    result.exit_code === 0 &&
    /No projects (?:found|matched the filters)/u.test(`${result.stdout}\n${result.stderr}`);
  const status: SensorStatus = emptyPopulation
    ? 'review'
    : result.exit_code === 0
      ? 'pass'
      : 'fail';
  return buildSensorReading({
    sensorName: 'build',
    sensorKind: 'build',
    command: args,
    status,
    deterministic: true,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    out_head: result.stdout,
    err_head: result.stderr,
    killed: result.killed,
    ...(emptyPopulation && {
      findings: [
        {
          severity: 'warning' as const,
          code: 'BUILD_POPULATION_EMPTY',
          message: 'The configured build command exited successfully without finding a project.',
        },
      ],
    }),
  });
}
