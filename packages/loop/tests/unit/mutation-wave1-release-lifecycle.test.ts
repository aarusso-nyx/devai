import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type EffectAuthorizationEvent,
  type EffectAuthorizationGrantRequest,
  type EffectAuthorizationLedger,
} from '@devai-nyx/authority';
import {
  executeAuthorizedReleaseTransition,
  finalizeReleaseLifecycleState,
  finalizeReleaseOfflineVerificationReceipt,
  finalizeReleasePlanReceipt,
  reduceReleaseLifecycle,
  resumeReleaseLifecycle,
  verifyReleaseOfflineReceiptIdentity,
  verifyReleasePlanReceiptIdentity,
  computeReleaseReadReceiptDigest,
  type ReleaseLifecycleStateRecord,
  type ReleaseArtifactIdentity,
  type ReleaseOfflineVerificationReceipt,
  type ReleasePlanReceipt,
  type PublicationExpectation,
} from '../../src/release-lifecycle/index.js';

const root = resolve(import.meta.dirname, '../../../..');

function examples(name: string): unknown[] {
  const document = JSON.parse(
    readFileSync(resolve(root, `law/schemas/${name}.schema.json`), 'utf8'),
  ) as { examples?: unknown[] };
  if (!document.examples) throw new Error(`Missing schema examples for ${name}`);
  return document.examples;
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing lifecycle fixture');
  return value;
}

type StateDraft = Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>;

function stateBase(): StateDraft {
  const value = structuredClone(present(examples('release-lifecycle-state')[0]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid lifecycle state example');
  }
  const draft = value as Record<string, unknown>;
  draft.schemaVersion = '1.0.0';
  delete draft.canonicalization;
  delete draft.release_units;
  delete draft.storage;
  delete draft.record_digest_sha256;
  return draft as StateDraft;
}

function nextState(
  prior: ReleaseLifecycleStateRecord,
  state: 'certified' | 'prepared' | 'exported',
  action_id: StateDraft['action_id'],
): ReleaseLifecycleStateRecord {
  const local = action_id === 'release prepare' || action_id === 'release export';
  const artifacts =
    action_id === 'release prepare'
      ? [
          {
            kind: 'package-tarball' as const,
            path: 'dist/package.tgz',
            sha256: 'a'.repeat(64),
            size_bytes: 1,
          },
          {
            kind: 'manifest' as const,
            path: 'dist/manifest.json',
            sha256: 'b'.repeat(64),
            size_bytes: 1,
          },
          { kind: 'sbom' as const, path: 'dist/sbom.json', sha256: 'c'.repeat(64), size_bytes: 1 },
        ]
      : action_id === 'release export'
        ? [
            {
              kind: 'package-tarball' as const,
              path: 'dist/package.tgz',
              sha256: 'a'.repeat(64),
              size_bytes: 1,
            },
            {
              kind: 'manifest' as const,
              path: 'dist/manifest.json',
              sha256: 'b'.repeat(64),
              size_bytes: 1,
            },
            {
              kind: 'sbom' as const,
              path: 'dist/sbom.json',
              sha256: 'c'.repeat(64),
              size_bytes: 1,
            },
            {
              kind: 'evidence-bundle' as const,
              path: 'dist/evidence.tgz',
              sha256: 'd'.repeat(64),
              size_bytes: 1,
            },
            {
              kind: 'provider-result' as const,
              path: 'dist/provider.json',
              sha256: 'e'.repeat(64),
              size_bytes: 1,
            },
          ]
        : [];
  return finalizeReleaseLifecycleState({
    ...stateBase(),
    state_id: `RLS-${String(['certified', 'prepared', 'exported'].indexOf(state) + 1).padStart(16, '0')}`,
    state,
    action_id,
    effect: local ? 'local-write' : 'harness-write',
    actor: {
      kind: 'human',
      role: local ? 'architect' : 'inspector',
      declaration_source: 'cli-flag',
    },
    consent: { write: true, allow_publish: false, experimental: false },
    artifacts,
    prior_state: {
      state: prior.state,
      state_id: prior.state_id,
      record_digest_sha256: prior.record_digest_sha256,
    },
    bound_receipts: [],
  });
}

function localChain(
  until: 'exported' | 'evidence_published' = 'exported',
): ReleaseLifecycleStateRecord[] {
  const records = [finalizeReleaseLifecycleState(stateBase())];
  records.push(nextState(present(records[0]), 'certified', 'release certify'));
  records.push(nextState(present(records[1]), 'prepared', 'release prepare'));
  records.push(nextState(present(records[2]), 'exported', 'release export'));
  if (until === 'evidence_published') {
    const prior = present(records.at(-1));
    records.push(
      finalizeReleaseLifecycleState({
        ...stateBase(),
        state_id: 'RLS-0000000000000004',
        state: 'evidence_published',
        action_id: 'release evidence-publish',
        effect: 'remote-write',
        prior_state: {
          state: prior.state,
          state_id: prior.state_id,
          record_digest_sha256: prior.record_digest_sha256,
        },
        bound_receipts: [
          {
            kind: 'release-offline-verification-receipt',
            receipt_id: offlineReceipt().receipt_id,
            receipt_digest_sha256: offlineReceipt().receipt_digest_sha256,
            verdict: 'pass',
          },
        ],
        artifacts: [
          {
            kind: 'evidence-bundle',
            path: 'dist/evidence.tgz',
            sha256: 'd'.repeat(64),
            size_bytes: 1,
          },
        ],
        actor: { kind: 'human', role: 'owner', declaration_source: 'cli-flag' },
        consent: { write: true, allow_publish: true, experimental: false },
        authorization_event_id: 'EA-0123456789abcdef',
      }),
    );
  }
  return records;
}

function remoteDraft(
  prior: ReleaseLifecycleStateRecord,
  authorization_event_id: string,
): StateDraft {
  const example = present(examples('release-lifecycle-state')[1]) as ReleaseLifecycleStateRecord;
  return {
    ...stateBase(),
    state_id: 'RLS-0000000000000005',
    state: 'publication_dispatched',
    action_id: 'release publish',
    effect: 'remote-write',
    prior_state: {
      state: prior.state,
      state_id: prior.state_id,
      record_digest_sha256: prior.record_digest_sha256,
    },
    artifacts: example['artifacts'] as readonly ReleaseArtifactIdentity[],
    actor: { kind: 'human', role: 'owner', declaration_source: 'cli-flag' },
    consent: { write: true, allow_publish: true, experimental: false },
    authorization_event_id,
    publication_expectation: {
      ...(example['publication_expectation'] as PublicationExpectation),
      authorization_event_id,
    },
    bound_receipts: [],
  };
}

function planReceipt(version: '1.0.0' | '2.0.0'): ReleasePlanReceipt {
  const name = version === '2.0.0' ? 'release-plan-receipt-v2' : 'release-plan-receipt';
  const source = structuredClone(present(examples(name)[0]));
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Invalid plan receipt example');
  }
  const {
    receipt_id: _id,
    receipt_digest_sha256: _digest,
    ...draft
  } = source as ReleasePlanReceipt;
  void _id;
  void _digest;
  return finalizeReleasePlanReceipt(draft);
}

function offlineReceipt(): ReleaseOfflineVerificationReceipt {
  const source = structuredClone(present(examples('release-offline-verification-receipt')[0]));
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Invalid offline receipt example');
  }
  const {
    receipt_id: _id,
    receipt_digest_sha256: _digest,
    ...draft
  } = source as ReleaseOfflineVerificationReceipt;
  void _id;
  void _digest;
  return finalizeReleaseOfflineVerificationReceipt(draft);
}

describe('Wave1 release lifecycle receipt and resume boundaries', () => {
  it('rejects a validly shaped record whose digest was tampered', () => {
    const record = finalizeReleaseLifecycleState(stateBase());
    const tampered = { ...record, record_digest_sha256: 'f'.repeat(64) };
    const result = reduceReleaseLifecycle([tampered]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected digest rejection');
    expect(result.errors).toContain('release-state-record-digest-mismatch');
  });

  it('round-trips and detects tampering for v1, v2 plan, and offline receipts', () => {
    const v1 = planReceipt('1.0.0');
    expect(v1.receipt_id).toBe(`RPL-${computeReleaseReadReceiptDigest(v1).slice(0, 16)}`);
    expect(verifyReleasePlanReceiptIdentity(v1)).toBe(true);
    expect(verifyReleasePlanReceiptIdentity({ ...v1, receipt_id: 'RPL-0000000000000000' })).toBe(
      false,
    );
    expect(verifyReleasePlanReceiptIdentity({ ...v1, receipt_digest_sha256: 'f'.repeat(64) })).toBe(
      false,
    );

    const v2 = planReceipt('2.0.0');
    expect(v2.schemaVersion).toBe('2.0.0');
    expect(verifyReleasePlanReceiptIdentity(v2)).toBe(true);

    const offline = offlineReceipt();
    expect(offline.receipt_id).toBe(`ROV-${computeReleaseReadReceiptDigest(offline).slice(0, 16)}`);
    expect(verifyReleaseOfflineReceiptIdentity(offline)).toBe(true);
    expect(
      verifyReleaseOfflineReceiptIdentity({ ...offline, receipt_id: 'ROV-0000000000000000' }),
    ).toBe(false);
  });

  it('derives offline verification only from an exported head and its receipt', async () => {
    const exported = localChain('exported');
    const head = present(exported.at(-1));
    const receipt = offlineReceipt();
    const derived = {
      state: 'offline_verified' as const,
      receipt_kind: 'release-offline-verification-receipt' as const,
      receipt_id: receipt.receipt_id,
      receipt_digest_sha256: receipt.receipt_digest_sha256,
      verified: true as const,
    };
    const withReceipt = await resumeReleaseLifecycle({
      records: exported,
      repository: head.repository,
      candidate: head.candidate,
      derived_receipts: [derived],
      verifySignature: () => {
        throw new Error('No publication signature should be requested');
      },
    });
    expect(withReceipt.next_action).toBe('release evidence-publish');

    const withoutReceipt = await resumeReleaseLifecycle({
      records: exported,
      repository: head.repository,
      candidate: head.candidate,
      verifySignature: () => false,
    });
    expect(withoutReceipt.next_action).toBe('release offline-verify');

    const published = localChain('evidence_published');
    const publishedHead = present(published.at(-1));
    const evidenceObservation = await resumeReleaseLifecycle({
      records: published,
      repository: publishedHead.repository,
      candidate: publishedHead.candidate,
      derived_receipts: [derived],
      verifySignature: () => false,
    });
    expect(evidenceObservation.next_action).toBe('release publish');
  });

  it('derives planned only from a planned receipt when there is no persisted head', async () => {
    const receipt = planReceipt('1.0.0');
    const planned = {
      state: 'planned' as const,
      receipt_kind: 'release-plan-receipt' as const,
      receipt_id: receipt.receipt_id,
      receipt_digest_sha256: receipt.receipt_digest_sha256,
      verified: true as const,
    };
    const repository = receipt.repository;
    const candidate = receipt.candidate;
    const plannedObservation = await resumeReleaseLifecycle({
      records: [],
      repository,
      candidate,
      derived_receipts: [planned],
      verifySignature: () => false,
    });
    expect(plannedObservation.next_action).toBe('release preflight');

    const emptyObservation = await resumeReleaseLifecycle({
      records: [],
      repository,
      candidate,
      verifySignature: () => false,
    });
    expect(emptyObservation.next_action).toBe('release plan');
    const nonPlannedObservation = await resumeReleaseLifecycle({
      records: [],
      repository,
      candidate,
      derived_receipts: [
        {
          ...planned,
          state: 'offline_verified',
          receipt_kind: 'release-offline-verification-receipt',
          receipt_id: offlineReceipt().receipt_id,
          receipt_digest_sha256: offlineReceipt().receipt_digest_sha256,
        },
      ],
      verifySignature: () => false,
    });
    expect(nonPlannedObservation.next_action).toBe('release plan');
  });

  it('rejects a remote draft whose state authorization event differs from the request', async () => {
    const records = localChain('evidence_published');
    const prior = present(records.at(-1));
    const remote = remoteDraft(prior, 'EA-1111111111111111');
    const grant = present(examples('effect-authorization-event')[0]) as EffectAuthorizationEvent;
    const ledger = present(examples('effect-authorization-ledger')[0]) as EffectAuthorizationLedger;
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
    const adapter = vi.fn(async () => 'should-not-run');
    const appendState = vi.fn(async () => undefined);
    const result = await executeAuthorizedReleaseTransition({
      records,
      draft: {
        ...remote,
        authorization_event_id: 'EA-1111111111111111',
        prior_state: {
          state: prior.state,
          state_id: prior.state_id,
          record_digest_sha256: prior.record_digest_sha256,
        },
        publication_expectation: {
          ...(remote.publication_expectation ?? {}),
          authorization_event_id: grant.event_id,
        },
      },
      authorizationLedger: ledger,
      resolveAuthorizationEvent: () => grant,
      authorizationRequest: request,
      appendAuthorizationConsumption: async () => undefined,
      adapter,
      appendState,
    });
    expect(result).toEqual({
      ok: false,
      phase: 'validation',
      code: 'release-state-authorization-mismatch',
    });
    expect(adapter).not.toHaveBeenCalled();
    expect(appendState).not.toHaveBeenCalled();
  });

  it('reports an authorization phase when the ledger has no matching grant', async () => {
    const chain = localChain('evidence_published');
    const prior = present(chain.at(-1));
    const grant = present(examples('effect-authorization-event')[0]) as EffectAuthorizationEvent;
    const ledger = present(examples('effect-authorization-ledger')[0]) as EffectAuthorizationLedger;
    const request: EffectAuthorizationGrantRequest = {
      authorization_event_id: 'EA-2222222222222222',
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
    const appendState = vi.fn(async () => undefined);
    const adapter = vi.fn(async () => 'should-not-run');
    const result = await executeAuthorizedReleaseTransition({
      records: chain,
      draft: {
        ...remoteDraft(prior, request.authorization_event_id),
      },
      authorizationLedger: ledger,
      resolveAuthorizationEvent: (entry) => (entry.event_id === grant.event_id ? grant : undefined),
      authorizationRequest: request,
      appendAuthorizationConsumption: async () => undefined,
      adapter,
      appendState,
    });
    expect(result).toEqual({
      ok: false,
      phase: 'authorization',
      code: 'absent-effect-authorization',
    });
    expect(appendState).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });
});
