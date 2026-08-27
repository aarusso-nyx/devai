// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for opt-in governance tracking (v1.3.0):
// recording is local-first and append-only, ordering is per authority session
// and never globally fabricated, correction is by supersession, sealing is
// durable across a crash, projection is lossless by event ID, and a remote
// that is absent for an entire round never changes a governed verdict.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  GovernanceTrackingError,
  buildProjectionBatch,
  governanceTrackingStatus,
  listGovernanceSegments,
  readGovernanceEvents,
  recordGovernanceEvent,
  sealGovernanceSegment,
  type GovernanceEventDraft,
} from '../../src/tracking/index.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-governance-tracking-'));
  roots.push(root);
  return root;
}

const SESSION_A = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const SESSION_B = 'AUTH-SESSION-1a2b3c4d5e6f70819273';

function draft(overrides: Partial<GovernanceEventDraft> = {}): GovernanceEventDraft {
  return {
    round_id: 'R-0042',
    authority_session_id: SESSION_A,
    session_source: 'session-state',
    role: 'engineer',
    kind: 'action_completed',
    summary: 'Mediated action completed.',
    coverage: { mediated: true },
    payload: { detail: 'local-only payload' },
    ...overrides,
  };
}

function record(root: string, overrides: Partial<GovernanceEventDraft> = {}) {
  return withAuthorityHostTestScope(() =>
    recordGovernanceEvent({ repoRoot: root, repositoryId: 'devai', draft: draft(overrides) }),
  );
}

describe('canonical governance event recording', () => {
  it('derives a content-addressed event id and validates against the canonical schema', async () => {
    const root = repository();
    const event = await record(root);

    expect(event.event_id).toMatch(/^GEV-[0-9a-f]{16}$/u);
    expect(validators.governanceEvent(event)).toBe(true);
    expect(event.session_sequence).toBe(1);
    expect(event.previous_event_digest_sha256).toBeNull();
  });

  it('gives byte-identical events the same id and different events different ids', async () => {
    const first = repository();
    const second = repository();
    const fixed = { recordedAt: '2026-08-27T12:00:00.000Z' } as const;

    const a = await withAuthorityHostTestScope(() =>
      recordGovernanceEvent({ repoRoot: first, repositoryId: 'devai', draft: draft(), ...fixed }),
    );
    const b = await withAuthorityHostTestScope(() =>
      recordGovernanceEvent({ repoRoot: second, repositoryId: 'devai', draft: draft(), ...fixed }),
    );
    const c = await withAuthorityHostTestScope(() =>
      recordGovernanceEvent({
        repoRoot: repository(),
        repositoryId: 'devai',
        draft: draft({ summary: 'A different mediated action.' }),
        ...fixed,
      }),
    );

    expect(a.event_id).toBe(b.event_id);
    expect(c.event_id).not.toBe(a.event_id);
  });

  it('chains events per authority session without fabricating a global order', async () => {
    const root = repository();
    const a1 = await record(root, { authority_session_id: SESSION_A });
    const b1 = await record(root, { authority_session_id: SESSION_B });
    const a2 = await record(root, { authority_session_id: SESSION_A });
    const b2 = await record(root, { authority_session_id: SESSION_B });

    // Each session numbers itself from 1 and links only to its own predecessor.
    expect([a1.session_sequence, a2.session_sequence]).toEqual([1, 2]);
    expect([b1.session_sequence, b2.session_sequence]).toEqual([1, 2]);
    expect(a1.previous_event_digest_sha256).toBeNull();
    expect(b1.previous_event_digest_sha256).toBeNull();
    expect(a2.previous_event_digest_sha256).not.toBeNull();
    expect(a2.previous_event_digest_sha256).not.toBe(b2.previous_event_digest_sha256);
  });

  it('refuses an unregistered event kind instead of passing it through', async () => {
    const root = repository();
    await expect(
      record(root, { kind: 'totally_unregistered_kind' as GovernanceEventDraft['kind'] }),
    ).rejects.toThrow(GovernanceTrackingError);
  });

  it('records uncovered host activity as explicitly unmediated, never as mediated', async () => {
    const root = repository();
    const event = await record(root, {
      coverage: { mediated: false, uncovered_reason: 'editor write outside DEVAI mediation' },
    });

    expect(event.coverage.mediated).toBe(false);
    expect(event.coverage.uncovered_reason).toContain('outside DEVAI');
    expect(
      governanceTrackingStatus({ repoRoot: root, round: 'R-0042' }).coverage_disclosure,
    ).toMatchObject({ mediated_only: true });
  });
});

describe('append-only correction', () => {
  it('supersedes prior evidence by appending, leaving the original bytes untouched', async () => {
    const root = repository();
    const original = await record(root, { summary: 'Verification reported PASS.' });
    const before = readFileSync(join(root, '.devai/state/tracking/R-0042/events.jsonl'), 'utf8');

    const correction = await record(root, {
      kind: 'evidence_superseded',
      summary: 'Superseded: the earlier verification was observed on a stale tree.',
      supersedes_event_id: original.event_id,
    });

    const after = readFileSync(join(root, '.devai/state/tracking/R-0042/events.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(correction.supersedes_event_id).toBe(original.event_id);

    const events = readGovernanceEvents({ repoRoot: root, round: 'R-0042' });
    expect(events.map((event) => event.event_id)).toEqual([original.event_id, correction.event_id]);
  });

  it('refuses a supersession that names an event which was never recorded', async () => {
    const root = repository();
    await expect(
      record(root, {
        kind: 'evidence_superseded',
        supersedes_event_id: 'GEV-0000000000000000',
      }),
    ).rejects.toThrow(GovernanceTrackingError);
  });
});

describe('sealing and crash recovery', () => {
  it('seals a contiguous segment into machine-written proof storage', async () => {
    const root = repository();
    await record(root);
    await record(root);
    const segment = await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' }),
    );

    expect(segment).toBeDefined();
    expect(validators.governanceEventSegment(segment)).toBe(true);
    expect(segment?.event_ids).toHaveLength(2);
    expect(segment?.sequence_range).toEqual({ first: 1, last: 2 });
    expect(segment?.chain.previous_segment_digest_sha256).toBeNull();

    const stored = listGovernanceSegments({ repoRoot: root, round: 'R-0042' });
    expect(stored.map((entry) => entry.segment_id)).toEqual([segment?.segment_id]);
  });

  it('links a later segment to its predecessor and never reseals sealed events', async () => {
    const root = repository();
    await record(root);
    const first = await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' }),
    );
    await record(root);
    const second = await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'round_close' }),
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.chain.previous_segment_digest_sha256).toBe(first?.segment_digest_sha256);
    expect(second?.sequence_range).toEqual({ first: 2, last: 2 });
    expect(second?.event_ids).not.toContain(first?.event_ids[0]);
  });

  it('recovers a torn trailing append instead of trusting a partial record', async () => {
    const root = repository();
    await record(root);
    await record(root);
    const path = join(root, '.devai/state/tracking/R-0042/events.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"schemaVersion":"1.0.0","eve`);

    const events = readGovernanceEvents({ repoRoot: root, round: 'R-0042' });
    expect(events).toHaveLength(2);

    // Recording continues from the last intact event rather than duplicating a sequence.
    const next = await record(root);
    expect(next.session_sequence).toBe(3);
  });
});

describe('lossless public projection', () => {
  it('represents every sealed canonical event exactly once, by id', async () => {
    const root = repository();
    await record(root, { authority_session_id: SESSION_A });
    await record(root, { authority_session_id: SESSION_B });
    await record(root, { authority_session_id: SESSION_A });
    await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' }),
    );

    const batch = buildProjectionBatch({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' });
    if (batch === undefined) expect.unreachable('sealed events must produce a batch');

    const canonical = readGovernanceEvents({ repoRoot: root, round: 'R-0042' });
    expect(validators.governanceProjectionBatch(batch)).toBe(true);
    expect([...batch.event_ids].sort()).toEqual([...canonical.map((e) => e.event_id)].sort());
    expect(batch.entries).toHaveLength(canonical.length);
    expect(new Set(batch.event_ids).size).toBe(batch.event_ids.length);

    // Per-session ordering is preserved; no global order is invented.
    const sessions = batch.sessions.map((session) => session.authority_session_id).sort();
    expect(sessions).toEqual([SESSION_A, SESSION_B].sort());
  });

  it('never projects unsealed events', async () => {
    const root = repository();
    await record(root);
    expect(
      buildProjectionBatch({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' }),
    ).toBeUndefined();
  });

  it('publishes a digest in place of withheld payload content', async () => {
    const root = repository();
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
    await record(root, { payload: { token: secret }, summary: 'Authorization recorded.' });
    await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' }),
    );

    const batch = buildProjectionBatch({ repoRoot: root, round: 'R-0042', reason: 'checkpoint' });
    const rendered = JSON.stringify(batch);
    expect(rendered).not.toContain(secret);
    expect(batch?.entries.at(0)?.payload_digest_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('readiness independence', () => {
  it('keeps recording and reports pending projection for an entire offline round', async () => {
    const root = repository();
    for (let index = 0; index < 4; index += 1) await record(root);
    await withAuthorityHostTestScope(() =>
      sealGovernanceSegment({ repoRoot: root, round: 'R-0042', reason: 'round_close' }),
    );

    const status = governanceTrackingStatus({ repoRoot: root, round: 'R-0042' });
    expect(validators.governanceProjectionStatus(status)).toBe(true);
    expect(status.canonical_events).toBe(4);
    expect(status.projected_events).toBe(0);
    expect(status.pending_events).toBe(4);
    expect(status.projection).toBe('pending');
    expect(status.issue).toBeNull();
    expect(status.divergence).toBe(false);
  });

  it('reports a disabled opt-out as valid with no canonical state at all', () => {
    const status = governanceTrackingStatus({ repoRoot: repository(), round: 'R-0042' });
    expect(status.mode).toBe('disabled');
    expect(status.activation).toBe('absent');
    expect(status.canonical_events).toBe(0);
    expect(status.projection).toBe('idle');
  });
});
