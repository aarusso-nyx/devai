import type { CAC } from 'cac';
import { realpathSync } from 'node:fs';
import { routeArgv } from '../../command-router.js';
import { defineCommand, type RegistryEntry } from '../../define-command.js';
import { EXIT_FAIL, EXIT_GATE, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { declaredInvocationAuthority } from '../../authority/index.js';
import {
  gateSelfDogfoodCommand,
  resolveSelfDogfoodDeclaration,
  selfDogfoodRefusal,
} from '../../services/self-dogfood.js';
import { SENSE_PRESET_POLICY } from '@devai-nyx/sensors';
import { sensorAdapter } from './adapters.js';
import { resolveSensorReadingInstance } from './reading-instance.js';
import { runWithResolvedSensorMember } from '../../authority/sensor-member.js';
import {
  resolveSenseSelection,
  type ResolvedSenseSelection,
  type SenseSelection,
} from './facade.js';
import { type SensorInputs } from './shared.js';

import { resolveMemberInputs } from './member-inputs.js';
export { resolveMemberInputs } from './member-inputs.js';
import { resolveTaskBoundSenseSelection } from './task-selection.js';
import { resolveSensorTaskBinding, executeSensorTask } from './task-binding.js';

type ReadinessStatus = 'pass' | 'review' | 'fail' | 'unknown' | 'na';
type StructuredStatus = Exclude<ReadinessStatus, 'na'> | 'skipped' | 'error' | 'killed';
type AggregateCountStatus = ReadinessStatus | 'error';

export interface SensorRunChildResult {
  readonly command: string;
  readonly processStatus: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly na?: boolean;
}

export interface SensorRunAggregate {
  readonly execution_status: 'pass' | 'error';
  readonly readiness_status: ReadinessStatus;
  readonly applicable_count: number;
  readonly na_count: number;
  readonly counts: Readonly<Record<AggregateCountStatus, number>>;
  /** Total public result code. Operational errors dominate readiness. */
  readonly exit_code: 0 | 1 | 3;
}

interface SenseRunOptions {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
  readonly pass?: string;
}

const STRUCTURED_STATUSES = new Set([
  'pass',
  'review',
  'fail',
  'unknown',
  'skipped',
  'error',
  'killed',
]);

function parseStructuredStatus(stdout: string): StructuredStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const status = (parsed as { readonly status?: unknown }).status;
    return typeof status === 'string' && STRUCTURED_STATUSES.has(status)
      ? (status as StructuredStatus)
      : undefined;
  } catch {
    return undefined;
  }
}

function aggregateExitCode(
  executionStatus: SensorRunAggregate['execution_status'],
  readinessStatus: ReadinessStatus,
): 0 | 1 | 3 {
  if (executionStatus === 'error' || readinessStatus === 'fail') return EXIT_GATE;
  if (readinessStatus === 'review' || readinessStatus === 'unknown') return EXIT_REVIEW;
  return EXIT_PASS;
}

/**
 * Aggregate readiness as a total function over every result state.
 *
 * Sensor process codes overlap readiness codes, so structured output remains the
 * readiness authority. Missing/malformed output and execution errors are FAIL(2),
 * UNKNOWN remains REVIEW(1), and an all-N/A population is a successful result.
 */
export function aggregateSensorRunResults(
  children: readonly SensorRunChildResult[],
): SensorRunAggregate {
  const counts: Record<AggregateCountStatus, number> = {
    pass: 0,
    review: 0,
    fail: 0,
    unknown: 0,
    na: 0,
    error: 0,
  };
  let executionError = false;

  for (const child of children) {
    if (child.processStatus === null) {
      counts.error += 1;
      executionError = true;
      continue;
    }
    const status = parseStructuredStatus(child.stdout);
    if (status === undefined || status === 'error' || status === 'killed') {
      counts.error += 1;
      executionError = true;
      continue;
    }
    if (child.na === true || status === 'skipped') {
      counts.na += 1;
      continue;
    }
    counts[status] += 1;
  }

  const applicableCount = counts.pass + counts.review + counts.fail + counts.unknown;
  const readinessStatus: ReadinessStatus =
    applicableCount === 0
      ? counts.na > 0
        ? 'na'
        : 'unknown'
      : counts.fail > 0
        ? 'fail'
        : counts.review > 0
          ? 'review'
          : counts.unknown > 0
            ? 'unknown'
            : 'pass';
  const executionStatus = executionError ? 'error' : 'pass';

  return {
    execution_status: executionStatus,
    readiness_status: readinessStatus,
    applicable_count: applicableCount,
    na_count: counts.na,
    counts,
    exit_code: aggregateExitCode(executionStatus, readinessStatus),
  };
}

export function routeSensorChildArgv(
  command: readonly string[],
  executable: string,
  entries: readonly RegistryEntry[],
  version: string,
): readonly string[] {
  const routed = routeArgv([process.execPath, executable, ...command], entries, version);
  if (routed.kind !== 'dispatch') throw new Error('SENSE_RUN_CHILD_ROUTE_INVALID');
  const internalName = routed.argv[2];
  const entry = entries.find((candidate) => candidate.internal_name === internalName);
  if (entry === undefined) throw new Error('SENSE_RUN_CHILD_ACTION_UNKNOWN');
  return [...entry.path, ...routed.argv.slice(3)];
}

function readingExitCode(status: StructuredStatus): 0 | 1 | 2 {
  if (status === 'review') return EXIT_REVIEW;
  if (status === 'fail' || status === 'error' || status === 'killed') return EXIT_FAIL;
  return EXIT_PASS;
}

function parseInputs(value?: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SENSE_INPUT_MUST_BE_JSON_OBJECT');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export async function executeResolvedSenseSelection(
  resolved: ResolvedSenseSelection,
  options: {
    readonly repoRoot: string;
    readonly inputs?: Readonly<Record<string, unknown>>;
    /** Per-member effective inputs; takes precedence over `inputs` when present. */
    readonly memberInputs?: ReadonlyMap<string, SensorInputs>;
  },
): Promise<readonly SensorRunChildResult[]> {
  const results: SensorRunChildResult[] = [];
  for (const member of resolved.members) {
    try {
      const inputs =
        options.memberInputs === undefined ? options.inputs : options.memberInputs.get(member.kind);
      const binding = resolveSensorTaskBinding(options.repoRoot, member.kind, inputs);
      const measured = await runWithResolvedSensorMember(member.kind, () =>
        binding !== undefined
          ? executeSensorTask(binding)
          : sensorAdapter(member.kind)({
              repoRoot: options.repoRoot,
              ...(inputs === undefined ||
              (options.memberInputs !== undefined && Object.keys(inputs).length === 0)
                ? {}
                : { inputs }),
            }),
      );
      const reading = resolveSensorReadingInstance(options.repoRoot, measured);
      if (reading.sensor.kind !== member.kind) {
        throw new Error(`SENSE_ADAPTER_KIND_MISMATCH:${member.kind}:${reading.sensor.kind}`);
      }
      const stdout = JSON.stringify(reading);
      const status = parseStructuredStatus(stdout);
      results.push({
        command: `devai sense run ${member.kind}`,
        processStatus: status === undefined ? null : readingExitCode(status),
        stdout,
        stderr: '',
        na: status === 'skipped',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /^OPTIONAL_DEPENDENCY_MISSING:[A-Za-z0-9@/._-]+$/u.test(error.message)
      ) {
        throw error;
      }
      results.push({
        command: `devai sense run ${member.kind}`,
        processStatus: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze(results);
}

/** One ordered pass of a resolved selection (ADR-SCR-0008). */
export type ResolvedSensePass = ResolvedSenseSelection & { readonly pass: 'first' | 'second' };

const PASS_EFFECT_RANK: Readonly<Record<string, number>> = Object.freeze({
  read: 0,
  'harness-write': 1,
  'local-write': 2,
  'remote-write': 3,
});

/**
 * The ordered second pass of the sweep, as `law/policy/sense-presets.json` declares it
 * in `selection_effect_rule.sweep_second_pass`: the members that read the readings
 * store, comma-separated in execution order.
 */
export function sweepSecondPass(): readonly string[] {
  const rule = (
    SENSE_PRESET_POLICY as unknown as {
      readonly selection_effect_rule?: Readonly<Record<string, unknown>>;
    }
  ).selection_effect_rule;
  const declared = rule?.['sweep_second_pass'];
  if (typeof declared !== 'string') return [];
  return declared
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
}

function passOf(
  resolved: ResolvedSenseSelection,
  pass: 'first' | 'second',
  kinds: readonly string[],
): ResolvedSensePass {
  const members = kinds.flatMap((kind) => {
    const member = resolved.members.find((candidate) => candidate.kind === kind);
    return member === undefined ? [] : [member];
  });
  const executed = members
    .map((member) => member.kind)
    .filter((kind) => resolved.executed.includes(kind));
  const aggregate = members.reduce<ResolvedSenseSelection['aggregate_effect']>(
    (current, member) =>
      (PASS_EFFECT_RANK[member.effect] ?? 0) > (PASS_EFFECT_RANK[current] ?? 0)
        ? member.effect
        : current,
    'read',
  );
  return Object.freeze({
    ...resolved,
    pass,
    members,
    executed,
    aggregate_effect: aggregate,
  });
}

/**
 * Split a resolved selection into its two ordered passes (ADR-SCR-0008). For the
 * sweep the first pass omits the declared store readers and the second pass runs
 * them in their declared order after the first pass is recorded; the preset never
 * records. Any other selection is a single first pass with an empty second pass.
 * Selection and exclusions are unchanged in both passes.
 */
export function resolveSensePasses(resolved: ResolvedSenseSelection): {
  readonly first: ResolvedSensePass;
  readonly second: ResolvedSensePass;
} {
  const isSweep = resolved.selection.type === 'preset' && resolved.selection.value === 'sweep';
  const memberKinds = resolved.members.map((member) => member.kind);
  const secondKinds = isSweep ? sweepSecondPass().filter((kind) => memberKinds.includes(kind)) : [];
  const firstKinds = memberKinds.filter((kind) => !secondKinds.includes(kind));
  return {
    first: passOf(resolved, 'first', firstKinds),
    second: passOf(resolved, 'second', secondKinds),
  };
}

function selectedPass(
  resolved: ResolvedSenseSelection,
  pass: string | undefined,
): ResolvedSenseSelection | ResolvedSensePass {
  if (pass !== undefined && pass !== 'first' && pass !== 'second') {
    throw new Error(`SENSE_PASS_UNKNOWN:${pass}`);
  }
  const isSweep = resolved.selection.type === 'preset' && resolved.selection.value === 'sweep';
  if (!isSweep) {
    if (pass === 'second') throw new Error(`SENSE_PASS_SWEEP_ONLY:${resolved.selection.value}`);
    return resolved;
  }
  const passes = resolveSensePasses(resolved);
  return pass === 'second' ? passes.second : passes.first;
}

function selectionFor(kind: string | undefined, preset: string | undefined): SenseSelection {
  if (kind !== undefined && preset === undefined) return { kind };
  if (kind === undefined && preset !== undefined) return { preset };
  throw new Error('SENSE_SELECTION_EXACTLY_ONE_REQUIRED');
}

export const senseRunSetCmd = defineCommand({
  name: 'sense run',
  description:
    'Run one resolved sensor kind or preset; per-kind effect and authority are enforced before execution.',
  authority: 'sensor',
  register(cli: CAC): void {
    cli
      .command(
        'sense-run [kind]',
        'Run one resolved sensor kind or preset; per-kind effect and authority are enforced before execution',
      )
      .option('--preset <name>', 'Canonical preset: baseline | structural | governed | sweep')
      .option('--round <id>', 'Round id required by the sweep preset')
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--input <json>', 'Sensor-specific inputs as a JSON object')
      .option(
        '--pass <pass>',
        'Sweep pass: first (default, omits the store readers) | second (the declared store readers)',
      )
      .option('--dry-run', 'Resolve and display the exact population without executing it')
      .option('--human', 'Human-readable summary')
      .action(async (kind: string | undefined, options: SenseRunOptions) => {
        try {
          // Resolution is intentionally complete before any adapter can execute.
          // ADR-SCR-0008: the sweep runs in two ordered passes; the first is the default.
          let resolved = selectedPass(
            resolveSenseSelection(selectionFor(kind, options.preset), {
              ...(options.round === undefined ? {} : { roundId: options.round }),
            }),
            options.pass,
          );
          const repoRoot = realpathSync(options.repoRoot ?? '.');
          const explicit = parseInputs(options.input);
          const memberInputs = resolveMemberInputs(resolved, {
            repoRoot,
            ...(explicit === undefined ? {} : { explicit }),
          });
          resolved = resolveTaskBoundSenseSelection(resolved, repoRoot, memberInputs);
          // ADR-SCR-0001: on the framework repository the self-dogfood matrix
          // decides the run from the declared role, the consent and the whole
          // resolved population, after the invocation is validated and before
          // any adapter runs.
          const selfDogfood = gateSelfDogfoodCommand({
            repoRoot,
            action_id: 'sense run',
            declaration: resolveSelfDogfoodDeclaration(declaredInvocationAuthority()),
            population: {
              aggregate_effect: resolved.aggregate_effect,
              member_effects: resolved.members.map((member) => member.effect),
            },
          });
          if (options.dryRun !== true && selfDogfood.applies && !selfDogfood.decision.ok) {
            process.stderr.write(selfDogfoodRefusal(selfDogfood));
            process.exitCode = EXIT_USAGE;
            return;
          }
          if (options.dryRun === true) {
            const members = resolved.members.map((member) => ({
              ...member,
              effective_inputs: memberInputs.get(member.kind) ?? {},
            }));
            process.stdout.write(
              `${JSON.stringify({
                ok: true,
                dry_run: true,
                ...resolved,
                members,
                ...(selfDogfood.applies ? { self_dogfood: selfDogfood } : {}),
              })}\n`,
            );
            process.exitCode = EXIT_PASS;
            return;
          }

          const results = await executeResolvedSenseSelection(resolved, {
            repoRoot,
            memberInputs,
          });
          const aggregate = aggregateSensorRunResults(results);
          const publicResults = results.map(({ processStatus, ...result }) => ({
            ...result,
            status: processStatus,
          }));
          const output = {
            ok: aggregate.exit_code === EXIT_PASS,
            dry_run: false,
            ...resolved,
            ...aggregate,
            results: publicResults,
          };
          if (options.human === true) {
            process.stdout.write(
              `devai sense run (${resolved.selection.value}): execution=${aggregate.execution_status.toUpperCase()} readiness=${aggregate.readiness_status.toUpperCase()} executed=${String(resolved.executed.length)} excluded=${String(resolved.excluded.length)}\n`,
            );
          } else {
            process.stdout.write(`${JSON.stringify(output)}\n`);
          }
          process.exitCode = aggregate.exit_code;
        } catch (error) {
          if (
            error instanceof Error &&
            /^OPTIONAL_DEPENDENCY_MISSING:[A-Za-z0-9@/._-]+$/u.test(error.message)
          ) {
            throw error;
          }
          process.stderr.write(
            `devai sense run: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_USAGE;
        }
      });
  },
});
