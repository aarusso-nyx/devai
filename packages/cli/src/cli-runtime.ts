import { cac, type CAC } from 'cac';
import { fileURLToPath } from 'node:url';
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
  disposeCliInvocationAuthority,
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
  type CliExecutionStage,
  type CliStageResult,
} from './action-output.js';

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
      const {
        releaseCertify,
        releaseCheck,
        releaseDrift,
        releaseEvidencePublish,
        releaseExport,
        releaseOfflineVerify,
        releasePlan,
        releasePreflight,
        releasePrepare,
        releasePublish,
        releaseResume,
        releaseStatus,
        releaseVerify,
      } = await import('./commands/release/facade.js');
      return [
        releaseCertify,
        releaseCheck,
        releaseDrift,
        releaseEvidencePublish,
        releaseExport,
        releaseOfflineVerify,
        releasePlan,
        releasePreflight,
        releasePrepare,
        releasePublish,
        releaseResume,
        releaseStatus,
        releaseVerify,
      ];
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

async function registerDomains(cli: CAC, domains: readonly CommandDomain[]): Promise<void> {
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

async function main(captureOutput: boolean): Promise<void> {
  const pkgVersion = resolveCliVersion();
  const cli = cac('devai');
  cli.version(pkgVersion);
  cli.help();
  const fullRegistry = needsRuntimeMetadata(process.argv);
  if (fullRegistry) await registerDomains(cli, DOMAIN_ORDER);
  const registry = fullRegistry
    ? (() => {
        attachRuntimeContracts(cli.commands);
        return getFullRegistry();
      })()
    : canonicalRegistry();
  const invocationAction = invocationActionForArgv(process.argv, registry);
  const machineAction = publicActionForArgv(process.argv, registry);
  const validated = invocationStage(machineAction, 'registry-validation', () => {
    validateActionSurface(registry);
    validateLiveAuthorityActionRegistry(registry);
  });
  const routed = validated.ok
    ? invocationStage(machineAction, 'routing', () =>
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
        await registerDomains(cli, [domain as CommandDomain]);
      } catch (error) {
        invocationStage(machineAction, 'initialization', () => {
          throw error;
        });
        return;
      }
    }
  }
  const handlerRegistry = fullRegistry ? registry : getFullRegistry();
  const initialized = invocationStage(machineAction, 'initialization', () => {
    attachAuthorityCommandBoundaries(cli.commands, handlerRegistry);
    attachActionOutputBoundaries(cli.commands, handlerRegistry);
  });
  if (!initialized.ok) return;

  const authorized = invocationStage(machineAction, 'authorization', () =>
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
  if (human && !captureOutput) preserveHumanOutputBeforeExplicitExit();
  const dispatched = invocationStage(machineAction, 'handler-dispatch', () => {
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
      invocationStage(machineAction, 'handler-dispatch', () => {
        throw error;
      });
    }
  }
}

class CliInvocationExit extends Error {
  constructor(readonly exitCode: number) {
    super('release-host-explicit-exit');
  }
}

let invocationActive = false;
let invocationCwd: string | undefined;
let authorityCleanupFailed = false;

/** Package-private gate shared by invocation and adapter configuration. */
export function assertCliInvocationIdle(): void {
  if (authorityCleanupFailed) throw new Error('release-host-authority-cleanup-failed');
  if (invocationActive) throw new Error('release-host-invocation-in-progress');
}

function assertStableWorkingDirectory(): void {
  if (invocationCwd !== undefined && process.cwd() !== invocationCwd) {
    throw new Error('release-host-working-directory-changed');
  }
}

function invocationStage<T>(
  entry: RegistryEntry | undefined,
  stage: CliExecutionStage,
  operation: () => T,
): CliStageResult<T> {
  assertStableWorkingDirectory();
  let explicitExit: CliInvocationExit | undefined;
  const result = runCliStage(entry, stage, () => {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof CliInvocationExit)) throw error;
      explicitExit = error;
      return undefined as T;
    }
  });
  if (explicitExit !== undefined) throw explicitExit;
  return result;
}

export interface CliInvocationResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(
  argv: readonly string[],
  captureOutput: boolean,
): Promise<CliInvocationResult> {
  assertCliInvocationIdle();
  assertStableWorkingDirectory();
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('release-host-argv-invalid');
  }
  invocationActive = true;
  invocationCwd ??= process.cwd();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    exit: process.exit,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const capture = (append: (text: string) => void): typeof process.stdout.write =>
    ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      append(
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : String(chunk),
      );
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof process.stdout.write;
  try {
    process.argv = [...argv];
    process.exitCode = undefined;
    process.exit = ((code?: string | number | null): never => {
      const resolved = Number(code ?? process.exitCode ?? 0);
      throw new CliInvocationExit(Number.isFinite(resolved) ? resolved : 6);
    }) as typeof process.exit;
    if (captureOutput) {
      process.stdout.write = capture((text) => {
        stdout += text;
      });
      process.stderr.write = capture((text) => {
        stderr += text;
      });
    }
    try {
      await main(captureOutput);
    } catch (error) {
      if (error instanceof CliInvocationExit) {
        process.exitCode = error.exitCode;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`devai: ${message}\n`);
        process.exitCode = 6;
      }
    }
  } finally {
    try {
      disposeCliInvocationAuthority();
    } catch {
      // A failed disposal never leaves a reusable invocation surface.
      authorityCleanupFailed = true;
      process.stderr.write('devai: release-host-authority-cleanup-failed\n');
      process.exitCode = 6;
    } finally {
      exitCode = Number(process.exitCode ?? 0);
      process.argv = previous.argv;
      process.exitCode = previous.exitCode;
      process.exit = previous.exit;
      process.stdout.write = previous.stdout;
      process.stderr.write = previous.stderr;
      invocationActive = false;
    }
  }
  return { exit_code: exitCode, stdout, stderr };
}

/**
 * Run normal DEVAI CLI arguments (without node/bin prefixes), capturing its output.
 * Routing, consent, role and final authority checks are identical to the executable.
 * Sequential calls are supported. Concurrent/reentrant calls reject before effects.
 * The first invocation fixes the process cwd; later cwd drift rejects before effects.
 * Use explicit --repo-root/--target arguments for other repositories. The host must
 * not change cwd, argv, exit or process streams while a call is active.
 * This function restores process globals and never exits the host process.
 */
export function invokeDevaiCli(args: readonly string[]): Promise<CliInvocationResult> {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return Promise.reject(new TypeError('release-host-argv-invalid'));
  }
  return invoke(
    [process.execPath, fileURLToPath(new URL('./bin.js', import.meta.url)), ...args],
    true,
  );
}

/** Explicit executable startup. Writes normal CLI output and returns the exit code. */
export async function startDevaiCli(argv: readonly string[] = process.argv): Promise<number> {
  return (await invoke(argv, false)).exit_code;
}
