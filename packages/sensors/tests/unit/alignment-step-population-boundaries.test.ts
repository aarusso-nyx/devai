import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const candidate = '1'.repeat(40);
const now = '2026-09-07T12:00:00.000Z';
const dependencyCheck = 'check --only dependencies';
let root: string;

function write(path: string, contents: string): void {
  writeFileSync(join(root, path), contents);
}

function evidence(command: string, name = 'result'): void {
  write(
    `evidence/${name}.json`,
    JSON.stringify({
      command: `devai ${command}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: candidate,
      completed_at: '2026-09-07T11:00:00.000Z',
    }),
  );
}

function sense() {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: candidate,
    now,
    evidenceDir: 'evidence',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-step-boundaries-'));
  for (const path of ['law/invariants', '.github/workflows', 'evidence'])
    mkdirSync(join(root, path), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('alignment step population boundaries', () => {
  it('preserves a multiline gate body through a blank line and a following step boundary', () => {
    write(
      'law/invariants/INV-ALIGN-MULTILINE.json',
      JSON.stringify({
        id: 'INV-ALIGN-MULTILINE',
        severity: 'gate',
        measurable_via: [dependencyCheck],
      }),
    );
    write(
      '.github/workflows/ci.yml',
      `jobs:
  check:
    steps:
      - name: gate
        run: |-
          set -euo pipefail

          devai ${dependencyCheck}
      - name: disabled
        if: false
        run: echo unrelated
`,
    );
    evidence(dependencyCheck);

    const reading = sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ gate_invariants: 1, misaligned: 0 });
    expect(reading.findings).toEqual([]);
  });
});
