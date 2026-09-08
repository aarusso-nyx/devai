import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  governanceEventDigest,
  governanceEventId,
  type GovernanceEvent,
  type GovernanceEventDraft,
} from '../../src/tracking/events.js';
import {
  readGovernanceEvents,
  recordGovernanceEvent,
  sealGovernanceSegments,
  trackingEventsPath,
} from '../../src/tracking/store.js';

let root: string;
const round = 'R-0042';
const sessionA = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const sessionB = 'AUTH-SESSION-1a2b3c4d5e6f70819273';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-tracking-integrity-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function draft(session = sessionA): GovernanceEventDraft {
  return {
    round_id: round,
    authority_session_id: session,
    session_source: 'session-state',
    role: 'engineer',
    kind: 'action_completed',
    summary: 'Verified local action.',
    coverage: { mediated: true },
    payload: { action: 'local' },
  };
}
function record(session = sessionA) {
  return withAuthorityHostTestScope(() =>
    recordGovernanceEvent({
      repoRoot: root,
      repositoryId: 'devai',
      draft: draft(session),
      recordedAt: '2026-09-08T12:00:00Z',
    }),
  );
}
function read() {
  return withAuthorityHostTestScope(() => readGovernanceEvents({ repoRoot: root, round }));
}
function replace(events: unknown[]) {
  writeFileSync(
    trackingEventsPath(root, round),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}
function reidentify(event: GovernanceEvent): GovernanceEvent {
  const { event_id: _old, ...base } = event;
  return { ...base, event_id: governanceEventId(base) };
}

describe('governance append-log identity and session continuity', () => {
  it('reads an absent log without inventing events or proofs', async () => {
    expect(await read()).toEqual([]);
    expect(
      await withAuthorityHostTestScope(() =>
        sealGovernanceSegments({ repoRoot: root, round, reason: 'checkpoint' }),
      ),
    ).toEqual([]);
  });

  it.each(['public_safe_summary', 'payload_digest_sha256', 'event_id'] as const)(
    'refuses altered %s before appending any bytes',
    async (field) => {
      const original = await record();
      const changed = {
        ...original,
        [field]:
          field === 'public_safe_summary'
            ? 'Altered claim.'
            : field === 'event_id'
              ? 'GEV-0000000000000000'
              : 'f'.repeat(64),
      };
      replace([changed]);
      const before = readFileSync(trackingEventsPath(root, round));
      await expect(read()).rejects.toThrow('GOVERNANCE_EVENT_IDENTITY_MISMATCH:1');
      await expect(record()).rejects.toThrow('GOVERNANCE_EVENT_IDENTITY_MISMATCH:1');
      expect(readFileSync(trackingEventsPath(root, round))).toEqual(before);
    },
  );

  it.each(['session_sequence', 'previous_event_digest_sha256'] as const)(
    'refuses recomputed IDs with broken %s',
    async (field) => {
      const first = await record();
      const second = await record();
      const altered = reidentify({
        ...second,
        [field]: field === 'session_sequence' ? 3 : 'f'.repeat(64),
      });
      replace([first, altered]);
      await expect(read()).rejects.toThrow('GOVERNANCE_EVENT_CHAIN_MISMATCH:2');
    },
  );

  it('rejects duplicated complete records instead of treating them as replay', async () => {
    const first = await record();
    replace([first, first]);
    await expect(read()).rejects.toThrow('GOVERNANCE_EVENT_CHAIN_MISMATCH:2');
  });

  it('binds the log to its requested round even if foreign records have valid IDs', async () => {
    const first = await record();
    replace([reidentify({ ...first, round_id: 'R-0043' })]);
    await expect(read()).rejects.toThrow('GOVERNANCE_EVENT_ROUND_MISMATCH:1');
  });

  it('rejects schema-invalid complete records and identifies their physical line', async () => {
    await record();
    appendFileSync(trackingEventsPath(root, round), '\n{}\n');
    await expect(read()).rejects.toThrow('GOVERNANCE_EVENT_LOG_INVALID:3');
  });

  it('rejects malformed complete JSON while preserving the original bytes', async () => {
    await record();
    appendFileSync(trackingEventsPath(root, round), '{broken}\n');
    const before = readFileSync(trackingEventsPath(root, round));
    await expect(record()).rejects.toThrow('GOVERNANCE_EVENT_LOG_CORRUPT:2');
    expect(readFileSync(trackingEventsPath(root, round))).toEqual(before);
  });

  it.each(['{"partial":', '{"looks":"complete"}'])(
    'discards only uncommitted trailing bytes: %s',
    async (trailing) => {
      const first = await record();
      appendFileSync(trackingEventsPath(root, round), trailing);
      expect(await read()).toEqual([first]);
      const second = await record();
      expect(await read()).toEqual([first, second]);
      expect(second.previous_event_digest_sha256).toBe(governanceEventDigest(first));
      expect(readFileSync(trackingEventsPath(root, round), 'utf8')).toBe(
        JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n',
      );
    },
  );

  it('maintains separate interleaved chains and seals each session once', async () => {
    const a1 = await record();
    const b1 = await record(sessionB);
    const a2 = await record();
    expect(await read()).toEqual([a1, b1, a2]);
    expect(a2.previous_event_digest_sha256).toBe(governanceEventDigest(a1));
    expect(b1.previous_event_digest_sha256).toBeNull();
    const segments = await withAuthorityHostTestScope(() =>
      sealGovernanceSegments({
        repoRoot: root,
        round,
        reason: 'recovery',
        sealedAt: '2026-09-08T12:00:01Z',
      }),
    );
    expect(
      segments.map((s) => [s.authority_session_id, s.event_ids, s.sequence_range, s.seal_reason]),
    ).toEqual([
      [sessionA, [a1.event_id, a2.event_id], { first: 1, last: 2 }, 'recovery'],
      [sessionB, [b1.event_id], { first: 1, last: 1 }, 'recovery'],
    ]);
    expect(
      await withAuthorityHostTestScope(() =>
        sealGovernanceSegments({ repoRoot: root, round, reason: 'checkpoint' }),
      ),
    ).toEqual([]);
  });
});
