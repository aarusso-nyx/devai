// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for ADR-GOV-0019 IA-002 and IA-004: projecting a
// backlog item needs the existing Owner activation of the item's explicit
// round and runs under the existing public-safe disclosure profile; a round is
// never inferred; and no backlog action can pause, resolve, or otherwise alter
// a round gap.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CAC } from 'cac';
import { afterAll, describe, expect, it } from 'vitest';
import * as loop from '@devai-nyx/loop';
import {
  GovernanceTrackingError,
  buildProjectionBatch,
  emitRgr,
  readGovernanceEvents,
  sealGovernanceSegments,
  type GovernanceEvent,
  type RoundTrackingActivation,
} from '@devai-nyx/loop';
import { validators } from '@devai-nyx/schemas';
import {
  clearResolvedInvocationAuthority,
  rememberResolvedInvocationAuthority,
} from '../../src/authority/invocation-authority.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface FacadeDefinition {
  readonly name: string;
  register(cli: CAC): void;
}

/** The projector the Engineer must export from @devai-nyx/loop (repository-backlog module). */
interface BacklogProjector {
  projectBacklogItem(options: {
    readonly repoRoot: string;
    readonly id: string;
    readonly lock?: { readonly waitMs?: number; readonly ttlMs?: number };
  }): GovernanceEvent;
}

const FACADES_URL = pathToFileURL(
  resolve(import.meta.dirname, '../../src/commands/backlog/index.ts'),
);

async function backlogCommands(): Promise<readonly FacadeDefinition[]> {
  return ((await import(FACADES_URL.href)) as { backlogCommands: readonly FacadeDefinition[] })
    .backlogCommands;
}

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const ROUND = 'R-0042';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const TITLE = 'Sensor inventory test depends on directory listing order';
const BODY = 'packages/sensors/tests/unit/inventory.test.ts asserts an unsorted listing.';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function activation(overrides: Partial<RoundTrackingActivation> = {}): RoundTrackingActivation {
  return {
    schemaVersion: '1.0.0',
    round_id: ROUND,
    repository_id: 'adopter',
    state: 'active',
    adapter: {
      id: 'github-issues',
      adapter_version: '1.0.0',
      package_version: '1.3.0',
      config_digest_sha256: 'a'.repeat(64),
      workflow_digest_sha256: 'b'.repeat(64),
    },
    target: { repository: 'example/adopter', issue_number: null },
    authorization: {
      authority_session_id: SESSION,
      role: 'owner',
      publish_flag: true,
      authorized_at: '2026-08-27T12:00:00.000Z',
    },
    disclosure_profile: 'public-safe-v1',
    pending_policy: 'freeze',
    disabled: null,
    ...overrides,
  };
}

function repository(options: { readonly activated: boolean }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-backlog-projection-')));
  roots.push(root);
  const git = (args: readonly string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=DEVAI Test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git(['init', '--quiet']);
  writeFileSync(join(root, 'README.md'), '# backlog projection fixture\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'test: seed backlog projection fixture']);
  if (options.activated) {
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
  }
  return root;
}

async function invoke(
  root: string,
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-backlog-projection');
  for (const definition of await backlogCommands()) definition.register(cli);
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
    rememberResolvedInvocationAuthority('engineer', 'cli-flag', []);
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
    clearResolvedInvocationAuthority();
  }
}

async function add(root: string, extra: readonly string[] = []): Promise<{ id: string }> {
  const result = await invoke(root, [
    'backlog-add',
    '--kind',
    'finding',
    '--title',
    TITLE,
    '--body',
    BODY,
    '--role',
    'engineer',
    ...extra,
  ]);
  expect(result.exit, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { id: string };
}

function projector(): BacklogProjector {
  return loop as unknown as BacklogProjector;
}

async function projectionRefusal(root: string, id: string): Promise<string> {
  try {
    await withAuthorityHostTestScope(() => projector().projectBacklogItem({ repoRoot: root, id }));
  } catch (error) {
    expect(error).toBeInstanceOf(GovernanceTrackingError);
    return (error as GovernanceTrackingError).code;
  }
  return expect.unreachable('projection must refuse');
}

function trackingPolicyDefaults(): {
  backlog_projection: { enabled_by: string; disclosure_profile: string };
  event_kinds: string[];
} {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, 'law/policy/github-issues-tracking.json'), 'utf8')) as {
      defaults: {
        backlog_projection: { enabled_by: string; disclosure_profile: string };
        event_kinds: string[];
      };
    }
  ).defaults;
}

describe('backlog projection requires the Owner activation', () => {
  it('refuses to project an attributed item when the round was never activated', async () => {
    const root = repository({ activated: false });
    const item = await add(root, ['--round', ROUND]);

    expect(await projectionRefusal(root, item.id)).toBe('BACKLOG_PROJECTION_NOT_ACTIVATED');
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });

  it('keeps an attributed item local when its round has no activation', async () => {
    const root = repository({ activated: false });
    const item = await add(root, ['--round', ROUND]);

    expect(
      JSON.parse(readFileSync(join(root, '.devai/state/backlog', `${item.id}.json`), 'utf8')),
    ).toMatchObject({ round_id: ROUND, status: 'open' });
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });

  it('refuses to project an item with no round even while a round is activated', async () => {
    const root = repository({ activated: true });
    const item = await add(root);

    expect(await projectionRefusal(root, item.id)).toBe('BACKLOG_PROJECTION_ROUND_REQUIRED');
    // A round is never inferred: the activated round's chain did not grow.
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });

  it('refuses to project into a round whose activation is disabled', async () => {
    const root = repository({ activated: false });
    put(
      root,
      join('.devai/state/tracking', ROUND, 'activation.json'),
      activation({
        state: 'disabled',
        disabled: {
          disabled_at: '2026-08-28T12:00:00.000Z',
          authority_session_id: SESSION,
          pending_events: 0,
        },
      }),
    );
    const item = await add(root, ['--round', ROUND]);

    expect(await projectionRefusal(root, item.id)).toBe('BACKLOG_PROJECTION_NOT_ACTIVATED');
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });
});

describe('backlog projection under the disclosure profile', () => {
  it('reuses the round activation and the public-safe profile declared by policy', () => {
    const defaults = trackingPolicyDefaults();
    expect(defaults.backlog_projection).toMatchObject({
      enabled_by: 'round-activation',
      disclosure_profile: activation().disclosure_profile,
    });
    expect(defaults.event_kinds).toContain('backlog_item_projected');
  });

  it('emits backlog_item_projected on the activated round chain when the item names it', async () => {
    const root = repository({ activated: true });
    const item = await add(root, ['--round', ROUND]);

    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(
      validators.governanceEvent(event),
      JSON.stringify(validators.governanceEvent.errors),
    ).toBe(true);
    expect(event).toMatchObject({
      kind: 'backlog_item_projected',
      round_id: ROUND,
      authority_session_id: SESSION,
      session_source: 'session-state',
      role: 'engineer',
      coverage: { mediated: true },
    });
    expect(event?.evidence_refs).toContain(item.id);
    // Title and body travel as digests only, never as text.
    expect(event?.payload_digest_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(event?.public_safe_summary).toContain(item.id);
    expect(event?.public_safe_summary).not.toContain(TITLE);
    expect(event?.public_safe_summary).not.toContain(BODY);
    expect(event?.public_safe_summary).not.toContain('packages/sensors');
  });

  it('projects an attributed item directly and batches it under public-safe-v1', async () => {
    const root = repository({ activated: false });
    const item = await add(root, ['--round', ROUND]);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());

    const event = await withAuthorityHostTestScope(() =>
      projector().projectBacklogItem({ repoRoot: root, id: item.id }),
    );
    expect(event).toMatchObject({ kind: 'backlog_item_projected', round_id: ROUND });
    expect(event.public_safe_summary).not.toContain(TITLE);

    await withAuthorityHostTestScope(() =>
      sealGovernanceSegments({ repoRoot: root, round: ROUND, reason: 'checkpoint' }),
    );
    const batch = buildProjectionBatch({ repoRoot: root, round: ROUND, reason: 'checkpoint' });
    expect(batch?.disclosure_profile).toBe('public-safe-v1');
    expect(batch?.event_ids).toContain(event.event_id);
    expect(JSON.stringify(batch)).not.toContain(TITLE);
    expect(JSON.stringify(batch)).not.toContain(BODY);
  });

  it('records nothing on any round when no round is given, even while one is activated', async () => {
    const root = repository({ activated: true });
    const item = await add(root);

    expect(item).not.toHaveProperty('round_id');
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });
});

describe('backlog add with round tracking is idempotent and recoverable', () => {
  const REQUEST = 'req-2026-10-06-0001';
  const addArgs = (root: string, extra: readonly string[] = []) =>
    invoke(root, [
      'backlog-add',
      '--kind',
      'finding',
      '--title',
      TITLE,
      '--body',
      BODY,
      '--round',
      ROUND,
      ...extra,
    ]);
  const withRequest = (root: string, id = REQUEST) => addArgs(root, ['--request-id', id]);
  const itemFiles = (root: string) =>
    readdirSync(join(root, '.devai/state/backlog')).filter((name) => name.endsWith('.json'));
  const logPath = (root: string) => join(root, '.devai/state/tracking', ROUND, 'events.jsonl');
  const lockPath = (root: string) => join(root, '.devai/state/tracking', ROUND, 'projection.lock');
  const foreignLock = (root: string, acquiredAt: string) =>
    put(root, join('.devai/state/tracking', ROUND, 'projection.lock'), {
      token: 'foreign-owner-token',
      pid: 1,
      acquired_at: acquiredAt,
    });

  it('recovers the recorded item by request id after a failed append', async () => {
    const root = repository({ activated: true });
    // A read-only log makes the append fail after the item is saved.
    put(root, join('.devai/state/tracking', ROUND, 'events.jsonl'), '');
    chmodSync(logPath(root), 0o444);

    const failed = await withRequest(root);
    expect(failed.exit).not.toBe(0);
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
    expect(existsSync(lockPath(root)), 'a failed append must release the round lock').toBe(false);

    chmodSync(logPath(root), 0o644);
    const retried = await withRequest(root);
    expect(retried.exit, retried.stderr).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({ id: 'BL-0001', request_id: REQUEST });
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events).toHaveLength(1);
    expect(events[0]?.evidence_refs).toContain('BL-0001');
  });

  it('returns the recorded outcome when the process died after the append', async () => {
    const root = repository({ activated: true });
    const first = await withRequest(root);
    expect(first.exit, first.stderr).toBe(0);

    // The caller never saw the response and retries with the same identity.
    const retried = await withRequest(root);

    expect(retried.exit, retried.stderr).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual(JSON.parse(first.stdout));
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(1);
  });

  it('always records a new item when no request id is given', async () => {
    const root = repository({ activated: true });

    expect((await addArgs(root)).exit).toBe(0);
    const second = await addArgs(root);

    expect(second.exit, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ id: 'BL-0002' });
    expect(itemFiles(root)).toEqual(['BL-0001.json', 'BL-0002.json']);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(2);
  });

  it('refuses a request id reused with different content', async () => {
    const root = repository({ activated: true });
    expect((await withRequest(root)).exit).toBe(0);

    const conflict = await invoke(root, [
      'backlog-add',
      '--kind',
      'finding',
      '--title',
      'A different finding',
      '--body',
      BODY,
      '--round',
      ROUND,
      '--request-id',
      REQUEST,
    ]);

    expect(conflict.exit).not.toBe(0);
    expect(JSON.parse(conflict.stderr)).toMatchObject({ code: 'BACKLOG_REQUEST_ID_CONFLICT' });
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
  });

  it('refuses a malformed request id', async () => {
    const root = repository({ activated: true });
    const result = await withRequest(root, 'short');
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'BACKLOG_REQUEST_ID_INVALID' });
  });

  it('keeps the item local while the round is not activated and completes it once it is', async () => {
    const root = repository({ activated: false });

    const local = await withRequest(root);
    expect(local.exit, local.stderr).toBe(0);
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);

    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
    const completed = await withRequest(root);
    expect(completed.exit, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({ id: 'BL-0001' });
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toHaveLength(1);
  });

  it('appends nothing when the activation is disabled after the item was saved', async () => {
    const root = repository({ activated: true });
    put(root, join('.devai/state/tracking', ROUND, 'events.jsonl'), '');
    chmodSync(logPath(root), 0o444);
    expect((await withRequest(root)).exit).not.toBe(0);
    chmodSync(logPath(root), 0o644);
    put(
      root,
      join('.devai/state/tracking', ROUND, 'activation.json'),
      activation({
        state: 'disabled',
        disabled: {
          disabled_at: '2026-08-28T12:00:00.000Z',
          authority_session_id: SESSION,
          pending_events: 0,
        },
      }),
    );

    const retried = await withRequest(root);

    expect(retried.exit, retried.stderr).toBe(0);
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
  });

  it('projects an item once however often projection is requested', async () => {
    const root = repository({ activated: true });
    const item = await add(root, ['--round', ROUND]);

    const again = await withAuthorityHostTestScope(() =>
      projector().projectBacklogItem({ repoRoot: root, id: item.id }),
    );

    const events = readGovernanceEvents({ repoRoot: root, round: ROUND });
    expect(events).toHaveLength(1);
    expect(again.event_id).toBe(events[0]?.event_id);
  });

  it('refuses to append while another holder owns the round lock and leaves that lock alone', async () => {
    const root = repository({ activated: false });
    const item = await add(root, ['--round', ROUND]);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
    foreignLock(root, new Date().toISOString());

    const code = await withAuthorityHostTestScope(() => {
      try {
        projector().projectBacklogItem({ repoRoot: root, id: item.id, lock: { waitMs: 0 } });
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    });

    expect(code).toBe('BACKLOG_LOCK_HELD');
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);
    expect(JSON.parse(readFileSync(lockPath(root), 'utf8'))).toMatchObject({
      token: 'foreign-owner-token',
    });
  });

  it('refuses a stale round lock with a repair code and never takes it over', async () => {
    const root = repository({ activated: false });
    const item = await add(root, ['--round', ROUND]);
    put(root, join('.devai/state/tracking', ROUND, 'activation.json'), activation());
    foreignLock(root, '2020-01-01T00:00:00.000Z');

    const code = await withAuthorityHostTestScope(() => {
      try {
        projector().projectBacklogItem({ repoRoot: root, id: item.id, lock: { waitMs: 0 } });
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    });

    expect(code).toBe('BACKLOG_LOCK_STALE');
    expect(existsSync(lockPath(root))).toBe(true);
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual([]);

    // After an operator removes the stale lock, the retry completes.
    rmSync(lockPath(root));
    const event = await withAuthorityHostTestScope(() =>
      projector().projectBacklogItem({ repoRoot: root, id: item.id }),
    );
    expect(event.kind).toBe('backlog_item_projected');
  });

  it('does not let a torn item file block an add without a request id', async () => {
    const root = repository({ activated: true });
    put(root, '.devai/state/backlog/BL-0001.json', '{"schemaVersion":"1.0.0","id":"BL-00');

    const plain = await addArgs(root);

    expect(plain.exit, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ id: 'BL-0002' });
  });

  it('refuses a request-id recovery with a repair code while an item file is unreadable', async () => {
    const root = repository({ activated: true });
    put(root, '.devai/state/backlog/BL-0001.json', '{"schemaVersion":"1.0.0","id":"BL-00');

    const result = await withRequest(root);

    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'BACKLOG_ITEM_UNREADABLE' });
    expect(itemFiles(root)).toEqual(['BL-0001.json']);
  });
});

describe('a backlog action does not know a round gap', () => {
  async function withGap(): Promise<{ root: string; gapPath: string; gapBytes: string }> {
    const root = repository({ activated: true });
    const gap = await withAuthorityHostTestScope(() =>
      emitRgr({
        repoRoot: root,
        emittingTaskId: 'TASK-0042',
        emittingDiscipline: 'engineer',
        summary: 'Refresh behavior is unspecified',
        ambiguity: 'Must stale refresh tokens be rejected?',
        evidenceRefs: ['EV-abcdef01'],
        createdAt: '2026-09-08T12:00:00.000Z',
      }),
    );
    expect(gap.id).toBe('RGR-0001');
    const gapPath = join(root, '.devai/state/rgr/RGR-0001.json');
    return { root, gapPath, gapBytes: readFileSync(gapPath, 'utf8') };
  }

  it('refuses to resolve or show a gap id and leaves the gap byte-identical', async () => {
    const { root, gapPath, gapBytes } = await withGap();
    const eventsBefore = readGovernanceEvents({ repoRoot: root, round: ROUND });

    for (const argv of [
      ['backlog-resolve', 'RGR-0001', '--resolution', 'TASK-0172'],
      ['backlog-show', 'RGR-0001'],
    ]) {
      const result = await invoke(root, argv);
      expect(result.exit, argv.join(' ')).not.toBe(0);
      expect(result.stderr, argv.join(' ')).toMatch(/BACKLOG_ITEM_(ID_INVALID|NOT_FOUND)/u);
    }
    expect(readFileSync(gapPath, 'utf8')).toBe(gapBytes);
    expect(JSON.parse(gapBytes)).toMatchObject({ status: 'open' });
    expect(readGovernanceEvents({ repoRoot: root, round: ROUND })).toEqual(eventsBefore);
  });

  it('never lists a gap and leaves it untouched while a backlog item is added and resolved', async () => {
    const { root, gapPath, gapBytes } = await withGap();
    const counters = () =>
      JSON.parse(readFileSync(join(root, '.devai/state/counters.json'), 'utf8')) as Record<
        string,
        number
      >;
    const item = await add(root, ['--body', 'See RGR-0001 for the related round gap.']);
    const resolved = await invoke(root, ['backlog-resolve', item.id, '--resolution', 'RGR-0001']);
    expect(resolved.exit, resolved.stderr).toBe(0);

    const listed = await invoke(root, ['backlog-list', '--status', 'all']);
    expect(listed.exit, listed.stderr).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as { items: Array<{ id: string }> }).items.map((i) => i.id),
    ).toEqual([item.id]);
    expect(readFileSync(gapPath, 'utf8')).toBe(gapBytes);
    expect(counters()).toMatchObject({ RGR: 1, BL: 1 });
  });
});
