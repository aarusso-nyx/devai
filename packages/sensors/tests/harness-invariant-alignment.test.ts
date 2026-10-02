// ADR-SCR-0004 (harness half): harness_invariant_alignment recognizes the bootstrapped
// runner the pull-request lane invokes, `node .devai/state/pr-bootstrap/cli/bin.js
// <action>` (.github/workflows/pull-request-checks.yml), as a DEVAI launcher, so a gate
// invariant measured by that step aligns when fresh candidate-bound evidence agrees.
//
// The evidence is a host-produced alignment record under an explicit evidence directory,
// the same shape packages/sensors/tests/unit/alignment-evidence.test.ts uses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../src/harness-invariant-alignment.js';

const CANDIDATE = '2'.repeat(40);
const NOW = '2026-09-27T12:00:00.000Z';
const ACTION = 'check --only trace';
const BOOTSTRAP = 'node .devai/state/pr-bootstrap/cli/bin.js';

let root: string;

function workflow(script: string): void {
  writeFileSync(
    join(root, '.github/workflows/pull-request-checks.yml'),
    `jobs:\n  check:\n    steps:\n      - run: ${script}\n`,
  );
}

function evidence(command: string): void {
  writeFileSync(
    join(root, 'evidence/result.json'),
    JSON.stringify({
      command,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: CANDIDATE,
      completed_at: '2026-09-27T11:00:00.000Z',
    }),
  );
}

function sense() {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: CANDIDATE,
    evidenceDir: 'evidence',
    now: NOW,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-harness-bootstrap-launcher-'));
  for (const dir of ['law/invariants', '.github/workflows', 'evidence']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, 'law/invariants/INV-TEST-001.json'),
    JSON.stringify({ id: 'INV-TEST-001', severity: 'gate', measurable_via: [ACTION] }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('harness_invariant_alignment and the bootstrapped pull-request runner', () => {
  it('recognizes node .devai/state/pr-bootstrap/cli/bin.js as a DEVAI launcher', () => {
    workflow(`${BOOTSTRAP} ${ACTION} --format json`);
    evidence(`${BOOTSTRAP} ${ACTION} --format json`);
    const reading = sense();
    expect(reading.status, JSON.stringify(reading.findings)).toBe('pass');
  });

  it('does not recognize a runner under another state directory', () => {
    workflow(`node .devai/state/other/cli/bin.js ${ACTION}`);
    evidence(`node .devai/state/other/cli/bin.js ${ACTION}`);
    expect(sense().status).not.toBe('pass');
  });
});

// Invariants: INV-CORE-003, INV-HARNESS-006
// ADR-MDL-0004: textual invocation and untrusted evidence cannot admit a gate.
describe('candidate gate alignment does not infer an observed verdict', () => {
  it.each(['review', 'fail', 'unknown', 'error'])(
    'rejects %s hard evidence despite a real registered launcher',
    (status) => {
      workflow(`${BOOTSTRAP} ${ACTION}`);
      evidence(`${BOOTSTRAP} ${ACTION}`);
      writeFileSync(
        join(root, 'evidence/result.json'),
        JSON.stringify({
          command: `${BOOTSTRAP} ${ACTION}`,
          status,
          lifecycle: 'supported',
          candidate_sha: CANDIDATE,
          completed_at: '2026-09-27T11:00:00.000Z',
        }),
      );
      expect(sense().status).not.toBe('pass');
    },
  );
  it('refuses a convenient pass for a moved candidate', () => {
    workflow(`${BOOTSTRAP} ${ACTION}`);
    writeFileSync(
      join(root, 'evidence/result.json'),
      JSON.stringify({
        command: `${BOOTSTRAP} ${ACTION}`,
        status: 'pass',
        lifecycle: 'supported',
        candidate_sha: '3'.repeat(40),
        completed_at: '2026-09-27T11:00:00.000Z',
      }),
    );
    expect(sense().status).not.toBe('pass');
  });
  it('refuses declaration-only soft evidence at the named producer invocation', () => {
    const command = 'node scripts/process/check-ci-invariant-gate.mjs';
    writeFileSync(
      join(root, 'law/invariants/INV-TEST-001.json'),
      JSON.stringify({ id: 'INV-TEST-001', severity: 'gate', measurable_via: ['audit scorecard'] }),
    );
    workflow(command);
    writeFileSync(
      join(root, 'evidence/result.json'),
      JSON.stringify({
        command,
        status: 'pass',
        lifecycle: 'supported',
        candidate_sha: CANDIDATE,
        completed_at: '2026-09-27T11:00:00.000Z',
        verified: true,
        isolated: true,
      }),
    );
    expect(sense().status).not.toBe('pass');
  });
});
