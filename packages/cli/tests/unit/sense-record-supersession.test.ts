// ADR-SCR-0008 IA-001, IA-002 and the role half of IA-004: a recorded reading is an
// immutable instance, a later instance names the earlier one in `supersedes` and
// selection follows those links, and `sense record` performs two ordered writes (the
// reading file, then one digest-bearing `sense.readings.record` chain entry) whose
// missing second half is repaired by re-recording the same file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { verifyChain } from '@devai-nyx/evidence';
import { filterLatestPerKind, loadReadingsFromDir, resolveScorecardInputs } from '@devai-nyx/loop';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading } from '@devai-nyx/sensors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { recordSensorReading } from '../../src/commands/sense/record.js';
import {
  authorizeSelfDogfoodCheck,
  gateSelfDogfoodCommand,
  type SelfDogfoodRequest,
} from '../../src/services/self-dogfood.js';

type Json = Record<string, unknown>;

interface ChainArtifact {
  readonly path?: string;
  readonly sha256?: string | null;
}
interface ChainRecord {
  readonly action?: string;
  readonly status?: string;
  readonly manifest_hash?: string;
  readonly context?: { readonly git?: { readonly head_sha?: string | null } };
  readonly artifacts?: readonly ChainArtifact[];
}
interface Chain {
  head: string | null;
  records: ChainRecord[];
}

const WORKSPACE = resolve(import.meta.dirname, '../../../..');
const STORE = '.devai/state/sensor-readings';
const CHAIN = 'record/proofs/chain.json';
const CHAIN_PATHS = ['.devai/state/sensor-readings', 'record/proofs/chain.json'] as const;
const T0 = '2026-10-01T08:00:00.000Z';
const T1 = '2026-10-01T09:00:00.000Z';
const T2 = '2026-10-01T10:00:00.000Z';
const T3 = '2026-10-01T11:00:00.000Z';

/**
 * Observes the authority-boundary writes `sense record` performs. When the reading
 * file is written, it captures how many chain entries already name it, which is how
 * the write order (file first, chain entry second) is proved.
 */
const observed = vi.hoisted(() => ({
  writes: [] as string[],
  chainEntriesAtFileWrite: new Map<string, number>(),
  probe: undefined as ((path: string) => number) | undefined,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const path = String(args[0]);
      observed.writes.push(path);
      if (observed.probe !== undefined && path.endsWith('.json') && path.includes(STORE)) {
        observed.chainEntriesAtFileWrite.set(path, observed.probe(path));
      }
      return actual.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];

beforeEach(() => {
  observed.writes.length = 0;
  observed.chainEntriesAtFileWrite.clear();
  observed.probe = undefined;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'DEVAI Test',
      GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
      GIT_COMMITTER_NAME: 'DEVAI Test',
      GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
    },
  }).trim();
}

function put(root: string, path: string, body: string): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

/** A fresh repository with one commit: the candidate head every recording binds. */
function repo(): { readonly root: string; readonly head: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-sense-record-supersession-')));
  roots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  put(root, 'README.md', 'fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

const BASE = {
  sensorName: 'inventory:api',
  sensorKind: 'inventory_api',
  command: ['devai', 'sense', 'run', 'inventory_api'],
  status: 'pass',
  deterministic: true,
  tier: 'L0',
  duration_ms: 120,
  metrics: { endpoints: 3 },
} as const;

function reading(timestamp: string, extra: Json = {}): SensorReading {
  // Built from a variable rather than a literal so the `supersedes` input the
  // builder gains under ADR-SCR-0008 is passed through unchanged.
  const input = { ...BASE, timestamp, ...extra };
  return buildSensorReading(input);
}

function supersedesOf(value: SensorReading): unknown {
  return (value as unknown as Json)['supersedes'];
}

function storePath(value: SensorReading): string {
  return `${STORE}/${value.sensor.kind}/${value.id}.json`;
}

function stage(root: string, name: string, value: unknown): string {
  put(root, `inputs/${name}.json`, JSON.stringify(value));
  return `inputs/${name}.json`;
}

function record(root: string, input: string) {
  return withAuthorityHostTestScope(() => recordSensorReading(root, input));
}

function loadChain(root: string): Chain {
  const path = join(root, CHAIN);
  if (!existsSync(path)) return { head: null, records: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as Chain;
}

function entriesFor(root: string, path: string): ChainRecord[] {
  return loadChain(root).records.filter(
    (entry) =>
      entry.action === 'sense.readings.record' &&
      entry.artifacts?.some((artifact) => artifact.path === path) === true,
  );
}

function digest(root: string, path: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex');
}

function cellOf(kind: string): string {
  const registry = JSON.parse(
    readFileSync(join(WORKSPACE, 'law/policy/sensor-registry.json'), 'utf8'),
  ) as {
    readonly entries: readonly {
      readonly kind: string;
      readonly cells: readonly { readonly substrate: string; readonly property: string }[];
    }[];
  };
  const cell = registry.entries.find((entry) => entry.kind === kind)?.cells[0];
  if (cell === undefined) throw new Error(`fixture kind ${kind} has no registry cell`);
  return `${cell.substrate}:${cell.property}`;
}

describe('ADR-SCR-0008 IA-001 reading instances and supersession', () => {
  it('still refuses a same-id different-body write and leaves the recorded bytes unchanged', async () => {
    const { root } = repo();
    const first = reading(T1);
    const created = await record(root, stage(root, 'first', first));
    expect(created.action).toBe('created');
    const bytes = readFileSync(created.path);

    // Metrics and the timestamp are outside the content-derived id, so both of
    // these bodies collide with the recorded id and must never overwrite it.
    for (const altered of [
      { ...first, metrics: { endpoints: 4 } },
      { ...first, timestamp: T2 },
    ]) {
      expect(altered.id).toBe(first.id);
      expect(validators.sensorReading(altered)).toBe(true);
      await expect(record(root, stage(root, 'altered', altered))).rejects.toThrow(
        `SENSE_RECORD_ID_CONFLICT:${first.id}`,
      );
      expect(readFileSync(created.path).equals(bytes)).toBe(true);
    }

    // A same-id same-body write stays already-recorded.
    expect((await record(root, stage(root, 'again', first))).action).toBe('already-recorded');
    expect(readFileSync(created.path).equals(bytes)).toBe(true);
  });

  it('builds a later reading of the same kind as a new instance that names the earlier id', () => {
    const first = reading(T1);
    const later = reading(T2, { supersedes: first.id });

    expect(later.id).toMatch(/^SR-[a-f0-9]{16}$/u);
    expect(later.id).not.toBe(first.id);
    expect(supersedesOf(later)).toBe(first.id);
    expect(supersedesOf(first)).toBeUndefined();
    expect(validators.sensorReading(later), JSON.stringify(validators.sensorReading.errors)).toBe(
      true,
    );
    // The id stays content-derived: the same content superseding the same instance
    // is the same id whatever its timestamp.
    expect(reading(T3, { supersedes: first.id }).id).toBe(later.id);
    // A reading never supersedes itself.
    expect(supersedesOf(later)).not.toBe(later.id);
  });

  it('records the later instance as a new file and never rewrites the earlier one', async () => {
    const { root } = repo();
    const first = reading(T1);
    const later = reading(T2, { supersedes: first.id });
    const recordedFirst = await record(root, stage(root, 'first', first));
    const firstBytes = readFileSync(recordedFirst.path);
    const firstMtime = statSync(recordedFirst.path).mtimeMs;

    const recordedLater = await record(root, stage(root, 'later', later));
    expect(recordedLater.action).toBe('created');
    expect(recordedLater.path).toBe(join(root, storePath(later)));
    expect(readFileSync(recordedFirst.path).equals(firstBytes)).toBe(true);
    expect(statSync(recordedFirst.path).mtimeMs).toBe(firstMtime);
    expect(readdirSync(join(root, STORE, 'inventory_api')).sort()).toEqual(
      [`${first.id}.json`, `${later.id}.json`].sort(),
    );
    const persisted = JSON.parse(readFileSync(recordedLater.path, 'utf8')) as Json;
    expect(persisted['supersedes']).toBe(first.id);
  });

  it('selects the superseding instance by its link, never by timestamp or file order', () => {
    // Explicit instances isolate selection from the id builder.
    const instance = (id: string, timestamp: string, supersedes?: string): SensorReading =>
      ({
        ...reading(timestamp),
        id,
        ...(supersedes === undefined ? {} : { supersedes }),
      }) as SensorReading;
    const first = instance('SR-00000000000000a1', T1);
    const later = instance('SR-00000000000000a2', T2, first.id);
    for (const value of [first, later]) expect(validators.sensorReading(value)).toBe(true);
    expect(filterLatestPerKind([first, later]).map((value) => value.id)).toEqual([later.id]);
    expect(filterLatestPerKind([later, first]).map((value) => value.id)).toEqual([later.id]);

    // A superseding instance whose clock reads earlier still wins: the link decides.
    const skewed = instance('SR-00000000000000b2', T0, first.id);
    expect(filterLatestPerKind([first, skewed]).map((value) => value.id)).toEqual([skewed.id]);
    expect(filterLatestPerKind([skewed, first]).map((value) => value.id)).toEqual([skewed.id]);

    // A chain of three is followed to its end in any input order, whatever the clocks say.
    const third = instance('SR-00000000000000a3', T0, later.id);
    for (const order of [
      [first, later, third],
      [third, later, first],
      [later, third, first],
    ]) {
      expect(filterLatestPerKind(order).map((value) => value.id)).toEqual([third.id]);
    }
  });

  it('resolves the later instance from the store for the scorecard and keeps both files', async () => {
    const { root, head } = repo();
    const first = reading(T1);
    const later = reading(T0, { supersedes: first.id });
    await record(root, stage(root, 'first', first));
    await record(root, stage(root, 'later', later));

    const loaded = loadReadingsFromDir(join(root, STORE), { rejectInvalid: true });
    expect(loaded.map((value) => value.id)).toEqual([later.id]);

    const resolved = resolveScorecardInputs({
      repoRoot: root,
      inputs: undefined,
      timestamp: T3,
      integrationHead: head,
    });
    expect(resolved.source).toBe('disk');
    const [substrate, property] = cellOf('inventory_api').split(':');
    const cell = resolved.scorecard.cells.find(
      (entry) => entry.substrate === substrate && entry.property === property,
    );
    expect(cell?.sensor_readings).toContain(later.id);
    expect(cell?.sensor_readings ?? []).not.toContain(first.id);
    expect(existsSync(join(root, storePath(first)))).toBe(true);
  });
});

describe('ADR-SCR-0008 IA-002 the two ordered writes of a recording', () => {
  it('writes the reading file first, then appends one digest-bearing chain entry bound to the head', async () => {
    const { root, head } = repo();
    const first = reading(T1);
    observed.probe = (path) => entriesFor(root, relative(root, path)).length;

    const created = await record(root, stage(root, 'first', first));
    const path = storePath(first);
    expect(created.path).toBe(join(root, path));
    expect(observed.chainEntriesAtFileWrite.get(created.path)).toBe(0);

    const entries = entriesFor(root, path);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.status).toBe('completed');
    expect(entry?.context?.git?.head_sha).toBe(head);
    expect(entry?.artifacts).toContainEqual(
      expect.objectContaining({ path, sha256: digest(root, path) }),
    );
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });

    // A same-body re-record of an already chained file appends nothing.
    const before = readFileSync(join(root, CHAIN));
    expect((await record(root, stage(root, 'again', first))).action).toBe('already-recorded');
    expect(readFileSync(join(root, CHAIN)).equals(before)).toBe(true);
  });

  it('repairs a deleted chain entry by re-recording the same file, appending one entry and rewriting nothing', async () => {
    const { root, head } = repo();
    const other = buildSensorReading({
      ...BASE,
      sensorName: 'inventory:routes',
      sensorKind: 'inventory_routes',
      command: ['devai', 'sense', 'run', 'inventory_routes'],
      timestamp: T0,
    });
    const first = reading(T1);
    await record(root, stage(root, 'other', other));
    await record(root, stage(root, 'first', first));
    const path = storePath(first);
    expect(entriesFor(root, path)).toHaveLength(1);

    // Delete the reading's chain entry (the last one) and rewind the head, so the
    // remaining chain is valid and simply lacks the second write.
    const chain = loadChain(root);
    const kept = chain.records.filter(
      (entry) => !entry.artifacts?.some((artifact) => artifact.path === path),
    );
    expect(kept).toHaveLength(chain.records.length - 1);
    const rewound: Chain = { head: kept.at(-1)?.manifest_hash ?? null, records: kept };
    writeFileSync(join(root, CHAIN), `${JSON.stringify(rewound, null, 2)}\n`);
    expect(verifyChain(join(root, CHAIN)).valid).toBe(true);
    expect(entriesFor(root, path)).toHaveLength(0);

    const bytes = readFileSync(join(root, path));
    const mtime = statSync(join(root, path)).mtimeMs;
    observed.writes.length = 0;

    const repaired = await record(root, path);
    expect(repaired.action).toBe('already-recorded');
    expect(observed.writes).not.toContain(join(root, path));
    expect(readFileSync(join(root, path)).equals(bytes)).toBe(true);
    expect(statSync(join(root, path)).mtimeMs).toBe(mtime);

    const after = loadChain(root);
    expect(after.records).toHaveLength(kept.length + 1);
    expect(after.records.slice(0, kept.length)).toEqual(kept);
    const entries = entriesFor(root, path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context?.git?.head_sha).toBe(head);
    expect(entries[0]?.artifacts).toContainEqual(
      expect.objectContaining({ path, sha256: digest(root, path) }),
    );
    expect(verifyChain(join(root, CHAIN))).toEqual({ valid: true, errors: [] });

    // The repair is idempotent.
    const repairedChain = readFileSync(join(root, CHAIN));
    await record(root, path);
    expect(readFileSync(join(root, CHAIN)).equals(repairedChain)).toBe(true);
  });

  it('fails the digest check when the recorded file is edited after its chain entry', async () => {
    const { root } = repo();
    const first = reading(T1);
    const input = stage(root, 'first', first);
    await record(root, input);
    const path = storePath(first);
    expect(entriesFor(root, path)).toHaveLength(1);

    const edited = { ...first, metrics: { endpoints: 9 } };
    writeFileSync(join(root, path), `${JSON.stringify(edited, null, 2)}\n`);
    const chainBytes = readFileSync(join(root, CHAIN));

    // Re-recording the edited file is a finding, not a repair.
    await expect(record(root, path)).rejects.toThrow(
      new RegExp(`^SENSE_RECORD_CHAIN_DIGEST_MISMATCH:${first.id}`, 'u'),
    );
    // The original input now differs from the stored body under the same id.
    await expect(record(root, input)).rejects.toThrow(`SENSE_RECORD_ID_CONFLICT:${first.id}`);
    expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
    expect(entriesFor(root, path)).toHaveLength(1);
  });
});

describe('ADR-SCR-0008 IA-004 who may record, and under which row', () => {
  const ATTRIBUTED = {
    declaring_role: 'inspector',
    human_invocation: 'maintainer:R-0402',
  } as const;

  function policy(): Json & { permitted_checks: Json[] } {
    return JSON.parse(
      readFileSync(join(WORKSPACE, 'law/policy/self-dogfood.json'), 'utf8'),
    ) as Json & {
      permitted_checks: Json[];
    };
  }

  function request(overrides: Partial<SelfDogfoodRequest> = {}): SelfDogfoodRequest {
    return {
      human_invoked: true,
      role: 'inspector',
      action_id: 'sense record',
      check_id: 'sense record',
      effect: 'harness-write',
      write_consent: true,
      reading: ATTRIBUTED,
      ...overrides,
    };
  }

  function withRow(patch: (row: Json) => Json): Json {
    const current = policy();
    return {
      ...current,
      permitted_checks: current.permitted_checks.map((row) =>
        row['check_id'] === 'sense record' ? patch(row) : row,
      ),
    };
  }

  it('admits the inspector under the row that declares both harness-write paths', () => {
    expect(authorizeSelfDogfoodCheck(policy(), request())).toEqual({
      ok: true,
      check_id: 'sense record',
      role: 'inspector',
      effect: 'harness-write',
      harness_write_paths: [...CHAIN_PATHS],
      produces_readiness_claim: false,
      grants_publication_authority: false,
    });
  });

  it('refuses a sense record initiated by an engineer', () => {
    const decision = authorizeSelfDogfoodCheck(
      policy(),
      request({ role: 'engineer', reading: { ...ATTRIBUTED, declaring_role: 'engineer' } }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reasons).toContain('undeclared-action-id');
      expect(decision.reasons).toContain('effect-outside-role-row');
    }
  });

  it.each([
    ['omits the chain path', (row: Json) => ({ ...row, harness_write_paths: [CHAIN_PATHS[0]] })],
    [
      'omits the harness-write paths entirely',
      (row: Json) => {
        const { harness_write_paths: _paths, ...rest } = row;
        return rest;
      },
    ],
  ])('refuses a sense record under a row that %s', (_label, patch) => {
    expect(authorizeSelfDogfoodCheck(withRow(patch), request())).toEqual({
      ok: false,
      reasons: ['self-dogfood-policy-invalid'],
    });
  });

  it('refuses the command gate on a repository whose row omits the chain path', () => {
    const { root } = repo();
    put(
      root,
      'law/policy/self-dogfood.json',
      `${JSON.stringify(withRow((row) => ({ ...row, harness_write_paths: [CHAIN_PATHS[0]] })))}\n`,
    );
    const gate = gateSelfDogfoodCommand({
      repoRoot: root,
      action_id: 'sense record',
      declaration: {
        role: 'inspector',
        human_invoked: true,
        declaration_source: 'cli-flag',
        write_consent: true,
        publish: false,
      },
      reading: ATTRIBUTED,
    });
    expect(gate.applies).toBe(true);
    if (gate.applies) expect(gate.decision.ok).toBe(false);
  });
});
