import type { CAC } from 'cac';
import { routeArgv } from '../../command-router.js';
import { defineCommand, type RegistryEntry } from '../../define-command.js';
import { EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '@devai-nyx/utils';
import { sensorAdapter } from './adapters.js';
import {
  resolveSenseSelection,
  type ResolvedSenseSelection,
  type SenseSelection,
} from './facade.js';

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
  readonly exit_code: 0 | 1 | 2;
}

interface SenseRunOptions {
  readonly preset?: string;
  readonly round?: string;
  readonly repoRoot?: string;
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly human?: boolean;
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
): 0 | 1 | 2 {
  if (executionStatus === 'error' || readinessStatus === 'fail') return EXIT_FAIL;
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
  options: { readonly repoRoot: string; readonly inputs?: Readonly<Record<string, unknown>> },
): Promise<readonly SensorRunChildResult[]> {
  const results: SensorRunChildResult[] = [];
  for (const member of resolved.members) {
    try {
      const reading = await sensorAdapter(member.kind)({
        repoRoot: options.repoRoot,
        ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
      });
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
      .option('--dry-run', 'Resolve and display the exact population without executing it')
      .option('--human', 'Human-readable summary')
      .action(async (kind: string | undefined, options: SenseRunOptions) => {
        try {
          // Resolution is intentionally complete before any adapter can execute.
          const resolved = resolveSenseSelection(selectionFor(kind, options.preset), {
            ...(options.round === undefined ? {} : { roundId: options.round }),
          });
          if (options.dryRun === true) {
            process.stdout.write(`${JSON.stringify({ ok: true, dry_run: true, ...resolved })}\n`);
            process.exitCode = EXIT_PASS;
            return;
          }

          const results = await executeResolvedSenseSelection(resolved, {
            repoRoot: options.repoRoot ?? '.',
            ...(options.input === undefined ? {} : { inputs: parseInputs(options.input) }),
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
          process.stderr.write(
            `devai sense run: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = EXIT_USAGE;
        }
      });
  },
});
