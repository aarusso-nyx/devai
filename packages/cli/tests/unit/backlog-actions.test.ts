// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance for ADR-GOV-0019 IA-001: backlog add, list, show, and
// resolve all complete with the network boundary denied, and the only host
// effects they record are filesystem writes under .devai/state/backlog/ and
// the shared counters file. Read actions record no write at all.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processIsReadOnlyForTest } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface FacadeDefinition {
  readonly name: string;
  register(cli: CAC): void;
}

/** The facades the Engineer must export from packages/cli/src/commands/backlog/index.ts. */
interface BacklogFacades {
  readonly backlogAdd: FacadeDefinition;
  readonly backlogList: FacadeDefinition;
  readonly backlogShow: FacadeDefinition;
  readonly backlogResolve: FacadeDefinition;
  readonly backlogCommands: readonly FacadeDefinition[];
}

const FACADES_URL = pathToFileURL(
  resolve(import.meta.dirname, '../../src/commands/backlog/index.ts'),
);

async function facades(): Promise<BacklogFacades> {
  return (await import(FACADES_URL.href)) as BacklogFacades;
}

const validateItem = getValidator('backlog-item.schema.json');
const validateList = getValidator('backlog-list-output.schema.json');
const NETWORK_EXECUTABLES = new Set(['gh', 'curl', 'wget', 'ssh', 'nc']);
const NETWORK_GIT_VERBS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote']);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=DEVAI Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A committed repository with no remote, so every backlog action is local by construction. */
function repository(): { readonly root: string; readonly head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-backlog-actions-')));
  roots.push(root);
  git(root, ['init', '--quiet']);
  writeFileSync(join(root, 'README.md'), '# backlog fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'test: seed backlog fixture']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

interface Observation {
  readonly writes: string[];
  readonly processes: string[];
  readonly denied: string[];
}

function paths(root: string, request: AuthorityHostEffectRequest): readonly string[] {
  if (['writeSync', 'fsyncSync', 'closeSync'].includes(request.symbol)) return [];
  const candidates = ['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync'].includes(
    request.symbol,
  )
    ? [request.arguments[0], request.arguments[1]]
    : [request.arguments[0]];
  return candidates.map((candidate) =>
    typeof candidate === 'string'
      ? relative(root, isAbsolute(candidate) ? candidate : resolve(candidate))
          .split(sep)
          .join('/')
      : `<non-path:${request.symbol}>`,
  );
}

/**
 * A host-effect scope with the network boundary denied: a network-capable
 * process or a non-read-only process is refused before it runs, a global
 * fetch throws, and every filesystem effect is recorded by repository path.
 */
function deniedNetworkScope(root: string, observation: Observation): AuthorityHostEffectScope {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'backlog-actions-network-denied',
    issuer_version: '1.0.0',
    invocation_id: 'backlog-actions-invocation',
    canonicalSha256: () => 'b'.repeat(64),
    randomId: () => `backlog-actions-${String(++ordinal)}`,
    now: () => '2026-09-26T14:05:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  return {
    action_id: 'backlog actions acceptance',
    invocation_id: 'backlog-actions-invocation',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      if (request.kind === 'process') {
        const executable = String(request.arguments[0]);
        const args = Array.isArray(request.arguments[1]) ? request.arguments[1] : [];
        observation.processes.push([executable, ...args.map(String)].join(' '));
        const network =
          NETWORK_EXECUTABLES.has(executable) ||
          (executable.endsWith('git') && NETWORK_GIT_VERBS.has(String(args[0])));
        if (network || !processIsReadOnlyForTest(request)) {
          observation.denied.push(executable);
          throw new Error('BACKLOG_TEST_NETWORK_OR_WRITE_PROCESS_DENIED');
        }
        return apply();
      }
      if (request.kind !== 'filesystem') {
        observation.denied.push(request.kind);
        throw new Error('BACKLOG_TEST_EFFECT_KIND_DENIED');
      }
      observation.writes.push(...paths(root, request));
      return apply();
    },
  };
}

async function invoke(
  definitions: readonly FacadeDefinition[],
  root: string,
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string; observation: Observation }> {
  const cli = cac('devai-backlog-actions');
  for (const definition of definitions) definition.register(cli);
  const observation: Observation = { writes: [], processes: [], denied: [] };
  const scope = deniedNetworkScope(root, observation);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv, '--repo-root', root];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await runWithAuthorityHostEffects(scope, () => cli.runMatchedCommand());
    } catch (error) {
      if (error instanceof Error && error.name === 'CACError') {
        process.exitCode = 2;
        stderr += error.message;
      } else if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) {
        throw error;
      }
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
      observation,
    };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
    (scope.receipt_store as { dispose(): void }).dispose();
  }
}

const fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubGlobal('fetch', (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error('BACKLOG_TEST_NETWORK_DENIED'));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function expectLocalBacklogWrites(observation: Observation): void {
  expect(observation.denied).toEqual([]);
  for (const path of observation.writes) {
    expect(
      path === '.devai' ||
        path === '.devai/state' ||
        path === '.devai/state/counters.json' ||
        path === '.devai/state/backlog' ||
        path.startsWith('.devai/state/backlog/'),
      `write outside the backlog store: ${path}`,
    ).toBe(true);
  }
}

describe('backlog action registry contract', () => {
  it('declares four stable actions with no remote effect and no network capability', () => {
    const entries = ACTION_REGISTRY.filter((entry) => entry.handler.startsWith('backlog '));
    expect(entries.map((entry) => entry.handler).sort()).toEqual([
      'backlog add',
      'backlog list',
      'backlog resolve',
      'backlog show',
    ]);
    for (const entry of entries) {
      expect(entry.status, entry.handler).toBe('stable');
      expect(['read', 'local-write'], entry.handler).toContain(entry.effect);
      expect(JSON.stringify(entry), entry.handler).not.toMatch(
        /net:|remote-write|allow_publish":true/u,
      );
    }
  });
});

describe('backlog actions with the network boundary denied', () => {
  it('binds one facade to each registered backlog action', async () => {
    const { backlogAdd, backlogList, backlogShow, backlogResolve, backlogCommands } =
      await facades();
    expect([backlogAdd, backlogList, backlogShow, backlogResolve].map((d) => d.name)).toEqual([
      'backlog add',
      'backlog list',
      'backlog show',
      'backlog resolve',
    ]);
    expect(backlogCommands.map((definition) => definition.name).sort()).toEqual([
      'backlog add',
      'backlog list',
      'backlog resolve',
      'backlog show',
    ]);
  });

  it('adds an item as a local write that records its origin commit', async () => {
    const { backlogCommands } = await facades();
    const { root, head } = repository();

    const added = await invoke(backlogCommands, root, [
      'backlog-add',
      '--kind',
      'finding',
      '--title',
      'Sensor inventory test depends on directory listing order',
      '--body',
      'The inventory test asserts an unsorted readdirSync result.',
      '--class',
      'tests',
      '--role',
      'engineer',
    ]);

    expect(added.exit, added.stderr).toBe(0);
    expect(added.stderr).toBe('');
    const item = JSON.parse(added.stdout) as Record<string, unknown>;
    expect(validateItem(item), JSON.stringify(validateItem.errors)).toBe(true);
    expect(item).toMatchObject({
      id: 'BL-0001',
      kind: 'finding',
      class: 'tests',
      status: 'open',
      resolved_at: null,
      origin: { role: 'engineer', commit: head },
    });
    expect(item).not.toHaveProperty('round_id');
    expect(
      JSON.parse(readFileSync(join(root, '.devai/state/backlog/BL-0001.json'), 'utf8')),
    ).toEqual(item);
    expect(JSON.parse(readFileSync(join(root, '.devai/state/counters.json'), 'utf8'))).toEqual({
      BL: 1,
    });
    expect(added.observation.writes).toContain('.devai/state/backlog/BL-0001.json');
    expectLocalBacklogWrites(added.observation);
    expect(fetchCalls).toEqual([]);
  });

  it('lists and shows items as reads that record no write', async () => {
    const { backlogCommands } = await facades();
    const { root } = repository();
    const add = (title: string) =>
      invoke(backlogCommands, root, [
        'backlog-add',
        '--kind',
        'note',
        '--title',
        title,
        '--body',
        `${title} body`,
        '--role',
        'architect',
      ]);
    expect((await add('First note')).exit).toBe(0);
    expect((await add('Second note')).exit).toBe(0);

    const listed = await invoke(backlogCommands, root, ['backlog-list']);
    expect(listed.exit, listed.stderr).toBe(0);
    const list = JSON.parse(listed.stdout) as { items: Array<{ id: string }> };
    expect(validateList(list), JSON.stringify(validateList.errors)).toBe(true);
    expect(list.items.map((item) => item.id)).toEqual(['BL-0001', 'BL-0002']);
    expect(listed.observation.writes).toEqual([]);
    expectLocalBacklogWrites(listed.observation);

    const shown = await invoke(backlogCommands, root, ['backlog-show', 'BL-0002']);
    expect(shown.exit, shown.stderr).toBe(0);
    const item = JSON.parse(shown.stdout) as { id: string; title: string };
    expect(validateItem(item)).toBe(true);
    expect(item).toMatchObject({ id: 'BL-0002', title: 'Second note' });
    expect(shown.observation.writes).toEqual([]);
    expectLocalBacklogWrites(shown.observation);
    expect(fetchCalls).toEqual([]);
  });

  it('resolves an item as a local write and drops it from the default open listing', async () => {
    const { backlogCommands } = await facades();
    const { root } = repository();
    const added = await invoke(backlogCommands, root, [
      'backlog-add',
      '--kind',
      'flaky-test',
      '--title',
      'live-ledger-workflow times out under parallel shards',
      '--body',
      'Observed twice in shard 06; passes in isolation.',
      '--role',
      'inspector',
    ]);
    expect(added.exit, added.stderr).toBe(0);

    const resolved = await invoke(backlogCommands, root, [
      'backlog-resolve',
      'BL-0001',
      '--resolution',
      'TASK-0172',
    ]);
    expect(resolved.exit, resolved.stderr).toBe(0);
    const item = JSON.parse(resolved.stdout) as Record<string, unknown>;
    expect(validateItem(item), JSON.stringify(validateItem.errors)).toBe(true);
    expect(item).toMatchObject({ id: 'BL-0001', status: 'resolved', resolution: 'TASK-0172' });
    expect(typeof item.resolved_at).toBe('string');
    expect(resolved.observation.writes).toContain('.devai/state/backlog/BL-0001.json');
    expectLocalBacklogWrites(resolved.observation);

    const open = await invoke(backlogCommands, root, ['backlog-list']);
    expect((JSON.parse(open.stdout) as { items: unknown[] }).items).toEqual([]);
    const all = await invoke(backlogCommands, root, ['backlog-list', '--status', 'all']);
    expect((JSON.parse(all.stdout) as { items: Array<{ id: string }> }).items).toHaveLength(1);
    expect(fetchCalls).toEqual([]);
  });

  it('refuses unknown ids and missing input without writing', async () => {
    const { backlogCommands } = await facades();
    const { root } = repository();
    const cases: readonly (readonly string[])[] = [
      ['backlog-show', 'BL-0404'],
      ['backlog-resolve', 'BL-0404', '--resolution', 'TASK-0172'],
      ['backlog-add', '--kind', 'finding', '--role', 'engineer'],
      ['backlog-add', '--kind', 'gap', '--title', 't', '--body', 'b', '--role', 'engineer'],
    ];
    for (const argv of cases) {
      const result = await invoke(backlogCommands, root, argv);
      expect(result.exit, argv.join(' ')).not.toBe(0);
      expect(result.stderr.length, `${argv.join(' ')}: refusal was silent`).toBeGreaterThan(0);
      expect(
        result.observation.writes.filter((path) => path.startsWith('.devai/state/backlog/')),
        argv.join(' '),
      ).toEqual([]);
    }
  });
});
