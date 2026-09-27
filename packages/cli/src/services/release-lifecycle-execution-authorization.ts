import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  PersistedReleaseAction,
  AuthorizationAttemptBinding,
  TrustedReleaseAuthority,
  PublicationControls,
  AuthorizationLedgerHead,
  VerifiedAuthorizationLedger,
  AuthorizationResolution,
  AuthorizationConsumptionProof,
} from './release-lifecycle-execution-types.js';
import {
  same,
  object,
  without,
  EFFECT_BY_ACTION,
  ROLES_BY_ACTION,
} from './release-lifecycle-execution-support.js';

export function authorizationDestination(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
): AuthorizationAttemptBinding['destination'] {
  if (request.destination === undefined) throw new Error('release-request-projection-invalid');
  return {
    system_id: request.destination.kind,
    exact_identifier: request.destination.exact_identifier,
    operation: request.action_id === 'release evidence-publish' ? 'create' : 'publish',
  };
}

export function assertTrustedAuthority(
  action: PersistedReleaseAction,
  authority: TrustedReleaseAuthority | undefined,
): TrustedReleaseAuthority {
  if (
    authority === undefined ||
    authority.actor.kind !== 'human' ||
    !ROLES_BY_ACTION[action].includes(authority.actor.role) ||
    !['cli-flag', 'session-state'].includes(authority.actor.declaration_source) ||
    authority.consent.write !== true ||
    authority.consent.experimental !== false ||
    authority.consent.allow_publish !== (EFFECT_BY_ACTION[action] === 'remote-write')
  ) {
    throw new Error('release-authority-context-invalid');
  }
  return authority;
}

export function assertPublicationControls(
  request: ReleaseLifecycleRequest & { readonly action_id: PersistedReleaseAction },
  controls: PublicationControls | undefined,
): asserts controls is PublicationControls {
  const destination = request.destination;
  const workflowPath = controls?.workflow.workflow_path ?? '';
  if (
    controls === undefined ||
    destination === undefined ||
    destination.trust === undefined ||
    controls.destination.system_id !== destination.kind ||
    controls.destination.exact_identifier !== destination.exact_identifier ||
    controls.destination.operation !== 'publish' ||
    controls.workflow.repository !== request.repository_locator.id ||
    workflowPath.startsWith('/') ||
    workflowPath.split('/').includes('..') ||
    workflowPath.includes('\\') ||
    workflowPath.includes('\0') ||
    workflowPath.length === 0 ||
    !/^[a-f0-9]{40}$/u.test(controls.workflow.workflow_sha) ||
    controls.workflow.protected_environment.length === 0 ||
    controls.workflow.protected !== true ||
    !same(controls.trust, destination.trust)
  ) {
    throw new Error('rpd-workflow-expectation-invalid');
  }
}

function eventIdentity(value: unknown): Readonly<Record<string, unknown>> {
  const parsed =
    parsers.effectAuthorizationEvent.safeParse<Readonly<Record<string, unknown>>>(value);
  if (!parsed.ok) throw new Error('release-authorization-attempt-binding-invalid');
  const event = parsed.value;
  const payloadDigest = canonicalSha256(without(event, ['event_id', 'payload_digest_sha256']));
  if (
    event['payload_digest_sha256'] !== payloadDigest ||
    event['event_id'] !== `EA-${payloadDigest.slice(0, 16)}`
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return event;
}

function assertLedgerHead(value: AuthorizationLedgerHead): void {
  if (
    typeof value.ledger_id !== 'string' ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !/^EA-[a-f0-9]{16}$/u.test(value.event_id) ||
    !/^[a-f0-9]{64}$/u.test(value.event_digest_sha256)
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
}

function verifyAuthorizationLedgerProof(
  ledgerInput: unknown,
  eventInputs: readonly unknown[],
): VerifiedAuthorizationLedger {
  const parsed =
    parsers.effectAuthorizationLedger.safeParse<Readonly<Record<string, unknown>>>(ledgerInput);
  if (!parsed.ok) throw new Error('release-authorization-attempt-binding-invalid');
  const ledger = parsed.value;
  const entries = ledger['entries'];
  if (!Array.isArray(entries) || entries.length !== eventInputs.length || entries.length === 0) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  const events = eventInputs.map(eventIdentity);
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  const terminalByGrant = new Set<string>();
  let priorDigest: string | null = null;
  for (const [index, event] of events.entries()) {
    const entry = object(entries[index]);
    const eventId = String(event['event_id']);
    const digest = canonicalSha256(event);
    const expectedSequence = index + 1;
    if (
      byId.has(eventId) ||
      event['ledger_id'] !== ledger['ledger_id'] ||
      event['sequence'] !== expectedSequence ||
      entry['sequence'] !== expectedSequence ||
      entry['event_id'] !== eventId ||
      entry['event_digest_sha256'] !== digest ||
      entry['previous_event_digest_sha256'] !== priorDigest ||
      entry['kind'] !== event['kind'] ||
      entry['references_event_id'] !== event['grant_event_id'] ||
      event['previous_event_digest_sha256'] !== priorDigest
    ) {
      throw new Error('release-authorization-attempt-binding-invalid');
    }
    if (event['kind'] !== 'granted') {
      const grantId = event['grant_event_id'];
      const grant = typeof grantId === 'string' ? byId.get(grantId) : undefined;
      if (
        grant === undefined ||
        terminalByGrant.has(String(grantId)) ||
        event['action_id'] !== grant['action_id'] ||
        event['effect'] !== grant['effect'] ||
        !same(event['resource'], grant['resource']) ||
        !same(event['repository'], grant['repository']) ||
        !same(event['candidate'], grant['candidate']) ||
        !same(event['grantor'], grant['grantor']) ||
        event['subject_role'] !== grant['subject_role'] ||
        !same(event['consent'], grant['consent'])
      ) {
        throw new Error('release-authorization-attempt-binding-invalid');
      }
      terminalByGrant.add(String(grantId));
      if (event['kind'] === 'consumed') {
        const consumedAt = Date.parse(String(event['recorded_at']));
        const notBefore = Date.parse(String(grant['not_before']));
        const expiresAt = Date.parse(String(grant['expires_at']));
        if (
          !Number.isFinite(consumedAt) ||
          !Number.isFinite(notBefore) ||
          !Number.isFinite(expiresAt) ||
          consumedAt < notBefore ||
          consumedAt >= expiresAt
        ) {
          throw new Error('release-authorization-attempt-binding-invalid');
        }
      }
    } else {
      const notBefore = Date.parse(String(event['not_before']));
      const expiresAt = Date.parse(String(event['expires_at']));
      if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
        throw new Error('release-authorization-attempt-binding-invalid');
      }
    }
    byId.set(eventId, event);
    priorDigest = digest;
  }
  const rawHead = object(ledger['head']);
  const head: AuthorizationLedgerHead = {
    ledger_id: String(ledger['ledger_id']),
    sequence: Number(rawHead['sequence']),
    event_id: String(rawHead['event_id']),
    event_digest_sha256: String(rawHead['event_digest_sha256']),
  };
  assertLedgerHead(head);
  const finalEvent = events.at(-1);
  if (
    finalEvent === undefined ||
    head.sequence !== events.length ||
    head.event_id !== finalEvent['event_id'] ||
    head.event_digest_sha256 !== canonicalSha256(finalEvent)
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return { ledger, head, events, by_id: byId };
}

function grantResource(binding: AuthorizationAttemptBinding) {
  return {
    kind: 'remote',
    system_id: binding.destination.system_id,
    exact_identifier: binding.destination.exact_identifier,
    operations: [binding.destination.operation],
  } as const;
}

export function verifyGrantResolution(
  resolution: AuthorizationResolution,
  binding: AuthorizationAttemptBinding,
  trustedAuthority: TrustedReleaseAuthority,
  observedAt: string,
): {
  readonly grant: Readonly<Record<string, unknown>>;
  readonly grant_event_id: string;
  readonly ledger_head: AuthorizationLedgerHead;
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
} {
  if (!resolution.ok) throw new Error(resolution.code);
  const verified = verifyAuthorizationLedgerProof(resolution.ledger, resolution.events);
  const grant = verified.events.at(-1);
  if (grant === undefined) throw new Error('release-authorization-attempt-binding-invalid');
  const candidate = primaryCandidateFromBinding(binding);
  const observedInstant = Date.parse(observedAt);
  const notBefore = Date.parse(String(grant['not_before']));
  const expiresAt = Date.parse(String(grant['expires_at']));
  if (
    grant['schemaVersion'] !== '1.0.0' ||
    grant['kind'] !== 'granted' ||
    grant['grant_event_id'] !== null ||
    grant['event_id'] !== verified.head.event_id ||
    canonicalSha256(grant) !== verified.head.event_digest_sha256 ||
    grant['ledger_id'] !== verified.head.ledger_id ||
    grant['action_id'] !== binding.action_id ||
    grant['effect'] !== 'remote-write' ||
    !same(grant['resource'], grantResource(binding)) ||
    !same(grant['repository'], binding.repository) ||
    !same(grant['candidate'], candidate) ||
    grant['subject_role'] !== trustedAuthority.actor.role ||
    !same(grant['grantor'], trustedAuthority.actor) ||
    !same(grant['consent'], trustedAuthority.consent) ||
    grant['one_time'] !== true ||
    grant['uses_permitted'] !== 1 ||
    grant['bearer_transferable'] !== false ||
    grant['delegable'] !== false ||
    !Number.isFinite(observedInstant) ||
    observedInstant < notBefore ||
    observedInstant >= expiresAt
  ) {
    throw new Error('release-authorization-attempt-binding-invalid');
  }
  return {
    grant,
    grant_event_id: String(grant['event_id']),
    ledger_head: verified.head,
    ledger: verified.ledger,
    events: verified.events,
  };
}

function primaryCandidateFromBinding(
  binding: AuthorizationAttemptBinding,
): ReleaseLifecycleStateV2['candidate'] {
  return binding.candidate;
}

export function verifyConsumptionProof(
  proof: AuthorizationConsumptionProof,
  binding: AuthorizationAttemptBinding,
  grant: Readonly<Record<string, unknown>>,
  grantEventId: string,
  predecessor: AuthorizationLedgerHead,
  priorLedger: Readonly<Record<string, unknown>>,
  priorEvents: readonly Readonly<Record<string, unknown>>[],
): string {
  if (proof.durable !== true) throw new Error('release-authorization-consumption-not-durable');
  const verified = verifyAuthorizationLedgerProof(proof.ledger, proof.events);
  const event = verified.events.at(-1);
  if (event === undefined) throw new Error('release-authorization-consumption-not-durable');
  const eventDigest = canonicalSha256(event);
  const expectedConsumptionBinding = {
    ...binding,
    grant_event_id: grantEventId,
    ledger_predecessor_digest_sha256: predecessor.event_digest_sha256,
  };
  if (
    event['schemaVersion'] !== '2.0.0' ||
    event['kind'] !== 'consumed' ||
    event['consumed_by_state_id'] !== null ||
    event['grant_event_id'] !== grantEventId ||
    event['ledger_id'] !== predecessor.ledger_id ||
    event['sequence'] !== predecessor.sequence + 1 ||
    event['previous_event_digest_sha256'] !== predecessor.event_digest_sha256 ||
    event['action_id'] !== binding.action_id ||
    event['effect'] !== 'remote-write' ||
    !same(event['resource'], grant['resource']) ||
    !same(event['repository'], grant['repository']) ||
    !same(event['candidate'], grant['candidate']) ||
    !same(event['grantor'], grant['grantor']) ||
    event['subject_role'] !== grant['subject_role'] ||
    !same(event['consent'], grant['consent']) ||
    !same(event['consumption_binding'], expectedConsumptionBinding) ||
    verified.head.ledger_id !== predecessor.ledger_id ||
    verified.head.sequence !== event['sequence'] ||
    verified.head.event_id !== event['event_id'] ||
    verified.head.event_digest_sha256 !== eventDigest ||
    !same(
      (verified.ledger['entries'] as readonly unknown[]).slice(0, -1),
      priorLedger['entries'],
    ) ||
    !same(
      without(verified.ledger, ['head', 'entries']),
      without(priorLedger, ['head', 'entries']),
    ) ||
    !same(verified.events.slice(0, -1), priorEvents)
  ) {
    throw new Error('release-authorization-consumption-not-durable');
  }
  return String(event['event_id']);
}
