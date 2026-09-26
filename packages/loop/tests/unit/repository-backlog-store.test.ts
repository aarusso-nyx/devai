// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-GOV-0019 (IA-001, IA-003, IA-004): the
// repository backlog store records schema-valid items under
// .devai/state/backlog/, allocates never-reused BL ids from the shared
// .devai/state/counters.json, never infers a round, and never touches a round
// gap. Every filesystem effect is observed and must stay inside the backlog
// directory or the counters file.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';

type BacklogKind = 'finding' | 'proposition' | 'note' | 'flaky-test';
type BacklogRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';

interface BacklogItem {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly kind: BacklogKind;
  readonly class?: string;
  readonly title: string;
  readonly body: string;
  readonly origin: {
    readonly session: string;
    readonly role: BacklogRole;
    readonly commit: string;
  };
  readonly round_id?: string;
  readonly status: 'open' | 'resolved';
  readonly resolution?: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface AddBacklogItemOptions {
  readonly repoRoot: string;
  readonly kind: BacklogKind;
  readonly title: string;
  readonly body: string;
  readonly class?: string;
  readonly roundId?: string;
  readonly origin: BacklogItem['origin'];
  readonly createdAt?: string;
}

/** The API the Engineer must export from packages/loop/src/repository-backlog/index.ts. */
interface RepositoryBacklogStore {
  addBacklogItem(options: AddBacklogItemOptions): BacklogItem;
  listBacklogItems(options: {
    readonly repoRoot: string;
    readonly status?: 'open' | 'resolved' | 'all';
    readonly roundId?: string;
  }): readonly BacklogItem[];
  showBacklogItem(options: { readonly repoRoot: string; readonly id: string }): BacklogItem;
  resolveBacklogItem(options: {
    readonly repoRoot: string;
    readonly id: string;
    readonly resolution: string;
    readonly resolvedAt?: string;
  }): BacklogItem;
}

// Loaded through a file URL so the suite typechecks before the module exists.
const STORE_URL = pathToFileURL(
  resolve(import.meta.dirname, '../../src/repository-backlog/index.ts'),
);

async function store(): Promise<RepositoryBacklogStore> {
  return (await import(STORE_URL.href)) as RepositoryBacklogStore;
}

const validateItem = getValidator('backlog-item.schema.json');
const CREATED_AT = '2026-09-26T14:05:00.000Z';
const RESOLVED_AT = '2026-09-27T09:00:00.000Z';
const ORIGIN = {
  session: 'DIRECT-CLI-0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  role: 'engineer',
  commit: 'f537a374f537a374f537a374f537a374f537a374',
} as const;

let root: string;
let writes: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-backlog-store-')));
  writes = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function effectPaths(request: AuthorityHostEffectRequest): readonly string[] {
  if (['writeSync', 'fsyncSync', 'closeSync'].includes(request.symbol)) return [];
  const candidates = ['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync'].includes(
    request.symbol,
  )
    ? [request.arguments[0], request.arguments[1]]
    : [request.arguments[0]];
  return candidates.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error('BACKLOG_TEST_EFFECT_TARGET_INVALID');
    const path = relative(root, isAbsolute(candidate) ? candidate : resolve(candidate));
    return path.split(sep).join('/');
  });
}

/** Run with every host effect observed; nothing may leave the owned repository. */
function run<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'backlog-store-test',
    issuer_version: '1.0.0',
    invocation_id: 'backlog-store',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'backlog-store-receipt',
    now: () => CREATED_AT,
    receipt_ttl_ms: 30_000,
  });
  try {
    return runWithAuthorityHostEffects(
      {
        action_id: 'backlog store acceptance',
        invocation_id: 'backlog-store',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (request, apply) => {
          if (request.kind !== 'filesystem') throw new Error('BACKLOG_TEST_NON_FILESYSTEM_EFFECT');
          for (const path of effectPaths(request)) {
            if (path.startsWith('..') || isAbsolute(path)) {
              throw new Error('BACKLOG_TEST_EFFECT_OUTSIDE_ROOT');
            }
            writes.push(path);
          }
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

function add(
  backlog: RepositoryBacklogStore,
  overrides: Partial<AddBacklogItemOptions> = {},
): BacklogItem {
  return run(() =>
    backlog.addBacklogItem({
      repoRoot: root,
      kind: 'finding',
      title: 'Sensor inventory test depends on directory listing order',
      body: 'The inventory test asserts an unsorted readdirSync result.',
      origin: ORIGIN,
      createdAt: CREATED_AT,
      ...overrides,
    }),
  );
}

function counters(): Record<string, number> {
  return JSON.parse(readFileSync(join(root, '.devai/state/counters.json'), 'utf8')) as Record<
    string,
    number
  >;
}

function itemPath(id: string): string {
  return join(root, '.devai/state/backlog', `${id}.json`);
}

describe('backlog add', () => {
  it('records a schema-valid open item at .devai/state/backlog/BL-0001.json', async () => {
    const backlog = await store();
    const item = add(backlog, { class: 'tests' });

    expect(validateItem(item), JSON.stringify(validateItem.errors)).toBe(true);
    expect(item).toEqual({
      schemaVersion: '1.0.0',
      id: 'BL-0001',
      kind: 'finding',
      class: 'tests',
      title: 'Sensor inventory test depends on directory listing order',
      body: 'The inventory test asserts an unsorted readdirSync result.',
      origin: ORIGIN,
      status: 'open',
      created_at: CREATED_AT,
      resolved_at: null,
    });
    const persisted = JSON.parse(readFileSync(itemPath('BL-0001'), 'utf8')) as unknown;
    expect(persisted).toEqual(item);
    expect(validateItem(persisted)).toBe(true);
  });

  it('allocates ascending ids from the BL key of the shared counters file', async () => {
    const backlog = await store();
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    writeFileSync(join(root, '.devai/state/counters.json'), `${JSON.stringify({ RGR: 7 })}\n`);

    const ids = [
      add(backlog),
      add(backlog, { kind: 'note' }),
      add(backlog, { kind: 'proposition' }),
    ].map((item) => item.id);

    expect(ids).toEqual(['BL-0001', 'BL-0002', 'BL-0003']);
    // The BL key joins the existing counters without disturbing another family.
    expect(counters()).toEqual({ RGR: 7, BL: 3 });
  });

  it('continues from an existing BL counter instead of restarting', async () => {
    const backlog = await store();
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    writeFileSync(join(root, '.devai/state/counters.json'), `${JSON.stringify({ BL: 41 })}\n`);

    expect(add(backlog).id).toBe('BL-0042');
    expect(counters()).toMatchObject({ BL: 42 });
  });

  it('never reuses an id already present in the store when the counter is absent', async () => {
    const backlog = await store();
    const first = add(backlog);
    // A fresh clone carries committed items but not the ignored counters file.
    rmSync(join(root, '.devai/state/counters.json'));

    const second = add(backlog, { kind: 'note' });
    expect(second.id).not.toBe(first.id);
    expect(second.id).toBe('BL-0002');
    expect(JSON.parse(readFileSync(itemPath(first.id), 'utf8'))).toEqual(first);
  });

  it('records round attribution only when a round is given explicitly', async () => {
    const backlog = await store();
    const unattributed = add(backlog);
    const attributed = add(backlog, { roundId: 'R-0105', kind: 'flaky-test' });

    expect(unattributed).not.toHaveProperty('round_id');
    expect(attributed.round_id).toBe('R-0105');
    expect(validateItem(attributed)).toBe(true);
  });

  it('refuses an item the schema rejects and writes no item file', async () => {
    const backlog = await store();
    const invalid: readonly Partial<AddBacklogItemOptions>[] = [
      { title: '' },
      { body: '' },
      { kind: 'gap' as BacklogKind },
      { class: 'not-a-class' },
      { roundId: 'round-five' },
      { origin: { ...ORIGIN, commit: 'HEAD' } },
      { origin: { ...ORIGIN, session: 'someone' } },
    ];
    for (const overrides of invalid) {
      expect(() => add(backlog, overrides), JSON.stringify(overrides)).toThrow();
    }
    const directory = join(root, '.devai/state/backlog');
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
  });

  it('writes only the backlog directory and the counters file', async () => {
    const backlog = await store();
    add(backlog);
    add(backlog, { roundId: 'R-0105' });

    expect(writes.length).toBeGreaterThan(0);
    for (const path of writes) {
      expect(
        path === '.devai' ||
          path === '.devai/state' ||
          path === '.devai/state/counters.json' ||
          path === '.devai/state/backlog' ||
          path.startsWith('.devai/state/backlog/'),
        path,
      ).toBe(true);
    }
    expect(existsSync(join(root, '.devai/state/rgr'))).toBe(false);
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });
});

describe('backlog list and show', () => {
  it('lists open items in ascending id order by default and every item on request', async () => {
    const backlog = await store();
    const first = add(backlog);
    const second = add(backlog, { kind: 'note', roundId: 'R-0105' });
    const third = add(backlog, { kind: 'proposition' });
    run(() =>
      backlog.resolveBacklogItem({
        repoRoot: root,
        id: second.id,
        resolution: 'TASK-0172',
        resolvedAt: RESOLVED_AT,
      }),
    );

    expect(backlog.listBacklogItems({ repoRoot: root }).map((item) => item.id)).toEqual([
      first.id,
      third.id,
    ]);
    expect(
      backlog.listBacklogItems({ repoRoot: root, status: 'resolved' }).map((item) => item.id),
    ).toEqual([second.id]);
    expect(
      backlog.listBacklogItems({ repoRoot: root, status: 'all' }).map((item) => item.id),
    ).toEqual([first.id, second.id, third.id]);
    for (const item of backlog.listBacklogItems({ repoRoot: root, status: 'all' })) {
      expect(validateItem(item), item.id).toBe(true);
    }
  });

  it('narrows by an explicit round without inferring one', async () => {
    const backlog = await store();
    add(backlog);
    const attributed = add(backlog, { roundId: 'R-0105' });
    add(backlog, { roundId: 'R-0106' });

    expect(
      backlog.listBacklogItems({ repoRoot: root, roundId: 'R-0105' }).map((item) => item.id),
    ).toEqual([attributed.id]);
    expect(backlog.listBacklogItems({ repoRoot: root })).toHaveLength(3);
  });

  it('returns an empty list for a repository that has no backlog', async () => {
    const backlog = await store();
    expect(backlog.listBacklogItems({ repoRoot: root })).toEqual([]);
    expect(existsSync(join(root, '.devai'))).toBe(false);
  });

  it('shows one exact item and refuses an unknown or malformed id', async () => {
    const backlog = await store();
    const item = add(backlog);

    expect(backlog.showBacklogItem({ repoRoot: root, id: item.id })).toEqual(item);
    expect(() => backlog.showBacklogItem({ repoRoot: root, id: 'BL-0999' })).toThrow(
      /BACKLOG_ITEM_NOT_FOUND/u,
    );
    for (const id of ['../counters', 'RGR-0001', 'BL-1', 'bl-0001']) {
      expect(() => backlog.showBacklogItem({ repoRoot: root, id }), id).toThrow(
        /BACKLOG_ITEM_(ID_INVALID|NOT_FOUND)/u,
      );
    }
  });
});

describe('backlog resolve', () => {
  it('resolves an open item once with a reference and keeps its origin and round', async () => {
    const backlog = await store();
    const item = add(backlog, { roundId: 'R-0105', kind: 'flaky-test', class: 'tests' });

    const resolved = run(() =>
      backlog.resolveBacklogItem({
        repoRoot: root,
        id: item.id,
        resolution: 'TASK-0172',
        resolvedAt: RESOLVED_AT,
      }),
    );

    expect(validateItem(resolved), JSON.stringify(validateItem.errors)).toBe(true);
    expect(resolved).toEqual({
      ...item,
      status: 'resolved',
      resolution: 'TASK-0172',
      resolved_at: RESOLVED_AT,
    });
    expect(JSON.parse(readFileSync(itemPath(item.id), 'utf8'))).toEqual(resolved);
    expect(() =>
      run(() =>
        backlog.resolveBacklogItem({ repoRoot: root, id: item.id, resolution: 'TASK-0173' }),
      ),
    ).toThrow(/BACKLOG_ITEM_ALREADY_RESOLVED/u);
    expect(JSON.parse(readFileSync(itemPath(item.id), 'utf8'))).toEqual(resolved);
  });

  it('refuses a resolution without a reference', async () => {
    const backlog = await store();
    const item = add(backlog);
    expect(() =>
      run(() => backlog.resolveBacklogItem({ repoRoot: root, id: item.id, resolution: '' })),
    ).toThrow();
    expect(backlog.showBacklogItem({ repoRoot: root, id: item.id })).toEqual(item);
  });

  it('does not know a round gap: resolving a gap id refuses and leaves the gap untouched', async () => {
    const backlog = await store();
    const gapDirectory = join(root, '.devai/state/rgr');
    mkdirSync(gapDirectory, { recursive: true });
    const gap = `${JSON.stringify({ schemaVersion: '1.0.0', id: 'RGR-0001', status: 'open' }, null, 2)}\n`;
    writeFileSync(join(gapDirectory, 'RGR-0001.json'), gap);
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    writeFileSync(join(root, '.devai/state/counters.json'), `${JSON.stringify({ RGR: 1 })}\n`);

    expect(() =>
      run(() =>
        backlog.resolveBacklogItem({ repoRoot: root, id: 'RGR-0001', resolution: 'TASK-0172' }),
      ),
    ).toThrow(/BACKLOG_ITEM_(ID_INVALID|NOT_FOUND)/u);
    expect(readFileSync(join(gapDirectory, 'RGR-0001.json'), 'utf8')).toBe(gap);
    expect(counters()).toEqual({ RGR: 1 });
    expect(backlog.listBacklogItems({ repoRoot: root, status: 'all' })).toEqual([]);
  });
});
