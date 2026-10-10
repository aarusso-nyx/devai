// Invariants: INV-DEVAI-001, INV-DEVAI-002, INV-DEVAI-020; ADR-SCR-0015 IA-003.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSensorReading } from '@devai-nyx/sensors';
import { verifyChain, type EvidenceChain } from '@devai-nyx/evidence';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveScorecardInputs } from '../../src/scorecard/inputs.js';
import { recordBoundScorecardReading } from '../helpers/scorecard-custody-fixture.js';

const roots: string[] = [];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = '2026-10-10T12:00:00.000Z';
const CHAIN = 'record/proofs/chain.json';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-scorecard-custody-'));
  roots.push(root);
  return root;
}
function reading(timestamp = NOW) {
  return buildSensorReading({
    sensorName: 'inventory:api',
    sensorKind: 'inventory_api',
    command: ['fixture'],
    deterministic: true,
    status: 'pass',
    timestamp,
    metrics: { endpoints: 1 },
  });
}
function score(root: string, head = A) {
  return resolveScorecardInputs({
    repoRoot: root,
    inputs: undefined,
    timestamp: NOW,
    integrationHead: head,
  });
}

describe('candidate-bound disk scorecard population', () => {
  it.each(['chain-candidate', 'artifact-bytes'] as const)(
    'refuses tampered %s without modifying evidence',
    (defect) => {
      const root = fixture();
      const first = reading();
      const target = recordBoundScorecardReading(root, first, A);
      if (defect === 'artifact-bytes')
        writeFileSync(target, JSON.stringify({ ...first, metrics: { endpoints: 999 } }));
      else {
        const chain = JSON.parse(readFileSync(join(root, CHAIN), 'utf8')) as EvidenceChain;
        const forgedRecord = chain.records[0];
        if (forgedRecord === undefined) throw new Error('Fixture chain missing');
        forgedRecord.context.git.head_sha = B;
        writeFileSync(join(root, CHAIN), JSON.stringify(chain));
        expect(verifyChain(join(root, CHAIN)).valid).toBe(false);
      }
      const chainBytes = readFileSync(join(root, CHAIN));
      const readingBytes = readFileSync(target);
      expect(() => score(root, defect === 'chain-candidate' ? B : A)).toThrow();
      expect(readFileSync(join(root, CHAIN)).equals(chainBytes)).toBe(true);
      expect(readFileSync(target).equals(readingBytes)).toBe(true);
    },
  );

  it('refuses a cross-candidate supersession edge with valid chain hashes', () => {
    const root = fixture();
    const first = reading();
    recordBoundScorecardReading(root, first, A);
    recordBoundScorecardReading(
      root,
      { ...reading('2026-10-10T13:00:00.000Z'), id: 'SR-2222222222222222', supersedes: first.id },
      B,
    );
    expect(verifyChain(join(root, CHAIN)).valid).toBe(true);
    expect(() => score(root, B)).toThrow();
    expect(score(root, A).readings).toEqual([first]);
  });

  it('refuses two same-candidate heads instead of selecting their newest timestamp', () => {
    const root = fixture();
    recordBoundScorecardReading(root, reading(), A);
    recordBoundScorecardReading(
      root,
      { ...reading('2026-10-10T13:00:00.000Z'), id: 'SR-3333333333333333' },
      A,
    );
    expect(() => score(root, A)).toThrow();
  });
});
