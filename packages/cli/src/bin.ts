#!/usr/bin/env node
import { cac } from 'cac';
import { routeArgv } from './command-router.js';
import {
  attachRuntimeContracts,
  canonicalRegistry,
  getFullRegistry,
  type CommandDefinition,
  type RegistryEntry,
  validateActionSurface,
} from './define-command.js';
import {
  authorizeCliArgv,
  attachAuthorityCommandBoundaries,
  stripAuthorityArgv,
  validateLiveAuthorityActionRegistry,
} from './authority/index.js';
import { resolveCliVersion } from './version.js';
import {
  attachActionOutputBoundaries,
  emitPreDispatchActionResult,
  publicActionForArgv,
  runCliStage,
} from './action-output.js';

const pkgVersion = resolveCliVersion();

const cli = cac('devai');
cli.version(pkgVersion);
cli.help();

const DOMAIN_ORDER = [
  'audit',
  'catalog',
  'check',
  'doctor',
  'evidence',
  'init',
  'release',
  'round',
  'sense',
  'task',
  'triage',
] as const;
type CommandDomain = (typeof DOMAIN_ORDER)[number];

function invocationActionForArgv(
  argv: readonly string[],
  entries: readonly RegistryEntry[],
): RegistryEntry | undefined {
  const words = argv.slice(2).filter((value) => !value.startsWith('-'));
  return entries
    .filter((entry) => entry.path.every((part, index) => words[index] === part))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function needsRuntimeMetadata(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const format = args.lastIndexOf('--format');
  return (
    args.length === 0 ||
    args.some((value) => ['--help', '-h', '--all'].includes(value)) ||
    (format >= 0 && args[format + 1] === 'human')
  );
}

async function commandsFor(domain: CommandDomain): Promise<readonly CommandDefinition[]> {
  switch (domain) {
    case 'audit': {
      const [{ auditObserve }, { auditScorecard }] = await Promise.all([
        import('./commands/audit/observe.js'),
        import('./commands/audit/scorecard.js'),
      ]);
      return [auditObserve, auditScorecard];
    }
    case 'catalog': {
      const { actionsList } = await import('./commands/actions-list.js');
      return [actionsList];
    }
    case 'check': {
      const { checkCmd } = await import('./commands/check/facade.js');
      return [checkCmd];
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.js');
      return [doctor];
    }
    case 'evidence': {
      const { evidenceCollect, evidenceRecord, evidenceRedact, evidenceRender, evidenceVerify } =
        await import('./commands/evidence/facade.js');
      return [evidenceCollect, evidenceRecord, evidenceRedact, evidenceRender, evidenceVerify];
    }
    case 'init': {
      const { initApplyArchitect, initApplyHarness, initApplyOwner, initBind, initPlan } =
        await import('./commands/init/index.js');
      return [initApplyArchitect, initApplyHarness, initApplyOwner, initBind, initPlan];
    }
    case 'release': {
      const { releaseCheck, releaseDrift, releaseStatus, releaseVerify } =
        await import('./commands/release/facade.js');
      return [releaseCheck, releaseDrift, releaseStatus, releaseVerify];
    }
    case 'round': {
      const [
        {
          roundAssess,
          roundClose,
          roundGapCreate,
          roundGapList,
          roundGapResolve,
          roundGapShow,
          roundPlan,
          roundRun,
          roundSeal,
          roundStatus,
        },
        { roundTrackingDisable, roundTrackingEnable, roundTrackingStatus, roundTrackingSync },
      ] = await Promise.all([
        import('./commands/round/workflow.js'),
        import('./commands/round/tracking.js'),
      ]);
      return [
        roundAssess,
        roundClose,
        roundGapCreate,
        roundGapList,
        roundGapResolve,
        roundGapShow,
        roundPlan,
        roundRun,
        roundSeal,
        roundStatus,
        roundTrackingDisable,
        roundTrackingEnable,
        roundTrackingStatus,
        roundTrackingSync,
      ];
    }
    case 'sense': {
      const [{ senseInventoryCmd }, { senseMigrateCmd }, { senseRecordCmd }, { senseRunSetCmd }] =
        await Promise.all([
          import('./commands/sense/inventory.js'),
          import('./commands/sense/migrate.js'),
          import('./commands/sense/record.js'),
          import('./commands/sense/run-set.js'),
        ]);
      return [senseInventoryCmd, senseMigrateCmd, senseRecordCmd, senseRunSetCmd];
    }
    case 'task': {
      const {
        taskEscalate,
        taskFinish,
        taskPause,
        taskQueueAdd,
        taskQueueComplete,
        taskQueueList,
        taskQueueNext,
        taskResume,
        taskStart,
        taskStatus,
      } = await import('./commands/task/index.js');
      return [
        taskEscalate,
        taskFinish,
        taskPause,
        taskQueueAdd,
        taskQueueComplete,
        taskQueueList,
        taskQueueNext,
        taskResume,
        taskStart,
        taskStatus,
      ];
    }
    case 'triage': {
      const { triageClassify } = await import('./commands/triage/classify.js');
      return [triageClassify];
    }
  }
}

async function registerDomains(domains: readonly CommandDomain[]): Promise<void> {
  const groups = await Promise.all(domains.map(commandsFor));
  for (const command of groups.flat()) command.register(cli);
}

function renderRouteOutput(
  machineAction: RegistryEntry | undefined,
  route: Extract<ReturnType<typeof routeArgv>, { readonly kind: 'output' }>,
): void {
  if (
    route.bypassActionOutput === true ||
    !emitPreDispatchActionResult(machineAction, {
      exit: route.exitCode,
      stdout: route.exitCode === 0 ? route.text : '',
      stderr: route.exitCode === 0 ? '' : route.text,
    })
  ) {
    const stream = route.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(route.text);
    process.exitCode = route.exitCode;
  }
}

function preserveHumanOutputBeforeExplicitExit(): void {
  const args = process.argv.slice(2);
  const format = args.lastIndexOf('--format');
  if (args.includes('--json') || (format >= 0 && args[format + 1] === 'json')) return;
  type BlockingStream = NodeJS.WriteStream & {
    readonly _handle?: { readonly setBlocking?: (value: boolean) => void };
  };
  for (const stream of [process.stdout, process.stderr] as readonly BlockingStream[]) {
    stream._handle?.setBlocking?.(true);
  }
}

async function main(): Promise<void> {
  const fullRegistry = needsRuntimeMetadata(process.argv);
  if (fullRegistry) await registerDomains(DOMAIN_ORDER);
  const registry = fullRegistry
    ? (() => {
        attachRuntimeContracts(cli.commands);
        return getFullRegistry();
      })()
    : canonicalRegistry();
  const invocationAction = invocationActionForArgv(process.argv, registry);
  const machineAction = publicActionForArgv(process.argv, registry);
  const validated = runCliStage(machineAction, 'registry-validation', () => {
    validateActionSurface(registry);
    validateLiveAuthorityActionRegistry(registry);
  });
  const routed = validated.ok
    ? runCliStage(machineAction, 'routing', () =>
        routeArgv(stripAuthorityArgv(process.argv), registry, pkgVersion),
      )
    : undefined;
  const route = routed?.ok === true ? routed.value : undefined;
  if (route === undefined) return;
  if (route.kind === 'output') {
    renderRouteOutput(machineAction, route);
    return;
  }

  if (!fullRegistry && invocationAction !== undefined) {
    const domain = invocationAction.path[0];
    if (DOMAIN_ORDER.includes(domain as CommandDomain)) {
      try {
        await registerDomains([domain as CommandDomain]);
      } catch (error) {
        runCliStage(machineAction, 'initialization', () => {
          throw error;
        });
        return;
      }
    }
  }
  const handlerRegistry = fullRegistry ? registry : getFullRegistry();
  const initialized = runCliStage(machineAction, 'initialization', () => {
    attachAuthorityCommandBoundaries(cli.commands, handlerRegistry);
    attachActionOutputBoundaries(cli.commands, handlerRegistry);
  });
  if (!initialized.ok) return;

  const authorized = runCliStage(machineAction, 'authorization', () =>
    authorizeCliArgv(process.argv, registry),
  );
  const authorityResult = authorized.ok ? authorized.value : undefined;
  if (!authorized.ok) return;
  if (authorityResult !== undefined) {
    if (
      !emitPreDispatchActionResult(machineAction, {
        exit: authorityResult.exit_code,
        stdout: authorityResult.stdout,
        stderr: authorityResult.stderr,
      })
    ) {
      const stream = authorityResult.stdout.length > 0 ? process.stdout : process.stderr;
      stream.write(
        authorityResult.stdout.length > 0 ? authorityResult.stdout : authorityResult.stderr,
      );
      process.exitCode = authorityResult.exit_code;
    }
    return;
  }
  const args = process.argv.slice(2);
  const format = args.lastIndexOf('--format');
  const human = !args.includes('--json') && !(format >= 0 && args[format + 1] === 'json');
  if (human) preserveHumanOutputBeforeExplicitExit();
  const dispatched = runCliStage(machineAction, 'handler-dispatch', () => {
    cli.parse(route.argv, { run: false });
    return cli.runMatchedCommand() as unknown;
  });
  const pending = dispatched.ok
    ? (dispatched.value as PromiseLike<unknown> | undefined)
    : undefined;
  if (pending !== undefined && typeof pending.then === 'function') {
    try {
      await pending;
    } catch (error) {
      runCliStage(machineAction, 'handler-dispatch', () => {
        throw error;
      });
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`devai: ${message}\n`);
  process.exitCode = 6;
}
