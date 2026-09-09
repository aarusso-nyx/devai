import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_USAGE } from '@devai-nyx/utils';

const runtime = vi.hoisted(() => ({
  closeGovernedRound: vi.fn(),
  closePhase: vi.fn(),
  declareGovernedRound: vi.fn(),
  diffBlueprintAgainstInventory: vi.fn(),
  emitRgr: vi.fn(),
  governedRoundStatus: vi.fn(),
  listRgrs: vi.fn(),
  loadBlueprint: vi.fn(),
  planScaffoldFromBlueprint: vi.fn(),
  readRgr: vi.fn(),
  requireActiveTaskRound: vi.fn(),
  resolveRgr: vi.fn(),
  roundTaskStatus: vi.fn(),
  runRoundTasks: vi.fn(),
  scaffoldGovernedRound: vi.fn(),
  trackGovernanceEvent: vi.fn(),
  validateBlueprint: vi.fn(),
}));

const seams = vi.hoisted(() => ({
  dispatchRoundTask: vi.fn(),
  recordRoundCloseTracking: vi.fn(),
  runPostMergeAuditor: vi.fn(),
}));

vi.mock('#runtime-core', () => {
  class TaskServiceError extends Error {
    readonly code: string;
    readonly exitCode: number;

    constructor(code: string, exitCode = 2) {
      super(code);
      this.code = code;
      this.exitCode = exitCode;
    }
  }
  return { ...runtime, TaskServiceError };
});
vi.mock('@devai-nyx/skills/post-merge-auditor', () => ({
  runPostMergeAuditor: seams.runPostMergeAuditor,
}));
vi.mock('../../src/commands/round/dispatch.js', () => ({
  dispatchRoundTask: seams.dispatchRoundTask,
}));
vi.mock('../../src/commands/round/tracking.js', () => ({
  recordRoundCloseTracking: seams.recordRoundCloseTracking,
}));
vi.mock('../../src/version.js', () => ({ resolveCliVersion: () => '1.5.0-test' }));

import {
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
} from '../../src/commands/round/workflow.js';

type Callback = (...args: never[]) => unknown;

interface CommandCapture {
  option(): CommandCapture;
  action(callback: Callback): CommandCapture;
}

const roots: string[] = [];
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
const originalPostMergeFail = process.env['DEVAI_TEST_POST_MERGE_FAIL'];
const actions = new Map<string, Callback>();

function register(command: { register(cli: CAC): void }): Callback {
  let action: Callback | undefined;
  const capture: CommandCapture = {
    option(): CommandCapture {
      return capture;
    },
    action(callback: Callback): CommandCapture {
      action = callback;
      return capture;
    },
  };
  command.register({ command: () => capture } as unknown as CAC);
  if (action === undefined) throw new Error('round workflow command did not register an action');
  return action;
}

async function invoke(name: string, ...args: unknown[]) {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await actions.get(name)?.(...(args as never[]));
    return { stdout, stderr, exit: process.exitCode ?? 0 };
  } finally {
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-workflow-'));
  roots.push(root);
  return root;
}

function put(root: string, path: string, value: unknown): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value)}\n`);
  return absolute;
}

beforeAll(() => {
  for (const [name, command] of Object.entries({
    assess: roundAssess,
    close: roundClose,
    create: roundGapCreate,
    list: roundGapList,
    resolve: roundGapResolve,
    show: roundGapShow,
    plan: roundPlan,
    run: roundRun,
    seal: roundSeal,
    status: roundStatus,
  })) {
    actions.set(name, register(command));
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.requireActiveTaskRound.mockReturnValue('R-0042');
  runtime.roundTaskStatus.mockReturnValue({
    round_id: 'R-0042',
    count: 2,
    tasks: [
      { id: 'T-1', status: 'done' },
      { id: 'T-2', status: 'ready' },
    ],
  });
  runtime.listRgrs.mockReturnValue([]);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  if (originalPostMergeFail === undefined) delete process.env['DEVAI_TEST_POST_MERGE_FAIL'];
  else process.env['DEVAI_TEST_POST_MERGE_FAIL'] = originalPostMergeFail;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('round workflow command boundaries', () => {
  it('assesses only gaps emitted by round tasks and counts each task status', async () => {
    runtime.roundTaskStatus.mockReturnValue({
      round_id: 'R-0042',
      count: 3,
      tasks: [
        { id: 'T-1', status: 'done' },
        { id: 'T-2', status: 'done' },
        { id: 'T-3', status: 'ready' },
      ],
    });
    runtime.listRgrs.mockReturnValue([
      { id: 'G-1', emitting_task_id: 'T-1', status: 'open' },
      { id: 'G-2', emitting_task_id: 'T-2', status: 'resolved' },
      { id: 'G-X', emitting_task_id: 'OTHER', status: 'open' },
    ]);

    const result = await invoke('assess', { repoRoot: '/repo', round: 'R-0042' });
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      round_id: 'R-0042',
      tasks: { count: 3, by_status: { done: 2, ready: 1 } },
      gaps: { count: 2, open: 1 },
    });
  });

  it('maps missing round, Error, and opaque failures to stable diagnostics', async () => {
    const missing = await invoke('assess', { repoRoot: '/repo' });
    expect(JSON.parse(missing.stderr)).toEqual({
      code: 'TASK_ROUND_REQUIRED',
      operation: 'assess',
      exit: EXIT_USAGE,
    });

    runtime.closeGovernedRound.mockImplementationOnce(() => {
      throw new Error('SEAL_FAILED');
    });
    expect(JSON.parse((await invoke('seal', { round: 'R-0042' })).stderr)).toEqual({
      code: 'SEAL_FAILED',
      operation: 'seal',
      exit: 2,
    });

    runtime.closeGovernedRound.mockImplementationOnce(() => {
      throw 'opaque';
    });
    expect(JSON.parse((await invoke('seal', { round: 'R-0042' })).stderr)).toEqual({
      code: 'ROUND_OPERATION_FAILED',
      operation: 'seal',
      exit: 2,
    });
  });

  it('requires a host receipt and binds the post-merge auditor inputs', async () => {
    const missing = await invoke('close', { postMergeReceipt: true });
    expect(missing).toEqual({ stdout: '', stderr: 'HOST_RECEIPT_MISSING\n', exit: EXIT_USAGE });

    process.env['DEVAI_TEST_POST_MERGE_FAIL'] = '1';
    seams.runPostMergeAuditor.mockResolvedValue({ status: 'recorded' });
    const result = await invoke('close', {
      repoRoot: './repo',
      postMergeReceipt: true,
      hostReceipt: './receipt.json',
      human: true,
    });
    expect(result).toEqual({
      stdout: 'round close post-merge: recorded\n',
      stderr: '',
      exit: 0,
    });
    expect(seams.runPostMergeAuditor).toHaveBeenCalledWith({
      repoRoot: expect.stringMatching(/\/repo$/),
      hostReceiptPath: expect.stringMatching(/\/receipt\.json$/),
      injectFailure: true,
      devaiVersion: '1.5.0-test',
    });

    seams.runPostMergeAuditor.mockRejectedValueOnce(new Error('AUDITOR_REFUSED'));
    expect(
      JSON.parse(
        (
          await invoke('close', {
            postMergeReceipt: true,
            hostReceipt: './receipt.json',
          })
        ).stderr,
      ),
    ).toEqual({ code: 'AUDITOR_REFUSED', operation: 'close-post-merge', exit: 2 });
  });

  it('validates and closes a phase while preserving optional tracking output', async () => {
    const root = repository();
    const input = put(root, 'draft.json', { round_id: 'R-0042' });
    runtime.closePhase.mockReturnValue({ record: { id: 'closure-1' }, sealed: true });
    seams.recordRoundCloseTracking.mockReturnValue({ projection: 'pending' });

    const result = await invoke('close', { repoRoot: root, round: 'R-0042', input });
    expect(JSON.parse(result.stdout)).toEqual({
      record: { id: 'closure-1' },
      sealed: true,
      tracking: { projection: 'pending' },
    });
    expect(seams.recordRoundCloseTracking).toHaveBeenCalledWith({
      repoRoot: root,
      round: 'R-0042',
      verdict: 'closure-1',
    });

    seams.recordRoundCloseTracking.mockReturnValue(undefined);
    expect(
      (await invoke('close', { repoRoot: root, round: 'R-0042', input, human: true })).stdout,
    ).toBe('round close: R-0042 -> closure-1\n');

    const mismatch = put(root, 'mismatch.json', { round_id: 'R-0099' });
    expect(
      JSON.parse(
        (await invoke('close', { repoRoot: root, round: 'R-0042', input: mismatch })).stderr,
      ),
    ).toMatchObject({ code: 'TASK_ROUND_MISMATCH', operation: 'close' });
    expect(
      JSON.parse((await invoke('close', { repoRoot: root, round: 'R-0042' })).stderr),
    ).toMatchObject({ code: 'ROUND_CLOSE_INPUT_REQUIRED', exit: EXIT_USAGE });
  });

  it('creates gaps with scalar and repeated evidence and records their governance event', async () => {
    runtime.emitRgr.mockReturnValue({
      id: 'G-1',
      emitting_task_id: 'T-1',
      emitting_discipline: 'engineer',
      problem: { summary: 'missing proof' },
      evidence_refs: ['E-1'],
    });
    const complete = {
      repoRoot: '/repo',
      round: 'R-0042',
      task: 'T-1',
      discipline: 'engineer',
      summary: 'missing proof',
      ambiguity: 'which proof',
      evidence: 'E-1',
    };
    expect(JSON.parse((await invoke('create', complete)).stdout)).toMatchObject({ id: 'G-1' });
    expect(runtime.emitRgr).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceRefs: ['E-1'] }),
    );
    expect(runtime.trackGovernanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'finding_emitted',
        status: 'review',
        evidenceRefs: ['G-1', 'E-1'],
      }),
    );

    await invoke('create', { ...complete, evidence: ['E-1', 'E-2'] });
    expect(runtime.emitRgr).toHaveBeenLastCalledWith(
      expect.objectContaining({ evidenceRefs: ['E-1', 'E-2'] }),
    );

    await invoke('create', { ...complete, evidence: undefined });
    expect(runtime.emitRgr).toHaveBeenLastCalledWith(expect.objectContaining({ evidenceRefs: [] }));

    const missing = await invoke('create', { round: 'R-0042', task: 'T-1' });
    expect(JSON.parse(missing.stderr)).toMatchObject({
      code: 'ROUND_GAP_INPUT_REQUIRED',
      exit: EXIT_USAGE,
    });
  });

  it('lists and shows only gaps belonging to the selected round', async () => {
    const own = { id: 'G-1', emitting_task_id: 'T-1', status: 'open' };
    runtime.listRgrs.mockReturnValue([
      own,
      { id: 'G-X', emitting_task_id: 'OTHER', status: 'open' },
    ]);
    const listed = await invoke('list', { round: 'R-0042' });
    expect(JSON.parse(listed.stdout)).toEqual({ round_id: 'R-0042', count: 1, gaps: [own] });

    expect(
      JSON.parse((await invoke('show', 'G-1', { round: 'R-0042', human: false })).stdout),
    ).toEqual(own);
    runtime.readRgr.mockReturnValue({ id: 'G-X', emitting_task_id: 'OTHER', status: 'open' });
    expect(JSON.parse((await invoke('show', 'G-X', { round: 'R-0042' })).stderr)).toMatchObject({
      code: 'ROUND_GAP_NOT_FOUND',
      operation: 'gap show',
    });
    runtime.readRgr.mockReturnValue(null);
    expect(JSON.parse((await invoke('show', 'G-404', { round: 'R-0042' })).stderr)).toMatchObject({
      code: 'ROUND_GAP_NOT_FOUND',
    });

    expect(JSON.parse((await invoke('list', {})).stderr)).toMatchObject({
      code: 'TASK_ROUND_REQUIRED',
      operation: 'gap list',
    });
  });

  it('resolves a scoped gap and records the classification semantics', async () => {
    runtime.listRgrs.mockReturnValue([{ id: 'G-1', emitting_task_id: 'T-1', status: 'open' }]);
    runtime.resolveRgr.mockReturnValue({
      id: 'G-1',
      status: 'rejected',
      emitting_task_id: 'T-1',
    });
    const result = await invoke('resolve', 'G-1', {
      round: 'R-0042',
      resolver: 'owner',
      status: 'rejected',
      human: true,
    });
    expect(result.stdout).toBe('round gap resolve: G-1 -> rejected\n');
    expect(runtime.resolveRgr).toHaveBeenCalledWith({
      repoRoot: expect.any(String),
      rgrId: 'G-1',
      resolver: 'owner',
      newStatus: 'rejected',
    });
    expect(runtime.trackGovernanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'finding_classified', status: 'review', checkpoint: true }),
    );

    runtime.resolveRgr.mockReturnValue({ id: 'G-1', status: 'resolved', emitting_task_id: 'T-1' });
    await invoke('resolve', 'G-1', { round: 'R-0042', resolver: 'owner' });
    expect(runtime.resolveRgr).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ newStatus: expect.anything() }),
    );
    expect(runtime.trackGovernanceEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'pass' }),
    );

    expect(
      JSON.parse((await invoke('resolve', 'G-X', { round: 'R-0042', resolver: 'owner' })).stderr),
    ).toMatchObject({ code: 'ROUND_GAP_NOT_FOUND' });
    expect(JSON.parse((await invoke('resolve', 'G-1', { round: 'R-0042' })).stderr)).toMatchObject({
      code: 'ROUND_GAP_RESOLVER_REQUIRED',
      exit: EXIT_USAGE,
    });
  });

  it('rejects invalid blueprint selections and invalid loaded blueprints', async () => {
    expect(JSON.parse((await invoke('plan', { blueprint: 'render' })).stderr)).toMatchObject({
      code: 'ROUND_BLUEPRINT_OPERATION_INVALID',
    });
    expect(JSON.parse((await invoke('plan', { blueprint: 'plan' })).stderr)).toMatchObject({
      code: 'ROUND_BLUEPRINT_FILE_REQUIRED',
    });
    expect(
      JSON.parse(
        (await invoke('plan', { blueprint: 'plan', file: 'b.json', scaffold: true })).stderr,
      ),
    ).toMatchObject({ code: 'ROUND_PLAN_SELECTION_CONFLICT' });
    runtime.loadBlueprint.mockReturnValue({ ok: false });
    expect(
      JSON.parse((await invoke('plan', { blueprint: 'plan', file: 'b.json' })).stderr),
    ).toMatchObject({ code: 'ROUND_BLUEPRINT_SCHEMA_INVALID' });
  });

  it('renders blueprint validation failure, plan, and inventory diff', async () => {
    const blueprint = { id: 'BP-1', module: { version: '2' } };
    runtime.loadBlueprint.mockReturnValue({ ok: true, blueprint });
    runtime.validateBlueprint.mockReturnValue({ ok: false, violations: ['missing task'] });
    const invalid = await invoke('plan', { blueprint: 'plan', file: 'b.json', human: false });
    expect(invalid.exit).toBe(2);
    expect(JSON.parse(invalid.stdout)).toEqual({
      ok: false,
      blueprint_id: 'BP-1',
      violations: ['missing task'],
    });

    runtime.validateBlueprint.mockReturnValue({ ok: true, violations: [] });
    runtime.planScaffoldFromBlueprint.mockReturnValue({
      blueprint_id: 'BP-1',
      blueprint_version: '2',
      tasks: [{ id: 'T-1' }],
    });
    expect(
      JSON.parse((await invoke('plan', { blueprint: 'plan', file: 'b.json' })).stdout),
    ).toMatchObject({ kind: 'blueprint-plan', blueprint_id: 'BP-1' });

    runtime.diffBlueprintAgainstInventory.mockReturnValue({
      status: 'drift',
      deltas: [{ path: 'src/x.ts' }],
    });
    const diff = JSON.parse(
      (await invoke('plan', { repoRoot: '/repo', blueprint: 'diff', file: 'b.json' })).stdout,
    );
    expect(diff).toMatchObject({
      kind: 'blueprint-diff',
      ok: false,
      blueprint_id: 'BP-1',
      blueprint_version: '2',
      inventory_root: '/repo',
      status: 'drift',
    });
  });

  it('selects declare, scaffold, or status planning without conflating them', async () => {
    runtime.declareGovernedRound.mockReturnValue({ mode: 'declared' });
    runtime.scaffoldGovernedRound.mockReturnValue({ mode: 'scaffolded' });
    runtime.governedRoundStatus.mockReturnValue({ mode: 'status' });

    expect(
      JSON.parse((await invoke('plan', { round: 'R-0042', declare: 'round.json' })).stdout),
    ).toEqual({ mode: 'declared' });
    expect(runtime.declareGovernedRound).toHaveBeenCalledWith({
      repoRoot: expect.any(String),
      round: 'R-0042',
      recordPath: 'round.json',
    });
    expect(JSON.parse((await invoke('plan', { round: 'R-0042', scaffold: true })).stdout)).toEqual({
      mode: 'scaffolded',
    });
    expect(JSON.parse((await invoke('plan', { round: 'R-0042' })).stdout)).toEqual({
      mode: 'status',
    });
  });

  it('runs selected tasks through the dispatch seam and reflects aggregate failure', async () => {
    runtime.runRoundTasks.mockImplementation(async ({ dispatch, ...input }) => {
      await dispatch({ id: 'T-1' });
      return { ...input, round_id: 'R-0042', ok: false, results: [{ id: 'T-1' }] };
    });
    seams.dispatchRoundTask.mockResolvedValue({ status: 'done' });
    const result = await invoke('run', {
      repoRoot: '/repo',
      round: 'R-0042',
      task: ['T-1', 'T-2'],
      human: true,
    });
    expect(result).toEqual({
      stdout: 'round run: R-0042; 1 task(s)\n',
      stderr: '',
      exit: 2,
    });
    expect(runtime.runRoundTasks).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/repo', round: 'R-0042', taskIds: ['T-1', 'T-2'] }),
    );
    expect(seams.dispatchRoundTask).toHaveBeenCalledWith('/repo', { id: 'T-1' });

    runtime.runRoundTasks.mockResolvedValue({ round_id: 'R-0042', ok: true, results: [] });
    await invoke('run', { round: 'R-0042' });
    expect(runtime.runRoundTasks).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ taskIds: expect.anything() }),
    );

    runtime.runRoundTasks.mockRejectedValueOnce(new Error('DISPATCH_FAILED'));
    expect(JSON.parse((await invoke('run', { round: 'R-0042' })).stderr)).toEqual({
      code: 'DISPATCH_FAILED',
      operation: 'run',
      exit: 2,
    });
  });

  it('seals and reports status with lifecycle success or active-round fallback', async () => {
    runtime.closeGovernedRound.mockReturnValue({ round_id: 'R-0042', status: 'sealed' });
    expect((await invoke('seal', { round: 'R-0042', human: true })).stdout).toBe(
      'round seal: R-0042\n',
    );

    runtime.governedRoundStatus.mockReturnValue({ id: 'R-0042', location: 'closed' });
    const status = JSON.parse((await invoke('status', { round: 'R-0042' })).stdout);
    expect(status).toEqual({
      lifecycle: { id: 'R-0042', location: 'closed' },
      tasks: expect.objectContaining({ round_id: 'R-0042', count: 2 }),
    });

    runtime.governedRoundStatus.mockImplementationOnce(() => {
      throw new Error('not declared');
    });
    const fallback = await invoke('status', { round: 'R-0042', human: true });
    expect(fallback.stdout).toBe('round status: R-0042; 2 task(s)\n');
    expect(runtime.requireActiveTaskRound).toHaveBeenCalledWith({
      repoRoot: expect.any(String),
      round: 'R-0042',
    });

    runtime.governedRoundStatus.mockImplementationOnce(() => {
      throw new Error('not declared');
    });
    runtime.requireActiveTaskRound.mockImplementationOnce(() => {
      throw new Error('ROUND_NOT_ACTIVE');
    });
    expect(JSON.parse((await invoke('status', { round: 'R-0042' })).stderr)).toEqual({
      code: 'ROUND_NOT_ACTIVE',
      operation: 'status',
      exit: 2,
    });
  });
});
