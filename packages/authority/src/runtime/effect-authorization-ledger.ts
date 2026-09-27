import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { equal } from './contracts.js';
import type {
  AuthorizedEffectExecutionResult,
  EffectAuthorizationEvent,
  EffectAuthorizationEventResolver,
  EffectAuthorizationGrantRequest,
  EffectAuthorizationKind,
  EffectAuthorizationLedger,
  EffectAuthorizationLedgerEntry,
  EffectAuthorizationLedgerError,
  EffectAuthorizationLedgerVerification,
  EffectAuthorizationResolution,
  EffectAuthorizationTerminalKind,
} from './effect-authorization-types.js';
export type {
  AuthorizedEffectExecutionResult,
  EffectAuthorizationCandidate,
  EffectAuthorizationConsent,
  EffectAuthorizationEvent,
  EffectAuthorizationEventResolver,
  EffectAuthorizationGrantRequest,
  EffectAuthorizationKind,
  EffectAuthorizationLedger,
  EffectAuthorizationLedgerEntry,
  EffectAuthorizationLedgerError,
  EffectAuthorizationLedgerVerification,
  EffectAuthorizationRepository,
  EffectAuthorizationResolution,
  EffectAuthorizationResource,
  EffectAuthorizationRole,
  EffectAuthorizationTerminalKind,
  VerifiedEffectAuthorizationLedger,
} from './effect-authorization-types.js';

const TERMINAL_KINDS = new Set<EffectAuthorizationKind>([
  'consumed',
  'revoked',
  'expired',
  'rejected',
]);

const IDENTITY_KEYS = [
  'action_id',
  'effect',
  'resource',
  'repository',
  'candidate',
  'subject_role',
  'consent',
] as const;

function addError(
  errors: Set<EffectAuthorizationLedgerError>,
  error: EffectAuthorizationLedgerError,
): void {
  errors.add(error);
}

export function computeEffectAuthorizationPayloadDigest(event: unknown): string {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('effect authorization event must be an object');
  }
  const projection = { ...(event as Record<string, unknown>) };
  delete projection['event_id'];
  delete projection['payload_digest_sha256'];
  return canonicalSha256(projection);
}

export function deriveEffectAuthorizationEventId(payloadDigestSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(payloadDigestSha256)) {
    throw new TypeError('effect authorization payload digest must be lowercase SHA-256');
  }
  return `EA-${payloadDigestSha256.slice(0, 16)}`;
}

export function computeEffectAuthorizationEventDigest(event: unknown): string {
  return canonicalSha256(event);
}

function sameIdentity(
  grant: EffectAuthorizationEvent,
  terminal: EffectAuthorizationEvent,
): boolean {
  return IDENTITY_KEYS.every((key) => equal(grant[key], terminal[key]));
}

function isTerminal(kind: EffectAuthorizationKind): kind is EffectAuthorizationTerminalKind {
  return TERMINAL_KINDS.has(kind);
}

function eventInstant(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

export function verifyEffectAuthorizationLedger(
  ledgerInput: unknown,
  resolveEvent: EffectAuthorizationEventResolver,
): EffectAuthorizationLedgerVerification {
  const ledgerResult =
    parsers.effectAuthorizationLedger.safeParse<EffectAuthorizationLedger>(ledgerInput);
  if (!ledgerResult.ok) {
    return {
      ok: false,
      kernel_id: 'devai.kernel.effect-authorization-ledger.v1',
      errors: ['eal-semantic-verification-not-performed'],
    };
  }

  const ledger = ledgerResult.value;
  const errors = new Set<EffectAuthorizationLedgerError>();
  const events = new Map<string, EffectAuthorizationEvent>();
  const eventDigests = new Map<string, string>();
  const terminalByGrant = new Map<string, EffectAuthorizationEvent>();
  const entryByEventId = new Map<string, EffectAuthorizationLedgerEntry>();
  const seenSequences = new Set<number>();

  for (const [index, entry] of ledger.entries.entries()) {
    if (seenSequences.has(entry.sequence)) addError(errors, 'eal-duplicate-sequence');
    seenSequences.add(entry.sequence);
    if (entry.sequence !== index + 1) addError(errors, 'eal-sequence-not-contiguous-from-one');
    const precedingEntry = index === 0 ? undefined : ledger.entries[index - 1];
    const expectedPrevious = precedingEntry?.event_digest_sha256 ?? null;
    if (entry.previous_event_digest_sha256 !== expectedPrevious) {
      addError(errors, 'eal-previous-digest-mismatch');
    }

    let unresolved: unknown;
    try {
      unresolved = resolveEvent(entry);
    } catch {
      unresolved = undefined;
    }
    const eventResult =
      parsers.effectAuthorizationEvent.safeParse<EffectAuthorizationEvent>(unresolved);
    if (!eventResult.ok) {
      addError(errors, 'eal-event-content-unresolved');
      continue;
    }

    const event = eventResult.value;
    events.set(entry.event_id, event);
    entryByEventId.set(entry.event_id, entry);
    if (event.ledger_id !== ledger.ledger_id) addError(errors, 'eal-event-ledger-id-mismatch');
    if (event.sequence !== entry.sequence) addError(errors, 'eal-entry-event-sequence-mismatch');
    if (event.previous_event_digest_sha256 !== entry.previous_event_digest_sha256) {
      addError(errors, 'eal-entry-event-previous-digest-mismatch');
    }
    if (event.kind !== entry.kind) addError(errors, 'eal-entry-event-kind-mismatch');
    if (event.grant_event_id !== entry.references_event_id) {
      addError(errors, 'eal-entry-event-grant-reference-mismatch');
    }

    const payloadDigest = computeEffectAuthorizationPayloadDigest(event);
    if (payloadDigest !== event.payload_digest_sha256) {
      addError(errors, 'eal-event-payload-digest-mismatch');
    }
    const eventId = deriveEffectAuthorizationEventId(payloadDigest);
    if (eventId !== event.event_id || eventId !== entry.event_id) {
      addError(errors, 'eal-event-id-mismatch');
    }
    const eventDigest = computeEffectAuthorizationEventDigest(event);
    eventDigests.set(entry.event_id, eventDigest);
    if (eventDigest !== entry.event_digest_sha256) addError(errors, 'eal-event-digest-mismatch');
  }

  for (const entry of ledger.entries) {
    const event = events.get(entry.event_id);
    if (!event) continue;
    if (event.kind === 'granted') {
      const notBefore = eventInstant(event.not_before);
      const expiresAt = eventInstant(event.expires_at);
      if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
        addError(errors, 'eal-grant-live-window-invalid');
      }
      continue;
    }

    if (!isTerminal(event.kind) || event.grant_event_id === null) {
      addError(errors, 'eal-terminal-entry-without-grant-reference');
      continue;
    }
    const grant = events.get(event.grant_event_id);
    const grantEntry = entryByEventId.get(event.grant_event_id);
    if (
      !grant ||
      !grantEntry ||
      grant.kind !== 'granted' ||
      grantEntry.sequence >= entry.sequence
    ) {
      addError(errors, 'eal-grant-reference-unresolved');
      continue;
    }
    if (!sameIdentity(grant, event)) addError(errors, 'eal-grant-identity-mismatch');
    if (terminalByGrant.has(grant.event_id)) {
      addError(errors, 'eal-grant-has-multiple-terminal-events');
      addError(errors, 'eal-terminal-after-terminal');
      if (event.kind === 'consumed') addError(errors, 'eal-grant-consumed-more-than-once');
    } else {
      terminalByGrant.set(grant.event_id, event);
    }
    if (event.kind === 'consumed') {
      const consumedAt = eventInstant(event.recorded_at);
      const notBefore = eventInstant(grant.not_before);
      const expiresAt = eventInstant(grant.expires_at);
      if (consumedAt < notBefore || consumedAt >= expiresAt) {
        addError(errors, 'eal-consume-outside-live-window');
      }
    }
  }

  const finalEntry = ledger.entries.at(-1);
  if (
    finalEntry === undefined ||
    ledger.head.sequence !== finalEntry.sequence ||
    ledger.head.event_id !== finalEntry.event_id ||
    ledger.head.event_digest_sha256 !== finalEntry.event_digest_sha256
  ) {
    addError(errors, 'eal-head-not-final-entry');
  }

  if (errors.size > 0) {
    return {
      ok: false,
      kernel_id: 'devai.kernel.effect-authorization-ledger.v1',
      errors: [...errors],
    };
  }
  return {
    ok: true,
    value: {
      kernel_id: 'devai.kernel.effect-authorization-ledger.v1',
      ledger,
      events,
      event_digests: eventDigests,
      terminal_by_grant: terminalByGrant,
    },
  };
}

export function resolveEffectAuthorization(
  ledgerInput: unknown,
  resolveEvent: EffectAuthorizationEventResolver,
  request: EffectAuthorizationGrantRequest,
): EffectAuthorizationResolution {
  const verification = verifyEffectAuthorizationLedger(ledgerInput, resolveEvent);
  if (!verification.ok) {
    return {
      ok: false,
      code: 'authorization-ledger-invalid',
      ledger_errors: verification.errors,
    };
  }
  const {
    ledger,
    events,
    event_digests: eventDigests,
    terminal_by_grant: terminals,
  } = verification.value;
  const grant = events.get(request.authorization_event_id);
  if (!grant || grant.kind !== 'granted' || ledger.ledger_id !== request.ledger_id) {
    return { ok: false, code: 'absent-effect-authorization' };
  }
  const terminal = terminals.get(grant.event_id);
  if (terminal?.kind === 'consumed' || terminal?.kind === 'rejected') {
    return { ok: false, code: 'consumed-effect-authorization' };
  }
  if (terminal?.kind === 'revoked') return { ok: false, code: 'revoked-effect-authorization' };
  if (terminal?.kind === 'expired') return { ok: false, code: 'expired-effect-authorization' };

  const observedAt = Date.parse(request.observed_at);
  const notBefore = eventInstant(grant.not_before);
  const expiresAt = eventInstant(grant.expires_at);
  if (!Number.isFinite(observedAt) || observedAt < notBefore || observedAt >= expiresAt) {
    return { ok: false, code: 'expired-effect-authorization' };
  }

  const exactRequest = {
    action_id: request.action_id,
    effect: request.effect,
    resource: request.resource,
    repository: request.repository,
    candidate: request.candidate,
    subject_role: request.subject_role,
    consent: request.consent,
  };
  const grantIdentity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, grant[key]]));
  if (!equal(grantIdentity, exactRequest)) {
    return { ok: false, code: 'authorization-identity-mismatch' };
  }
  const grantEventDigest = eventDigests.get(grant.event_id);
  if (grantEventDigest === undefined) {
    return { ok: false, code: 'authorization-ledger-invalid' };
  }
  return {
    ok: true,
    grant,
    grant_event_digest_sha256: grantEventDigest,
    verification: verification.value,
  };
}

export function buildEffectAuthorizationTerminalEvent(
  grant: EffectAuthorizationEvent,
  input: {
    readonly kind: EffectAuthorizationTerminalKind;
    readonly sequence: number;
    readonly previous_event_digest_sha256: string;
    readonly recorded_at: string;
    readonly consumed_by_state_id?: string;
    readonly reason_code?: string;
  },
): EffectAuthorizationEvent {
  const draft: Omit<EffectAuthorizationEvent, 'event_id' | 'payload_digest_sha256'> = {
    schemaVersion: grant.schemaVersion,
    canonicalization: grant.canonicalization,
    ledger_id: grant.ledger_id,
    sequence: input.sequence,
    previous_event_digest_sha256: input.previous_event_digest_sha256,
    kind: input.kind,
    action_id: grant.action_id,
    effect: grant.effect,
    resource: grant.resource,
    repository: grant.repository,
    candidate: grant.candidate,
    grantor: grant.grantor,
    subject_role: grant.subject_role,
    consent: grant.consent,
    one_time: true,
    uses_permitted: 1,
    bearer_transferable: false,
    delegable: false,
    recorded_at: input.recorded_at,
    grant_event_id: grant.event_id,
    ...(input.kind === 'consumed' && input.consumed_by_state_id !== undefined
      ? { consumed_by_state_id: input.consumed_by_state_id }
      : {}),
    ...(input.kind !== 'consumed' && input.reason_code !== undefined
      ? { reason_code: input.reason_code }
      : {}),
  };
  const payloadDigest = computeEffectAuthorizationPayloadDigest(draft);
  const event = {
    ...draft,
    event_id: deriveEffectAuthorizationEventId(payloadDigest),
    payload_digest_sha256: payloadDigest,
  };
  return parsers.effectAuthorizationEvent.parse<EffectAuthorizationEvent>(event);
}

export function appendEffectAuthorizationEvent(
  ledger: EffectAuthorizationLedger,
  event: EffectAuthorizationEvent,
): EffectAuthorizationLedger {
  if (
    event.ledger_id !== ledger.ledger_id ||
    event.sequence !== ledger.head.sequence + 1 ||
    event.previous_event_digest_sha256 !== ledger.head.event_digest_sha256
  ) {
    throw new Error('effect authorization event does not extend the exact ledger head');
  }
  parsers.effectAuthorizationEvent.parse(event);
  const eventDigest = computeEffectAuthorizationEventDigest(event);
  const entry: EffectAuthorizationLedgerEntry = {
    sequence: event.sequence,
    event_id: event.event_id,
    event_digest_sha256: eventDigest,
    previous_event_digest_sha256: event.previous_event_digest_sha256,
    kind: event.kind,
    references_event_id: event.grant_event_id,
  };
  return parsers.effectAuthorizationLedger.parse<EffectAuthorizationLedger>({
    ...ledger,
    head: {
      sequence: entry.sequence,
      event_id: entry.event_id,
      event_digest_sha256: entry.event_digest_sha256,
    },
    entries: [...ledger.entries, entry],
  });
}

/**
 * Executes one externally visible effect behind an injectable boundary. The
 * one-time grant is durably consumed before the adapter is entered. Adapter
 * failure therefore cannot make the grant replayable.
 */
export async function executeAuthorizedEffect<T>(input: {
  readonly ledger: unknown;
  readonly resolveEvent: EffectAuthorizationEventResolver;
  readonly request: EffectAuthorizationGrantRequest;
  readonly consumed_by_state_id: string;
  readonly appendConsumption: (
    event: EffectAuthorizationEvent,
    nextLedger: EffectAuthorizationLedger,
  ) => void | Promise<void>;
  readonly adapter: () => T | Promise<T>;
}): Promise<AuthorizedEffectExecutionResult<T>> {
  const resolution = resolveEffectAuthorization(input.ledger, input.resolveEvent, input.request);
  if (!resolution.ok) {
    return { ok: false, phase: 'authorization', code: resolution.code };
  }
  const { ledger } = resolution.verification;
  const consumedEvent = buildEffectAuthorizationTerminalEvent(resolution.grant, {
    kind: 'consumed',
    sequence: ledger.head.sequence + 1,
    previous_event_digest_sha256: ledger.head.event_digest_sha256,
    recorded_at: input.request.observed_at,
    consumed_by_state_id: input.consumed_by_state_id,
  });
  const nextLedger = appendEffectAuthorizationEvent(ledger, consumedEvent);
  try {
    await input.appendConsumption(consumedEvent, nextLedger);
  } catch (cause) {
    return {
      ok: false,
      phase: 'consumption',
      code: 'effect-authorization-consumption-failed',
      cause,
    };
  }
  try {
    return {
      ok: true,
      value: await input.adapter(),
      consumed_event: consumedEvent,
      ledger: nextLedger,
    };
  } catch (cause) {
    return {
      ok: false,
      phase: 'adapter',
      code: 'authorized-effect-adapter-failed',
      consumed_event: consumedEvent,
      ledger: nextLedger,
      cause,
    };
  }
}
