import { resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PRECONDITION, EXIT_USAGE } from '@devai-nyx/utils';
import { cliError, renderCliError } from '../../cli-error.js';
import { defineCommand } from '../../define-command.js';
import {
  runCheckTasks,
  type CheckRunnerReport,
  type TaskOperation,
  type TaskTarget,
} from '../../services/check-runner/index.js';
import { executeCheckMember, type CheckExecutionOptions } from './adapters.js';
import { resolveCheckPlan, runCheckPlan, type CheckRunReport } from './contracts.js';

interface CheckCliOptions extends Omit<CheckExecutionOptions, 'repoRoot'> {
  readonly suite?: string;
  readonly only?: string;
  readonly repoRoot?: string;
  readonly human?: boolean;
  readonly affected?: boolean;
  readonly local?: boolean;
  readonly rc?: boolean;
  readonly taskPlan?: boolean;
  readonly run?: boolean;
  readonly status?: boolean;
  readonly explain?: boolean;
  readonly base?: string;
  readonly taskTimeoutMs?: string;
}

function exactlyOne<T extends string>(
  values: readonly Readonly<{ name: T; selected: boolean | undefined }>[],
  label: string,
): T {
  const selected = values.filter((entry) => entry.selected === true);
  if (selected.length !== 1) {
    throw new Error(`CHECK_RUNNER_SELECTION: select exactly one ${label}`);
  }
  return selected[0]?.name as T;
}

function runnerSelection(
  options: CheckCliOptions,
): Readonly<{ target: TaskTarget; operation: TaskOperation }> | undefined {
  const targetFlags = [options.affected, options.local, options.rc];
  const operationFlags = [options.taskPlan, options.run, options.status, options.explain];
  if (![...targetFlags, ...operationFlags].some((value) => value === true)) return undefined;
  return {
    target: exactlyOne<TaskTarget>(
      [
        { name: 'affected', selected: options.affected },
        { name: 'local', selected: options.local },
        { name: 'rc', selected: options.rc },
      ],
      'task target: --affected, --local, or --rc',
    ),
    operation: exactlyOne<TaskOperation>(
      [
        { name: 'plan', selected: options.taskPlan },
        { name: 'run', selected: options.run },
        { name: 'status', selected: options.status },
        { name: 'explain', selected: options.explain },
      ],
      'task operation: --task-plan, --run, --status, or --explain',
    ),
  };
}

function renderRunnerHuman(report: CheckRunnerReport): string {
  const lines = [
    `check ${report.plan.target} ${report.operation}: ${String(report.plan.tasks.length)} task(s), tree=${report.plan.clean ? 'clean' : 'dirty'}`,
  ];
  for (const task of report.plan.tasks) {
    const executed = report.execution?.find((entry) => entry.nodeId === task.nodeId);
    lines.push(
      `  ${(executed?.disposition ?? task.cacheState).toUpperCase()} ${task.nodeId}: ${executed?.reason ?? task.reason}`,
    );
  }
  if (report.receipt !== undefined) lines.push(`  RECEIPT ${report.receipt.digest}`);
  if (report.receiptRefusal !== undefined) lines.push(`  NO RECEIPT: ${report.receiptRefusal}`);
  return `${lines.join('\n')}\n`;
}

function renderHuman(report: CheckRunReport): string {
  const selected =
    report.selection.kind === 'suite'
      ? `suite ${report.selection.suite}`
      : `only ${report.selection.member}`;
  const lines = [
    `check (${selected}): execution=${report.execution_status.toUpperCase()} readiness=${report.readiness_status.toUpperCase()}`,
  ];
  for (const result of report.results) {
    lines.push(
      `  ${result.status.toUpperCase()} ${result.id} (${String(result.duration_ms)}ms, ${result.effect})`,
    );
    if (result.message !== undefined) lines.push(`    ${result.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export const checkCmd = defineCommand({
  name: 'check',
  description: 'Run a canonical check suite or one named check with fail-closed aggregate output.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command(
        'check',
        'Run a canonical check suite or one named check with fail-closed aggregate output',
      )
      .option('--suite <name>', 'quick | standard | full | release (default: standard)')
      .option('--only <member>', 'Run one named canonical check member')
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--schema <path>', 'Schema path for --only schema')
      .option('--instance <path>', 'Instance path for --only schema')
      .option('--file <path>', 'Input file for --only blueprint')
      .option('--witness <path>', 'Translation witness for --only translation')
      .option('--database-url <url>', 'Administrative database URL for translation isolation')
      .option('--pr-body-file <path>', 'PR body file for --only pr-compliance')
      .option('--optional', 'Permit a missing compliance trailer for --only pr-compliance')
      .option('--strict', "Enable the named check's strict posture where supported")
      .option('--since-ref <ref>', 'Verified lower commit bound for forbidden-action history')
      .option('--max-commits <n>', 'Bound forbidden-action history when --since-ref is absent')
      .option('--skip-publish-check', 'Skip the docs-governance publication-branch probe')
      .option('--mutation-baseline <path>', 'Mutation baseline for --only mutation')
      .option('--mutation-current <path>', 'Mutation current report for --only mutation')
      .option('--mutation-thresholds <path>', 'Mutation thresholds for --only mutation')
      .option('--affected', 'Select tasks affected since the exact --base commit')
      .option('--local', 'Select the complete cheap local task closure')
      .option('--rc', 'Select the fixed release-candidate task closure')
      .option('--task-plan', 'Task operation (choose one): plan without executing')
      .option('--run', 'Task operation (choose one): execute or reuse selected tasks')
      .option('--status', 'Task operation (choose one): show freshness status')
      .option('--explain', 'Task operation (choose one): explain selection and reuse')
      .option('--base <commit>', 'Exact ancestor commit required with --affected')
      .option('--task-timeout-ms <n>', 'Per-task timeout in milliseconds for --run')
      .option('--human', 'Human-readable aggregate')
      .action(async (options: CheckCliOptions) => {
        const repoRoot = resolve(options.repoRoot ?? '.');
        try {
          const taskSelection = runnerSelection(options);
          if (taskSelection !== undefined) {
            if (options.suite !== undefined || options.only !== undefined) {
              throw new Error('CHECK_RUNNER_SELECTION: task flags conflict with --suite/--only');
            }
            const timeout =
              options.taskTimeoutMs === undefined ? undefined : Number(options.taskTimeoutMs);
            const report = runCheckTasks({
              repoRoot,
              ...taskSelection,
              ...(options.base !== undefined && { baseCommit: options.base }),
              ...(timeout !== undefined && { timeoutMs: timeout }),
            });
            process.stdout.write(
              options.human === true ? renderRunnerHuman(report) : `${JSON.stringify(report)}\n`,
            );
            process.exitCode = report.exitCode;
            return;
          }
          const plan = resolveCheckPlan(repoRoot, {
            ...(options.suite !== undefined && { suite: options.suite }),
            ...(options.only !== undefined && { only: options.only }),
          });
          const executionOptions: CheckExecutionOptions = {
            repoRoot,
            ...(options.schema !== undefined && { schema: options.schema }),
            ...(options.instance !== undefined && { instance: options.instance }),
            ...(options.file !== undefined && { file: options.file }),
            ...(options.witness !== undefined && { witness: options.witness }),
            ...(options.databaseUrl !== undefined && { databaseUrl: options.databaseUrl }),
            ...(options.prBodyFile !== undefined && { prBodyFile: options.prBodyFile }),
            ...(options.optional !== undefined && { optional: options.optional }),
            ...(options.strict !== undefined && { strict: options.strict }),
            ...(options.sinceRef !== undefined && { sinceRef: options.sinceRef }),
            ...(options.maxCommits !== undefined && {
              maxCommits: Number(options.maxCommits),
            }),
            ...(options.skipPublishCheck !== undefined && {
              skipPublishCheck: options.skipPublishCheck,
            }),
            ...(options.mutationBaseline !== undefined && {
              mutationBaseline: options.mutationBaseline,
            }),
            ...(options.mutationCurrent !== undefined && {
              mutationCurrent: options.mutationCurrent,
            }),
            ...(options.mutationThresholds !== undefined && {
              mutationThresholds: options.mutationThresholds,
            }),
          };
          const report = await runCheckPlan(plan, (member) =>
            executeCheckMember(member, executionOptions),
          );
          const machineResult =
            report.selection.kind === 'only' && report.results[0]?.value !== undefined
              ? report.results[0].value
              : report;
          process.stdout.write(
            options.human === true ? renderHuman(report) : `${JSON.stringify(machineResult)}\n`,
          );
          process.exitCode = report.exit_code;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.startsWith('CHECK_TASK_DESCRIPTOR_MISSING:') ||
            message.startsWith('CHECK_RC_DB_TESTS_REQUIRED:')
          ) {
            const code = message.startsWith('CHECK_RC_DB_TESTS_REQUIRED:')
              ? 'CHECK_RC_DB_TESTS_REQUIRED'
              : 'CHECK_TASK_DESCRIPTOR_MISSING';
            const diagnostic = cliError({
              code,
              class: 'precondition',
              exit: 5,
              message: message.replace(/^[A-Z0-9_]+:\s*/u, ''),
              remediation:
                code === 'CHECK_RC_DB_TESTS_REQUIRED'
                  ? 'Set DEVAI_DB_TESTS=1, provide a reachable test database, and retry the RC plan or run.'
                  : 'Create the adopter-owned test-tasks.json from docs/adopters/test-tasks.md, then retry.',
              refs: {
                doc:
                  code === 'CHECK_RC_DB_TESTS_REQUIRED'
                    ? 'docs/dev/operations/testing.md'
                    : 'docs/adopters/test-tasks.md',
              },
            });
            process.stderr.write(renderCliError(diagnostic, options.human !== true));
            process.exitCode = EXIT_PRECONDITION;
            return;
          }
          process.stderr.write(`devai check: ${message}\n`);
          process.exitCode =
            message.startsWith('CHECK_SUITE_UNKNOWN') ||
            message.startsWith('CHECK_MEMBER_UNKNOWN') ||
            message.startsWith('CHECK_SELECTION_CONFLICT') ||
            message.startsWith('CHECK_RUNNER_SELECTION') ||
            message.startsWith('CHECK_RUNNER_BASE_REQUIRED') ||
            message.startsWith('CHECK_RUNNER_TIMEOUT')
              ? EXIT_USAGE
              : EXIT_FAIL;
        }
      });
  },
});
