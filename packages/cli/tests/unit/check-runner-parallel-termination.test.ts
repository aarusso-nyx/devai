// ADR-CHK-0007 rule 8 with the review amendment: when a timed-out node's process group
// cannot be confirmed gone (PROCESS_GROUP_TERMINATION_UNCONFIRMED), something it started may
// still write shared state. The parallel runner then admits no further node until every
// running node has settled, runs the rest one at a time, and reports the node exactly as
// the sequential runner does (TIMEOUT). The governed spawn is replaced for fixture node
// processes only (argv under bin/); every other process, git included, is the real one.
import { spawnSync as realSpawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Scripted {
  /** Milliseconds before the governed process settles. */
  readonly delayMs: number;
  /** A timeout whose process group termination could not be confirmed. */
  readonly unconfirmed?: boolean;
}

const fixture = vi.hoisted(() => ({
  script: new Map<string, Scripted>(),
  events: [] as string[],
  running: 0,
  peak: 0,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  const nodeOf = (args: readonly string[] | undefined): string | undefined => {
    const script = args?.[0];
    return script?.startsWith('bin/') === true ? script.slice(4, -'.mjs'.length) : undefined;
  };
  const timedOut = (nodeId: string): boolean => fixture.script.get(nodeId)?.unconfirmed === true;
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: unknown) => {
      const nodeId = nodeOf(args);
      if (nodeId === undefined) return actual.spawn(command, args as string[], options as never);
      fixture.events.push(`start:${nodeId}`);
      fixture.running += 1;
      fixture.peak = Math.max(fixture.peak, fixture.running);
      const result = new Promise((resolve) => {
        setTimeout(
          () => {
            fixture.running -= 1;
            fixture.events.push(`end:${nodeId}`);
            resolve({
              exit_code: timedOut(nodeId) ? null : 0,
              signal: timedOut(nodeId) ? 'SIGKILL' : null,
              stdout: '',
              stderr: '',
              stdout_truncated: false,
              stderr_truncated: false,
              timed_out: timedOut(nodeId),
              spawn_error: null,
              ...(timedOut(nodeId) && {
                termination_error: 'PROCESS_GROUP_TERMINATION_UNCONFIRMED',
              }),
            });
          },
          fixture.script.get(nodeId)?.delayMs ?? 1,
        );
      });
      return { pid: 1, result, terminate: () => undefined };
    }) as typeof actual.spawn,
    spawnSync: ((command: string, args: readonly string[], options: unknown) => {
      const nodeId = nodeOf(args);
      if (nodeId === undefined)
        return actual.spawnSync(command, args as string[], options as never);
      fixture.events.push(`start:${nodeId}`, `end:${nodeId}`);
      const timeout = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return {
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: timedOut(nodeId) ? null : 0,
        signal: timedOut(nodeId) ? 'SIGKILL' : null,
        ...(timedOut(nodeId) && { error: timeout }),
      };
    }) as typeof actual.spawnSync,
  };
});

const { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } =
  await import('@devai-nyx/authority');
const { runCheckTasksAsync } = await import('../../src/services/check-runner/runner.js');

const NOW = '2026-10-07T00:00:00.000Z';
const FALLBACK = 'test:local-full';
const roots: string[] = [];
let ordinal = 0;

// Plan order: the node that times out, two long siblings, then three short nodes that
// would start the moment a worker frees up if nothing stopped admissions.
const NODES = ['stuck', 'long-a', 'long-b', 'tail-1', 'tail-2', 'tail-3'] as const;

function git(root: string, args: readonly string[]): void {
  const result = realSpawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

function put(root: string, path: string, bytes: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes, 'utf8');
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-check-runner-termination-'));
  roots.push(root);
  const task = (nodeId: string, dependencies: readonly string[]) => ({
    nodeId,
    dependencies,
    argv: ['node', `bin/${nodeId}.mjs`],
    cwd: '.',
    runner: 'node-v1',
    inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
    toolchainKeys: ['node'],
    allowlistedEnv: [],
    outputContract: { kind: 'marker', value: nodeId },
  });
  const descriptor = {
    schemaVersion: '1.0.0',
    descriptorVersion: 'termination-fixture',
    repositoryId: 'fixture/termination',
    fallbackNodeId: FALLBACK,
    dynamicFallbackSelectors: [],
    tasks: [...NODES.map((nodeId) => task(nodeId, [])), task(FALLBACK, [...NODES])],
    profiles: [{ profileId: 'affected', mode: 'affected', requiredNodes: [], eligibleNodes: [] }],
  };
  // Every node declares only shared keys, so nothing but the termination rule serializes.
  const exclusivity = {
    schemaVersion: '1.0.0',
    nodes: Object.fromEntries([...NODES, FALLBACK].map((nodeId) => [nodeId, { shared: ['src'] }])),
  };
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Termination Inspector']);
  git(root, ['config', 'user.email', 'termination@example.invalid']);
  put(root, '.gitignore', '.devai/state/*\n');
  put(root, 'src/main.ts', 'export const value = 1;\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  put(root, 'test-task-exclusivity.json', `${JSON.stringify(exclusivity, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

async function run(workers: number, unconfirmed: boolean) {
  fixture.events.length = 0;
  fixture.running = 0;
  fixture.peak = 0;
  fixture.script.clear();
  fixture.script.set('stuck', { delayMs: 20, unconfirmed });
  fixture.script.set('long-a', { delayMs: 150 });
  fixture.script.set('long-b', { delayMs: 150 });
  for (const tail of ['tail-1', 'tail-2', 'tail-3']) fixture.script.set(tail, { delayMs: 10 });
  const root = repository();
  ordinal += 1;
  const id = `check-runner-termination-${String(ordinal)}`;
  let receipt = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'check-runner-termination-test',
    issuer_version: '1.0.0',
    invocation_id: id,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${id}-${String(++receipt)}`,
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  });
  try {
    const report = await runWithAuthorityHostEffects(
      {
        action_id: 'check',
        invocation_id: id,
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (_request, apply) => apply(),
      },
      () =>
        runCheckTasksAsync({
          repoRoot: root,
          target: 'local',
          operation: 'run',
          toolchain: { node: 'v-test' },
          environment: {},
          resolveExecutable: () => ({ path: process.execPath, sha256: 'e'.repeat(64) }),
          now: () => NOW,
          workers,
        }),
    );
    return { report, events: [...fixture.events], peak: fixture.peak };
  } finally {
    issuer.dispose();
  }
}

const at = (events: readonly string[], event: string): number => {
  const index = events.indexOf(event);
  if (index < 0) throw new Error(`fixture: no ${event} event`);
  return index;
};

function comparable(report: Awaited<ReturnType<typeof run>>['report']) {
  return (report.execution ?? []).map(
    ({ nodeId, taskKey, disposition, outcome, reason, exitCode, signal }) => ({
      nodeId,
      taskKey,
      disposition,
      outcome,
      reason,
      exitCode,
      signal,
    }),
  );
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe('unconfirmed process-group termination under parallel execution', () => {
  it('admits nothing while siblings drain, then runs the rest one at a time', async () => {
    const { report, events, peak } = await run(3, true);

    expect(peak).toBe(3);
    const stuckEnded = at(events, 'end:stuck');
    const drained = Math.max(at(events, 'end:long-a'), at(events, 'end:long-b'));
    expect(stuckEnded).toBeLessThan(drained);
    // No node starts between the unconfirmed termination and the end of every running node.
    expect(
      events.slice(stuckEnded + 1, drained).filter((event) => event.startsWith('start:')),
    ).toEqual([]);
    // After the drain the remaining nodes run strictly one at a time.
    expect(events.slice(drained + 1)).toEqual([
      'start:tail-1',
      'end:tail-1',
      'start:tail-2',
      'end:tail-2',
      'start:tail-3',
      'end:tail-3',
    ]);
    const stuck = report.execution?.find((entry) => entry.nodeId === 'stuck');
    expect([stuck?.outcome, stuck?.reason]).toEqual(['TIMEOUT', 'process-ETIMEDOUT']);
  });

  it('reports exactly what the sequential runner reports for the same timeout', async () => {
    const parallel = await run(3, true);
    const sequential = await run(1, true);

    expect(sequential.peak).toBe(0);
    expect(comparable(parallel.report)).toEqual(comparable(sequential.report));
    expect(parallel.report.exitCode).toBe(sequential.report.exitCode);
    expect(parallel.report.blocked).toEqual(sequential.report.blocked);
  });

  it('keeps admitting concurrently when every termination is confirmed', async () => {
    // The control: the same plan without an unconfirmed termination never drains.
    const { events } = await run(3, false);
    expect(at(events, 'start:tail-1')).toBeLessThan(at(events, 'end:long-a'));
    expect(at(events, 'start:tail-1')).toBeLessThan(at(events, 'end:long-b'));
  });
});
