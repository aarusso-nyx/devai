#!/usr/bin/env node
import { cac } from 'cac';
import { routeArgv } from './command-router.js';
import {
  attachRuntimeContracts,
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
import { ACTION_REGISTRY } from './generated/action-registry.js';

const pkgVersion = resolveCliVersion();

const cli = cac('devai');
cli.version(pkgVersion);
cli.help();

const DOMAIN_ORDER = [
  'catalog',
  'check',
  'doctor',
  'evidence',
  'init',
  'release',
  'round',
  'sense',
  'task',
] as const;
type CommandDomain = (typeof DOMAIN_ORDER)[number];

function publicText(value: string): string {
  return value
    .replaceAll(process.cwd(), '<repo-root>')
    .replaceAll('--execute', '--write')
    .replaceAll('--apply', '--write')
    .replaceAll('--human', '--format human');
}

function canonicalRegistry(): readonly RegistryEntry[] {
  return ACTION_REGISTRY.map(
    (entry) =>
      ({
        name: entry.action_id,
        handler: entry.handler,
        internal_name: entry.handler.replaceAll(' ', '-'),
        path: entry.path,
        status: entry.status,
        description: publicText(entry.description),
        authority: entry.authority ?? 'mesh_controller',
        lifecycle: entry.status === 'preview' ? 'experimental' : 'supported',
        lifecycle_reason:
          entry.status === 'preview'
            ? 'Preview action; contract may change before v1.0.'
            : 'Stable action.',
        promotion_criteria: [],
        visibility: entry.status === 'internal' ? 'maintainer' : 'standard',
        tier: entry.status === 'internal' ? 'plumbing' : 'porcelain',
        profiles: entry.profiles,
        effects: entry.effect,
        authority_contract_version: entry.authority_contract_version,
        authority_contract: entry.authority_contract,
        output_contract: entry.output_contract,
        error_contract: entry.error_contract,
      }) as RegistryEntry,
  );
}

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
      const {
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
      } = await import('./commands/round/workflow.js');
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
  if (human) {
    preserveHumanOutputBeforeExplicitExit();
    runCliStage(machineAction, 'handler-dispatch', () => cli.parse(route.argv));
    return;
  }
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

await main();
