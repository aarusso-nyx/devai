import { cac, type CAC } from 'cac';
import { resolve } from 'node:path';
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
  declareSelfDogfoodInvocation,
  gateSelfDogfoodCommand,
  isSelfDogfoodRole,
  isSelfDogfoodSenseAction,
  readSelfDogfoodPolicy,
  selfDogfoodRefusal,
} from './services/self-dogfood.js';
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
  'backlog',
  'campaign',
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
    case 'backlog': {
      const { backlogAdd, backlogList, backlogResolve, backlogShow } =
        await import('./commands/backlog/index.js');
      return [backlogAdd, backlogList, backlogResolve, backlogShow];
    }
    case 'campaign': {
      const { campaignMaterialize, campaignStatusCmd } =
        await import('./commands/campaign/index.js');
      return [campaignMaterialize, campaignStatusCmd];
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
      const {
        initApplyArchitect,
        initApplyHarness,
        initApplyOwner,
        initBind,
        initPlan,
        initUpgrade,
      } = await import('./commands/init/index.js');
      return [
        initApplyArchitect,
        initApplyHarness,
        initApplyOwner,
        initBind,
        initPlan,
        initUpgrade,
      ];
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
        { roundDispatchActivate },
        { roundDispatch },
        { roundDispatchDeactivate },
        { roundDispatchDispose },
        { roundRatify },
      ] = await Promise.all([
        import('./commands/round/workflow.js'),
        import('./commands/round/tracking.js'),
        import('./commands/round/dispatch-activate.js'),
        import('./commands/round/dispatch-agents.js'),
        import('./commands/round/dispatch-deactivate.js'),
        import('./commands/round/dispatch-dispose.js'),
        import('./commands/round/ratify.js'),
      ]);
      return [
        roundAssess,
        roundClose,
        roundDispatch,
        roundDispatchActivate,
        roundDispatchDeactivate,
        roundDispatchDispose,
        roundGapCreate,
        roundGapList,
        roundGapResolve,
        roundGapShow,
        roundPlan,
        roundRatify,
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

function argvFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

/**
 * Capture the human declaration of a sensing action on the framework
 * repository before generic authority runs (ADR-SCR-0001).
 *
 * `--publish` on a sensing action is refused here, before the policy is
 * parsed. A read-effect `sense run` is decided by the self-dogfood matrix, so
 * the role and write consent it declares are handed to the handler and kept
 * from the generic authority layer, which admits no declaration on a read
 * effect. Every other population keeps its declaration for generic authority.
 * A repository that does not carry the framework's policy is unaffected.
 */
async function captureSelfDogfoodDeclaration(
  argv: readonly string[],
  action: RegistryEntry | undefined,
): Promise<{ readonly argv: readonly string[]; readonly refusal?: string }> {
  declareSelfDogfoodInvocation(undefined);
  if (action === undefined || !isSelfDogfoodSenseAction(action.name)) return { argv };
  if (argv.some((value) => value === '--help' || value === '-h')) return { argv };
  const repoRoot = resolve(argvFlag(argv, '--repo-root') ?? '.');
  const declaredRole = argvFlag(argv, '--as-role');
  const role = isSelfDogfoodRole(declaredRole) ? declaredRole : undefined;
  const declaration = {
    role,
    human_invoked: role !== undefined && !argv.includes('--machine-actor'),
    declaration_source: role === undefined ? undefined : 'cli-flag',
    write_consent: argv.includes('--write'),
    publish: argv.includes('--publish'),
  };
  if (declaration.publish) {
    const gate = gateSelfDogfoodCommand({ repoRoot, action_id: action.name, declaration });
    return gate.applies ? { argv, refusal: selfDogfoodRefusal(gate) } : { argv };
  }
  if (!readSelfDogfoodPolicy(repoRoot).applies) return { argv };
  declareSelfDogfoodInvocation(declaration);
  if (action.name !== 'sense run' || argv.includes('--authority-session')) return { argv };
  let aggregate: string;
  try {
    const { resolveSenseInvocation } = await import('./authority/sense-selection.js');
    aggregate = resolveSenseInvocation(action, argv)?.selection.aggregate_effect ?? 'read';
  } catch {
    // An invalid selection is reported by generic authority and the handler.
    return { argv };
  }
  if (aggregate !== 'read') return { argv };
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (value === '--as-role' && role !== undefined) {
      index += 1;
      continue;
    }
    if (value === '--write') continue;
    kept.push(value);
  }
  return { argv: kept };
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

  const selfDogfood = await captureSelfDogfoodDeclaration(process.argv, invocationAction);
  if (selfDogfood.refusal !== undefined) {
    if (
      !emitPreDispatchActionResult(machineAction, {
        exit: 2,
        stdout: '',
        stderr: selfDogfood.refusal,
      })
    ) {
      process.stderr.write(selfDogfood.refusal);
      process.exitCode = 2;
    }
    return;
  }
  const authorized = invocationStage(machineAction, 'authorization', () =>
    authorizeCliArgv(selfDogfood.argv, registry),
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
      declareSelfDogfoodInvocation(undefined);
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
