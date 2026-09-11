import { chdir, cwd, stderr, stdout } from 'node:process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = { readonly action_id: string; readonly path: readonly string[] };
type Stage =
  'registry-validation' | 'routing' | 'initialization' | 'authorization' | 'handler-dispatch';

const harness = vi.hoisted(() => {
  const entries: Entry[] = [
    { action_id: 'catalog', path: ['catalog'] },
    { action_id: 'catalog actions', path: ['catalog', 'actions'] },
  ];
  return {
    entries,
    commands: [] as Array<{ readonly name: string }>,
    stages: [] as Stage[],
    registered: [] as string[],
    parsedArgv: [] as string[],
    authorityArgv: [] as string[],
    attachFailure: undefined as Error | undefined,
    registerFailure: undefined as Error | undefined,
    authorityResult: undefined as
      { readonly exit_code: number; readonly stdout: string; readonly stderr: string } | undefined,
    runMatched: vi.fn<() => unknown>(),
    authorize: vi.fn<(argv: readonly string[]) => unknown>(),
    command(name: string) {
      return {
        register() {
          harness.registered.push(name);
          if (harness.registerFailure !== undefined) throw harness.registerFailure;
          harness.commands.push({ name });
        },
      };
    },
  };
});

vi.mock('cac', () => ({
  cac: () => ({
    commands: harness.commands,
    version() {},
    help() {},
    parse(argv: readonly string[]) {
      harness.parsedArgv = [...argv];
    },
    runMatchedCommand: harness.runMatched,
  }),
}));

vi.mock('../../src/command-router.js', () => ({
  routeArgv: (argv: readonly string[]) => ({ kind: 'dispatch', argv }),
}));

vi.mock('../../src/define-command.js', () => ({
  attachRuntimeContracts() {},
  canonicalRegistry: () => harness.entries,
  getFullRegistry: () => harness.entries,
  validateActionSurface() {},
}));

vi.mock('../../src/authority/index.js', () => ({
  attachAuthorityCommandBoundaries() {
    if (harness.attachFailure !== undefined) throw harness.attachFailure;
  },
  authorizeCliArgv: (argv: readonly string[]) => {
    harness.authorityArgv = [...argv];
    harness.authorize(argv);
    return harness.authorityResult;
  },
  disposeCliInvocationAuthority() {},
  stripAuthorityArgv: (argv: readonly string[]) => argv,
  validateLiveAuthorityActionRegistry() {},
}));

vi.mock('../../src/action-output.js', () => ({
  attachActionOutputBoundaries() {},
  emitPreDispatchActionResult: () => false,
  publicActionForArgv: () => harness.entries[1],
  runCliStage: (_entry: Entry | undefined, stage: Stage, operation: () => unknown) => {
    harness.stages.push(stage);
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`stage:${stage}:${message}\n`);
      process.exitCode = 6;
      return { ok: false, error };
    }
  },
}));

vi.mock('../../src/version.js', () => ({ resolveCliVersion: () => '1.5.0' }));

vi.mock('../../src/commands/audit/observe.js', () => ({
  auditObserve: harness.command('auditObserve'),
}));
vi.mock('../../src/commands/audit/scorecard.js', () => ({
  auditScorecard: harness.command('auditScorecard'),
}));
vi.mock('../../src/commands/actions-list.js', () => ({
  actionsList: harness.command('actionsList'),
}));
vi.mock('../../src/commands/check/facade.js', () => ({ checkCmd: harness.command('checkCmd') }));
vi.mock('../../src/commands/doctor.js', () => ({ doctor: harness.command('doctor') }));
vi.mock('../../src/commands/evidence/facade.js', () => ({
  evidenceCollect: harness.command('evidenceCollect'),
  evidenceRecord: harness.command('evidenceRecord'),
  evidenceRedact: harness.command('evidenceRedact'),
  evidenceRender: harness.command('evidenceRender'),
  evidenceVerify: harness.command('evidenceVerify'),
}));
vi.mock('../../src/commands/init/index.js', () => ({
  initApplyArchitect: harness.command('initApplyArchitect'),
  initApplyHarness: harness.command('initApplyHarness'),
  initApplyOwner: harness.command('initApplyOwner'),
  initBind: harness.command('initBind'),
  initPlan: harness.command('initPlan'),
}));
vi.mock('../../src/commands/release/facade.js', () => ({
  releaseCertify: harness.command('releaseCertify'),
  releaseCheck: harness.command('releaseCheck'),
  releaseDrift: harness.command('releaseDrift'),
  releaseEvidencePublish: harness.command('releaseEvidencePublish'),
  releaseExport: harness.command('releaseExport'),
  releaseOfflineVerify: harness.command('releaseOfflineVerify'),
  releasePlan: harness.command('releasePlan'),
  releasePreflight: harness.command('releasePreflight'),
  releasePrepare: harness.command('releasePrepare'),
  releasePublish: harness.command('releasePublish'),
  releaseResume: harness.command('releaseResume'),
  releaseStatus: harness.command('releaseStatus'),
  releaseVerify: harness.command('releaseVerify'),
}));
vi.mock('../../src/commands/round/workflow.js', () => ({
  roundAssess: harness.command('roundAssess'),
  roundClose: harness.command('roundClose'),
  roundGapCreate: harness.command('roundGapCreate'),
  roundGapList: harness.command('roundGapList'),
  roundGapResolve: harness.command('roundGapResolve'),
  roundGapShow: harness.command('roundGapShow'),
  roundPlan: harness.command('roundPlan'),
  roundRun: harness.command('roundRun'),
  roundSeal: harness.command('roundSeal'),
  roundStatus: harness.command('roundStatus'),
}));
vi.mock('../../src/commands/round/tracking.js', () => ({
  roundTrackingDisable: harness.command('roundTrackingDisable'),
  roundTrackingEnable: harness.command('roundTrackingEnable'),
  roundTrackingStatus: harness.command('roundTrackingStatus'),
  roundTrackingSync: harness.command('roundTrackingSync'),
}));
vi.mock('../../src/commands/sense/inventory.js', () => ({
  senseInventoryCmd: harness.command('senseInventoryCmd'),
}));
vi.mock('../../src/commands/sense/migrate.js', () => ({
  senseMigrateCmd: harness.command('senseMigrateCmd'),
}));
vi.mock('../../src/commands/sense/record.js', () => ({
  senseRecordCmd: harness.command('senseRecordCmd'),
}));
vi.mock('../../src/commands/sense/run-set.js', () => ({
  senseRunSetCmd: harness.command('senseRunSetCmd'),
}));
vi.mock('../../src/commands/task/index.js', () => ({
  taskEscalate: harness.command('taskEscalate'),
  taskFinish: harness.command('taskFinish'),
  taskPause: harness.command('taskPause'),
  taskQueueAdd: harness.command('taskQueueAdd'),
  taskQueueComplete: harness.command('taskQueueComplete'),
  taskQueueList: harness.command('taskQueueList'),
  taskQueueNext: harness.command('taskQueueNext'),
  taskResume: harness.command('taskResume'),
  taskStart: harness.command('taskStart'),
  taskStatus: harness.command('taskStatus'),
}));
vi.mock('../../src/commands/triage/classify.js', () => ({
  triageClassify: harness.command('triageClassify'),
}));

const initialCwd = cwd();
const temporaryRoots: string[] = [];
const restoreStreamHandles: Array<() => void> = [];

beforeEach(() => {
  harness.commands.splice(0);
  harness.stages.splice(0);
  harness.registered.splice(0);
  harness.parsedArgv = [];
  harness.authorityArgv = [];
  harness.attachFailure = undefined;
  harness.registerFailure = undefined;
  harness.authorityResult = undefined;
  harness.runMatched.mockReset().mockReturnValue(undefined);
  harness.authorize.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (cwd() !== initialCwd) chdir(initialCwd);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const restore of restoreStreamHandles.splice(0)) restore();
});

async function runtime() {
  return import('../../src/cli-runtime.js');
}

function setBlockingSpies() {
  const stdoutHandle = stdout as typeof stdout & {
    _handle?: { setBlocking(value: boolean): void };
  };
  const stderrHandle = stderr as typeof stderr & {
    _handle?: { setBlocking(value: boolean): void };
  };
  for (const stream of [stdoutHandle, stderrHandle]) {
    if (stream._handle !== undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(stream, '_handle');
    Object.defineProperty(stream, '_handle', {
      configurable: true,
      value: { setBlocking() {} },
    });
    restoreStreamHandles.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(stream, '_handle');
      else Object.defineProperty(stream, '_handle', descriptor);
    });
  }
  return [
    vi.spyOn(stdoutHandle._handle, 'setBlocking').mockImplementation(() => undefined),
    vi.spyOn(stderrHandle._handle, 'setBlocking').mockImplementation(() => undefined),
  ] as const;
}

describe('S06-B public runtime tail', () => {
  it('selects a command when global machine flags precede its path', async () => {
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['--machine', 'catalog', 'actions'])).resolves.toMatchObject({
      exit_code: 0,
    });
    expect(harness.registered).toEqual(['actionsList']);
  });

  it('reports selected-domain registration failures through initialization', async () => {
    harness.registerFailure = new Error('catalog-registration-failed');
    const { invokeDevaiCli } = await runtime();
    const result = await invokeDevaiCli(['catalog', 'actions', '--format', 'json']);
    expect(result).toEqual({
      exit_code: 6,
      stdout: '',
      stderr: 'stage:initialization:catalog-registration-failed\n',
    });
    expect(harness.stages).toEqual(['registry-validation', 'routing', 'initialization']);
  });

  it('does not re-enter selected-domain registration after full metadata materialization', async () => {
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli([])).resolves.toMatchObject({ exit_code: 0, stderr: '' });
    expect(harness.registered.filter((name) => name === 'actionsList')).toHaveLength(1);
  });

  it('stops before authorization and dispatch when boundary initialization fails', async () => {
    harness.attachFailure = new Error('boundary-initialization-failed');
    const { invokeDevaiCli } = await runtime();
    const result = await invokeDevaiCli(['catalog', 'actions', '--format', 'json']);
    expect(result).toMatchObject({
      exit_code: 6,
      stderr: 'stage:initialization:boundary-initialization-failed\n',
    });
    expect(harness.authorize).not.toHaveBeenCalled();
    expect(harness.runMatched).not.toHaveBeenCalled();
  });

  it('keeps authority stdout distinct from a simultaneously populated diagnostic', async () => {
    harness.authorityResult = { exit_code: 4, stdout: 'authorized-output', stderr: 'diagnostic' };
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toEqual({
      exit_code: 4,
      stdout: 'authorized-output',
      stderr: '',
    });
  });

  it('uses blocking streams only for executable human output', async () => {
    const spies = setBlockingSpies();
    const { invokeDevaiCli, startDevaiCli } = await runtime();

    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toMatchObject({ exit_code: 0 });
    expect(spies.map((spy) => spy.mock.calls)).toEqual([[], []]);

    await expect(
      startDevaiCli([process.execPath, '/fixture/devai.js', 'catalog', 'actions']),
    ).resolves.toBe(0);
    expect(spies.map((spy) => spy.mock.calls)).toEqual([[[true]], [[true]]]);
  });

  it('does not wait for non-promise handler values', async () => {
    harness.runMatched.mockReturnValue(17);
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toMatchObject({ exit_code: 0 });
  });

  it('waits for a thenable handler before completing the public invocation', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.runMatched.mockReturnValue(pending);
    const { invokeDevaiCli } = await runtime();
    let settled = false;
    const invocation = invokeDevaiCli(['catalog', 'actions']).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(invocation).resolves.toMatchObject({ exit_code: 0 });
  });

  it('routes rejected handler promises back through the handler-dispatch stage', async () => {
    harness.runMatched.mockReturnValue(Promise.reject(new Error('async-handler-failed')));
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toEqual({
      exit_code: 6,
      stdout: '',
      stderr: 'stage:handler-dispatch:async-handler-failed\n',
    });
    expect(harness.stages.filter((stage) => stage === 'handler-dispatch')).toHaveLength(2);
  });

  it('binds the synthesized executable path before authorizing host arguments', async () => {
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toMatchObject({ exit_code: 0 });
    expect(harness.authorityArgv).toHaveLength(4);
    expect(harness.authorityArgv[0]).toBe(process.execPath);
    expect(harness.authorityArgv[1]).toMatch(/\/bin\.js$/u);
    expect(harness.authorityArgv.slice(2)).toEqual(['catalog', 'actions']);
  });

  it('binds later invocations to the first working directory and preserves the exact refusal', async () => {
    const { invokeDevaiCli } = await runtime();
    await expect(invokeDevaiCli(['catalog', 'actions'])).resolves.toMatchObject({ exit_code: 0 });
    const other = mkdtempSync(join(tmpdir(), 'devai-cli-s06b-runtime-tail-'));
    temporaryRoots.push(other);
    chdir(other);
    await expect(invokeDevaiCli(['catalog', 'actions'])).rejects.toThrow(
      'release-host-working-directory-changed',
    );
  });
});
