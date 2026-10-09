// ADR-SCR-0008 IA-003 and IA-006: the sweep runs in two ordered passes declared by
// `law/policy/sense-presets.json` (`selection_effect_rule.sweep_second_pass`), the
// protocol is first pass, record, second pass, record, and on a fresh worktree the
// store-reading cells F4:T7 and F5:T4 read PASS or FAIL from the substrate. The
// inventory cells F4:T4 and F4:T9 are measured, never ledger N/A.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { resolveScorecardInputs } from '@devai-nyx/loop';
import {
  buildSensorReading,
  senseInventoryAdherence,
  type SensorReading,
} from '@devai-nyx/sensors';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { resolveSenseSelection } from '../../src/commands/sense/facade.js';
import { recordSensorReading } from '../../src/commands/sense/record.js';
import {
  executeResolvedSenseSelection,
  resolveSensePasses,
  senseRunSetCmd,
} from '../../src/commands/sense/run-set.js';

type Json = Record<string, unknown>;

/**
 * The first pass is a fixture: every first-pass member returns a deterministic
 * reading without touching the host. The two store-reading members run their real
 * adapters, so they measure exactly what was recorded.
 */
vi.mock('../../src/commands/sense/adapters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/sense/adapters.js')>();
  const sensors = await import('@devai-nyx/sensors');
  const storeReaders = new Set(['harness_invariant_alignment', 'inventory_performance']);
  return {
    ...actual,
    sensorAdapter: (kind: Parameters<typeof actual.sensorAdapter>[0]) =>
      storeReaders.has(kind)
        ? actual.sensorAdapter(kind)
        : () =>
            sensors.buildSensorReading({
              sensorName: `fixture:${kind}`,
              sensorKind: kind,
              // The lint fixture runs the measured action of the fixture's gate invariant.
              command:
                kind === 'lint'
                  ? ['devai', 'check', '--only', 'dependencies']
                  : ['devai', 'sense', 'run', kind],
              status: 'pass',
              deterministic: true,
              tier: 'L0',
              ...(kind.startsWith('inventory_') ? { duration_ms: 150 } : {}),
            }),
  };
});

const WORKSPACE = resolve(import.meta.dirname, '../../../..');
const ROUND = 'R-0402';
const SECOND_PASS = ['harness_invariant_alignment', 'inventory_performance'] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function workspaceJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(WORKSPACE, path), 'utf8')) as T;
}

interface PresetPolicy {
  readonly selection_effect_rule: Readonly<Record<string, string>>;
  readonly presets: readonly { readonly name: string; readonly members: readonly string[] }[];
}
interface Registry {
  readonly entries: readonly {
    readonly kind: string;
    readonly effect: string;
    readonly cells: readonly { readonly substrate: string; readonly property: string }[];
  }[];
}

function sweepMembers(): readonly string[] {
  const sweep = workspaceJson<PresetPolicy>('law/policy/sense-presets.json').presets.find(
    (preset) => preset.name === 'sweep',
  );
  if (sweep === undefined) throw new Error('sweep preset missing');
  return sweep.members;
}

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

function tempDir(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/**
 * A repository with one gate invariant measured by a fail-closed CI step, and a
 * fresh linked worktree of it. The readings store is ignored and therefore empty
 * in the new worktree, which is the state IA-003 starts from.
 */
function freshWorktree(): { readonly worktree: string; readonly head: string } {
  const origin = tempDir('devai-two-pass-origin-');
  git(origin, ['init', '-q', '-b', 'main']);
  put(origin, '.gitignore', '.devai/state/\n');
  put(
    origin,
    'law/invariants/INV-FIX-001.json',
    `${JSON.stringify({
      id: 'INV-FIX-001',
      severity: 'gate',
      measurable_via: ['check --only dependencies'],
    })}\n`,
  );
  put(
    origin,
    '.github/workflows/ci.yml',
    'jobs:\n  check:\n    steps:\n      - run: devai check --only dependencies\n',
  );
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'fixture']);
  const worktree = join(tempDir('devai-two-pass-worktree-'), 'checkout');
  git(origin, ['worktree', 'add', '-q', '-b', 'fresh', worktree]);
  return { worktree: realpathSync(worktree), head: git(worktree, ['rev-parse', 'HEAD']) };
}

function readings(results: readonly { readonly stdout: string }[]): SensorReading[] {
  return results.map((result) => JSON.parse(result.stdout) as SensorReading);
}

/** The inspector's harness-write step: `sense record` on every reading of a pass. */
async function recordAll(worktree: string, values: readonly SensorReading[]): Promise<void> {
  const inputs = tempDir('devai-two-pass-inputs-');
  for (const value of values) {
    const input = put(inputs, `${value.sensor.kind}.json`, JSON.stringify(value));
    await withAuthorityHostTestScope(() => recordSensorReading(worktree, input));
  }
}

describe('ADR-SCR-0008 the declared second pass', () => {
  it('declares the store readers in execution order as read-effect sweep members', () => {
    const rule = workspaceJson<PresetPolicy>('law/policy/sense-presets.json').selection_effect_rule;
    expect(rule['sweep_second_pass']?.split(',')).toEqual([...SECOND_PASS]);
    const registry = workspaceJson<Registry>('law/policy/sensor-registry.json');
    for (const kind of SECOND_PASS) {
      expect(sweepMembers()).toContain(kind);
      expect(registry.entries.find((entry) => entry.kind === kind)?.effect).toBe('read');
    }
  });

  it('keeps the inventory body producers and consumers read-only and the body writer outside the sweep (#382)', () => {
    const registry = workspaceJson<Registry>('law/policy/sensor-registry.json');
    const effectOf = (kind: string) =>
      registry.entries.find((entry) => entry.kind === kind)?.effect;
    const { first } = resolveSensePasses(
      resolveSenseSelection({ preset: 'sweep' }, { roundId: ROUND }),
    );
    for (const kind of [
      'inventory_api',
      'inventory_routes',
      'inventory_data_model',
      'inventory_rbac',
      'inventory_data_handling',
      'inventory_coverage',
      'plant_coverage',
      'inventory_adherence',
    ]) {
      expect(sweepMembers(), kind).toContain(kind);
      expect(effectOf(kind), kind).toBe('read');
      expect(first.executed, kind).toContain(kind);
    }
    // The one governed writer of the bodies runs before the sweep, never inside it.
    expect(effectOf('inventory_regeneration')).toBe('harness-write');
    expect(sweepMembers()).not.toContain('inventory_regeneration');
    expect(first.aggregate_effect).toBe('read');
    expect(first.implicit_persistence).toBe(false);
  });

  it('splits the sweep into a first pass without the store readers and an ordered second pass', () => {
    const resolved = resolveSenseSelection({ preset: 'sweep' }, { roundId: ROUND });
    const { first, second } = resolveSensePasses(resolved);
    const expectedFirst = sweepMembers().filter(
      (kind) => !(SECOND_PASS as readonly string[]).includes(kind),
    );

    expect(first.pass).toBe('first');
    expect(first.executed).toEqual(expectedFirst);
    expect(first.members.map((member) => member.kind)).toEqual(expectedFirst);
    expect(second.pass).toBe('second');
    expect(second.executed).toEqual([...SECOND_PASS]);
    expect(second.members.map((member) => member.kind)).toEqual([...SECOND_PASS]);
    for (const pass of [first, second]) {
      expect(pass.selection).toEqual({ type: 'preset', value: 'sweep' });
      expect(pass.excluded).toEqual(resolved.excluded);
      expect(pass.aggregate_effect).toBe('read');
      expect(pass.implicit_persistence).toBe(false);
    }
    // Together the passes execute the whole sweep, each member exactly once.
    expect([...first.executed, ...second.executed].sort()).toEqual([...sweepMembers()].sort());
  });

  describe('sense run --preset sweep', () => {
    let invoke: (kind: string | undefined, options: Json) => Promise<void>;

    beforeAll(() => {
      const command = {
        option: () => command,
        action(callback: typeof invoke) {
          invoke = callback;
          return command;
        },
      };
      senseRunSetCmd.register({ command: () => command } as unknown as CAC);
    });

    async function dryRun(options: Json): Promise<Json> {
      let stdout = '';
      const write = process.stdout.write;
      const exitCode = process.exitCode;
      process.stdout.write = ((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      try {
        await invoke(undefined, { preset: 'sweep', round: ROUND, dryRun: true, ...options });
      } finally {
        process.stdout.write = write;
        process.exitCode = exitCode;
      }
      return JSON.parse(stdout) as Json;
    }

    it('runs the first pass by default and the second pass only when asked', async () => {
      const { worktree } = freshWorktree();
      const first = await dryRun({ repoRoot: worktree });
      expect(first['pass']).toBe('first');
      for (const kind of SECOND_PASS) expect(first['executed']).not.toContain(kind);

      const second = await dryRun({ repoRoot: worktree, pass: 'second' });
      expect(second['pass']).toBe('second');
      expect(second['executed']).toEqual([...SECOND_PASS]);
    });
  });
});

describe('ADR-SCR-0008 IA-003 the ordered protocol on a fresh worktree', () => {
  it('records the first pass before the store readers run, so F4:T7 and F5:T4 measure the substrate', async () => {
    const { worktree, head } = freshWorktree();
    const { first, second } = resolveSensePasses(
      resolveSenseSelection({ preset: 'sweep' }, { roundId: ROUND }),
    );

    // First pass: the store readers are not among its results.
    const firstResults = await withAuthorityHostTestScope(() =>
      executeResolvedSenseSelection(first, { repoRoot: worktree }),
    );
    const firstReadings = readings(firstResults);
    expect(firstReadings.map((value) => value.sensor.kind)).toEqual(first.executed);
    for (const kind of SECOND_PASS) {
      expect(firstReadings.map((value) => value.sensor.kind)).not.toContain(kind);
    }

    // Record, then run the second pass against the recorded store.
    await recordAll(worktree, firstReadings);
    const secondResults = await withAuthorityHostTestScope(() =>
      executeResolvedSenseSelection(second, { repoRoot: worktree }),
    );
    const secondReadings = readings(secondResults);
    expect(secondReadings.map((value) => value.sensor.kind)).toEqual([...SECOND_PASS]);

    const performance = secondReadings.find(
      (value) => value.sensor.kind === 'inventory_performance',
    );
    const inventoryKinds = first.executed.filter((kind) => kind.startsWith('inventory_'));
    expect(performance?.status).toBe('pass');
    expect(performance?.metrics?.['total_observations']).toBe(inventoryKinds.length);
    expect(performance?.findings?.map((finding) => finding.code) ?? []).not.toContain(
      'INVENTORY_PERFORMANCE_NO_READINGS',
    );

    const alignment = secondReadings.find(
      (value) => value.sensor.kind === 'harness_invariant_alignment',
    );
    expect(alignment?.status).toBe('pass');
    expect(alignment?.metrics).toMatchObject({ gate_invariants: 1, misaligned: 0 });

    // Record the second pass; the scorecard reads both cells from the substrate.
    await recordAll(worktree, secondReadings);
    const { scorecard } = resolveScorecardInputs({
      repoRoot: worktree,
      inputs: undefined,
      timestamp: new Date().toISOString(),
      integrationHead: head,
    });
    const verdict = (substrate: string, property: string) =>
      scorecard.cells.find((cell) => cell.substrate === substrate && cell.property === property)
        ?.verdict;
    for (const [substrate, property] of [
      ['F4', 'T7'],
      ['F5', 'T4'],
    ] as const) {
      expect(['PASS', 'FAIL']).toContain(verdict(substrate, property));
    }
    expect(verdict('F4', 'T7')).toBe('PASS');
    expect(verdict('F5', 'T4')).toBe('PASS');
  });
});

describe('ADR-SCR-0008 IA-006 the measured inventory cells', () => {
  interface Ledger {
    readonly cells: readonly { readonly cell: string }[];
  }

  it('binds inventory_adherence to F4:T4 and inventory_regeneration to F4:T9 with no ledger N/A for either', () => {
    const registry = workspaceJson<Registry>('law/policy/sensor-registry.json');
    const cellsOf = (kind: string) =>
      registry.entries
        .find((entry) => entry.kind === kind)
        ?.cells.map((cell) => `${cell.substrate}:${cell.property}`);
    expect(cellsOf('inventory_adherence')).toEqual(['F4:T4']);
    expect(cellsOf('inventory_regeneration')).toEqual(['F4:T9']);
    for (const path of ['law/policy/scorecard-na.json', '.devai/config/scorecard-na.json']) {
      const declared = workspaceJson<Ledger>(path).cells.map((entry) => entry.cell);
      expect(declared).not.toContain('F4:T4');
      expect(declared).not.toContain('F4:T9');
    }
  });

  it.each(['inventory_dep_graph', 'inventory_coverage'])(
    'rejects a ledger N/A for F4:T9 while %s readings exist',
    (kind) => {
      const root = tempDir('devai-two-pass-ledger-');
      put(
        root,
        '.devai/config/scorecard-na.json',
        `${JSON.stringify({
          schemaVersion: '1.0.0',
          cells: [{ cell: 'F4:T9', reason: 'Fixture ledger entry for a measured cell.' }],
        })}\n`,
      );
      const value = buildSensorReading({
        sensorName: `fixture:${kind}`,
        sensorKind: kind as 'inventory_dep_graph',
        command: ['devai', 'sense', 'run', kind],
        status: 'pass',
        deterministic: true,
        timestamp: '2026-10-01T09:00:00.000Z',
      });
      const resolveWith = () =>
        resolveScorecardInputs({
          repoRoot: root,
          inputs: undefined,
          timestamp: '2026-10-01T10:00:00.000Z',
        });
      // Without the measured kind the ledger entry is admissible.
      expect(() => resolveWith()).not.toThrow();
      put(
        root,
        `.devai/state/sensor-readings/${kind}/${value.id}.json`,
        `${JSON.stringify(value, null, 2)}\n`,
      );
      expect(() => resolveWith()).toThrow(/^SCORECARD_NA_MEASURED_CELL:F4:T9/u);
    },
  );

  it('reads F4:T4 N/A only when every surface inventory_adherence measures is declared absent', () => {
    const report = { counts: { total: 4, claimed: 4, orphan: 0 } };
    const absent = { http: false, database: false, rbac: false, actions: false };
    const options = (surfaces: typeof absent) =>
      ({ report, surfaces }) as Parameters<typeof senseInventoryAdherence>[0];

    expect(senseInventoryAdherence(options(absent)).status).toBe('skipped');
    for (const surface of ['http', 'database', 'rbac', 'actions'] as const) {
      expect(senseInventoryAdherence(options({ ...absent, [surface]: true })).status).toBe('pass');
    }
    // The framework declares the action surface present, so its F4:T4 is measured.
    const declared = workspaceJson<{ readonly surfaces: typeof absent }>(
      '.devai/config/sensor-inputs.json',
    ).surfaces;
    expect(declared.actions).toBe(true);
    expect(senseInventoryAdherence(options(declared)).status).toBe('pass');
  });
});
