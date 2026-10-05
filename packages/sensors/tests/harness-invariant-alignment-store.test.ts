// ADR-SCR-0008 IA-004 (sensor half): harness_invariant_alignment reads the canonical
// store `.devai/state/sensor-readings/<kind>/<id>.json` and accepts a recorded reading
// only when its `sense.readings.record` chain entry (the digest-bearing entry
// `sense record` appends after writing the file) carries the candidate head. A store
// reading whose binding is missing or names another head is ignored, so reading the
// store never weakens the candidate-binding requirement.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../src/harness-invariant-alignment.js';
import { buildSensorReading, type SensorReading } from '../src/sensor-reading.js';

const ACTION = 'check --only dependencies';
const NOW = '2026-10-01T12:00:00.000Z';
const RECORDED = '2026-10-01T11:00:00.000Z';
const CANDIDATE = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
const STORE = '.devai/state/sensor-readings';
const CHAIN = 'record/proofs/chain.json';

let root: string;

function put(path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-store-'));
  put(
    'law/invariants/INV-STORE-001.json',
    JSON.stringify({ id: 'INV-STORE-001', severity: 'gate', measurable_via: [ACTION] }),
  );
  put('.github/workflows/ci.yml', `jobs:\n  check:\n    steps:\n      - run: devai ${ACTION}\n`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A real SensorReading, persisted with the exact bytes `sense record` writes. */
function recordInStore(options: { readonly status?: 'pass' | 'fail' } = {}): {
  readonly reading: SensorReading;
  readonly path: string;
  readonly sha256: string;
} {
  const reading = buildSensorReading({
    sensorName: 'fixture:lint',
    sensorKind: 'lint',
    command: ['devai', ...ACTION.split(' ')],
    status: options.status ?? 'pass',
    deterministic: true,
    tier: 'L0',
    timestamp: RECORDED,
  });
  const path = `${STORE}/${reading.sensor.kind}/${reading.id}.json`;
  const bytes = `${JSON.stringify(reading, null, 2)}\n`;
  put(path, bytes);
  return { reading, path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The `sense.readings.record` chain entry naming the reading file and its digest. */
function chainEntry(path: string, sha256: string, headSha: string | null): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'EV-0123456789abcdef',
    timestamp: RECORDED,
    actor: 'devai-cli',
    actor_role: 'harness',
    action: 'sense.readings.record',
    status: 'completed',
    context: { repo_root: root, git: { head_sha: headSha, dirty_files: [] } },
    artifacts: [{ path, sha256 }],
    previous_run_hash: null,
    manifest_hash: 'e'.repeat(64),
  };
}

function writeChain(records: readonly Record<string, unknown>[]): void {
  put(
    CHAIN,
    `${JSON.stringify({ head: records.length > 0 ? 'e'.repeat(64) : null, records }, null, 2)}\n`,
  );
}

function sense() {
  return senseHarnessInvariantAlignment({ repoRoot: root, candidateHead: CANDIDATE, now: NOW });
}

function expectIgnored(result: ReturnType<typeof sense>): void {
  expect(result.status).toBe('review');
  expect(result.metrics).toMatchObject({ gate_invariants: 1, misaligned: 1, evidence_records: 1 });
  expect(result.findings?.map((finding) => finding.code)).toEqual([
    'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
  ]);
}

describe('ADR-SCR-0008 IA-004 store readings and candidate binding', () => {
  it('accepts a canonical-store reading whose chain entry carries the candidate head', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, CANDIDATE)]);

    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
      evidence_records: 1,
    });
    expect(result.findings).toEqual([]);
  });

  it('reads the store at its default location without an evidence directory override', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, CANDIDATE)]);
    // The canonical store path is the only place the reading exists.
    expect(readFileSync(join(root, path), 'utf8')).toContain('"kind": "lint"');
    expect(
      senseHarnessInvariantAlignment({
        repoRoot: root,
        candidateHead: CANDIDATE,
        now: NOW,
        evidenceDir: 'elsewhere',
      }).status,
    ).toBe('review');
    expect(sense().status).toBe('pass');
  });

  it('ignores a store reading with no chain entry at all', () => {
    recordInStore();
    expectIgnored(sense());
  });

  it('ignores a store reading whose chain is empty after the entry was lost', () => {
    recordInStore();
    writeChain([]);
    expectIgnored(sense());
  });

  it('ignores a store reading whose chain entry names another head', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, OTHER_HEAD)]);
    expectIgnored(sense());
  });

  it('ignores a store reading whose chain entry carries no head', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, null)]);
    expectIgnored(sense());
  });

  it('ignores a store reading when the bound chain entry names a different reading file', () => {
    const { reading, sha256 } = recordInStore();
    writeChain([
      chainEntry(`${STORE}/lint/SR-${'0'.repeat(16)}.json`, sha256, CANDIDATE),
      chainEntry(`${STORE}/type_check/${reading.id}.json`, sha256, CANDIDATE),
    ]);
    expectIgnored(sense());
  });

  it('never promotes a bound store reading that did not pass', () => {
    const { path, sha256 } = recordInStore({ status: 'fail' });
    writeChain([chainEntry(path, sha256, CANDIDATE)]);
    expectIgnored(sense());
  });
});

// ADR-SCR-0013: reading ids are content-derived, so a reading with the same content
// lands on the same store path at every candidate and the append-only chain keeps
// each earlier receipt for it. The receipt whose digest names the current bytes binds.
describe('ADR-SCR-0013 receipts for a store path recorded at several candidates', () => {
  it('binds the receipt whose digest names the current bytes, not the first for the path', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, 'a'.repeat(64), OTHER_HEAD), chainEntry(path, sha256, CANDIDATE)]);
    expect(sense()).toMatchObject({ status: 'pass', metrics: { misaligned: 0 } });
  });

  it('binds every candidate that recorded the same bytes, in either order', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, CANDIDATE), chainEntry(path, sha256, OTHER_HEAD)]);
    expect(sense()).toMatchObject({ status: 'pass', metrics: { evidence_records: 2 } });
  });

  it('ignores a candidate receipt whose digest names other bytes', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, OTHER_HEAD), chainEntry(path, 'a'.repeat(64), CANDIDATE)]);
    expect(sense()).toMatchObject({ status: 'review', metrics: { misaligned: 1 } });
  });

  it('ignores a reading edited after its candidate receipt was appended', () => {
    const { path, sha256 } = recordInStore();
    writeChain([chainEntry(path, sha256, CANDIDATE)]);
    put(path, `${readFileSync(join(root, path), 'utf8')} `);
    expectIgnored(sense());
  });

  it('keeps the first-receipt rule for receipts that carry no digest', () => {
    const { path } = recordInStore();
    const legacy = (headSha: string): Record<string, unknown> => ({
      ...chainEntry(path, '', headSha),
      artifacts: [{ path }],
    });
    writeChain([legacy(CANDIDATE), legacy(OTHER_HEAD)]);
    expect(sense().status).toBe('pass');
    writeChain([legacy(OTHER_HEAD), legacy(CANDIDATE)]);
    expectIgnored(sense());
  });
});
