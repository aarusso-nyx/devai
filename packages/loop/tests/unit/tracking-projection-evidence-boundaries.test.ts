import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  buildProjectionBatch,
  governanceTrackingStatus,
  recordGovernanceEvent,
  sealGovernanceSegments,
  readDeliveryState,
  writeDeliveryState,
  writeRoundTrackingActivation,
  type GovernanceEventDraft,
  type DeliveryState,
  type RoundTrackingActivation,
} from '../../src/tracking/index.js';
const roots: string[] = [];
const ROUND = 'R-0042';
const SESSION = 'AUTH-SESSION-0f1e2d3c4b5a69788796';
const OTHER = 'AUTH-SESSION-1a2b3c4d5e6f70819273';
const NOW = '2026-09-08T12:00:00.000Z';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'devai-tracking-projection-'));
  roots.push(path);
  return path;
}
function options(repoRoot: string) {
  return { repoRoot, round: ROUND };
}
function event(repoRoot: string, overrides: Partial<GovernanceEventDraft> = {}) {
  return recordGovernanceEvent({
    repoRoot,
    repositoryId: 'devai',
    recordedAt: NOW,
    draft: {
      round_id: ROUND,
      authority_session_id: SESSION,
      session_source: 'session-state',
      role: 'engineer',
      kind: 'action_completed',
      summary: 'Exact mediated action completed.',
      coverage: { mediated: true },
      payload: { detail: 'withheld payload' },
      ...overrides,
    },
  });
}
function canonicalBytes(repoRoot: string) {
  return readFileSync(join(repoRoot, '.devai/state/tracking', ROUND, 'events.jsonl'));
}
function delivery(repoRoot: string, change: Partial<DeliveryState>) {
  writeDeliveryState({
    ...options(repoRoot),
    state: { ...readDeliveryState(options(repoRoot)), ...change },
  });
}

describe('projection state counts exact canonical identities without rewriting evidence', () => {
  it.each(['duplicate', 'unknown'] as const)(
    'does not treat %s delivery identifiers as additional projected events',
    async (kind) => {
      const base = root();
      await withAuthorityHostTestScope(() => {
        const first = event(base);
        event(base, { summary: 'Another action completed.' });
        const before = canonicalBytes(base);
        delivery(base, {
          projected_event_ids:
            kind === 'duplicate'
              ? [first.event_id, first.event_id]
              : [first.event_id, 'GEV-0000000000000000'],
        });
        const status = governanceTrackingStatus(options(base));
        expect(status.canonical_events).toBe(2);
        expect(status.projected_events).toBe(1);
        expect(status.pending_events).toBe(1);
        expect(status.projection).toBe('pending');
        expect(canonicalBytes(base)).toEqual(before);
      });
    },
  );
  it.each([
    'authentication',
    'permission',
    'rate-limit',
    'validation',
    'missing-resource',
    'service',
    'ambiguous-response',
  ] as const)(
    'reports %s delivery failure separately from canonical action evidence',
    async (classification) => {
      const base = root();
      await withAuthorityHostTestScope(() => {
        event(base, { status: 'pass' });
        const before = canonicalBytes(base);
        const error = {
          classification,
          observed_at: NOW,
          attempts: 3,
          public_safe_detail: 'Remote observation unavailable.',
        };
        delivery(base, {
          issue: 17,
          divergence: true,
          divergence_detail: 'Observed projection differs.',
          last_error: error,
        });
        const status = governanceTrackingStatus(options(base));
        expect(status.projection).toBe(
          classification === 'rate-limit' || classification === 'service'
            ? 'unreachable'
            : 'failed',
        );
        expect(status).toMatchObject({
          canonical_events: 1,
          projected_events: 0,
          pending_events: 1,
          issue: 17,
          divergence: true,
          divergence_detail: 'Observed projection differs.',
          last_error: error,
        });
        expect(canonicalBytes(base)).toEqual(before);
      });
    },
  );
  it('reports idle and synchronized delivery before interpreting a stale remote error', async () => {
    const base = root();
    await withAuthorityHostTestScope(() => {
      delivery(base, {
        last_error: {
          classification: 'service',
          observed_at: NOW,
          attempts: 1,
          public_safe_detail: null,
        },
      });
      expect(governanceTrackingStatus(options(base)).projection).toBe('idle');
      const recorded = event(base);
      delivery(base, { projected_event_ids: [recorded.event_id] });
      expect(governanceTrackingStatus(options(base))).toMatchObject({
        projection: 'synced',
        canonical_events: 1,
        projected_events: 1,
        pending_events: 0,
      });
    });
  });
  it.each(['active', 'frozen', 'disabled'] as const)(
    'preserves explicit %s activation and target issue independently of delivery state',
    async (state) => {
      const base = root();
      await withAuthorityHostTestScope(() => {
        const activation: RoundTrackingActivation = {
          schemaVersion: '1.0.0',
          round_id: ROUND,
          repository_id: 'devai',
          state,
          adapter: {
            id: 'github-issues',
            adapter_version: '1.0.0',
            package_version: '1.3.0',
            config_digest_sha256: 'a'.repeat(64),
            workflow_digest_sha256: 'b'.repeat(64),
          },
          target: { repository: 'example/devai', issue_number: 31 },
          authorization: {
            authority_session_id: SESSION,
            role: 'owner',
            publish_flag: true,
            authorized_at: NOW,
          },
          disclosure_profile: 'public-safe-v1',
          pending_policy: 'freeze',
          disabled: null,
        };
        writeRoundTrackingActivation({ ...options(base), activation });
        expect(governanceTrackingStatus(options(base))).toMatchObject({
          mode: 'github-issues',
          activation: state,
          issue: 31,
        });
        delivery(base, { issue: 42 });
        expect(governanceTrackingStatus(options(base)).issue).toBe(42);
      });
    },
  );
  it('distinguishes a bound capability from an activated round', () => {
    const base = root();
    expect(governanceTrackingStatus({ ...options(base), bound: true })).toMatchObject({
      mode: 'github-issues',
      activation: 'bound-inactive',
      projection: 'idle',
    });
    expect(governanceTrackingStatus({ ...options(base), bound: false })).toMatchObject({
      mode: 'disabled',
      activation: 'absent',
      projection: 'idle',
    });
  });
});

describe('projection batches retain only sealed undelivered evidence with exact bindings', () => {
  it.each(['checkpoint', 'round_close', 'tracking_disabled', 'reconciliation'] as const)(
    'binds %s reason and exact versions while retaining per-session sequence',
    async (reason) => {
      const base = root();
      await withAuthorityHostTestScope(() => {
        const first = event(base, {
          status: 'pass',
          commit_binding: {
            base_commit: 'a'.repeat(40),
            base_tree: 'b'.repeat(40),
            candidate_commit: 'c'.repeat(40),
            candidate_tree: 'd'.repeat(40),
          },
        });
        const second = event(base, {
          authority_session_id: OTHER,
          status: 'review',
          commit_binding: {
            base_commit: 'e'.repeat(40),
            base_tree: 'f'.repeat(40),
            candidate_commit: null,
            candidate_tree: null,
          },
        });
        expect(buildProjectionBatch({ ...options(base), reason })).toBeUndefined();
        const segments = sealGovernanceSegments({
          ...options(base),
          reason: 'checkpoint',
          sealedAt: NOW,
        });
        event(base, { summary: 'Unsealed trailing action.' });
        const before = canonicalBytes(base);
        const batch = buildProjectionBatch({
          ...options(base),
          reason,
          adapterVersion: '1.2.3',
          packageVersion: '1.5.0',
        });
        expect(batch).toMatchObject({
          repository_id: 'devai',
          round_id: ROUND,
          reason,
          adapter: { id: 'github-issues', adapter_version: '1.2.3', package_version: '1.5.0' },
          event_ids: [first.event_id, second.event_id],
          sessions: [
            { authority_session_id: SESSION, first: 1, last: 1 },
            { authority_session_id: OTHER, first: 1, last: 1 },
          ],
          projected_at: null,
        });
        expect([...(batch?.segment_digests_sha256 ?? [])].sort()).toEqual(
          segments.map((segment) => segment.segment_digest_sha256).sort(),
        );
        expect(batch?.entries).toEqual(
          [first, second].map((value, index) => ({
            event_id: value.event_id,
            role: value.role,
            kind: value.kind,
            status: value.status,
            public_safe_summary: value.public_safe_summary,
            commit: (index === 0 ? 'c' : 'e').repeat(40),
            tree: (index === 0 ? 'd' : 'f').repeat(40),
            evidence_digests_sha256: [],
            payload_digest_sha256: value.payload_digest_sha256,
            mediated: true,
          })),
        );
        expect(JSON.stringify(batch)).not.toContain('withheld payload');
        expect(canonicalBytes(base)).toEqual(before);
        delivery(base, { projected_event_ids: [first.event_id] });
        const remaining = buildProjectionBatch({ ...options(base), reason });
        expect(remaining?.event_ids).toEqual([second.event_id]);
        expect(remaining?.sessions).toEqual([{ authority_session_id: OTHER, first: 1, last: 1 }]);
        delivery(base, { projected_event_ids: [first.event_id, second.event_id] });
        expect(buildProjectionBatch({ ...options(base), reason })).toBeUndefined();
      });
    },
  );
});
