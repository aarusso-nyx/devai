import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const ACTION = 'check --only dependencies';
const CANDIDATE = 'a'.repeat(40);
const NOW = '2026-09-08T12:00:00.000Z';
const RECENT = '2026-09-08T11:00:00.000Z';
let root: string;

function write(relativePath: string, content: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(relativePath: string, value: unknown): void {
  write(relativePath, JSON.stringify(value));
}

function writeBase(): void {
  writeJson('law/invariants/INV-TEST-001.json', {
    id: 'INV-TEST-001',
    severity: 'gate',
    measurable_via: [ACTION],
  });
  write('.github/workflows/ci.yml', `jobs:\n  check:\n    steps:\n      - run: devai ${ACTION}\n`);
}

function sense(options: Partial<Parameters<typeof senseHarnessInvariantAlignment>[0]> = {}) {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: CANDIDATE,
    now: NOW,
    evidenceDir: 'evidence',
    ...options,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave9-alignment-receipt-'));
  writeBase();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness alignment receipt and freshness boundaries', () => {
  it('uses the record timestamp when a matching test receipt has no timestamp', () => {
    writeJson('record/proofs/work/test-results/run-1.json', {
      id: 'tr-0001',
      env: { commit: CANDIDATE },
      command: `devai ${ACTION}`,
      status: 'pass',
      timestamp: RECENT,
    });
    writeJson('record/proofs/chain.json', {
      records: [
        {
          actor: 'devai-record-run',
          action: 'test-run.record',
          status: 'completed',
          context: { git: { head_sha: CANDIDATE } },
          notes: ['test-result id: tr-0001; suite: local'],
        },
      ],
    });

    expect(sense({ evidenceDir: undefined })).toMatchObject({
      status: 'pass',
      metrics: { evidence_records: 1, misaligned: 0 },
      findings: [],
    });
  });

  it('refuses a sensor receipt that names the artifact without a git context', () => {
    writeJson('record/proofs/sensor-readings/2026/dependency.json', {
      command: `devai ${ACTION}`,
      status: 'pass',
    });
    writeJson('record/proofs/chain.json', {
      records: [
        {
          actor: 'devai-sense',
          action: 'sense.readings.record',
          status: 'completed',
          timestamp: RECENT,
          context: {},
          artifacts: [{ path: 'record/proofs/sensor-readings/2026/dependency.json' }],
        },
      ],
    });

    expect(sense({ evidenceDir: undefined })).toMatchObject({
      status: 'review',
      metrics: { evidence_records: 1, misaligned: 1 },
      findings: [{ code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI' }],
    });
  });

  it('accepts exact-now evidence with a zero-hour age window', () => {
    writeJson('evidence/result.json', {
      command: `devai ${ACTION}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: CANDIDATE,
      completed_at: NOW,
    });

    expect(sense({ maxEvidenceAgeHours: 0 })).toMatchObject({
      status: 'pass',
      metrics: { evidence_records: 1, misaligned: 0 },
      findings: [],
    });
  });
});
