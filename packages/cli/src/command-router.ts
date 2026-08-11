import type { RegistryEntry } from './define-command.js';
import { isSensorKind } from '@devai-nyx/sensors/registry';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { cliError, renderCliError } from './cli-error.js';
import { resolveInvocationEntry } from './authority/sense-selection.js';

export { EXIT_USAGE };

function wantsJson(args: readonly string[]): boolean {
  const format = args.lastIndexOf('--format');
  return args.includes('--json') || (format >= 0 && args[format + 1] === 'json');
}

const DOMAIN_SUMMARIES: Readonly<Record<string, string>> = {
  catalog: 'Inspect the live action catalog.',
  check: 'Run governed validation suites and checks.',
  doctor: 'Diagnose the declared adoption posture.',
  evidence: 'Record, render, redact, and verify audit evidence.',
  init: 'Install and bind DEVAI in a repository.',
  release: 'Check and verify releases.',
  round: 'Plan, run, assess, and close governed rounds.',
  sense: 'Observe repository and runtime state through sensors.',
  task: 'Operate round-bound task plumbing.',
};

const DEFAULT_DOMAIN_ORDER = [
  'init',
  'doctor',
  'check',
  'sense',
  'round',
  'evidence',
  'release',
] as const;

const EXPANDED_DOMAIN_ORDER = [...DEFAULT_DOMAIN_ORDER, 'task', 'catalog'] as const;

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function renderRows(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.min(32, Math.max(...rows.map(([name]) => name.length), 0));
  return rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`);
}

export function renderHelp(
  entries: readonly RegistryEntry[],
  version: string,
  prefix: readonly string[] = [],
  includeAll = false,
): string {
  const visible = entries.filter(
    (entry) =>
      startsWithPath(entry.path, prefix) &&
      (includeAll || entry.tier === 'porcelain' || entry.path.length === prefix.length),
  );
  const lines = [`devai/${version}`, ''];
  lines.push(`Usage: devai${prefix.length > 0 ? ` ${prefix.join(' ')}` : ''} <command> [options]`);
  lines.push('');
  if (prefix.length === 0) {
    lines.push('Domains:');
    const domains = includeAll ? EXPANDED_DOMAIN_ORDER : DEFAULT_DOMAIN_ORDER;
    lines.push(
      ...renderRows(
        domains.map((domain) => [domain, DOMAIN_SUMMARIES[domain] ?? 'DEVAI command domain.']),
      ),
    );
  } else {
    const exact = visible.find((entry) => entry.path.length === prefix.length);
    if (exact !== undefined) {
      lines[2] = `Usage: devai ${exact.name}${exact.runtime_args === undefined || exact.runtime_args.length === 0 ? '' : ` ${exact.runtime_args}`} [options]`;
      lines.push(exact.description);
      lines.push('');
      lines.push(`Lifecycle: ${exact.lifecycle}`);
      lines.push(`Authority: ${exact.authority}`);
      lines.push(`Effects: ${exact.effects}`);
      if ((exact.runtime_options?.length ?? 0) > 0) {
        lines.push('');
        lines.push('Options:');
        lines.push(
          ...renderRows(
            (exact.runtime_options ?? []).map((option) => [option.flags, option.description]),
          ),
        );
      }
    }
    const children = new Map<string, string>();
    for (const entry of visible) {
      const child = entry.path[prefix.length];
      if (child === undefined) continue;
      const isLeaf = entry.path.length === prefix.length + 1;
      children.set(
        child,
        isLeaf
          ? entry.description
          : prefix.length === 0
            ? (DOMAIN_SUMMARIES[child] ?? `${child} commands.`)
            : `${child} commands.`,
      );
    }
    if (children.size > 0) {
      lines.push('Commands:');
      lines.push(
        ...renderRows(Array.from(children.entries()).sort(([a], [b]) => a.localeCompare(b))),
      );
    }
  }
  lines.push('');
  if (prefix.length === 0 || visible.every((entry) => entry.path.length !== prefix.length)) {
    lines.push('Options:');
    lines.push('  --help       Show help for this command path.');
    lines.push('  --all        Include plumbing commands in help.');
    lines.push('  --version    Show the DEVAI CLI version.');
  }
  lines.push('');
  return lines.join('\n');
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[b.length] ?? Math.max(a.length, b.length);
}

function suggestion(
  input: readonly string[],
  entries: readonly RegistryEntry[],
): string | undefined {
  const wanted = input.join(' ');
  return entries
    .map((entry) => entry.path.join(' '))
    .sort((a, b) => distance(wanted, a) - distance(wanted, b))[0];
}

export type RouteResult =
  | { readonly kind: 'dispatch'; readonly argv: string[] }
  | {
      readonly kind: 'output';
      readonly text: string;
      readonly exitCode: number;
      readonly bypassActionOutput?: true;
    };

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith('-') ? undefined : value;
}

function usageRefusal(
  args: readonly string[],
  code: string,
  message: string,
  remediation: string,
  context: Readonly<Record<string, unknown>>,
): RouteResult {
  const error = cliError({
    code,
    class: 'routing-authority',
    exit: EXIT_USAGE,
    message,
    remediation,
    context,
  });
  return {
    kind: 'output',
    text: renderCliError(error, wantsJson(args)),
    exitCode: EXIT_USAGE,
  };
}

export function invocationIsNonMutating(internalName: string, args: readonly string[]): boolean {
  if (args.includes('--check')) return true;
  if (
    internalName === 'check' &&
    ['--task-plan', '--status', '--explain'].some((flag) => args.includes(flag))
  ) {
    return true;
  }
  if (internalName === 'round-close' && args.includes('--post-merge-receipt')) return true;
  if (internalName === 'mutation-verify' && !args.includes('--save-baseline')) return true;
  return (
    ['init', 'adopt', 'init-bind', 'ci-scaffold', 'hooks-install', 'state-prune'].includes(
      internalName,
    ) && !args.includes('--write')
  );
}

export function routeArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
  version: string,
): RouteResult {
  const args = argv.slice(2);
  if (
    args[0] === 'sense' &&
    args[1] === 'run' &&
    args[2] !== undefined &&
    !args[2].startsWith('-')
  ) {
    const kind = args[2];
    if (!isSensorKind(kind)) {
      const error = cliError({
        code: 'SENSOR_KIND_UNKNOWN',
        class: 'routing-authority',
        exit: 2,
        message: `Sensor kind '${kind}' is not registered.`,
        remediation: 'Run devai sense run --help.',
        context: { kind },
      });
      return { kind: 'output', text: renderCliError(error, wantsJson(args)), exitCode: 2 };
    }
    // Canonical kinds remain positional values of the direct `sense run` facade.
  }
  const privateFlag = args.find((arg) => ['--execute', '--apply', '--human'].includes(arg));
  if (privateFlag !== undefined) {
    return {
      kind: 'output',
      text: `devai: unknown option ${privateFlag}\n`,
      exitCode: EXIT_USAGE,
    };
  }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === '--all') {
    return {
      kind: 'output',
      text: renderHelp(entries, version, [], args.includes('--all')),
      exitCode: 0,
    };
  }
  if (args[0] === '--version' || args[0] === '-v') return { kind: 'dispatch', argv: [...argv] };

  const optionIndex = args.findIndex((arg) => arg.startsWith('-'));
  const words = args.slice(0, optionIndex < 0 ? args.length : optionIndex);
  const exact = entries
    .filter((entry) => startsWithPath(words, entry.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (exact !== undefined) {
    let remaining = args.slice(exact.path.length);
    remaining = remaining.filter((arg) => arg !== '--json');
    const formatIndex = remaining.lastIndexOf('--format');
    if (formatIndex >= 0) {
      const format = remaining[formatIndex + 1];
      if (format === 'json' || format === 'human') {
        remaining = remaining.filter(
          (_, index) => index !== formatIndex && index !== formatIndex + 1,
        );
      }
      if (format === 'human') {
        const supportsHuman = exact.runtime_supports_human === true;
        if (!supportsHuman) {
          return {
            kind: 'output',
            text: `devai ${exact.name}: human output is not available for this action\n`,
            exitCode: EXIT_USAGE,
          };
        }
        remaining = [...remaining, '--human'];
      }
    }
    const wantsHelp =
      remaining.includes('--help') || remaining.includes('-h') || remaining.includes('--all');
    if (wantsHelp) {
      return {
        kind: 'output',
        text: renderHelp(entries, version, exact.path, remaining.includes('--all')),
        exitCode: 0,
      };
    }
    if (exact.path[0] === 'task' && flagValue(remaining, '--round') === undefined) {
      return {
        kind: 'output',
        text: `${JSON.stringify({
          code: 'TASK_ROUND_REQUIRED',
          operation: exact.name.slice('task '.length),
          exit: EXIT_USAGE,
        })}\n`,
        exitCode: EXIT_USAGE,
        bypassActionOutput: true,
      };
    }
    const blueprintOperation = flagValue(remaining, '--blueprint');
    if (
      exact.name === 'round plan' &&
      blueprintOperation !== undefined &&
      !['plan', 'diff'].includes(blueprintOperation)
    ) {
      return usageRefusal(
        args,
        'ROUND_BLUEPRINT_OPERATION_INVALID',
        `--blueprint must be plan or diff (got '${blueprintOperation}').`,
        'Use --blueprint plan or --blueprint diff.',
        { option: '--blueprint', value: blueprintOperation },
      );
    }
    if (
      exact.name === 'round plan' &&
      blueprintOperation !== undefined &&
      flagValue(remaining, '--file') === undefined
    ) {
      return usageRefusal(
        args,
        'ROUND_BLUEPRINT_FILE_REQUIRED',
        '--file is required with --blueprint.',
        'Provide --file <path>.',
        { option: '--file', blueprint: blueprintOperation },
      );
    }
    if (
      exact.name === 'check' &&
      flagValue(remaining, '--only') === 'blueprint' &&
      flagValue(remaining, '--file') === undefined
    ) {
      return usageRefusal(
        args,
        'CHECK_BLUEPRINT_FILE_REQUIRED',
        '--file is required with --only blueprint.',
        'Provide --file <path>.',
        { option: '--file', member: 'blueprint' },
      );
    }
    if (
      exact.name === 'task start' &&
      remaining.includes('--with-db') &&
      flagValue(remaining, '--database-url') === undefined
    ) {
      return usageRefusal(
        args,
        'TASK_DATABASE_URL_REQUIRED',
        '--database-url is required with --with-db.',
        'Provide --database-url <url>.',
        { option: '--database-url', operation: 'start' },
      );
    }
    if (
      exact.name === 'task finish' &&
      remaining.includes('--drop-db') &&
      flagValue(remaining, '--database-url') === undefined
    ) {
      return usageRefusal(
        args,
        'TASK_DATABASE_URL_REQUIRED',
        '--database-url is required with --drop-db.',
        'Provide --database-url <url>.',
        { option: '--database-url', operation: 'finish' },
      );
    }
    if (exact.internal_name === 'init-bind') {
      const selectors = ['--constitution', '--subprocess-effects', '--operational-law'].filter(
        (selector) => remaining.includes(selector),
      );
      if (selectors.length > 1) {
        return usageRefusal(
          args,
          'INIT_BIND_SELECTION_INVALID',
          'init bind accepts only one binding selector per invocation.',
          'Choose one of --constitution, --subprocess-effects, or --operational-law.',
          { selectors },
        );
      }
    }
    let routedEntry: RegistryEntry;
    try {
      routedEntry = resolveInvocationEntry(exact, argv);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const check = exact.name === 'check';
      const refusal = cliError({
        code: check ? 'CHECK_SELECTION_INVALID' : 'SENSE_SELECTION_INVALID',
        class: 'routing-authority',
        exit: EXIT_USAGE,
        message: `${check ? 'Check' : 'Sense'} selection is invalid: ${detail}.`,
        remediation: check
          ? 'Choose one canonical suite or member, then retry.'
          : 'Choose one registered kind or one canonical --preset, then retry.',
        refs: {
          doc: check ? 'law/policy/check-suites.json' : 'law/policy/sense-presets.json',
        },
        context: { detail },
      });
      return {
        kind: 'output',
        text: renderCliError(refusal, wantsJson(args)),
        exitCode: EXIT_USAGE,
      };
    }
    if (
      (routedEntry.effects === 'harness-write' || routedEntry.effects === 'local-write') &&
      !remaining.includes('--write') &&
      !invocationIsNonMutating(routedEntry.internal_name, remaining)
    ) {
      return {
        kind: 'output',
        text: `devai ${exact.name}: local mutation requires --write\n`,
        exitCode: EXIT_USAGE,
      };
    }
    if (
      routedEntry.effects === 'remote-write' &&
      !remaining.includes('--dry-run') &&
      !invocationIsNonMutating(routedEntry.internal_name, remaining) &&
      (!remaining.includes('--write') || !remaining.includes('--publish'))
    ) {
      return {
        kind: 'output',
        text: `devai ${exact.name}: remote mutation requires --write --publish\n`,
        exitCode: EXIT_USAGE,
      };
    }
    let translated = remaining.filter((arg) => arg !== '--write' && arg !== '--publish');
    if (exact.internal_name === 'init-bind' && remaining.includes('--write')) {
      translated = remaining.filter((arg) => arg !== '--publish');
    }
    if (exact.internal_name === 'state-prune' && remaining.includes('--write'))
      translated = [...translated, '--apply'];
    return {
      kind: 'dispatch',
      argv: [...argv.slice(0, 2), exact.internal_name, ...translated],
    };
  }

  const prefixMatches = entries.filter((entry) => startsWithPath(entry.path, words));
  if (prefixMatches.length > 0) {
    // R17.C.2 (D-131): a bare valid domain/group path renders that node's
    // help exactly as `--help` would, instead of falling through to the
    // unknown-command suggester. Fail-closed exit 2 remains reserved for
    // paths that match nothing.
    return {
      kind: 'output',
      text: renderHelp(entries, version, words, args.includes('--all')),
      exitCode: 0,
    };
  }
  const maybe = suggestion(words, entries);
  const error = cliError({
    code: 'ROUTE_UNKNOWN',
    class: 'routing-authority',
    exit: 2,
    message: `Unknown or incomplete command '${words.join(' ')}'.`,
    remediation: maybe === undefined ? 'Run devai --help.' : `Did you mean 'devai ${maybe}'?`,
    refs: { doc: 'docs/reference/cli/' },
    context: { argv: words },
  });
  return {
    kind: 'output',
    text: renderCliError(error, wantsJson(args)),
    exitCode: EXIT_USAGE,
  };
}
