// Invariants: INV-DEVAI-019
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const CANDIDATE = '1111111111111111111111111111111111111111';
const NOW = '2026-07-17T02:00:00.000Z';

let repo = '';

function prepare(workflowRun: string, lifecycle: 'supported' | 'experimental' = 'supported'): void {
  const invariantDir = join(repo, 'docs/framework/arch/invariants');
  const workflowDir = join(repo, '.github/workflows');
  const evidenceDir = join(repo, '.devai/state/readings');
  mkdirSync(invariantDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(invariantDir, 'INV-TEST-001.json'),
    JSON.stringify({
      id: 'INV-TEST-001',
      severity: 'gate',
      measurable_via: ['policy check dependencies'],
      measurable_via_mode: 'all',
    }),
  );
  writeFileSync(
    join(workflowDir, 'ci.yml'),
    `name: ci\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${workflowRun}\n`,
  );
  writeFileSync(
    join(evidenceDir, 'dependency.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      command: 'devai check --only dependencies',
      status: 'pass',
      lifecycle,
      candidate_sha: CANDIDATE,
      completed_at: '2026-07-17T01:00:00.000Z',
    }),
  );
}

function sense() {
  return senseHarnessInvariantAlignment({
    repoRoot: repo,
    now: NOW,
    candidateHead: CANDIDATE,
    evidenceDir: '.devai/state/readings',
    maxEvidenceAgeHours: 24,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'devai-r21-w09-alignment-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('adversarial alignment semantics', () => {
  it('rejects the canonical action when it is only an argument to another executable', () => {
    prepare('grep devai check --only dependencies README.md');
    expect(sense().status).not.toBe('pass');
  });

  it('does not let experimental evidence promote supported alignment', () => {
    prepare('devai check --only dependencies', 'experimental');
    expect(sense().status).not.toBe('pass');
  });
});
