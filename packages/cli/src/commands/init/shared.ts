import { existsSync, lstatSync, realpathSync } from '@devai-nyx/authority';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { isAdoptionProfile, EXIT_PRECONDITION, EXIT_USAGE } from '@devai-nyx/utils';
import { cliError, renderCliError } from '../../cli-error.js';

export const DEFAULT_REPO_ROOT = '.';

export function emit(json: unknown, human: boolean, humanText: string): void {
  if (human) process.stdout.write(humanText.endsWith('\n') ? humanText : humanText + '\n');
  else process.stdout.write(JSON.stringify(json) + '\n');
}

export interface InitOptions {
  readonly target?: string;
  readonly force?: boolean;
  readonly stampVersion?: string;
  readonly introspect?: boolean;
  readonly tier?: string;
  readonly include?: string;
  readonly hook?: string;
  readonly command?: string;
  readonly output?: string;
  readonly human?: boolean;
}

export interface InitBindOptions {
  readonly target?: string;
  readonly full?: boolean;
  readonly constitution?: boolean;
  readonly subprocessEffects?: boolean;
  readonly operationalLaw?: boolean;
  readonly adopterPolicy?: string;
  readonly hostAdapter?: string;
  readonly trackingAdapter?: string;
  readonly trackingRepository?: string;
  readonly tier?: string;
  readonly write?: boolean;
  readonly human?: boolean;
}

export type InitSegment = 'owner' | 'architect' | 'harness';
export type InitInclude = 'ci' | 'hooks' | 'skills';

export function validateInitTier(options: InitOptions): void {
  if (options.tier !== undefined && !isAdoptionProfile(options.tier)) {
    process.stderr.write(
      `devai init: --tier must be one of tier1 | tier2 | tier3 (got '${options.tier}')\n`,
    );
    process.exit(EXIT_USAGE);
  }
}

export interface ValidatedInitTarget {
  readonly requested: string;
  readonly resolved: string;
}

function initTargetError(path: string, message: string, human: boolean): void {
  const error = cliError({
    code: 'INIT_TARGET_PRECONDITION_UNSATISFIED',
    class: 'precondition',
    exit: 5,
    message: `${message}: ${path}`,
    remediation: 'Choose an existing directory inside a Git work tree and retry.',
    context: { target_root: path },
  });
  process.stderr.write(renderCliError(error, !human));
  process.exitCode = EXIT_PRECONDITION;
}

export function validateInitTarget(options: InitOptions): ValidatedInitTarget | undefined {
  const requested = options.target ?? DEFAULT_REPO_ROOT;
  const path = resolve(requested);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    initTargetError(path, 'Init target must exist and be a directory', options.human === true);
    return undefined;
  }
  const resolved = realpathSync(path);
  let cursor = resolved;
  let workTree = false;
  while (true) {
    const gitEntry = join(cursor, '.git');
    if (existsSync(gitEntry)) {
      const entry = lstatSync(gitEntry);
      workTree = entry.isDirectory() || entry.isFile();
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!workTree) {
    initTargetError(path, 'Init target is not a Git repository', options.human === true);
    return undefined;
  }
  return { requested, resolved };
}

export function addInitOptions(command: ReturnType<CAC['command']>, includeIntrospection: boolean) {
  command
    .option('--target <path>', `Target directory (default: ${DEFAULT_REPO_ROOT})`)
    .option('--stamp-version <v>', 'DEVAI version stamp for reproducible plans')
    .option('--tier <tier>', 'Adoption tier: tier1 | tier2 | tier3')
    .option('--human', 'Human-readable output');
  if (includeIntrospection) command.option('--introspect', 'Include repository introspection');
  return command;
}
