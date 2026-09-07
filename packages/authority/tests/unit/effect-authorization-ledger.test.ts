import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { parsers } from '@devai-nyx/schemas';
import {
  appendEffectAuthorizationEvent,
  buildEffectAuthorizationTerminalEvent,
  computeEffectAuthorizationEventDigest,
  computeEffectAuthorizationPayloadDigest,
  deriveEffectAuthorizationEventId,
  executeAuthorizedEffect,
  resolveEffectAuthorization,
  verifyEffectAuthorizationLedger,
  type EffectAuthorizationEvent,
  type EffectAuthorizationGrantRequest,
  type EffectAuthorizationLedger,
  type EffectAuthorizationTerminalKind,
} from '../../src/runtime/effect-authorization-ledger.js';

function example<T>(name: string): T {
  const schema = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../../law/schemas', name), 'utf8'),
  ) as { examples: T[] };
  return structuredClone(schema.examples[0]) as T;
}

function fixture() {
  const grant = example<EffectAuthorizationEvent>('effect-authorization-event.schema.json');
  const ledger = example<EffectAuthorizationLedger>('effect-authorization-ledger.schema.json');
  const request: EffectAuthorizationGrantRequest = {
    authorization_event_id: grant.event_id,
    ledger_id: grant.ledger_id,
    action_id: grant.action_id,
    effect: grant.effect,
    resource: grant.resource,
    repository: grant.repository,
    candidate: grant.candidate,
    subject_role: grant.subject_role,
    consent: grant.consent,
    observed_at: '2026-09-03T00:30:00.000Z',
  };
  const events = new Map([[grant.event_id, grant]]);
  return {
    grant,
    ledger,
    request,
    events,
    resolveEvent: (entry: { event_id: string }) => events.get(entry.event_id),
  };
}

function terminate(kind: EffectAuthorizationTerminalKind) {
  const f = fixture();
  const terminal = buildEffectAuthorizationTerminalEvent(f.grant, {
    kind,
    sequence: 2,
    previous_event_digest_sha256: f.ledger.head.event_digest_sha256,
    recorded_at: f.request.observed_at,
    consumed_by_state_id: 'RLS-0123456789abcdef',
    reason_code: 'owner-revoked',
  });
  f.events.set(terminal.event_id, terminal);
  return { ...f, terminal, ledger: appendEffectAuthorizationEvent(f.ledger, terminal) };
}

// Independently reseal tampered fixtures so schema-valid attacks reach the semantic verifier.
function seal(event: EffectAuthorizationEvent): EffectAuthorizationEvent {
  const payload: Record<string, unknown> = { ...event };
  delete payload['event_id'];
  delete payload['payload_digest_sha256'];
  const digest = canonicalSha256(payload);
  return { ...event, event_id: `EA-${digest.slice(0, 16)}`, payload_digest_sha256: digest };
}

function ledgerFor(events: EffectAuthorizationEvent[]): EffectAuthorizationLedger {
  const entries = events.map((event) => ({
    sequence: event.sequence,
    event_id: event.event_id,
    event_digest_sha256: canonicalSha256(event),
    previous_event_digest_sha256: event.previous_event_digest_sha256,
    kind: event.kind,
    references_event_id: event.grant_event_id,
  }));
  const last = entries.at(-1);
  if (!last) throw Error('fixture needs an event');
  return {
    ...fixture().ledger,
    entries,
    head: {
      sequence: last.sequence,
      event_id: last.event_id,
      event_digest_sha256: last.event_digest_sha256,
    },
  };
}

function verifyEvents(events: EffectAuthorizationEvent[]) {
  const ledger = ledgerFor(events);
  expect(parsers.effectAuthorizationLedger.safeParse(ledger).ok).toBe(true);
  for (const event of events)
    expect(parsers.effectAuthorizationEvent.safeParse(event).ok).toBe(true);
  return verifyEffectAuthorizationLedger(ledger, (entry) =>
    events.find((event) => event.event_id === entry.event_id),
  );
}

describe('one-time effect authorization runtime', () => {
  it('rejects resealed events belonging to a different ledger', () => {
    const event = seal({ ...fixture().grant, ledger_id: 'EAL-other-release' });
    expect(verifyEvents([event])).toMatchObject({
      ok: false,
      errors: ['eal-event-ledger-id-mismatch'],
    });
  });

  it.each(['2026-09-03T00:00:00.000Z', '2026-09-02T23:59:59.999Z'])(
    'rejects a grant ending at or before its start: %s',
    (expires_at) => {
      const event = seal({ ...fixture().grant, expires_at });
      expect(verifyEvents([event])).toMatchObject({
        ok: false,
        errors: ['eal-grant-live-window-invalid'],
      });
    },
  );

  it.each(['2026-09-02T23:59:59.999Z', '2026-09-03T01:00:00.000Z'])(
    'rejects a resealed consumption outside the live window: %s',
    (recorded_at) => {
      const f = terminate('consumed');
      const event = seal({ ...f.terminal, recorded_at });
      expect(verifyEvents([f.grant, event])).toMatchObject({
        ok: false,
        errors: ['eal-consume-outside-live-window'],
      });
    },
  );

  it('rejects a terminal record referring to an absent grant', () => {
    const f = terminate('revoked');
    const terminal = seal({ ...f.terminal, grant_event_id: 'EA-0000000000000000' });
    expect(verifyEvents([f.grant, terminal])).toMatchObject({
      ok: false,
      errors: ['eal-grant-reference-unresolved'],
    });
  });

  it('rejects a second consumption even when every event hash and chain link is valid', () => {
    const f = terminate('consumed');
    const replay = seal({
      ...f.terminal,
      sequence: 3,
      previous_event_digest_sha256: canonicalSha256(f.terminal),
      consumed_by_state_id: 'RLS-1111111111111111',
    });
    expect(verifyEvents([f.grant, f.terminal, replay])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'eal-grant-has-multiple-terminal-events',
        'eal-terminal-after-terminal',
        'eal-grant-consumed-more-than-once',
      ]),
    });
  });

  it('rejects revocation after consumption without misreporting another consumption', () => {
    const f = terminate('consumed');
    const revoked = terminate('revoked').terminal;
    const event = seal({
      ...revoked,
      sequence: 3,
      previous_event_digest_sha256: canonicalSha256(f.terminal),
    });
    const result = verifyEvents([f.grant, f.terminal, event]);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'eal-terminal-after-terminal',
        'eal-grant-has-multiple-terminal-events',
      ]),
    });
    if (result.ok) throw Error('terminal replay accepted');
    expect(result.errors).not.toContain('eal-grant-consumed-more-than-once');
  });

  it('rejects terminal authority transferred to a different exact artifact', () => {
    const f = terminate('consumed');
    const event = seal({
      ...f.terminal,
      resource: { ...f.terminal.resource, exact_identifier: '@aarusso-nyx/devai@9.9.9' },
    });
    expect(verifyEvents([f.grant, event])).toMatchObject({
      ok: false,
      errors: ['eal-grant-identity-mismatch'],
    });
  });

  it('rejects reordered chains, duplicate sequences, and an incorrect final head', () => {
    const f = terminate('consumed');
    const later = seal({
      ...terminate('revoked').terminal,
      sequence: 3,
      previous_event_digest_sha256: canonicalSha256(f.terminal),
    });
    const reordered = verifyEvents([f.grant, later, f.terminal]);
    expect(reordered).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'eal-sequence-not-contiguous-from-one',
        'eal-previous-digest-mismatch',
      ]),
    });
    const duplicated = seal({ ...later, sequence: 2 });
    expect(verifyEvents([f.grant, f.terminal, duplicated])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'eal-duplicate-sequence',
        'eal-sequence-not-contiguous-from-one',
      ]),
    });
    for (const head of [
      { ...f.ledger.head, sequence: 1 },
      { ...f.ledger.head, event_id: f.grant.event_id },
      { ...f.ledger.head, event_digest_sha256: 'a'.repeat(64) },
    ])
      expect(verifyEffectAuthorizationLedger({ ...f.ledger, head }, f.resolveEvent)).toMatchObject({
        ok: false,
        errors: ['eal-head-not-final-entry'],
      });
  });

  it('checks event bytes against the entry and independently sealed payload', () => {
    const f = terminate('consumed');
    for (const [change, error] of [
      [{ payload_digest_sha256: 'a'.repeat(64) }, 'eal-event-payload-digest-mismatch'],
      [{ event_id: 'EA-0000000000000000' }, 'eal-event-id-mismatch'],
      [{ sequence: 3 }, 'eal-entry-event-sequence-mismatch'],
      [
        { previous_event_digest_sha256: 'a'.repeat(64) },
        'eal-entry-event-previous-digest-mismatch',
      ],
    ] as const) {
      const event = { ...f.terminal, ...change };
      expect(parsers.effectAuthorizationEvent.safeParse(event).ok).toBe(true);
      expect(
        verifyEffectAuthorizationLedger(f.ledger, (entry) =>
          entry.event_id === f.grant.event_id ? f.grant : event,
        ),
      ).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([error, 'eal-event-digest-mismatch']),
      });
    }
  });

  it('refuses append against a stale head without modifying the ledger', () => {
    const f = terminate('consumed');
    const before = structuredClone(f.ledger);
    expect(() => appendEffectAuthorizationEvent(f.ledger, f.terminal)).toThrow(
      'does not extend the exact ledger head',
    );
    expect(f.ledger).toEqual(before);
  });

  it('does not persist or execute when authorization is absent', async () => {
    const f = fixture();
    const adapter = vi.fn();
    const appendConsumption = vi.fn();
    expect(
      await executeAuthorizedEffect({
        ...f,
        request: { ...f.request, authorization_event_id: 'EA-0000000000000000' },
        consumed_by_state_id: 'RLS-0123456789abcdef',
        appendConsumption,
        adapter,
      }),
    ).toEqual({ ok: false, phase: 'authorization', code: 'absent-effect-authorization' });
    expect(adapter).not.toHaveBeenCalled();
    expect(appendConsumption).not.toHaveBeenCalled();
  });

  it('verifies the independently sealed contract example and resolves its exact grant', () => {
    const f = fixture();
    expect(computeEffectAuthorizationPayloadDigest(f.grant)).toBe(f.grant.payload_digest_sha256);
    expect(deriveEffectAuthorizationEventId(f.grant.payload_digest_sha256)).toBe(f.grant.event_id);
    expect(computeEffectAuthorizationEventDigest(f.grant)).toBe(f.ledger.head.event_digest_sha256);
    const result = resolveEffectAuthorization(f.ledger, f.resolveEvent, f.request);
    expect(result).toMatchObject({
      ok: true,
      grant: f.grant,
      grant_event_digest_sha256: f.ledger.head.event_digest_sha256,
    });
    if (!result.ok) throw Error('grant did not resolve');
    expect(result.verification.events.size).toBe(1);
    expect(result.verification.terminal_by_grant.size).toBe(0);
  });

  it.each([null, [], 3, 'event'])('refuses a non-object payload: %j', (value) => {
    expect(() => computeEffectAuthorizationPayloadDigest(value)).toThrow(TypeError);
  });

  it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ''])(
    'refuses malformed digest %s',
    (value) => {
      expect(() => deriveEffectAuthorizationEventId(value)).toThrow(TypeError);
    },
  );

  it.each([
    ['2026-09-02T23:59:59.999Z', false],
    ['2026-09-03T00:00:00.000Z', true],
    ['2026-09-03T00:59:59.999Z', true],
    ['2026-09-03T01:00:00.000Z', false],
    ['invalid', false],
  ])('enforces the half-open grant window at %s', (observed_at, allowed) => {
    const f = fixture();
    const result = resolveEffectAuthorization(f.ledger, f.resolveEvent, {
      ...f.request,
      observed_at: String(observed_at),
    });
    expect(result.ok).toBe(allowed);
    if (!allowed) expect(result).toEqual({ ok: false, code: 'expired-effect-authorization' });
  });

  it.each([
    ['consumed', 'consumed-effect-authorization'],
    ['rejected', 'consumed-effect-authorization'],
    ['revoked', 'revoked-effect-authorization'],
    ['expired', 'expired-effect-authorization'],
  ] as const)('refuses replay after %s', (kind, code) => {
    const f = terminate(kind);
    expect(verifyEffectAuthorizationLedger(f.ledger, f.resolveEvent).ok).toBe(true);
    expect(resolveEffectAuthorization(f.ledger, f.resolveEvent, f.request)).toEqual({
      ok: false,
      code,
    });
    expect(f.ledger.entries).toHaveLength(2);
    expect(f.ledger.head.event_id).toBe(f.terminal.event_id);
  });

  it('aggregates missing event content and refuses the authorization', () => {
    const f = fixture();
    const unavailable = () => {
      throw Error('store unavailable');
    };
    expect(verifyEffectAuthorizationLedger(f.ledger, unavailable)).toMatchObject({
      ok: false,
      errors: ['eal-event-content-unresolved'],
    });
    expect(resolveEffectAuthorization(f.ledger, unavailable, f.request)).toMatchObject({
      ok: false,
      code: 'authorization-ledger-invalid',
    });
    expect(verifyEffectAuthorizationLedger({}, f.resolveEvent)).toMatchObject({
      ok: false,
      errors: ['eal-semantic-verification-not-performed'],
    });
  });

  it('requires exact request identity and a grant in the selected ledger', () => {
    const f = fixture();
    expect(
      resolveEffectAuthorization(f.ledger, f.resolveEvent, {
        ...f.request,
        ledger_id: 'another-ledger',
      }),
    ).toEqual({ ok: false, code: 'absent-effect-authorization' });
    expect(
      resolveEffectAuthorization(f.ledger, f.resolveEvent, {
        ...f.request,
        authorization_event_id: 'EA-0000000000000000',
      }),
    ).toEqual({ ok: false, code: 'absent-effect-authorization' });
    for (const change of [
      { action_id: 'release tag' },
      { effect: 'read' as const },
      { resource: { ...f.request.resource, exact_identifier: 'different-artifact' } },
      { repository: { ...f.request.repository, tree: 'a'.repeat(40) } },
      { candidate: { ...f.request.candidate, version: '9.9.9' } },
      { subject_role: 'auditor' as const },
      { consent: { ...f.request.consent, allow_publish: !f.request.consent.allow_publish } },
    ])
      expect(
        resolveEffectAuthorization(f.ledger, f.resolveEvent, { ...f.request, ...change }),
      ).toEqual({ ok: false, code: 'authorization-identity-mismatch' });
  });

  it('persists consumption before entering the effect adapter', async () => {
    const f = fixture();
    const order: string[] = [];
    const result = await executeAuthorizedEffect({
      ...f,
      consumed_by_state_id: 'RLS-0123456789abcdef',
      appendConsumption: async (event, ledger) => {
        order.push('persist');
        f.events.set(event.event_id, event);
        expect(resolveEffectAuthorization(ledger, f.resolveEvent, f.request)).toEqual({
          ok: false,
          code: 'consumed-effect-authorization',
        });
        await Promise.resolve();
        order.push('durable');
      },
      adapter: () => {
        order.push('effect');
        return 'published-by-fixture';
      },
    });
    expect(order).toEqual(['persist', 'durable', 'effect']);
    expect(result).toMatchObject({
      ok: true,
      value: 'published-by-fixture',
      consumed_event: { kind: 'consumed', consumed_by_state_id: 'RLS-0123456789abcdef' },
    });
  });

  it('never enters the adapter if consumption cannot be persisted', async () => {
    const adapter = vi.fn();
    const cause = Error('disk unavailable');
    const result = await executeAuthorizedEffect({
      ...fixture(),
      consumed_by_state_id: 'RLS-0123456789abcdef',
      appendConsumption: () => {
        throw cause;
      },
      adapter,
    });
    expect(result).toEqual({
      ok: false,
      phase: 'consumption',
      code: 'effect-authorization-consumption-failed',
      cause,
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('keeps the grant consumed when the external adapter fails', async () => {
    const f = fixture();
    const cause = Error('external outcome unknown');
    const result = await executeAuthorizedEffect({
      ...f,
      consumed_by_state_id: 'RLS-0123456789abcdef',
      appendConsumption: (event) => {
        f.events.set(event.event_id, event);
      },
      adapter: () => {
        throw cause;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      phase: 'adapter',
      code: 'authorized-effect-adapter-failed',
      cause,
    });
    if (result.ok || !result.ledger) throw Error('missing consumed ledger');
    expect(resolveEffectAuthorization(result.ledger, f.resolveEvent, f.request)).toEqual({
      ok: false,
      code: 'consumed-effect-authorization',
    });
  });
});
