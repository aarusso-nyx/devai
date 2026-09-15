import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const candidate = '1'.repeat(40);
const now = '2026-09-08T12:00:00.000Z';
const first = 'check --only dependencies';
const second = 'check --only integrity';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-all-measurements-'));
  for (const path of ['law/invariants', '.github/workflows', 'evidence'])
    mkdirSync(join(root, path), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function invariant(mode: 'all' | 'any'): void {
  write(
    'law/invariants/INV-ALIGN-MEASUREMENTS.json',
    JSON.stringify({
      id: 'INV-ALIGN-MEASUREMENTS',
      severity: 'gate',
      measurable_via: [first, second],
      measurable_via_mode: mode,
    }),
  );
}

function workflow(commands: readonly string[]): void {
  write(
    '.github/workflows/ci.yml',
    `jobs:
  check:
    steps:
${commands.map((command) => `      - run: devai ${command}`).join('\n')}
`,
  );
}

function evidenceFor(command: string): void {
  write(
    `evidence/${command.replaceAll(' ', '-')}.json`,
    JSON.stringify({
      command: `devai ${command}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: candidate,
      completed_at: '2026-09-08T11:00:00.000Z',
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

describe('alignment all-measurements population', () => {
  it('reports the exact missing candidate when all measurements are required', () => {
    invariant('all');
    workflow([first]);
    evidenceFor(first);

    const reading = sense();

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({ gate_invariants: 1, misaligned: 1 });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({
        code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
        message: `Gate invariant INV-ALIGN-MEASUREMENTS requires ALL of measurable_via=[${first}, ${second}] in CI (measurable_via_mode=all); missing: [${second}].`,
      }),
    );
  });

  it('passes all-mode alignment when every candidate has fresh executable evidence', () => {
    invariant('all');
    workflow([first, second]);
    evidenceFor(first);
    evidenceFor(second);

    const reading = sense();

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ gate_invariants: 1, misaligned: 0 });
    expect(reading.findings).toEqual([]);
  });

  it('reports no executable measurements using the any-mode explanation', () => {
    invariant('any');
    workflow([]);
    const reading = sense();
    expect(reading.status).toBe('review');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({
        code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
        message: `Gate invariant INV-ALIGN-MEASUREMENTS has measurable_via=[${first}, ${second}] but none has an executable fail-closed CI step with fresh successful candidate-bound evidence.`,
      }),
    );
  });

  it('keeps any-mode alignment satisfied by one fresh candidate measurement', () => {
    invariant('any');
    workflow([first]);
    evidenceFor(first);

    const reading = sense();

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ gate_invariants: 1, misaligned: 0 });
    expect(reading.findings).toEqual([]);
  });
});
