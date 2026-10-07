import type { CAC } from 'cac';
import { buildBootstrapPlan, introspectRepo } from '@devai-nyx/skills';
import { validators } from '@devai-nyx/schemas';
import { isAdoptionProfile, EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';
import { cliError, renderCliError } from '../../cli-error.js';
import { resolveCliVersion } from '../../version.js';
import {
  addInitOptions,
  emit,
  validateInitTarget,
  validateInitTier,
  type InitOptions,
  type InitSegment,
  type ValidatedInitTarget,
} from './shared.js';

export function initPlanFor(options: InitOptions, target: ValidatedInitTarget) {
  return buildBootstrapPlan({
    targetRoot: target.requested,
    version: options.stampVersion ?? resolveCliVersion(),
    ...(options.tier !== undefined && isAdoptionProfile(options.tier) && { profile: options.tier }),
  });
}

export function inspectForInit(options: InitOptions, target: ValidatedInitTarget) {
  if (options.introspect !== true) return null;
  const introspection = introspectRepo({ targetRoot: target.resolved });
  if (!validators.repoIntrospection(introspection)) {
    process.stderr.write(
      `devai init --introspect: introspection failed schema validation: ${JSON.stringify(validators.repoIntrospection.errors)}\n`,
    );
    process.exit(EXIT_FAIL);
  }
  return introspection;
}

export function segmentedPlan(plan: ReturnType<typeof buildBootstrapPlan>, segment: InitSegment) {
  const entries = plan.entries.filter((entry) => {
    if (segment === 'owner') {
      return entry.path.startsWith('product/') || entry.path.startsWith('law/glossary/');
    }
    if (segment === 'architect') {
      return (
        entry.path === 'AGENTS.md' ||
        entry.path === 'CLAUDE.md' ||
        entry.path.startsWith('docs/') ||
        entry.path.startsWith('work/') ||
        (entry.path.startsWith('law/') && !entry.path.startsWith('law/glossary/'))
      );
    }
    return (
      entry.path !== 'AGENTS.md' &&
      entry.path !== 'CLAUDE.md' &&
      !entry.path.startsWith('product/') &&
      !entry.path.startsWith('docs/') &&
      !entry.path.startsWith('work/') &&
      !entry.path.startsWith('law/')
    );
  });
  return {
    ...plan,
    entries,
    summary: {
      create: entries.filter((entry) => entry.action === 'create').length,
      overwrite: entries.filter((entry) => entry.action === 'overwrite').length,
      replace: entries.filter((entry) => entry.action === 'replace').length,
      skip: entries.filter((entry) => entry.action === 'skip-exists').length,
    },
  };
}

function canonicalInitPlanFor(options: InitOptions, target: ValidatedInitTarget) {
  const plan = initPlanFor(options, target);
  const segments = (['owner', 'architect', 'harness'] as const).map((segment) => {
    const projection = segmentedPlan(plan, segment);
    return { segment, entries: projection.entries, summary: projection.summary };
  });
  const partition = segments.flatMap(({ entries }) => entries.map(({ path }) => path));
  if (partition.length !== plan.entries.length || new Set(partition).size !== partition.length) {
    throw new Error('INIT_SEGMENT_PARTITION_INVALID');
  }
  return {
    ...plan,
    segments,
  };
}

export const initPlan = defineCommand({
  name: 'init plan',
  description: 'Build the exact segmented bootstrap plan without authorizing a mutation.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    addInitOptions(cli.command('init-plan', 'Generate the non-authorizing bootstrap plan'), true)
      .option(
        '--interactive',
        'Author the plan through schema-driven prompts; writes replay as init bind and init apply',
      )
      .option('--mode <mode>', 'Interactive mode: bind | edit (default: bind)')
      .action(async (options: InitPlanOptions) => {
        validateInitTier(options);
        if (options.interactive === true) {
          await runInteractiveInitPlanAction(options);
          return;
        }
        const target = validateInitTarget(options);
        if (target === undefined) return;
        const introspection = inspectForInit(options, target);
        const plan = canonicalInitPlanFor(options, target);
        emit(
          introspection === null ? plan : { introspection, plan },
          options.human === true,
          `init plan: ${String(plan.summary.create)} would be created, ${String(plan.summary.skip)} already exist\n${plan.entries
            .map(
              (entry) =>
                `  ${entry.action === 'create' ? '+' : entry.action === 'skip-exists' ? '·' : '~'} ${entry.path}`,
            )
            .join('\n')}`,
        );
        process.exitCode = EXIT_PASS;
      });
  },
});

interface InitPlanOptions extends InitOptions {
  readonly interactive?: boolean;
  readonly mode?: string;
}

function interactiveError(
  error: Omit<Parameters<typeof cliError>[0], 'class' | 'exit'> & {
    readonly class?: Parameters<typeof cliError>[0]['class'];
    readonly exit?: Parameters<typeof cliError>[0]['exit'];
  },
  human: boolean,
): void {
  const envelope = cliError({ class: 'precondition', exit: 5, ...error });
  process.stderr.write(renderCliError(envelope, !human));
  process.exitCode = envelope.exit;
}

async function runInteractiveInitPlanAction(options: InitPlanOptions): Promise<void> {
  const human = options.human === true;
  const mode = options.mode ?? 'bind';
  if (mode !== 'bind' && mode !== 'edit') {
    interactiveError(
      {
        code: 'INIT_INTERACTIVE_MODE_INVALID',
        class: 'invalid-input',
        exit: 4,
        message: `--mode must be one of bind | edit (got '${mode}')`,
        remediation: 'Choose --mode bind or --mode edit and retry.',
        context: { mode },
      },
      human,
    );
    return;
  }
  // Checked before any plan is built or the target is touched: the flow never
  // falls back to defaults or reads answers from anywhere but a terminal.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    interactiveError(
      {
        code: 'INIT_INTERACTIVE_TERMINAL_REQUIRED',
        message: 'init plan --interactive needs a terminal on standard input and standard output',
        remediation:
          'Run it from an interactive terminal, or run the non-interactive init plan, init bind, and init apply argv instead.',
        context: {
          stdin_is_tty: process.stdin.isTTY === true,
          stdout_is_tty: process.stdout.isTTY === true,
        },
      },
      human,
    );
    return;
  }
  const target = validateInitTarget(options);
  if (target === undefined) return;
  const [{ runInteractiveInitPlan }, { openTerminalPromptIo }] = await Promise.all([
    import('../../services/interactive-config.js'),
    import('../../services/schema-prompts.js'),
  ]);
  const io = openTerminalPromptIo();
  try {
    await runInteractiveInitPlan({
      repoRoot: target.resolved,
      target: target.requested,
      mode,
      io,
      ...(options.tier !== undefined && { tier: options.tier }),
      ...(options.stampVersion !== undefined && { stampVersion: options.stampVersion }),
    });
    process.exitCode = EXIT_PASS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let envelope: unknown;
    try {
      envelope = JSON.parse(message) as unknown;
    } catch {
      envelope = undefined;
    }
    if (validators.error(envelope)) {
      const structured = envelope as ReturnType<typeof cliError>;
      process.stderr.write(renderCliError(structured, !human));
      process.exitCode = structured.exit;
    } else {
      interactiveError(
        {
          code: 'INIT_INTERACTIVE_FAILED',
          class: 'infrastructure',
          exit: 6,
          message,
          remediation: 'Replay the printed non-interactive argv to reproduce the failure.',
        },
        human,
      );
    }
  } finally {
    io.close();
  }
}
