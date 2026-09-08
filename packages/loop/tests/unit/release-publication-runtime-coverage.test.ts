// Pure legacy publication reconciliation with real Ed25519 signatures; no external effects.
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsers } from '@devai-nyx/schemas';
import {
  computePublicationReceiptDigest,
  computePublicationSignedPayloadDigest,
  finalizeReleaseLifecycleState,
  resumeReleaseLifecycle,
  type ReleaseLifecycleStateRecord,
  type ReleasePublicationReceipt,
} from '../../src/release-lifecycle/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const examples = (name: string): Record<string, unknown>[] =>
  JSON.parse(readFileSync(resolve(root, `law/schemas/${name}.schema.json`), 'utf8')).examples;
const stateExamples = examples('release-lifecycle-state');
const receiptExample = examples(
  'release-publication-receipt',
)[0] as unknown as ReleasePublicationReceipt;
const keys = generateKeyPairSync('ed25519');
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing publication fixture');
  return value;
}
function base() {
  const value = structuredClone(present(stateExamples[0]));
  value.schemaVersion = '1.0.0';
  delete value.canonicalization;
  delete value.release_units;
  delete value.storage;
  delete value.record_digest_sha256;
  return value;
}
function reference(state: ReleaseLifecycleStateRecord) {
  return {
    state: state.state,
    state_id: state.state_id,
    record_digest_sha256: state.record_digest_sha256,
  };
}
function chain(): ReleaseLifecycleStateRecord[] {
  const records = [finalizeReleaseLifecycleState(base())];
  const remote = present(stateExamples[1]);
  const transitions = [
    ['certified', 'release certify', 'harness-write', 'inspector'],
    ['prepared', 'release prepare', 'local-write', 'architect'],
    ['exported', 'release export', 'local-write', 'architect'],
    ['evidence_published', 'release evidence-publish', 'remote-write', 'owner'],
    ['publication_dispatched', 'release publish', 'remote-write', 'owner'],
  ] as const;
  for (const [index, [state, action, effect, role]] of transitions.entries()) {
    const prior = present(records.at(-1));
    const remoteWrite = effect === 'remote-write';
    records.push(
      finalizeReleaseLifecycleState({
        ...base(),
        state_id: `RLS-${String(index + 1).repeat(16)}`,
        state,
        action_id: action,
        effect,
        actor: { kind: 'human', role, declaration_source: 'cli-flag' },
        consent: { write: true, allow_publish: remoteWrite, experimental: false },
        prior_state: reference(prior),
        authorization_event_id: remoteWrite ? remote.authorization_event_id : null,
        publication_expectation:
          state === 'publication_dispatched' ? remote.publication_expectation : null,
        bound_receipts:
          state === 'evidence_published'
            ? [
                {
                  kind: 'release-offline-verification-receipt',
                  receipt_id: 'ROV-0123456789abcdef',
                  receipt_digest_sha256: 'a'.repeat(64),
                  verdict: 'pass',
                },
              ]
            : [],
        artifacts: remoteWrite
          ? receiptExample.artifacts
          : ['package-tarball', 'manifest', 'sbom', 'evidence-bundle', 'provider-result'].map(
              (kind) => ({ kind, path: `dist/${kind}.bin`, sha256: 'a'.repeat(64), size_bytes: 1 }),
            ),
      }),
    );
  }
  return records;
}
function reseal(receipt: ReleasePublicationReceipt): ReleasePublicationReceipt {
  const value = structuredClone(receipt);
  const digest = computePublicationSignedPayloadDigest(value);
  const trust = {
    ...value.trust,
    signed_payload_digest_sha256: digest,
    signature: sign(null, Buffer.from(digest, 'utf8'), keys.privateKey).toString('base64'),
  };
  return {
    ...value,
    trust,
    receipt_id: `RPU-${digest.slice(0, 16)}`,
    receipt_digest_sha256: computePublicationReceiptDigest({
      ...value,
      trust,
      receipt_id: `RPU-${digest.slice(0, 16)}`,
    }),
  };
}
function receiptFor(head: ReleaseLifecycleStateRecord): ReleasePublicationReceipt {
  return reseal({
    ...structuredClone(receiptExample),
    repository: head.repository,
    candidate: head.candidate,
    dispatched_state: { ...reference(head), state: 'publication_dispatched' },
    artifacts: head.artifacts,
  });
}
async function observe(records: ReleaseLifecycleStateRecord[], receipt: unknown, calls: string[]) {
  const head = present(records.at(-1));
  return resumeReleaseLifecycle({
    records,
    repository: head.repository,
    candidate: head.candidate,
    publication_receipt: receipt,
    verifySignature: ({ signed_payload_digest_sha256, signature, trust }) => {
      calls.push(trust.key_id);
      return verify(
        null,
        Buffer.from(signed_payload_digest_sha256, 'utf8'),
        keys.publicKey,
        Buffer.from(signature, 'base64'),
      );
    },
  });
}

describe('publication receipts bind exact dispatch and independent signature evidence', () => {
  it('does not derive publication from a signed failed outcome', async () => {
    const records = chain();
    const receipt = reseal({
      ...receiptFor(present(records.at(-1))),
      outcome: 'failed',
      attests_state: null,
    });
    expect(parsers.releasePublicationReceipt.safeParse(receipt).ok).toBe(true);
    const calls: string[] = [];
    const observed = await observe(records, receipt, calls);
    expect(observed.published.observed).toBe(false);
    expect(observed.derived_states).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('does not treat a receipt as evidence that an unrecorded dispatch happened', async () => {
    const records = chain();
    const receipt = receiptFor(present(records.at(-1)));
    const calls: string[] = [];
    const observed = await observe(records.slice(0, -1), receipt, calls);
    expect(observed.head?.state).toBe('evidence_published');
    expect(observed.published.observed).toBe(false);
    expect(observed.next_action).toBe('release publish');
    expect(calls).toEqual([]);
  });

  it('reproduces the fixed publisher example digest vectors', () => {
    expect(computePublicationSignedPayloadDigest(receiptExample)).toBe(
      receiptExample.trust.signed_payload_digest_sha256,
    );
    expect(computePublicationReceiptDigest(receiptExample)).toBe(
      receiptExample.receipt_digest_sha256,
    );
  });

  it('derives publication only after signature verification without changing the persisted chain', async () => {
    const records = chain();
    const head = present(records.at(-1));
    const receipt = receiptFor(head);
    const calls: string[] = [];
    expect(parsers.releasePublicationReceipt.safeParse(receipt).ok).toBe(true);
    const before = JSON.stringify({ records, receipt });
    const observed = await observe(records, receipt, calls);
    expect(calls).toEqual([receipt.trust.key_id]);
    expect(observed.next_action).toBeNull();
    expect(observed.next_outcome).toBe('complete');
    expect(observed.published).toMatchObject({
      observed: true,
      verified_against: {
        ...reference(head),
        candidate_identity_verified: true,
        artifact_identity_verified: true,
        destination_identity_verified: true,
        workflow_identity_verified: true,
        trust_identity_verified: true,
      },
    });
    expect(observed.derived_states).toEqual([
      {
        state: 'published',
        receipt_kind: 'release-publication-receipt',
        receipt_id: receipt.receipt_id,
        receipt_digest_sha256: receipt.receipt_digest_sha256,
        verified: true,
      },
    ]);
    expect(JSON.stringify({ records, receipt })).toBe(before);
  });

  it('waits for a receipt after dispatch instead of claiming completion or redispatch', async () => {
    const records = chain();
    const calls: string[] = [];
    const observed = await observe(records, undefined, calls);
    expect(observed.next_action).toBe('release resume');
    expect(observed.next_outcome).toBe('awaiting-external-receipt');
    expect(observed.published.observed).toBe(false);
    expect(calls).toEqual([]);
  });

  const changes: ReadonlyArray<
    readonly [string, (r: ReleasePublicationReceipt) => ReleasePublicationReceipt]
  > = [
    ['repository', (r) => ({ ...r, repository: { ...r.repository, id: 'other/repository' } })],
    ['candidate commit', (r) => ({ ...r, candidate: { ...r.candidate, commit: 'd'.repeat(40) } })],
    ['candidate tree', (r) => ({ ...r, candidate: { ...r.candidate, tree: 'e'.repeat(40) } })],
    [
      'dispatch identity',
      (r) => ({
        ...r,
        dispatched_state: { ...r.dispatched_state, state_id: 'RLS-abcdef0123456789' },
      }),
    ],
    [
      'dispatch digest',
      (r) => ({
        ...r,
        dispatched_state: { ...r.dispatched_state, record_digest_sha256: 'b'.repeat(64) },
      }),
    ],
    [
      'artifact bytes',
      (r) => ({ ...r, artifacts: r.artifacts.map((a) => ({ ...a, sha256: 'c'.repeat(64) })) }),
    ],
    [
      'artifact location',
      (r) => ({ ...r, artifacts: r.artifacts.map((a) => ({ ...a, path: 'dist/other.tgz' })) }),
    ],
    [
      'destination',
      (r) => ({
        ...r,
        publication: { ...r.publication, exact_identifier: '@fixture/other@1.5.0' },
      }),
    ],
    [
      'workflow revision',
      (r) => ({ ...r, workflow: { ...r.workflow, workflow_sha: 'f'.repeat(40) } }),
    ],
    [
      'workflow repository',
      (r) => ({ ...r, workflow: { ...r.workflow, repository: 'other/repo' } }),
    ],
    [
      'workflow path',
      (r) => ({ ...r, workflow: { ...r.workflow, workflow_path: '.github/workflows/other.yml' } }),
    ],
    [
      'protected environment',
      (r) => ({ ...r, workflow: { ...r.workflow, protected_environment: 'other-release' } }),
    ],
    ['trust key', (r) => ({ ...r, trust: { ...r.trust, key_id: 'other-key' } })],
    ['trust root', (r) => ({ ...r, trust: { ...r.trust, trust_root_id: 'other-root' } })],
    [
      'trust population',
      (r) => ({ ...r, trust: { ...r.trust, trust_store_digest_sha256: 'd'.repeat(64) } }),
    ],
  ];
  it.each(changes)(
    'rejects a correctly signed receipt for a different %s before invoking signature verification',
    async (_label, change) => {
      const records = chain();
      const receipt = reseal(change(receiptFor(present(records.at(-1)))));
      const calls: string[] = [];
      expect(parsers.releasePublicationReceipt.safeParse(receipt).ok).toBe(true);
      const observed = await observe(records, receipt, calls);
      expect(observed.published.observed).toBe(false);
      expect(observed.derived_states).toEqual([]);
      expect(calls).toEqual([]);
      expect(observed.next_outcome).toBe('awaiting-external-receipt');
    },
  );

  it.each(['receipt_id', 'receipt_digest_sha256', 'signed_payload_digest_sha256'] as const)(
    'rejects corrupt %s before signature verification',
    async (field) => {
      const records = chain();
      let receipt = receiptFor(present(records.at(-1)));
      receipt =
        field === 'signed_payload_digest_sha256'
          ? { ...receipt, trust: { ...receipt.trust, [field]: 'b'.repeat(64) } }
          : {
              ...receipt,
              [field]: field === 'receipt_id' ? 'RPU-abcdef0123456789' : 'b'.repeat(64),
            };
      // Keep the outer hash valid so it cannot mask a missing inner-identity check.
      if (field !== 'receipt_digest_sha256') {
        receipt = { ...receipt, receipt_digest_sha256: computePublicationReceiptDigest(receipt) };
      }
      expect(parsers.releasePublicationReceipt.safeParse(receipt).ok).toBe(true);
      const calls: string[] = [];
      const observed = await observe(records, receipt, calls);
      expect(observed.published.observed).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it('rejects a signature from an untrusted key even when all identities and hashes match', async () => {
    const records = chain();
    const original = receiptFor(present(records.at(-1)));
    const wrong = generateKeyPairSync('ed25519');
    const changed = {
      ...original,
      trust: {
        ...original.trust,
        signature: sign(
          null,
          Buffer.from(original.trust.signed_payload_digest_sha256, 'utf8'),
          wrong.privateKey,
        ).toString('base64'),
      },
    };
    const receipt = { ...changed, receipt_digest_sha256: computePublicationReceiptDigest(changed) };
    const calls: string[] = [];
    expect(parsers.releasePublicationReceipt.safeParse(receipt).ok).toBe(true);
    const observed = await observe(records, receipt, calls);
    expect(calls).toHaveLength(1);
    expect(observed.published.observed).toBe(false);
    expect(observed.derived_states).toEqual([]);
  });
});
