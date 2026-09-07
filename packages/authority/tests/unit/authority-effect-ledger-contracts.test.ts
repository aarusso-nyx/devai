import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { parsers } from '@devai-nyx/schemas';
import {
  buildEffectAuthorizationTerminalEvent,
  verifyEffectAuthorizationLedger,
  type EffectAuthorizationEvent,
  type EffectAuthorizationLedger,
  type EffectAuthorizationTerminalKind,
} from '../../src/runtime/effect-authorization-ledger.js';

// Effect ledger verification contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's. Fixtures
// are the schema examples, independently resealed after each tamper so that only the
// semantic verifier can refuse them.

function example<T>(name: string): T {
  const schema = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../../law/schemas', name), 'utf8'),
  ) as { examples: T[] };
  return structuredClone(schema.examples[0]) as T;
}

function seal(event: EffectAuthorizationEvent): EffectAuthorizationEvent {
  const payload: Record<string, unknown> = { ...event };
  delete payload['event_id'];
  delete payload['payload_digest_sha256'];
  const digest = canonicalSha256(payload);
  return { ...event, event_id: `EA-${digest.slice(0, 16)}`, payload_digest_sha256: digest };
}

const grant = () => example<EffectAuthorizationEvent>('effect-authorization-event.schema.json');

function terminal(
  base: EffectAuthorizationEvent,
  kind: EffectAuthorizationTerminalKind,
  sequence: number,
  previous: string,
  recorded_at = '2026-09-03T00:30:00.000Z',
) {
  return buildEffectAuthorizationTerminalEvent(base, {
    kind,
    sequence,
    previous_event_digest_sha256: previous,
    recorded_at,
    consumed_by_state_id: 'RLS-0123456789abcdef',
    reason_code: 'owner-revoked',
  });
}

function entry<T>(entries: readonly T[], index: number): T {
  const value = entries[index];
  if (value === undefined) throw new Error(`fixture has no entry ${String(index)}`);
  return value;
}

function entriesFor(events: readonly EffectAuthorizationEvent[]) {
  return events.map((event) => ({
    sequence: event.sequence,
    event_id: event.event_id,
    event_digest_sha256: canonicalSha256(event),
    previous_event_digest_sha256: event.previous_event_digest_sha256,
    kind: event.kind,
    references_event_id: event.grant_event_id,
  }));
}

function verify(
  events: readonly EffectAuthorizationEvent[],
  tamper: (entries: ReturnType<typeof entriesFor>) => void = () => undefined,
) {
  const entries = entriesFor(events);
  tamper(entries);
  const last = entries.at(-1);
  if (!last) throw new Error('fixture needs an event');
  const ledger: EffectAuthorizationLedger = {
    ...example<EffectAuthorizationLedger>('effect-authorization-ledger.schema.json'),
    entries,
    head: {
      sequence: last.sequence,
      event_id: last.event_id,
      event_digest_sha256: last.event_digest_sha256,
    },
  };
  expect(parsers.effectAuthorizationLedger.safeParse(ledger).ok).toBe(true);
  for (const event of events)
    expect(parsers.effectAuthorizationEvent.safeParse(event).ok).toBe(true);
  // Events resolve by sequence so a tampered entry id is observed by the verifier itself.
  return verifyEffectAuthorizationLedger(ledger, (entry) =>
    events.find((event) => event.sequence === entry.sequence),
  );
}

/** A valid grant followed by one sealed terminal event. */
function chain(kind: EffectAuthorizationTerminalKind, recorded_at?: string) {
  const first = grant();
  const second = terminal(first, kind, 2, canonicalSha256(first), recorded_at);
  return { first, second };
}

describe('entry and event agreement', () => {
  // Mutants 6484, 6488, 6490, 6502: the ledger entry must repeat the event's kind, grant
  // reference and id; each disagreement is reported on its own.
  it('reports an entry whose kind differs from its event', () => {
    const { first, second } = chain('consumed');
    expect(
      verify([first, second], (entries) => {
        entry(entries, 1).kind = 'revoked';
      }),
    ).toMatchObject({ ok: false, errors: ['eal-entry-event-kind-mismatch'] });
  });

  it('reports an entry whose grant reference differs from its event', () => {
    const { first, second } = chain('consumed');
    expect(
      verify([first, second], (entries) => {
        entry(entries, 1).references_event_id = 'EA-0000000000000000';
      }),
    ).toMatchObject({ ok: false, errors: ['eal-entry-event-grant-reference-mismatch'] });
  });

  it('reports an entry whose id differs from its event id', () => {
    const first = grant();
    expect(
      verify([first], (entries) => {
        entry(entries, 0).event_id = 'EA-0000000000000000';
      }),
    ).toMatchObject({ ok: false, errors: ['eal-event-id-mismatch'] });
  });
});

describe('grant references', () => {
  // Mutant 6548: a terminal event may reference only a grant, never another terminal.
  it('refuses a terminal event referencing an earlier terminal event', () => {
    const { first, second } = chain('consumed');
    const third = seal({
      ...terminal(first, 'revoked', 3, canonicalSha256(second)),
      grant_event_id: second.event_id,
    });
    expect(verify([first, second, third])).toMatchObject({
      ok: false,
      errors: ['eal-grant-reference-unresolved'],
    });
  });

  // Resealing the reordered chain invalidates the forward grant reference. This checks
  // rejection of that population, not isolated coverage of the sequence-order guard.
  it('refuses a resequenced chain with an unresolved forward grant reference', () => {
    // A valid chain, re-sequenced so the consumption precedes the grant it references.
    const { first, second } = chain('consumed');
    const earlier = seal({ ...second, sequence: 1, previous_event_digest_sha256: null });
    const later = seal({
      ...first,
      sequence: 2,
      previous_event_digest_sha256: canonicalSha256(earlier),
    });
    const bound = seal({ ...earlier, grant_event_id: later.event_id });
    const relinked = seal({ ...later, previous_event_digest_sha256: canonicalSha256(bound) });
    const result = verify([bound, relinked]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContain('eal-grant-reference-unresolved');
  });
});

describe('terminal event windows', () => {
  // Mutant 6571: only a consumption is bound to the grant's live window; a revocation after
  // expiry is a valid terminal event.
  it('accepts a revocation recorded after the grant expired', () => {
    const { first, second } = chain('revoked', '2026-09-03T02:00:00.000Z');
    expect(verify([first, second])).toMatchObject({ ok: true });
    const consumedLate = chain('consumed', '2026-09-03T02:00:00.000Z');
    expect(verify([consumedLate.first, consumedLate.second])).toMatchObject({
      ok: false,
      errors: ['eal-consume-outside-live-window'],
    });
  });
});

describe('terminal event construction', () => {
  // Mutants 6721, 6723, 6724: a consumption carries its consuming state and never a
  // reason; a revocation carries its reason and never a consuming state, even when the
  // request supplies both.
  it('projects only the fields of each terminal kind', () => {
    const first = grant();
    const consumed = terminal(first, 'consumed', 2, canonicalSha256(first));
    expect(consumed).toMatchObject({ consumed_by_state_id: 'RLS-0123456789abcdef' });
    expect(Object.hasOwn(consumed, 'reason_code')).toBe(false);
    const revoked = terminal(first, 'revoked', 2, canonicalSha256(first));
    expect(revoked).toMatchObject({ reason_code: 'owner-revoked' });
    expect(Object.hasOwn(revoked, 'consumed_by_state_id')).toBe(false);
  });
});
