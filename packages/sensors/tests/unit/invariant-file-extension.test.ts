import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const candidate = '1'.repeat(40);
const now = '2026-09-07T12:00:00.000Z';
const measuredAction = 'check --only dependencies';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-extension-'));
  mkdirSync(join(root, 'law/invariants'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'evidence'), { recursive: true });

  writeFileSync(
    join(root, 'law/invariants/INV-GATE.json'),
    JSON.stringify({
      id: 'INV-GATE',
      severity: 'gate',
      measurable_via: [measuredAction],
    }),
  );
  writeFileSync(
    join(root, 'law/invariants/extra.txt'),
    JSON.stringify({
      id: 'INV-NON-JSON',
      severity: 'gate',
      measurable_via: ['check --only integrity'],
    }),
  );
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    `jobs:\n  check:\n    steps:\n      - run: devai ${measuredAction}\n`,
  );
  writeFileSync(
    join(root, 'evidence/result.json'),
    JSON.stringify({
      command: `devai ${measuredAction}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: candidate,
      completed_at: '2026-09-07T11:00:00.000Z',
    }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness alignment invariant filename boundary', () => {
  it('loads only JSON invariant files and ignores valid JSON in other extensions', () => {
    const reading = senseHarnessInvariantAlignment({
      repoRoot: root,
      candidateHead: candidate,
      now,
      evidenceDir: 'evidence',
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
      workflow_count: 1,
      executable_run_steps: 1,
      evidence_records: 1,
      candidate_head_resolved: true,
    });
    expect(reading.findings).toEqual([]);
  });
});
