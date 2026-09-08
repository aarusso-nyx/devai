// Invariants: INV-DEVAI-019
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseHarnessInvariantAlignment } from '../../src/harness-invariant-alignment.js';

const ACTION = 'check --only dependencies';
const NOW = '2026-09-07T12:00:00.000Z';
const RECENT = '2026-09-07T11:00:00.000Z';
const CANDIDATE = 'a'.repeat(40);

let root: string;

function write(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value));
}

function sense(options: Partial<Parameters<typeof senseHarnessInvariantAlignment>[0]> = {}) {
  return senseHarnessInvariantAlignment({
    repoRoot: root,
    candidateHead: CANDIDATE,
    now: NOW,
    ...options,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-alignment-binding-'));
  writeJson('law/invariants/INV-TEST-001.json', {
    id: 'INV-TEST-001',
    severity: 'gate',
    measurable_via: [ACTION],
  });
  write('.github/workflows/ci.yml', `jobs:\n  check:\n    steps:\n      - run: devai ${ACTION}\n`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Canonical DEVAI evidence carries no `candidate_sha` of its own; the sensor
 * derives one from the matching `record/proofs/chain.json` receipt. Both
 * projections below are the shapes the CLI actually writes.
 */
describe('canonical evidence pairs', () => {
  function readingPair(receiptPatch: Record<string, unknown> = {}): void {
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
          context: { git: { head_sha: CANDIDATE } },
          artifacts: [{ path: 'record/proofs/sensor-readings/2026/dependency.json' }],
          ...receiptPatch,
        },
      ],
    });
  }

  function testResultPair(receiptPatch: Record<string, unknown> = {}): void {
    writeJson('record/proofs/work/test-results/run-1.json', {
      id: 'tr-0001',
      env: { commit: CANDIDATE },
      command: `devai ${ACTION}`,
      status: 'pass',
    });
    writeJson('record/proofs/chain.json', {
      records: [
        {
          actor: 'devai-record-run',
          action: 'test-run.record',
          status: 'completed',
          timestamp: RECENT,
          context: { git: { head_sha: CANDIDATE } },
          notes: ['test-result id: tr-0001; suite: local'],
          ...receiptPatch,
        },
      ],
    });
  }

  it('promotes a nested sensor reading bound by its sense.readings.record receipt', () => {
    readingPair();
    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
      evidence_records: 1,
    });
    expect(result.findings).toEqual([]);
  });

  it.each([
    { action: 'sense.readings.other' },
    { artifacts: [{ path: 'record/proofs/sensor-readings/other.json' }] },
    { artifacts: [] },
    { context: { git: { head_sha: 'not-a-commit' } } },
  ])('refuses a sensor reading whose receipt does not bind it: %j', (patch) => {
    readingPair(patch);
    expect(sense().status).toBe('review');
  });

  it('promotes a test-result record bound by its devai-record-run receipt', () => {
    testResultPair();
    const result = sense();
    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      gate_invariants: 1,
      misaligned: 0,
      evidence_records: 1,
    });
  });

  it.each([
    { actor: 'devai-sense' },
    { action: 'sense.readings.record' },
    { action: 'run.test' },
    { status: 'failed' },
    { notes: ['test-result id: tr-0002; suite: local'] },
    { notes: [] },
    { context: { git: { head_sha: 'b'.repeat(40) } } },
  ])('refuses a test-result record whose receipt does not bind it: %j', (patch) => {
    testResultPair(patch);
    expect(sense().status).toBe('review');
  });

  it('refuses a canonical reading when the chain itself is missing or unreadable', () => {
    readingPair();
    write('record/proofs/chain.json', '{broken');
    expect(sense().status).toBe('review');
    rmSync(join(root, 'record/proofs/chain.json'));
    expect(sense().status).toBe('review');
  });
});

/**
 * The sensor's Git reads run through the authority process boundary, so the
 * ancestor rule can only be exercised inside a real host-effect scope. This
 * scope grants exactly the two read-only verbs the sensor issues.
 */
function withGitReadScope<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-alignment-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'sensors-alignment-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'sensors-alignment-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense harness-invariant-alignment',
    invocation_id: 'sensors-alignment-1',
    effect: 'read',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const [executable, args] = request.arguments;
      if (
        request.kind !== 'process' ||
        executable !== 'git' ||
        !Array.isArray(args) ||
        !['diff', 'merge-base'].includes(String(args[0]))
      ) {
        throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
      }
      return apply();
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('ancestor candidate binding', () => {
  let base = '';
  let unchanged = '';
  let observationsOnly = '';
  let sourceChange = '';

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  function commit(message: string, empty = false): string {
    git('add', '-A');
    git(
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      ...(empty ? ['--allow-empty'] : []),
      '-m',
      message,
    );
    return git('rev-parse', 'HEAD');
  }

  function senseAgainst(head: string) {
    return withGitReadScope(() => sense({ candidateHead: head, evidenceDir: 'evidence' }));
  }

  beforeEach(() => {
    git('init', '--quiet');
    write('README.md', '# fixture\n');
    writeJson('evidence/result.json', { placeholder: true });
    base = commit('base');
    unchanged = commit('no observed change', true);
    writeJson('record/proofs/chain.json', { records: [] });
    observationsOnly = commit('record observations');
    write('README.md', '# fixture, revised\n');
    writeJson('record/proofs/chain.json', { records: [], revision: 2 });
    sourceChange = commit('revise source and observations');
    // Written after the commits so the working tree never contributes to any
    // of the compared diffs.
    writeJson('evidence/result.json', {
      command: `devai ${ACTION}`,
      status: 'pass',
      lifecycle: 'supported',
      candidate_sha: base,
      completed_at: RECENT,
    });
  });

  it('carries evidence forward only across an observation-only advance', () => {
    expect(senseAgainst(base).status).toBe('pass');
    expect(senseAgainst(observationsOnly).status).toBe('pass');
    expect(senseAgainst(sourceChange).status).toBe('review');
    expect(senseAgainst(unchanged).status).toBe('review');
  });

  it('refuses a candidate that does not descend from the evidence subject', () => {
    const orphan = 'c'.repeat(40);
    expect(senseAgainst(orphan).status).toBe('review');
  });
});
