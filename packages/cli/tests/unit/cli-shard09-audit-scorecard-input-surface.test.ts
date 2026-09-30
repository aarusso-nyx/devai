import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Scorecard } from '@devai-nyx/loop';
import type { SensorReading } from '@devai-nyx/sensors';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { EXIT_PASS, EXIT_USAGE } from '../../../utils/src/exit.js';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

// Git is the only host process the facade spawns (exact-head guard and commit
// timestamp); everything else — the loop resolver, the readings store, the N/A
// ledger, the schema validator, and `sense record` persistence — runs for real.
vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return { ...actual, spawnSync: mocks.spawnSync };
});

import { auditScorecard } from '../../src/commands/audit/scorecard.js';
import { recordSensorReading } from '../../src/commands/sense/record.js';

interface CapturedRegistration {
  readonly action: (options: { repoRoot?: string; at?: string; human?: boolean }) => void;
  readonly command: readonly unknown[];
  readonly options: readonly (readonly unknown[])[];
}

function captureRegistration(): CapturedRegistration {
  let action: CapturedRegistration['action'] | undefined;
  const options: unknown[][] = [];
  const chain = {
    option: (...args: unknown[]) => {
      options.push(args);
      return chain;
    },
    action: (value: CapturedRegistration['action']) => {
      action = value;
      return chain;
    },
  };
  const command = vi.fn(() => chain);
  auditScorecard.register({ command } as unknown as CAC);
  expect(action).toBeTypeOf('function');
  if (action === undefined) throw new Error('audit scorecard action missing');
  return { action, command: command.mock.calls[0] ?? [], options };
}

const AT = 'a'.repeat(40);
const TIMESTAMP = '2026-09-26T12:00:00+00:00';
const RECORDED_ID = 'SR-0123456789abcdef';
const RETIRED_STORE_ID = 'SR-fedcba9876543210';

function answerGit(head: string = AT): void {
  mocks.spawnSync.mockImplementation((_command: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: `${TIMESTAMP}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected git ${String(args[0])}` };
  });
}

function reading(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `sense:${kind}`, kind, version: '1.0.0' },
    timestamp: '2026-09-26T11:00:00.000Z',
    status,
    deterministic: true,
    command: `devai sense run ${kind}`,
    command_hash: 'a'.repeat(64),
    tier: 'L0',
  };
}

function put(root: string, relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function cell(scorecard: Scorecard, substrate: string, property: string) {
  const found = scorecard.cells.find((c) => c.substrate === substrate && c.property === property);
  if (found === undefined) throw new Error(`cell ${substrate}:${property} missing`);
  return found;
}

function naCells(scorecard: Scorecard): string[] {
  return scorecard.cells
    .filter((c) => c.verdict === 'N/A')
    .map((c) => `${c.substrate}:${c.property}`)
    .sort();
}

const roots: string[] = [];
let stdout = '';
let stderr = '';
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-shard09-audit-scorecard-'));
  roots.push(root);
  return root;
}

function runScorecard(root: string): Scorecard {
  answerGit();
  captureRegistration().action({ repoRoot: root, at: AT });
  expect(stderr).toBe('');
  expect(process.exitCode).toBe(EXIT_PASS);
  return JSON.parse(stdout) as Scorecard;
}

describe('CLI shard 09 audit scorecard input surface', () => {
  it('documents the command and every registered option with a non-empty description', () => {
    const registration = captureRegistration();

    expect(auditScorecard.description.trim()).not.toBe('');
    expect(registration.command).toHaveLength(2);
    expect(registration.command[0]).toBe('audit-scorecard');
    expect(String(registration.command[1]).trim()).not.toBe('');
    expect(registration.options.map(([flags]) => flags)).toEqual([
      '--repo-root <path>',
      '--at <full-sha>',
      '--human',
    ]);
    expect(registration.options.every(([, description]) => String(description).trim() !== '')).toBe(
      true,
    );
  });

  it('refuses malformed exact commit input before invoking Git', () => {
    for (const at of [`x${'a'.repeat(40)}`, `${'a'.repeat(40)}x`, 'A'.repeat(40)]) {
      const { action } = captureRegistration();
      process.exitCode = undefined;
      stdout = '';
      stderr = '';
      mocks.spawnSync.mockClear();

      action({ repoRoot: '/fixture/repository', at });

      expect(process.exitCode).toBe(EXIT_USAGE);
      expect(stdout).toBe('');
      expect(stderr).toBe('devai audit scorecard: --at requires a full 40-character SHA\n');
      expect(mocks.spawnSync).not.toHaveBeenCalled();
    }
  });
});

describe('CLI shard 09 audit scorecard reads the one readings store (ADR-SCR-0002)', () => {
  it('sees a reading persisted through sense record at the same head without a copy or rebuild step', async () => {
    const root = makeRoot();
    const recorded = reading('inventory_api', 'pass', RECORDED_ID);
    put(root, 'reading.json', JSON.stringify(recorded));

    const persisted = await withAuthorityHostTestScope(() =>
      recordSensorReading(root, 'reading.json'),
    );
    expect(persisted.action).toBe('created');
    expect(persisted.path).toBe(
      join(root, '.devai/state/sensor-readings/inventory_api', `${RECORDED_ID}.json`),
    );

    // A contradicting reading in the retired store must never reach the facade:
    // inventory_routes maps to the same F4:T1 presence cell and would flip it to FAIL.
    put(
      root,
      `record/proofs/freshness/readings/inventory_routes/${RETIRED_STORE_ID}.json`,
      JSON.stringify(reading('inventory_routes', 'fail', RETIRED_STORE_ID)),
    );

    const scorecard = runScorecard(root);

    expect(scorecard.integration_head).toBe(AT);
    expect(scorecard.generated_at).toBe(TIMESTAMP);
    expect(scorecard.cells).toHaveLength(45);
    const presence = cell(scorecard, 'F4', 'T1');
    expect(presence.verdict).toBe('PASS');
    expect(presence.sensor_readings).toEqual([RECORDED_ID]);
    expect(scorecard.cells.flatMap((c) => c.sensor_readings ?? []).includes(RETIRED_STORE_ID)).toBe(
      false,
    );
    expect(mocks.spawnSync.mock.calls.map(([, args]) => (args as readonly string[])[0])).toEqual([
      'rev-parse',
      'show',
    ]);
  });

  it('takes N/A cells from the materialized ledger alone: none without it, exactly its entries with it', () => {
    const root = makeRoot();

    expect(naCells(runScorecard(root))).toEqual([]);

    process.exitCode = undefined;
    stdout = '';
    put(
      root,
      '.devai/config/scorecard-na.json',
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          cells: [
            { cell: 'F1:T1', reason: 'No contract-validation emitter on this repository.' },
            { cell: 'F4:T5', reason: 'Inventory is derived, never authored (Article 5).' },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const scorecard = runScorecard(root);
    expect(naCells(scorecard)).toEqual(['F1:T1', 'F4:T5']);
    expect(scorecard.cells.filter((c) => c.verdict !== 'N/A')).toHaveLength(43);
  });
});

const STORE = '.devai/state/sensor-readings';
const OLDER_ID = 'SR-00000000000000a1';
const NEWER_ID = 'SR-00000000000000b2';
const DIAGNOSTIC_KINDS = [
  'decision_record_integrity',
  'decision_citation_resolution',
  'archive_immutability',
  'round_record_integrity',
] as const;

function stored(
  kind: SensorReading['sensor']['kind'],
  status: SensorReading['status'],
  id: string,
  timestamp: string,
): SensorReading {
  return { ...reading(kind, status, id), timestamp };
}

function putReading(root: string, value: SensorReading | Record<string, unknown>): void {
  const kind = (value as SensorReading).sensor.kind;
  const id = (value as SensorReading).id;
  put(root, `${STORE}/${kind}/${id}.json`, `${JSON.stringify(value)}\n`);
}

function runRaw(root: string, at: string = AT): void {
  answerGit();
  process.exitCode = undefined;
  stdout = '';
  stderr = '';
  captureRegistration().action({ repoRoot: root, at });
}

function emittedScorecard(): Scorecard | undefined {
  return stdout === '' ? undefined : (JSON.parse(stdout) as Scorecard);
}

describe('CLI shard 09 audit scorecard resolver seam (ADR-REL-0033)', () => {
  it('reads UNKNOWN for a cell whose readings store is empty', () => {
    const root = makeRoot();
    mkdirSync(join(root, STORE), { recursive: true });

    const presence = cell(runScorecard(root), 'F4', 'T1');
    expect(presence.verdict).toBe('UNKNOWN');
    expect(presence.sensor_readings ?? []).toEqual([]);
  });

  it('refuses an --at that is a full SHA but not the exact HEAD', () => {
    const root = makeRoot();
    answerGit('b'.repeat(40));
    captureRegistration().action({ repoRoot: root, at: AT });

    expect(process.exitCode).not.toBe(EXIT_PASS);
    expect(stdout).toBe('');
    expect(stderr).toContain('AUDIT_SCORECARD_EXACT_HEAD_REQUIRED');
  });

  it('selects the later of two readings of one kind, identically on two runs', () => {
    const root = makeRoot();
    putReading(root, stored('inventory_api', 'pass', NEWER_ID, '2026-09-26T11:30:00.000Z'));
    putReading(root, stored('inventory_api', 'fail', OLDER_ID, '2026-09-26T10:00:00.000Z'));

    const first = runScorecard(root);
    const firstBytes = stdout;
    process.exitCode = undefined;
    stdout = '';
    const second = runScorecard(root);

    expect(stdout).toBe(firstBytes);
    for (const scorecard of [first, second]) {
      const presence = cell(scorecard, 'F4', 'T1');
      expect(presence.verdict).toBe('PASS');
      expect(presence.sensor_readings).toEqual([NEWER_ID]);
    }
  });

  it('reads a failure older than the stale window as stale and never PASS', () => {
    const root = makeRoot();
    put(
      root,
      '.devai/config/thresholds.json',
      `${JSON.stringify({ freshness: { scorecard_failure_max_age_hours: 168 } })}\n`,
    );
    putReading(root, stored('inventory_api', 'fail', OLDER_ID, '2026-09-01T00:00:00.000Z'));

    const presence = cell(runScorecard(root), 'F4', 'T1');
    expect(presence.verdict).not.toBe('PASS');
    expect(presence.verdict).toBe('REVIEW');
    expect(presence.notes).toContain('REVIEW-stale');
  });

  it('moves no cell verdict when the four admitted diagnostic kinds are in the store', () => {
    const root = makeRoot();
    putReading(root, stored('inventory_api', 'pass', NEWER_ID, '2026-09-26T11:30:00.000Z'));
    const baseline = runScorecard(root).cells.map((c) => [c.substrate, c.property, c.verdict]);

    DIAGNOSTIC_KINDS.forEach((kind, index) => {
      putReading(root, stored(kind, 'fail', `SR-${String(index).padStart(16, 'c')}`, TIMESTAMP));
    });
    process.exitCode = undefined;
    stdout = '';
    const withDiagnostics = runScorecard(root);

    expect(withDiagnostics.cells.map((c) => [c.substrate, c.property, c.verdict])).toEqual(
      baseline,
    );
  });

  it('rejects a file of invalid JSON in the store with SCORECARD_READING_UNPARSEABLE', () => {
    const root = makeRoot();
    put(root, `${STORE}/inventory_api/${OLDER_ID}.json`, '{not json\n');

    runRaw(root);

    expect(`${stdout}${stderr}`).toMatch(/SCORECARD_READING_UNPARSEABLE:\S+/u);
    expect(`${stdout}${stderr}`).toContain(`${OLDER_ID}.json`);
    const scorecard = emittedScorecard();
    if (scorecard !== undefined) expect(cell(scorecard, 'F4', 'T1').verdict).not.toBe('PASS');
  });

  it('rejects a schema-invalid SensorReading with SCORECARD_READING_INVALID and never counts it PASS', () => {
    const root = makeRoot();
    const invalid: Record<string, unknown> = {
      ...stored('inventory_api', 'pass', NEWER_ID, '2026-09-26T11:30:00.000Z'),
    };
    delete invalid['command_hash'];
    putReading(root, invalid);

    runRaw(root);

    expect(`${stdout}${stderr}`).toMatch(/SCORECARD_READING_INVALID:\S+/u);
    expect(`${stdout}${stderr}`).toContain(`${NEWER_ID}.json`);
    const scorecard = emittedScorecard();
    if (scorecard !== undefined) expect(cell(scorecard, 'F4', 'T1').verdict).not.toBe('PASS');
  });
});
