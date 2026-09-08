import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } from '@devai-nyx/authority';
import {
  emitRgr,
  getRgrDir,
  listRgrs,
  nextRgrId,
  readRgr,
  resolveRgr,
  rgrContentHash,
  type EmitRgrOptions,
} from '../../src/rgr/index.js';

let root: string;
const createdAt = '2026-09-08T12:00:00.000Z';
const resolvedAt = '2026-09-08T12:01:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-rgr-persistence-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function options(): EmitRgrOptions {
  return {
    repoRoot: root,
    emittingTaskId: 'TASK-0042',
    emittingDiscipline: 'engineer',
    summary: 'Refresh behavior is unspecified',
    ambiguity: 'Must stale refresh tokens be rejected?',
    evidenceRefs: ['EV-abcdef01'],
    createdAt,
  };
}
// Exercise real filesystem operations only inside this test's owned root.
function run<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'rgr-persistence-test',
    issuer_version: '1.0.0',
    invocation_id: 'rgr-persistence',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'rgr-persistence-receipt',
    now: () => createdAt,
    receipt_ttl_ms: 30000,
  });
  try {
    return runWithAuthorityHostEffects(
      {
        action_id: 'rgr persistence acceptance',
        invocation_id: 'rgr-persistence',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect: (request, apply) => {
          const path = request.arguments[0];
          if (
            request.kind !== 'filesystem' ||
            typeof path !== 'string' ||
            !resolve(path).startsWith(resolve(root) + sep)
          )
            throw new Error('RGR_TEST_EFFECT_OUTSIDE_ROOT');
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

describe('reference gap report persistence', () => {
  it('persists and reads an exact default report with an ambiguity question', () => {
    const record = run(() => emitRgr(options()));
    expect(record).toEqual({
      schemaVersion: '1.0.0',
      id: 'RGR-0001',
      emitting_task_id: 'TASK-0042',
      emitting_discipline: 'engineer',
      created_at: createdAt,
      problem: { summary: options().summary, ambiguity: options().ambiguity },
      questions: [{ qid: 'Q1', question: options().ambiguity }],
      evidence_refs: ['EV-abcdef01'],
      status: 'open',
    });
    expect(getRgrDir(root)).toBe(join(root, '.devai/state/rgr'));
    expect(readFileSync(join(getRgrDir(root), 'RGR-0001.json'), 'utf8')).toBe(
      JSON.stringify(record, null, 2) + '\n',
    );
    expect(run(() => readRgr(root, record.id))).toEqual(record);
    expect(run(() => listRgrs(root))).toEqual([record]);
  });
  it('retains all declared context and explicit questions without mutating the request', () => {
    const opts: EmitRgrOptions = {
      ...options(),
      emittingDiscipline: 'auditor',
      targetAuthority: 'architect',
      invariantsImpacted: ['INV-001'],
      journeysImpacted: ['JNY-001'],
      surfaces: ['api/refresh'],
      riskClass: 'security',
      proposedResolutionSummary: 'Reject stale tokens',
      questions: [
        { qid: 'Q1', question: 'Reject?', options: ['yes', 'no'] },
        { qid: 'Q2', question: 'Which status?', depends_on: ['Q1'] },
      ],
    };
    const before = JSON.stringify(opts);
    const record = run(() => emitRgr(opts));
    expect(record).toMatchObject({
      emitting_discipline: 'auditor',
      target_authority: 'architect',
      problem: {
        invariants_impacted: ['INV-001'],
        journeys_impacted: ['JNY-001'],
        surfaces: ['api/refresh'],
        risk_class: 'security',
      },
      proposed_resolution: { summary: 'Reject stale tokens' },
      questions: opts.questions,
    });
    expect(JSON.stringify(opts)).toBe(before);
    expect(run(() => readRgr(root, record.id))).toEqual(record);
  });
  it('uses a fallback question for an explicitly empty question list', () => {
    expect(run(() => emitRgr({ ...options(), questions: [] })).questions).toEqual([
      { qid: 'Q1', question: options().ambiguity },
    ]);
  });
  it('uses the clock only when the caller omits creation time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(resolvedAt));
    expect(run(() => emitRgr({ ...options(), createdAt: undefined })).created_at).toBe(resolvedAt);
    expect(run(() => emitRgr(options())).created_at).toBe(createdAt);
  });
  it('allocates durable increasing identities independently of existing record files', () => {
    expect(run(() => nextRgrId(root))).toBe('RGR-0001');
    expect(run(() => emitRgr(options())).id).toBe('RGR-0002');
    expect(run(() => nextRgrId(root))).toBe('RGR-0003');
  });
  it.each([
    { label: 'empty summary', change: { summary: '' } },
    { label: 'missing evidence', change: { evidenceRefs: [] } },
    { label: 'invalid task', change: { emittingTaskId: 'OTHER-0042' } },
    { label: 'invalid question', change: { questions: [{ qid: 'wrong', question: 'Why?' }] } },
  ])('refuses $label before creating a report file', ({ change }) => {
    expect(() => run(() => emitRgr({ ...options(), ...change }))).toThrow(
      /emitRgr: produced record failed/,
    );
    expect(existsSync(getRgrDir(root))).toBe(false);
  });
  it('returns no records for absent storage and null for absent or malformed records', () => {
    expect(run(() => listRgrs(root))).toEqual([]);
    expect(run(() => readRgr(root, 'RGR-0001'))).toBeNull();
    mkdirSync(getRgrDir(root), { recursive: true });
    writeFileSync(join(getRgrDir(root), 'RGR-0001.json'), '{');
    expect(run(() => readRgr(root, 'RGR-0001'))).toBeNull();
    expect(run(() => listRgrs(root))).toEqual([]);
  });
  it('sorts matching record filenames and skips malformed content and foreign filenames', () => {
    const first = run(() => emitRgr(options()));
    const second = run(() => emitRgr(options()));
    writeFileSync(join(getRgrDir(root), 'RGR-0003.json'), '{');
    for (const name of ['RGR-003.json', 'xRGR-0004.json', 'RGR-0005.json.bak', 'notes.json'])
      writeFileSync(join(getRgrDir(root), name), JSON.stringify(first));
    expect(run(() => listRgrs(root))).toEqual([first, second]);
  });
  it('returns an empty listing if the record directory is a file', () => {
    mkdirSync(join(root, '.devai/state'), { recursive: true });
    writeFileSync(getRgrDir(root), 'not a directory');
    expect(run(() => listRgrs(root))).toEqual([]);
  });
  it.each(['resolved', 'rejected', 'superseded'] as const)(
    'persists %s with exact resolution identity and evidence',
    (newStatus) => {
      const prior = run(() => emitRgr(options()));
      const next = run(() =>
        resolveRgr({
          repoRoot: root,
          rgrId: prior.id,
          resolver: 'Owner',
          answers: [{ qid: 'Q1', answer: 'Reject stale refresh tokens' }],
          resultingCommits: ['a'.repeat(40)],
          resumedTaskId: 'TASK-0043',
          newStatus,
          resolvedAt,
        }),
      );
      expect(next).toEqual({
        ...prior,
        status: newStatus,
        resolution: {
          resolved_at: resolvedAt,
          resolver: 'Owner',
          answers: [{ qid: 'Q1', answer: 'Reject stale refresh tokens' }],
          resulting_commits: ['a'.repeat(40)],
          resumed_task_id: 'TASK-0043',
        },
      });
      expect(run(() => readRgr(root, prior.id))).toEqual(next);
    },
  );
  it('defaults resolution status and time while omitting undeclared optional fields', () => {
    const prior = run(() => emitRgr(options()));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(resolvedAt));
    expect(
      run(() => resolveRgr({ repoRoot: root, rgrId: prior.id, resolver: 'Architect' })),
    ).toEqual({
      ...prior,
      status: 'resolved',
      resolution: { resolved_at: resolvedAt, resolver: 'Architect' },
    });
  });
  it('retains an explicit null resumed task rather than omitting it', () => {
    const prior = run(() => emitRgr(options()));
    expect(
      run(() =>
        resolveRgr({
          repoRoot: root,
          rgrId: prior.id,
          resolver: 'Owner',
          resumedTaskId: null,
          resolvedAt,
        }),
      ).resolution,
    ).toEqual({ resolved_at: resolvedAt, resolver: 'Owner', resumed_task_id: null });
  });
  it('refuses a missing report with its exact requested identity', () => {
    expect(() =>
      run(() => resolveRgr({ repoRoot: root, rgrId: 'RGR-0008', resolver: 'Owner', resolvedAt })),
    ).toThrow(`resolveRgr: RGR-0008 not found at ${getRgrDir(root)}`);
  });
  it('preserves the previous file when the resolution fails schema validation', () => {
    const prior = run(() => emitRgr(options()));
    const path = join(getRgrDir(root), prior.id + '.json');
    const before = readFileSync(path);
    expect(() =>
      run(() =>
        resolveRgr({
          repoRoot: root,
          rgrId: prior.id,
          resolver: 'Owner',
          answers: [{ qid: 'wrong', answer: 'Reject' }],
          resolvedAt,
        }),
      ),
    ).toThrow(/resolveRgr: result failed/);
    expect(readFileSync(path)).toEqual(before);
  });
  it('hashes current content canonically without adding a stored hash', () => {
    const prior = run(() => emitRgr(options()));
    const before = readFileSync(join(getRgrDir(root), prior.id + '.json'));
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    expect(rgrContentHash(prior)).toBe(
      createHash('sha256')
        .update(JSON.stringify(canonical(prior)))
        .digest('hex'),
    );
    expect(rgrContentHash({ ...prior, status: 'in_review' })).not.toBe(rgrContentHash(prior));
    expect(readFileSync(join(getRgrDir(root), prior.id + '.json'))).toEqual(before);
  });
});
