import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import {
  computeReleaseRequestDigest,
  executeReleaseLifecycleAction,
  finalizeReleaseStateV2,
  finalizeStoreHead,
  finalizeStoreRecord,
  reduceStoreRecords,
  type AuthorizationAttemptBinding,
  type AuthorizationBridge,
  type PublicationControls,
  type ReleaseLifecycleFileStore,
  type ReleaseLifecycleRequest,
  type ReleaseLifecycleStateV2,
  type StoreRecord,
  type TrustedReleaseAuthority,
} from '../../src/services/release-lifecycle-execution.js';

const FIXTURE = createLifecyclePolicyFixture();
const COMMIT = FIXTURE.candidate.repository.commit;
const TREE = FIXTURE.candidate.repository.tree;
const RECORDED_AT = '2026-09-03T00:30:00.000Z';
const TRUST = {
  trust_root_id: 'release-root',
  trust_store_digest_sha256: 'b'.repeat(64),
  key_id: 'release-key',
  signature_algorithm: 'ed25519' as const,
};
const STATE_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-state.v2',
  encoding: 'utf-8' as const,
  json_form: 'rfc8785-jcs' as const,
  digest_algorithm: 'sha256' as const,
  projection_excludes: ['state_id', 'record_digest_sha256'] as const,
  id_derivation: 'RLS-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256' as const,
};
const STORE_CANONICALIZATION = {
  json_form: 'rfc8785-jcs' as const,
  encoding: 'utf-8' as const,
  digest_algorithm: 'sha256' as const,
  projection_excludes: ['record_id', 'record_digest_sha256'] as const,
  id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256' as const,
};

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture-object-required');
  }
  return value as Readonly<Record<string, unknown>>;
}

function ownerAuthority(): TrustedReleaseAuthority {
  return {
    actor: { kind: 'human', role: 'owner', declaration_source: 'cli-flag' },
    consent: { write: true, allow_publish: true, experimental: false },
  };
}

function request(action: ReleaseLifecycleRequest['action_id']): ReleaseLifecycleRequest {
  const receipt = FIXTURE.receipt;
  const manifest = FIXTURE.package_json;
  const manifestDigest = createHash('sha256').update(manifest).digest('hex');
  const base = {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: action,
    repository_locator: { id: 'aarusso-nyx/devai', commit: COMMIT, tree: TREE },
    candidate_locator: {
      commit: COMMIT,
      tree: TREE,
      release_units: [
        {
          release_unit: '@aarusso-nyx/devai',
          version: '1.5.0',
          package_roster: [
            {
              package_id: '@aarusso-nyx/devai',
              manifest_path: 'package.json',
              manifest_digest_sha256: manifestDigest,
            },
          ],
        },
      ],
    },
    receipt_locators: [
      {
        kind: 'release-plan-receipt' as const,
        receipt_id: String(receipt['receipt_id']),
        receipt_digest_sha256: String(receipt['receipt_digest_sha256']),
        path: 'receipts/plan.json',
      },
    ],
  } as const;
  if (action !== 'release publish') return base as ReleaseLifecycleRequest;
  return {
    ...base,
    provider: { kind: 'protected-dispatch', provider_id: 'github-actions' },
    destination: {
      kind: 'publication-destination',
      exact_identifier: 'npm:@aarusso-nyx/devai@1.5.0',
      trust: TRUST,
    },
  } as ReleaseLifecycleRequest;
}

function publicationControls(): PublicationControls {
  return {
    destination: {
      system_id: 'publication-destination',
      exact_identifier: 'npm:@aarusso-nyx/devai@1.5.0',
      operation: 'publish',
    },
    workflow: {
      repository: 'aarusso-nyx/devai',
      workflow_path: '.github/workflows/release.yml',
      workflow_sha: COMMIT,
      protected_environment: 'release',
      protected: true,
    },
    trust: TRUST,
  };
}

function seededStore() {
  const schema = JSON.parse(
    readFileSync('law/schemas/release-lifecycle-state.schema.json', 'utf8'),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const material = object(schema.examples[1]);
  const releaseUnits = material['release_units'] as readonly {
    readonly packages: readonly Readonly<Record<string, unknown>>[];
  }[];
  const releasePackage: Record<string, unknown> = {
    ...object(releaseUnits[0]?.packages[0]),
    manifest: {
      ...object(object(releaseUnits[0]?.packages[0])['manifest']),
      sha256: createHash('sha256').update(FIXTURE.package_json).digest('hex'),
    },
  };
  const normalizedReleaseUnits = [{ ...object(releaseUnits[0]), packages: [releasePackage] }];
  const artifacts = [
    { kind: 'package-tarball', ...object(releasePackage['tarball']) },
    { kind: 'manifest', ...object(releasePackage['manifest']) },
    { kind: 'sbom', ...object(releasePackage['sbom']) },
    { kind: 'evidence-bundle', ...object(releasePackage['evidence_manifest']) },
    { kind: 'provider-result', ...object(releasePackage['provider_result']) },
  ];
  const actions = [
    ['release preflight', 'preflight_passed', 'harness-write'],
    ['release certify', 'certified', 'harness-write'],
    ['release prepare', 'prepared', 'local-write'],
    ['release export', 'exported', 'local-write'],
    ['release evidence-publish', 'evidence_published', 'remote-write'],
  ] as const;
  const states: ReleaseLifecycleStateV2[] = [];
  const records: StoreRecord[] = [];
  let priorState: ReleaseLifecycleStateV2 | null = null;
  let priorRecord: StoreRecord | null = null;
  let head: ReturnType<typeof finalizeStoreHead> | null = null;
  for (const [generation, [action, state, effect]] of actions.entries()) {
    const value = request(action);
    const candidate = {
      release_unit: '@aarusso-nyx/devai',
      version: '1.5.0',
      commit: COMMIT,
      tree: TREE,
    };
    const next = finalizeReleaseStateV2({
      schemaVersion: '2.0.0',
      canonicalization: STATE_CANONICALIZATION,
      state,
      action_id: action,
      effect,
      prior_state:
        priorState === null
          ? null
          : {
              state: priorState.state,
              state_id: priorState.state_id,
              record_digest_sha256: priorState.record_digest_sha256,
            },
      bound_receipts:
        action === 'release evidence-publish'
          ? [
              {
                kind: 'release-offline-verification-receipt',
                receipt_id: 'ROV-0123456789abcdef',
                receipt_digest_sha256: 'd'.repeat(64),
                verdict: 'pass',
              },
            ]
          : (value.receipt_locators?.map((locator) => ({
              kind: locator.kind,
              receipt_id: locator.receipt_id,
              receipt_digest_sha256: locator.receipt_digest_sha256,
              verdict: 'pass' as const,
            })) ?? []),
      repository: value.repository_locator,
      candidate,
      release_units: normalizedReleaseUnits,
      inputs: material['inputs'],
      evidence: material['evidence'],
      artifacts,
      actor:
        action === 'release evidence-publish'
          ? ownerAuthority().actor
          : {
              kind: 'human',
              role:
                action === 'release prepare' || action === 'release export'
                  ? 'architect'
                  : 'inspector',
              declaration_source: 'cli-flag',
            },
      consent: {
        write: true,
        allow_publish: action === 'release evidence-publish',
        experimental: false,
      },
      authorization_event_id: action === 'release evidence-publish' ? 'EA-0123456789abcdef' : null,
      publication_expectation: null,
      storage: {
        generation,
        head_before:
          priorState === null
            ? null
            : {
                generation: generation - 1,
                record_digest_sha256: priorState.record_digest_sha256,
              },
      },
      recorded_at: RECORDED_AT,
    } as never);
    const requestDigest = computeReleaseRequestDigest(value);
    const attemptId = `RLA-${canonicalSha256({
      request_digest_sha256: requestDigest,
      action_id: action,
      sequence: records.length,
      predecessor_record:
        priorRecord === null
          ? null
          : {
              sequence: priorRecord.sequence,
              record_id: priorRecord.record_id,
              record_digest_sha256: priorRecord.record_digest_sha256,
            },
    }).slice(0, 16)}`;
    const attempt = finalizeStoreRecord({
      schemaVersion: '1.0.0',
      record_kind: 'attempt',
      canonicalization: STORE_CANONICALIZATION,
      sequence: records.length,
      repository: value.repository_locator,
      candidate: {
        commit: COMMIT,
        tree: TREE,
        release_units: [
          {
            release_unit: candidate.release_unit,
            version: candidate.version,
            packages: [{ package_id: '@aarusso-nyx/devai' }],
          },
        ],
      },
      predecessor_record:
        priorRecord === null
          ? null
          : {
              sequence: priorRecord.sequence,
              record_id: priorRecord.record_id,
              record_digest_sha256: priorRecord.record_digest_sha256,
            },
      observed_head_before: head,
      attempt_id: attemptId,
      action_id: action,
      request_digest_sha256: requestDigest,
      authorization_event_id: action === 'release evidence-publish' ? 'EA-0123456789abcdef' : null,
      provider_handle: null,
      provider_dispatch: { status: 'not-dispatched', handle_observed: false },
      completion: null,
      failure: null,
      unknown: null,
    } as never);
    const completion = finalizeStoreRecord({
      schemaVersion: '1.0.0',
      record_kind: 'completion',
      canonicalization: STORE_CANONICALIZATION,
      sequence: records.length + 1,
      repository: value.repository_locator,
      candidate: attempt.candidate,
      predecessor_record: {
        sequence: attempt.sequence,
        record_id: attempt.record_id,
        record_digest_sha256: attempt.record_digest_sha256,
      },
      observed_head_before: head,
      attempt_id: attemptId,
      action_id: action,
      request_digest_sha256: requestDigest,
      authorization_event_id: action === 'release evidence-publish' ? 'EA-0123456789abcdef' : null,
      provider_handle: action === 'release evidence-publish' ? 'evidence-dispatch' : null,
      provider_dispatch:
        action === 'release evidence-publish'
          ? { status: 'dispatched', handle_observed: true }
          : { status: 'not-dispatched', handle_observed: false },
      completion: {
        state_id: next.state_id,
        state_digest_sha256: next.record_digest_sha256,
        state,
      },
      failure: null,
      unknown: null,
    } as never);
    head = finalizeStoreHead({
      schemaVersion: '2.0.0',
      canonicalization: {
        kernel_id: 'devai.kernel.release-lifecycle-store-head.v2',
        encoding: 'utf-8',
        json_form: 'rfc8785-jcs',
        digest_algorithm: 'sha256',
        projection_excludes: ['head_digest_sha256'],
      },
      repository: value.repository_locator,
      candidate: { commit: COMMIT, tree: TREE },
      generation,
      state_id: next.state_id,
      state_digest_sha256: next.record_digest_sha256,
      completion_record: {
        sequence: completion.sequence,
        record_id: completion.record_id,
        record_digest_sha256: completion.record_digest_sha256,
        attempt_id: completion.attempt_id,
      },
    } as never);
    records.push(attempt, completion);
    states.push(next);
    priorState = next;
    priorRecord = completion;
  }
  expect(reduceStoreRecords(records)).toMatchObject({ ok: true, ambiguous: false });
  const appendStoreRecord = vi.fn();
  return {
    states,
    records,
    head,
    appendStoreRecord,
    store: {
      withExecutionLock: async <T>(callback: () => T | Promise<T>) => callback(),
      readStoreRecords: () => records,
      readStateRecords: () => states,
      readHead: () => head,
      appendStoreRecord,
    } as unknown as ReleaseLifecycleFileStore,
  };
}

function finalizeEvent(draft: Readonly<Record<string, unknown>>) {
  const digest = canonicalSha256(draft);
  return { ...draft, event_id: `EA-${digest.slice(0, 16)}`, payload_digest_sha256: digest };
}

function ledger(events: readonly Readonly<Record<string, unknown>>[]) {
  const schema = JSON.parse(
    readFileSync('law/schemas/effect-authorization-ledger.schema.json', 'utf8'),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const template = object(schema.examples[0]);
  const entries = events.map((event) => ({
    sequence: event['sequence'],
    event_id: event['event_id'],
    event_digest_sha256: canonicalSha256(event),
    previous_event_digest_sha256: event['previous_event_digest_sha256'],
    kind: event['kind'],
    references_event_id: event['grant_event_id'],
  }));
  const final = object(entries.at(-1));
  return {
    ...template,
    ledger_id: 'EAL-release-matrix',
    repository: { id: 'aarusso-nyx/devai' },
    head: {
      sequence: final['sequence'],
      event_id: final['event_id'],
      event_digest_sha256: final['event_digest_sha256'],
    },
    entries,
  };
}

function grant(binding: AuthorizationAttemptBinding) {
  return finalizeEvent({
    schemaVersion: '1.0.0',
    canonicalization: object(
      object(
        JSON.parse(readFileSync('law/schemas/effect-authorization-event.schema.json', 'utf8'))
          .examples[0],
      )['canonicalization'],
    ),
    ledger_id: 'EAL-release-matrix',
    sequence: 1,
    previous_event_digest_sha256: null,
    kind: 'granted',
    action_id: binding.action_id,
    effect: 'remote-write',
    resource: {
      kind: 'remote',
      system_id: binding.destination.system_id,
      exact_identifier: binding.destination.exact_identifier,
      operations: [binding.destination.operation],
    },
    repository: binding.repository,
    candidate: binding.candidate,
    grantor: ownerAuthority().actor,
    subject_role: 'owner',
    consent: ownerAuthority().consent,
    one_time: true,
    uses_permitted: 1,
    bearer_transferable: false,
    delegable: false,
    not_before: '2026-09-03T00:00:00.000Z',
    expires_at: '2026-09-03T01:00:00.000Z',
    recorded_at: '2026-09-03T00:00:00.000Z',
    grant_event_id: null,
  });
}

function consumed(
  grantEvent: Readonly<Record<string, unknown>>,
  binding: AuthorizationAttemptBinding,
) {
  const {
    event_id: _id,
    payload_digest_sha256: _payload,
    not_before: _nb,
    expires_at: _exp,
    ...base
  } = grantEvent;
  return finalizeEvent({
    ...base,
    schemaVersion: '2.0.0',
    canonicalization: {
      ...object(base['canonicalization']),
      kernel_id: 'devai.kernel.effect-authorization-event-canonicalization.v2',
    },
    sequence: 2,
    previous_event_digest_sha256: canonicalSha256(grantEvent),
    kind: 'consumed',
    recorded_at: RECORDED_AT,
    grant_event_id: grantEvent['event_id'],
    consumed_by_state_id: null,
    consumption_binding: {
      ...binding,
      ledger_predecessor_digest_sha256: canonicalSha256(grantEvent),
    },
  });
}

function rehashEvent(
  event: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
) {
  const { event_id: _id, payload_digest_sha256: _payload, ...draft } = event;
  return finalizeEvent({ ...draft, ...changes });
}

type LedgerTransform = (
  value: Readonly<Record<string, unknown>>,
  events: readonly Readonly<Record<string, unknown>>[],
) => Readonly<Record<string, unknown>>;

interface BridgeDefect {
  readonly grant?: (
    value: Readonly<Record<string, unknown>>,
    binding: AuthorizationAttemptBinding,
  ) => Readonly<Record<string, unknown>>;
  readonly grantLedger?: LedgerTransform;
  readonly consumed?: (
    value: Readonly<Record<string, unknown>>,
    grantEvent: Readonly<Record<string, unknown>>,
    binding: AuthorizationAttemptBinding,
  ) => Readonly<Record<string, unknown>>;
  readonly consumedEvents?: (
    grantEvent: Readonly<Record<string, unknown>>,
    terminal: Readonly<Record<string, unknown>>,
  ) => readonly Readonly<Record<string, unknown>>[];
  readonly consumedLedger?: LedgerTransform;
}

function bridge(defect: BridgeDefect = {}) {
  let currentGrant: Readonly<Record<string, unknown>> | undefined;
  const resolve = vi.fn((binding: AuthorizationAttemptBinding) => {
    currentGrant ??= defect.grant?.(grant(binding), binding) ?? grant(binding);
    const events = [currentGrant];
    const exactLedger = ledger(events);
    return {
      ok: true as const,
      ledger: defect.grantLedger?.(exactLedger, events) ?? exactLedger,
      events,
    };
  });
  const consume = vi.fn((binding: AuthorizationAttemptBinding) => {
    currentGrant ??= defect.grant?.(grant(binding), binding) ?? grant(binding);
    const exactTerminal = consumed(currentGrant, binding);
    const terminal = defect.consumed?.(exactTerminal, currentGrant, binding) ?? exactTerminal;
    const events = defect.consumedEvents?.(currentGrant, terminal) ?? [currentGrant, terminal];
    const exactLedger = ledger(events);
    return {
      durable: true as const,
      ledger: defect.consumedLedger?.(exactLedger, events) ?? exactLedger,
      events,
    };
  });
  return {
    resolve,
    consume,
    authorization: { resolve, consume } satisfies AuthorizationBridge,
  };
}

async function execute(defect: BridgeDefect = {}) {
  const fixture = seededStore();
  const authorization = bridge(defect);
  const provider = vi.fn(() => ({ outcome: 'unknown' as const, provider_handle: 'dispatch-1' }));
  const result = await executeReleaseLifecycleAction({
    request: request('release publish'),
    action: 'release publish',
    authority: ownerAuthority(),
    publication_controls: publicationControls(),
    store: fixture.store,
    resolveReceipt: () => FIXTURE.receipt,
    resolvePlanInput: FIXTURE.resolve_plan_input,
    authorization: authorization.authorization,
    provider,
    recorded_at: RECORDED_AT,
  });
  return { ...fixture, ...authorization, provider, result };
}

const changed =
  (field: string, value: unknown): BridgeDefect['consumed'] =>
  (event) =>
    rehashEvent(event, { [field]: value });

const ZERO = '0'.repeat(64);
const OTHER_EVENT = 'EA-0000000000000000';
// RFC 3339 admits a leap second at this historical boundary while ECMAScript
// Date.parse returns NaN. This reaches the reducer's finite-instant guards
// through the same public authorization bridge used by real execution.
const RFC3339_LEAP_SECOND = '1990-12-31T23:59:60Z';

function mutateEntry(
  value: Readonly<Record<string, unknown>>,
  index: number,
  changes: Readonly<Record<string, unknown>>,
) {
  const entries = [...(value['entries'] as readonly Readonly<Record<string, unknown>>[])];
  entries[index] = { ...object(entries[index]), ...changes };
  return { ...value, entries };
}

const RESOLUTION_CASES: readonly [string, BridgeDefect][] = [
  [
    'event parser rejection',
    { grant: (event) => ({ ...event, schemaVersion: 'invalid-schema-version' }) },
  ],
  [
    'event payload digest identity',
    { grant: (event) => ({ ...event, payload_digest_sha256: ZERO }) },
  ],
  ['event id identity', { grant: (event) => ({ ...event, event_id: OTHER_EVENT }) }],
  ['first event sequence', { grant: (event) => rehashEvent(event, { sequence: 2 }) }],
  [
    'first event ledger scope',
    { grant: (event) => rehashEvent(event, { ledger_id: 'EAL-release-other' }) },
  ],
  [
    'first event predecessor continuity',
    { grant: (event) => rehashEvent(event, { previous_event_digest_sha256: ZERO }) },
  ],
  ['ledger entry population', { grantLedger: (value) => ({ ...value, entries: [] }) }],
  ['entry sequence', { grantLedger: (value) => mutateEntry(value, 0, { sequence: 2 }) }],
  ['entry event id', { grantLedger: (value) => mutateEntry(value, 0, { event_id: OTHER_EVENT }) }],
  [
    'entry event digest',
    { grantLedger: (value) => mutateEntry(value, 0, { event_digest_sha256: ZERO }) },
  ],
  [
    'entry predecessor',
    { grantLedger: (value) => mutateEntry(value, 0, { previous_event_digest_sha256: ZERO }) },
  ],
  ['entry kind', { grantLedger: (value) => mutateEntry(value, 0, { kind: 'consumed' }) }],
  [
    'entry grant reference',
    { grantLedger: (value) => mutateEntry(value, 0, { references_event_id: OTHER_EVENT }) },
  ],
  [
    'head sequence',
    {
      grantLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), sequence: 2 },
      }),
    },
  ],
  [
    'head event id',
    {
      grantLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), event_id: OTHER_EVENT },
      }),
    },
  ],
  [
    'head event digest',
    {
      grantLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), event_digest_sha256: ZERO },
      }),
    },
  ],
  [
    'grant empty validity window',
    {
      grant: (event) =>
        rehashEvent(event, {
          not_before: '2026-09-03T01:00:00.000Z',
          expires_at: '2026-09-03T01:00:00.000Z',
        }),
    },
  ],
  [
    'grant reversed validity window',
    {
      grant: (event) =>
        rehashEvent(event, {
          not_before: '2026-09-03T01:00:01.000Z',
          expires_at: '2026-09-03T01:00:00.000Z',
        }),
    },
  ],
  [
    'grant RFC3339 leap-second not-before',
    { grant: (event) => rehashEvent(event, { not_before: RFC3339_LEAP_SECOND }) },
  ],
];

const CONSUMPTION_CASES: readonly [string, BridgeDefect][] = [
  ['event sequence', { consumed: (event) => rehashEvent(event, { sequence: 3 }) }],
  [
    'event predecessor continuity',
    { consumed: (event) => rehashEvent(event, { previous_event_digest_sha256: ZERO }) },
  ],
  ['entry sequence', { consumedLedger: (value) => mutateEntry(value, 1, { sequence: 3 }) }],
  [
    'entry event id',
    { consumedLedger: (value) => mutateEntry(value, 1, { event_id: OTHER_EVENT }) },
  ],
  [
    'entry digest',
    { consumedLedger: (value) => mutateEntry(value, 1, { event_digest_sha256: ZERO }) },
  ],
  [
    'entry predecessor continuity',
    {
      consumedLedger: (value) => mutateEntry(value, 1, { previous_event_digest_sha256: ZERO }),
    },
  ],
  [
    'entry terminal kind',
    { consumedLedger: (value) => mutateEntry(value, 1, { kind: 'revoked' }) },
  ],
  [
    'entry grant reference',
    { consumedLedger: (value) => mutateEntry(value, 1, { references_event_id: OTHER_EVENT }) },
  ],
  ['unknown grant', { consumed: changed('grant_event_id', OTHER_EVENT) }],
  [
    'second terminal for one grant',
    {
      consumedEvents: (grantEvent, terminal) => [
        grantEvent,
        terminal,
        rehashEvent(terminal, {
          sequence: 3,
          previous_event_digest_sha256: canonicalSha256(terminal),
        }),
      ],
    },
  ],
  ['issuer', { consumed: changed('grantor', { ...ownerAuthority().actor, role: 'architect' }) }],
  ['subject', { consumed: changed('subject_role', 'architect') }],
  ['action policy', { consumed: changed('action_id', 'release evidence-publish') }],
  ['effect policy', { consumed: changed('effect', 'local-write') }],
  [
    'resource scope',
    {
      consumed: (event) =>
        rehashEvent(event, {
          resource: { ...object(event['resource']), exact_identifier: 'npm:other@1.5.0' },
        }),
    },
  ],
  [
    'repository scope',
    {
      consumed: (event) =>
        rehashEvent(event, {
          repository: { ...object(event['repository']), tree: 'f'.repeat(40) },
        }),
    },
  ],
  [
    'candidate scope',
    {
      consumed: (event) =>
        rehashEvent(event, { candidate: { ...object(event['candidate']), version: '1.5.1' } }),
    },
  ],
  [
    'consent policy',
    {
      consumed: (event) =>
        rehashEvent(event, { consent: { ...object(event['consent']), write: false } }),
    },
  ],
  ['before not-before freshness', { consumed: changed('recorded_at', '2026-09-02T23:59:59.999Z') }],
  ['at expiry freshness', { consumed: changed('recorded_at', '2026-09-03T01:00:00.000Z') }],
  [
    'RFC3339 leap-second consumption instant',
    { consumed: changed('recorded_at', RFC3339_LEAP_SECOND) },
  ],
  [
    'terminal head sequence',
    {
      consumedLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), sequence: 1 },
      }),
    },
  ],
  [
    'terminal head id',
    {
      consumedLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), event_id: OTHER_EVENT },
      }),
    },
  ],
  [
    'terminal head digest',
    {
      consumedLedger: (value) => ({
        ...value,
        head: { ...object(value['head']), event_digest_sha256: ZERO },
      }),
    },
  ],
];

describe('release authorization ledger MC/DC matrix', () => {
  it('reaches the public authorization boundary with an exact ledger proof', async () => {
    const run = await execute();
    expect(run.result).toMatchObject({
      ok: false,
      phase: 'ambiguous',
      code: 'release-provider-result-unknown',
    });
    expect(run.resolve).toHaveBeenCalledTimes(2);
    expect(run.consume).toHaveBeenCalledOnce();
    expect(run.provider).toHaveBeenCalledOnce();
  });

  it.each(RESOLUTION_CASES)(
    'denies the resolve-phase %s defect before durable effects',
    async (_label, defect) => {
      const run = await execute(defect);
      expect(run.result).toEqual({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-attempt-binding-invalid',
      });
      expect(run.appendStoreRecord).not.toHaveBeenCalled();
      expect(run.consume).not.toHaveBeenCalled();
      expect(run.provider).not.toHaveBeenCalled();
    },
  );

  it.each(CONSUMPTION_CASES)(
    'denies the consume-phase %s defect before dispatch',
    async (_label, defect) => {
      const run = await execute(defect);
      const appended = run.appendStoreRecord.mock.calls.map(([record]) => record);
      const [attempt, failure] = appended;
      expect(attempt).toBeDefined();
      expect(failure).toBeDefined();
      if (attempt === undefined || failure === undefined) throw new Error('fixture-record-missing');
      const value = request('release publish');
      const prior = run.records.at(-1);
      if (prior === undefined) throw new Error('fixture-prior-record-missing');
      const expectedCandidate = {
        commit: COMMIT,
        tree: TREE,
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            packages: [{ package_id: '@aarusso-nyx/devai' }],
          },
        ],
      };
      const requestDigest = computeReleaseRequestDigest(value);
      const expectedAttempt = {
        schemaVersion: '1.0.0',
        record_kind: 'attempt',
        canonicalization: STORE_CANONICALIZATION,
        record_id: attempt.record_id,
        record_digest_sha256: attempt.record_digest_sha256,
        sequence: prior.sequence + 1,
        repository: value.repository_locator,
        candidate: expectedCandidate,
        predecessor_record: {
          sequence: prior.sequence,
          record_id: prior.record_id,
          record_digest_sha256: prior.record_digest_sha256,
        },
        observed_head_before: run.head,
        attempt_id: attempt.attempt_id,
        action_id: 'release publish',
        request_digest_sha256: requestDigest,
        authorization_event_id: attempt.authorization_event_id,
        provider_handle: null,
        provider_dispatch: { status: 'not-dispatched', handle_observed: false },
        completion: null,
        failure: null,
        unknown: null,
      };
      const expectedFailure = {
        ...expectedAttempt,
        record_kind: 'failure',
        record_id: failure.record_id,
        record_digest_sha256: failure.record_digest_sha256,
        sequence: attempt.sequence + 1,
        predecessor_record: {
          sequence: attempt.sequence,
          record_id: attempt.record_id,
          record_digest_sha256: attempt.record_digest_sha256,
        },
        provider_dispatch: { status: 'failed-before-dispatch', handle_observed: false },
        failure: { code: 'release-authorization-consumption-failed', retryable: false },
      };
      expect(run.result).toEqual({
        ok: false,
        phase: 'authorization',
        code: 'release-authorization-attempt-binding-invalid',
        record: expectedFailure,
      });
      expect(appended).toHaveLength(2);
      expect(attempt.authorization_event_id).toEqual(expect.stringMatching(/^EA-[a-f0-9]{16}$/u));
      expect(attempt).toEqual(expectedAttempt);
      expect(failure).toEqual(expectedFailure);
      for (const record of appended) {
        const { record_id: recordId, record_digest_sha256: digest, ...draft } = record;
        const expectedDigest = canonicalSha256(draft);
        expect(digest).toBe(expectedDigest);
        expect(recordId).toBe(`RLE-${expectedDigest.slice(0, 16)}`);
      }
      expect(run.resolve).toHaveBeenCalledTimes(2);
      expect(run.consume).toHaveBeenCalledOnce();
      expect(run.provider).not.toHaveBeenCalled();
    },
  );
});
