import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const candidate = '1'.repeat(40);
const now = '2026-09-07T12:00:00.000Z';
const action = 'check --only dependencies';
let root: string;
function evidence(patch: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, 'evidence/result.json'),
    JSON.stringify({
      command: `devai ${action}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: candidate,
      completed_at: '2026-09-07T11:00:00.000Z',
      ...patch,
    }),
  );
}
function workflow(script: string, metadata = '') {
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    `jobs:\n  check:\n    steps:\n      - run: ${script}\n${metadata}`,
  );
}
function sense(options: Partial<Parameters<typeof senseHarnessInvariantAlignment>[0]> = {}) {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: candidate,
    now,
    evidenceDir: 'evidence',
    ...options,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-evidence-'));
  for (const path of ['law/invariants', '.github/workflows', 'evidence'])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, 'law/invariants/INV-TEST-001.json'),
    JSON.stringify({ id: 'INV-TEST-001', severity: 'gate', measurable_via: [action] }),
  );
  workflow(`devai ${action}`);
  evidence();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('candidate-bound harness alignment evidence', () => {
  it('passes a real populated gate only when executable CI and fresh matching evidence agree', () => {
    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
      workflow_count: 1,
      executable_run_steps: 1,
      evidence_records: 1,
      candidate_head_resolved: true,
    });
    expect(result.findings).toEqual([]);
  });

  it.each([
    { status: 'fail' },
    { status: 'review' },
    { lifecycle: 'experimental' },
    { candidate_sha: 123 },
    { candidate_sha: 'not-a-commit' },
    { completed_at: 'invalid' },
    { completed_at: 123 },
    { completed_at: '2026-09-07T12:00:00.001Z' },
    { completed_at: '2026-09-06T11:59:59.999Z' },
    { command: 'echo devai check --only dependencies' },
    { command: 'devai check --only dependencies || true' },
    { command: 'devai check --only unrelated' },
  ])('does not promote incompatible or nonbinding evidence %j', (patch) => {
    expect(sense().status).toBe('pass');
    evidence(patch);
    const result = sense();
    expect(result.status).toBe('review');
    expect(result.metrics).toMatchObject({ gate_invariants: 1, misaligned: 1 });
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI',
    ]);
  });

  it('accepts evidence exactly at the age boundary and rejects it one millisecond older', () => {
    evidence({ completed_at: '2026-09-06T12:00:00.000Z' });
    expect(sense().status).toBe('pass');
    expect(sense({ maxEvidenceAgeHours: 23 }).status).toBe('review');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'refuses invalid evidence age policy %s',
    (maxEvidenceAgeHours) => {
      expect(sense({ maxEvidenceAgeHours }).status).toBe('review');
    },
  );

  it('does not accept an invalid clock or malformed candidate identity', () => {
    expect(() => sense({ now: 'not a date' })).toThrow('sensor-reading.schema.json');
    expect(sense({ candidateHead: 'invalid' }).status).toBe('review');
  });

  it.each([
    'echo devai check --only dependencies',
    'devai check --only dependencies || true',
    'devai check --only dependencies | cat',
    'devai check --only dependencies &',
  ])('requires binding executable CI, even with a passing evidence record: %s', (script) => {
    workflow(script);
    expect(sense().status).toBe('review');
  });

  it.each(['        continue-on-error: true\n', '        if: false\n'])(
    'does not count a disabled or nonblocking step %s',
    (metadata) => {
      workflow(`devai ${action}`, metadata);
      expect(sense().status).toBe('review');
    },
  );
});

describe('alignment command and measurement population', () => {
  it.each([
    'pnpm exec devai',
    'pnpm devai',
    'npx --no-install devai',
    'npm exec -- devai',
    'env CHECK_MODE=strict devai',
    'CHECK_MODE=strict command -- devai',
    'node packages/cli/dist/bin.js',
    'nodejs packages/cli/src/bin.ts',
    '"/opt/devai tools/devai"',
  ])('recognizes a directly invoked supported launcher: %s', (launcher) => {
    workflow(`${launcher} ${action}`);
    evidence({ command: `${launcher} ${action}` });
    expect(sense().status).toBe('pass');
  });

  it.each([
    'node other.js devai',
    'python script.py devai',
    'pnpm exec unrelated devai',
    'npx unrelated devai',
    'npm run devai',
    'grep devai',
  ])('does not promote action text passed to another executable: %s', (launcher) => {
    workflow(`${launcher} ${action}`);
    expect(sense().status).toBe('review');
  });

  it('requires all declared measurements in all mode but one suffices in any mode', () => {
    const path = join(root, 'law/invariants/INV-TEST-001.json');
    const second = 'check --only integrity';
    const invariant = { id: 'INV-TEST-001', severity: 'gate', measurable_via: [action, second] };
    writeFileSync(path, JSON.stringify({ ...invariant, measurable_via_mode: 'any' }));
    expect(sense().status).toBe('pass');
    writeFileSync(path, JSON.stringify({ ...invariant, measurable_via_mode: 'all' }));
    expect(sense().status).toBe('review');
    workflow(`devai ${action} && devai ${second}`);
    expect(sense().status).toBe('review');
    writeFileSync(
      join(root, 'evidence/second.json'),
      JSON.stringify({
        command: `devai ${second}`,
        status: 'pass',
        candidate_sha: candidate,
        completed_at: now,
      }),
    );
    expect(sense().status).toBe('pass');
  });

  it('aggregates missing measurements and escalates three misaligned gates to failure', () => {
    for (const id of ['INV-TEST-001', 'INV-TEST-002', 'INV-TEST-003']) {
      writeFileSync(
        join(root, `law/invariants/${id}.json`),
        JSON.stringify({ id, severity: 'gate' }),
      );
    }
    const result = sense();
    expect(result.status).toBe('fail');
    expect(result.metrics).toMatchObject({ gate_invariants: 3, misaligned: 3 });
    expect(result.findings?.map((finding) => finding.code)).toEqual(
      Array(3).fill('HARNESS_INVARIANT_ALIGNMENT_NO_MEASURABLE_VIA'),
    );
  });

  it('reports a genuinely empty selected population as review with the dedicated finding', () => {
    const result = sense({ gateSeverityValue: 'constitutional' });
    expect(result.status).toBe('review');
    expect(result.metrics).toEqual({ gate_invariants: 0, misaligned: 0 });
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'HARNESS_INVARIANT_ALIGNMENT_NO_GATES',
    ]);
  });

  it('cannot promote a gate from missing or malformed evidence', () => {
    writeFileSync(join(root, 'evidence/result.json'), '{broken');
    expect(sense().status).toBe('review');
    rmSync(join(root, 'evidence'), { recursive: true });
    expect(sense().status).toBe('review');
  });
});
