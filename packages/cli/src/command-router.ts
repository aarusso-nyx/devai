import type { RegistryEntry } from './define-command.js';
import { resolve } from 'node:path';
import {
  SENSOR_REGISTRY,
  isSensorKind,
  schemaUnsupportedKinds,
  type SensorRegistry,
} from '@devai-nyx/sensors/registry';
import { sensePreset } from '@devai-nyx/sensors/presets';
import { EXIT_USAGE } from '@devai-nyx/utils';
import { cliError, renderCliError } from './cli-error.js';
import { resolveInvocationEntry } from './authority/sense-selection.js';
import { knownCheckMembers, suggestCheckMembers } from './commands/check/contracts.js';
import { renderHelp, startsWithPath, suggestion } from './command-router-help.js';
export { renderHelp } from './command-router-help.js';

export { EXIT_USAGE };

function wantsJson(args: readonly string[]): boolean {
  const format = args.lastIndexOf('--format');
  return args.includes('--json') || (format >= 0 && args[format + 1] === 'json');
}

export type RouteResult =
  | { readonly kind: 'dispatch'; readonly argv: string[] }
  | {
      readonly kind: 'output';
      readonly text: string;
      readonly exitCode: number;
      readonly bypassActionOutput?: true;
    };

export const ROUTER_INTERNAL_NAMES = ['check', 'round-close', 'init-bind'] as const;

// Actions whose handlers take a positional operand. The fast path routes from the canonical
// registry, which carries no runtime_args, so a positional action must be named here (#338).
const POSITIONAL_ACTION_NAMES = new Set([
  'backlog resolve',
  'backlog show',
  'evidence redact',
  'round gap resolve',
  'round gap show',
  'sense run',
]);

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith('-') ? undefined : value;
}

function positionalArguments(args: readonly string[], entry: RegistryEntry): readonly string[] {
  const valueOptions = new Set(
    (entry.runtime_options ?? [])
      .filter((option) => /[<[]/u.test(option.flags))
      .map((option) => option.flags.split(/\s/u)[0]),
  );
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument.startsWith('-')) {
      const flag = argument.split('=')[0];
      if (!argument.includes('=') && flag !== undefined && valueOptions.has(flag)) index += 1;
      continue;
    }
    positionals.push(argument);
  }
  return positionals;
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
  if (
    internalName === 'check' &&
    ['--task-plan', '--status', '--explain'].some((flag) => args.includes(flag))
  ) {
    return true;
  }
  if (internalName === 'round-close' && args.includes('--post-merge-receipt')) return true;
  // init bind and init upgrade (#264) plan without --write under a read scope.
  return (
    (internalName === 'init-bind' || internalName === 'init-upgrade') && !args.includes('--write')
  );
}

/**
 * ADR-SCR-0011: refuse `sense run` before any sensor starts when the selected kind, or any
 * member of the selected preset, is declared `schema_admission: "unsupported"`. An inline
 * `--preset=` token is refused first as an invalid selection (#252).
 */
function schemaAdmissionRefusal(
  args: readonly string[],
  registry: Pick<SensorRegistry, 'entries'>,
): RouteResult | undefined {
  if (args[0] !== 'sense' || args[1] !== 'run') return undefined;
  // #252 (Owner decision 2026-10-01): the inline `--preset=<name>` form is unsupported. Any
  // inline token invalidates the selection before schema membership is examined.
  const inline = args.find((arg) => arg.startsWith('--preset='));
  if (inline !== undefined && !args.includes('--help') && !args.includes('-h')) {
    const error = cliError({
      code: 'SENSE_SELECTION_INVALID',
      class: 'routing-authority',
      exit: 2,
      message: `Sense selection is invalid: the inline ${inline} form is unsupported.`,
      remediation: 'Select a preset with the separated form --preset <name>.',
      context: { token: inline },
    });
    return { kind: 'output', text: renderCliError(error, wantsJson(args)), exitCode: 2 };
  }
  const positional = args[2] !== undefined && !args[2].startsWith('-') ? args[2] : undefined;
  const presetName = flagValue(args, '--preset');
  const selected = [
    ...(positional === undefined ? [] : [positional]),
    ...(presetName === undefined ? [] : (sensePreset(presetName)?.members ?? [])),
  ];
  const unsupported = schemaUnsupportedKinds(selected, registry);
  if (unsupported.length === 0) return undefined;
  const error = cliError({
    code: 'SENSOR_KIND_SCHEMA_UNSUPPORTED',
    class: 'routing-authority',
    exit: 2,
    message: `Sensor kind '${unsupported.join("', '")}' is declared unsupported by the SensorReading schema and is refused before it runs.`,
    remediation:
      'Admit the kind in law/schemas/sensor-reading.schema.json and drop its schema_admission marker, or select other kinds.',
    context: {
      kinds: unsupported,
      ...(presetName === undefined ? {} : { preset: presetName }),
    },
  });
  return { kind: 'output', text: renderCliError(error, wantsJson(args)), exitCode: 2 };
}

/**
 * Route the process argv. `sensorRegistry` defaults to the validated law registry; it is
 * the ADR-SCR-0011 seam through which a caller supplies a registry-shaped fixture whose
 * entries carry `schema_admission`, without editing law.
 */
export function routeArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
  version: string,
  sensorRegistry: Pick<SensorRegistry, 'entries'> = SENSOR_REGISTRY,
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
  const admissionRefusal = schemaAdmissionRefusal(args, sensorRegistry);
  if (admissionRefusal !== undefined) return admissionRefusal;
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
    const leadingPositionals = words.slice(exact.path.length);
    const unexpectedPositionals =
      leadingPositionals.length > 0
        ? leadingPositionals
        : exact.runtime_options === undefined
          ? []
          : positionalArguments(remaining, exact);
    if (
      unexpectedPositionals.length > 0 &&
      (exact.runtime_args ?? '') === '' &&
      !POSITIONAL_ACTION_NAMES.has(exact.name)
    ) {
      const argument = unexpectedPositionals[0] ?? '';
      if (exact.name === 'check') {
        const repoRoot = resolve(flagValue(remaining, '--repo-root') ?? '.');
        const knownMember = knownCheckMembers(repoRoot).includes(argument);
        return usageRefusal(
          args,
          'CHECK_SELECTION_INVALID',
          `Check selection is invalid: unexpected argument "${argument}".`,
          knownMember
            ? `Use --only ${argument} to run one member, or --suite <name> for a suite.`
            : 'Use --only <member> to run one member, or --suite <name> for a suite.',
          { argument, known_member: knownMember },
        );
      }
      return usageRefusal(
        args,
        'ROUTE_UNEXPECTED_ARGUMENT',
        `${exact.name} does not accept positional argument "${argument}".`,
        `Run devai ${exact.name} --help and pass named options only.`,
        { action_id: exact.name, argument },
      );
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
      const selectors = [
        '--full',
        '--constitution',
        '--subprocess-effects',
        '--operational-law',
      ].filter((selector) => remaining.includes(selector));
      if (selectors.length > 1) {
        return usageRefusal(
          args,
          'INIT_BIND_SELECTION_INVALID',
          'init bind accepts only one binding selector per invocation.',
          'Choose one of --full, --constitution, --subprocess-effects, or --operational-law.',
          { selectors },
        );
      }
    }
    try {
      resolveInvocationEntry(exact, argv);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const check = exact.name === 'check';
      const unknownMember = check ? /^CHECK_MEMBER_UNKNOWN:(.+)$/u.exec(detail)?.[1] : undefined;
      const suggestions =
        unknownMember === undefined
          ? []
          : suggestCheckMembers(resolve(flagValue(remaining, '--repo-root') ?? '.'), unknownMember);
      const refusal = cliError({
        code:
          unknownMember !== undefined
            ? 'CHECK_MEMBER_UNKNOWN'
            : check
              ? 'CHECK_SELECTION_INVALID'
              : 'SENSE_SELECTION_INVALID',
        class: 'routing-authority',
        exit: EXIT_USAGE,
        message:
          unknownMember === undefined
            ? `${check ? 'Check' : 'Sense'} selection is invalid: ${detail}.`
            : `Check member is unknown: "${unknownMember}".`,
        remediation:
          unknownMember !== undefined
            ? suggestions.length > 0
              ? `Did you mean ${suggestions.map((member) => `--only ${member}`).join(', ')}?`
              : 'Run devai check --help and choose a canonical member.'
            : check
              ? 'Choose one canonical suite or member, then retry.'
              : 'Choose one registered kind or one canonical --preset, then retry.',
        refs: {
          doc: check ? 'law/policy/check-suites.json' : 'law/policy/sense-presets.json',
        },
        context: {
          detail,
          ...(unknownMember !== undefined && { member: unknownMember, suggestions }),
        },
      });
      return {
        kind: 'output',
        text: renderCliError(refusal, wantsJson(args)),
        exitCode: EXIT_USAGE,
      };
    }
    let translated = remaining.filter(
      (arg) => arg !== '--write' && arg !== '--publish' && arg !== '--experimental',
    );
    if (
      (exact.internal_name === 'init-bind' || exact.internal_name === 'init-upgrade') &&
      remaining.includes('--write')
    ) {
      translated = remaining.filter((arg) => arg !== '--publish');
    }
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
