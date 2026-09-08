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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave2-alignment-'));
  writeJson('law/invariants/INV-TEST-001.json', {
    id: 'INV-TEST-001',
    severity: 'gate',
    measurable_via: [ACTION],
  });
  writeWorkflow(`devai ${ACTION}`);
  writeJson('evidence/result.json', {
    command: `devai ${ACTION}`,
    status: 'pass',
    lifecycle: 'supported',
    candidate_sha: CANDIDATE,
    completed_at: RECENT,
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(relativePath: string, value: unknown): void {
  write(relativePath, JSON.stringify(value));
}

function writeWorkflow(script: string): void {
  write('.github/workflows/ci.yml', `jobs:\n  check:\n    steps:\n      - run: ${script}\n`);
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

describe('wave 2 harness alignment boundaries', () => {
  it('distinguishes quoted false metadata from a genuinely nonblocking step', () => {
    expect(sense()).toMatchObject({
      status: 'pass',
      metrics: { gate_invariants: 1, misaligned: 0, evidence_records: 1 },
      findings: [],
    });

    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - name: gate\n        continue-on-error: "false"\n        run: devai ${ACTION}\n`,
    );
    expect(sense().status).toBe('pass');

    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - name: gate\n        if: "\${{ false }}"\n        run: devai ${ACTION}\n`,
    );
    expect(sense()).toMatchObject({
      status: 'review',
      findings: [{ code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI' }],
    });
  });

  it.each([
    "'${{ false }}'",
    '"${{ false }}" # disabled gate',
    '${{ false }} # disabled gate',
    'false && true',
    'false || true',
  ])('rejects a disabled condition expressed as %s', (condition) => {
    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - name: gate\n        if: ${condition}\n        run: devai ${ACTION}\n`,
    );
    expect(sense()).toMatchObject({ status: 'review', metrics: { misaligned: 1 } });
  });

  it('keeps a quoted true condition executable', () => {
    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - name: gate\n        if: "\${{ true }}" # enabled gate\n        run: devai ${ACTION}\n`,
    );
    expect(sense()).toMatchObject({ status: 'pass', metrics: { misaligned: 0 }, findings: [] });
  });

  it('keeps a real gate after a blank line in a literal block', () => {
    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - name: gate\n        run: |\n          # explanatory comment\n\n          devai ${ACTION}\n`,
    );

    expect(sense().status).toBe('pass');
    expect(sense().metrics).toMatchObject({ executable_run_steps: 1, misaligned: 0 });
  });

  it('does not promote quoted shell text into an executable gate', () => {
    write(
      '.github/workflows/ci.yml',
      `jobs:\n  check:\n    steps:\n      - run: |\n          echo 'quoted; devai ${ACTION}; ignored'\n`,
    );
    expect(sense()).toMatchObject({
      status: 'review',
      metrics: { misaligned: 1 },
      findings: [{ code: 'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI' }],
    });
  });

  it('recognizes npm exec after its option separator', () => {
    const command = `npm exec -- devai ${ACTION}`;
    writeWorkflow(command);
    writeJson('evidence/result.json', {
      command,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: CANDIDATE,
      completed_at: RECENT,
    });

    expect(sense().status).toBe('pass');
  });

  it.each(['sensor', 'test'] as const)(
    'uses the %s record timestamp when its canonical receipt omits it',
    (kind) => {
      rmSync(join(root, 'evidence/result.json'));
      const sensor = kind === 'sensor';
      const path = sensor
        ? 'record/proofs/sensor-readings/2026/dependency.json'
        : 'record/proofs/work/test-results/run-1.json';
      writeJson(path, {
        command: `devai ${ACTION}`,
        status: 'pass',
        completed_at: RECENT,
        ...(sensor ? {} : { id: 'tr-0001', env: { commit: CANDIDATE } }),
      });
      writeJson('record/proofs/chain.json', {
        records: [
          {
            actor: sensor ? 'devai-sense' : 'devai-record-run',
            action: sensor ? 'sense.readings.record' : 'test-run.record',
            status: 'completed',
            context: { git: { head_sha: CANDIDATE } },
            ...(sensor
              ? { artifacts: [{ path }] }
              : { notes: ['test-result id: tr-0001; suite: local'] }),
          },
        ],
      });
      const reading = sense({ evidenceDir: undefined });
      expect(reading.status).toBe('pass');
      expect(reading.metrics).toMatchObject({ evidence_records: 1, misaligned: 0 });
    },
  );

  it('reports the unknown invariant id in a no-measurement finding', () => {
    rmSync(join(root, 'law/invariants/INV-TEST-001.json'));
    writeJson('law/invariants/INV-UNKNOWN.json', { severity: 'gate' });

    const reading = sense();

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      expect.objectContaining({
        code: 'HARNESS_INVARIANT_ALIGNMENT_NO_MEASURABLE_VIA',
        message: 'Gate invariant <unknown> has no measurable_via[] entries to align against CI.',
      }),
    ]);
  });
});
