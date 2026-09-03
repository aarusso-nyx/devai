import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  ReleaseLifecycleFileStore,
  executeReleaseLifecycleAction,
  executeOfflineVerification,
  reduceStoreRecords,
  resumeReleaseLifecycleExecution,
  validateReleaseLifecycleRequest,
  verifyReleaseStateIdentity,
  type ReleaseLifecycleRequest,
  type ReleaseStateMaterial,
  type StoreRecord,
} from '../../src/services/release-lifecycle-execution.js';

const COMMIT = '5461ba500000000000000000000000000000aaaa';
const TREE = '2cad519aba8117a1850eee85d41eae452d51a141';
const MANIFEST_DIGEST = 'a4001ab74eae5866fc8a070f305bc4e393da167965cbcc4d2471872881ce68d5';
const EVIDENCE_DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function planReceipt(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas/release-plan-receipt.schema.json'), 'utf8'),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const example = schema.examples[0];
  if (example === undefined) throw new Error('missing release plan fixture');
  return example;
}

function offlineReceipt(): Readonly<Record<string, unknown>> {
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), 'law/schemas/release-offline-verification-receipt.schema.json'),
      'utf8',
    ),
  ) as { examples: readonly Readonly<Record<string, unknown>>[] };
  const example = schema.examples[0];
  if (example === undefined) throw new Error('missing offline verification fixture');
  return example;
}

function request(
  action: ReleaseLifecycleRequest['action_id'] = 'release preflight',
): ReleaseLifecycleRequest {
  const receipt = planReceipt();
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
              manifest_digest_sha256: MANIFEST_DIGEST,
            },
          ],
        },
      ],
    },
  } as const;
  if (action === 'release plan' || action === 'release resume') return base;
  if (action === 'release prepare') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
      destination: { kind: 'local-staging', exact_identifier: 'staging/devai-1.5.0' },
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release export') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
      provider: { kind: 'evidence-export', provider_id: 'canonical-verifier' },
      destination: { kind: 'evidence-destination', exact_identifier: 'external/devai-1.5.0' },
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release offline-verify') {
    return {
      ...base,
      receipt_locators: [receiptLocator(receipt)],
      provider: { kind: 'offline-verifier', provider_id: 'canonical-verifier' },
      destination: {
        kind: 'external-trust-input',
        exact_identifier: 'trust/devai-1.5.0',
        trust: {
          trust_root_id: 'release-root',
          trust_store_digest_sha256: 'b'.repeat(64),
          key_id: 'release-key',
          signature_algorithm: 'ed25519',
        },
      },
    } as ReleaseLifecycleRequest;
  }
  if (action === 'release evidence-publish' || action === 'release publish') {
    const requiredReceipt = action === 'release evidence-publish' ? offlineReceipt() : receipt;
    return {
      ...base,
      receipt_locators: [
        {
          ...receiptLocator(requiredReceipt),
          kind:
            action === 'release evidence-publish'
              ? ('release-offline-verification-receipt' as const)
              : ('release-plan-receipt' as const),
        },
      ],
      provider: { kind: 'protected-dispatch', provider_id: 'github-actions' },
      destination: {
        kind: 'publication-destination',
        exact_identifier:
          action === 'release publish'
            ? 'npm:@aarusso-nyx/devai@1.5.0'
            : 'git:refs/tags/evidence/v1.5.0',
      },
    } as ReleaseLifecycleRequest;
  }
  return { ...base, receipt_locators: [receiptLocator(receipt)] } as ReleaseLifecycleRequest;
}

function receiptLocator(receipt: Readonly<Record<string, unknown>>) {
  return {
    kind: 'release-plan-receipt' as const,
    receipt_id: String(receipt['receipt_id']),
    receipt_digest_sha256: String(receipt['receipt_digest_sha256']),
    path: 'receipts/plan.json',
  };
}

function material(): ReleaseStateMaterial {
  return {
    release_units: [
      {
        release_unit: '@aarusso-nyx/devai',
        version: '1.5.0',
        packages: [
          {
            package_id: '@aarusso-nyx/devai',
            manifest: { path: 'package.json', sha256: MANIFEST_DIGEST, size_bytes: 1 },
            tarball: null,
            sbom: null,
            evidence_manifest: null,
            provider_result: null,
            trust: null,
          },
        ],
      },
    ],
    inputs: [
      {
        kind: 'release-lifecycle-policy',
        path: 'law/policy/release-lifecycle.json',
        sha256: MANIFEST_DIGEST,
      },
    ],
    evidence: {
      manifest_digest_sha256: EVIDENCE_DIGEST,
      receipt_digests: [String(planReceipt()['receipt_digest_sha256'])],
      independently_checkable: true,
    },
    artifacts: [],
  };
}

function materialFor(action: ReleaseLifecycleRequest['action_id']): ReleaseStateMaterial {
  const base = material();
  const baseUnit = required(base.release_units[0], 'missing base unit');
  const packageEvidence = required(baseUnit.packages[0], 'missing base package');
  const artifact = (path: string): { path: string; sha256: string; size_bytes: number } => ({
    path,
    sha256: MANIFEST_DIGEST,
    size_bytes: 1,
  });
  if (action === 'release preflight' || action === 'release certify') return base;
  const prepared = {
    ...packageEvidence,
    tarball: artifact('dist/devai.tgz'),
    sbom: artifact('dist/devai.sbom.json'),
  };
  if (action === 'release prepare') {
    return {
      ...base,
      release_units: [{ ...baseUnit, packages: [prepared] }],
      artifacts: [
        { kind: 'manifest', ...artifact('dist/devai.manifest.json') },
        { kind: 'package-tarball', ...artifact('dist/devai.tgz') },
        { kind: 'sbom', ...artifact('dist/devai.sbom.json') },
      ],
    };
  }
  const exported = {
    ...prepared,
    evidence_manifest: artifact('evidence/manifest.json'),
    provider_result: artifact('evidence/provider-result.json'),
    trust: {
      trust_root_id: 'release-root',
      trust_store_digest_sha256: 'b'.repeat(64),
      key_id: 'release-key',
      signature_algorithm: 'ed25519' as const,
    },
  };
  return {
    ...base,
    release_units: [{ ...baseUnit, packages: [exported] }],
    artifacts: [
      { kind: 'evidence-bundle', ...artifact('evidence/bundle.tgz') },
      { kind: 'provider-result', ...artifact('evidence/provider-result.json') },
    ],
  };
}

async function advanceToExported(store: ReleaseLifecycleFileStore): Promise<void> {
  for (const action of [
    'release preflight',
    'release certify',
    'release prepare',
    'release export',
  ] as const) {
    const value = request(action);
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action,
        store,
        resolveReceipt: () => planReceipt(),
        provider: () => ({ outcome: 'success', material: materialFor(action) }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    if (!result.ok) throw new Error(`advance failed: ${result.code}`);
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'devai-release-lifecycle-'));
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe('release lifecycle execution kernel', () => {
  it('rejects recursive authority injection, identity drift, and non-canonical rosters', () => {
    const valid = request();
    expect(validateReleaseLifecycleRequest(valid, 'release preflight')).toEqual(valid);
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: { ...valid.candidate_locator, authorization: 'invented' },
      }),
    ).toThrow('release-request-projection-invalid:authorization');
    expect(() =>
      validateReleaseLifecycleRequest({
        ...valid,
        candidate_locator: { ...valid.candidate_locator, tree: 'f'.repeat(40) },
      }),
    ).toThrow('release-request-identity-mismatch');
    const twoPackages = {
      ...valid,
      candidate_locator: {
        ...valid.candidate_locator,
        release_units: [
          {
            ...valid.candidate_locator.release_units[0],
            package_roster: [
              {
                package_id: 'z-package',
                manifest_path: 'z/package.json',
                manifest_digest_sha256: MANIFEST_DIGEST,
              },
              ...required(
                valid.candidate_locator.release_units[0],
                'missing candidate release unit',
              ).package_roster,
            ],
          },
        ],
      },
    };
    expect(() => validateReleaseLifecycleRequest(twoPackages)).toThrow(
      'release-release-unit-bijection-invalid',
    );
  });

  it('persists a v2 preflight attempt, state, completion, and head durably', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const result = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        store,
        resolveReceipt: () => planReceipt(),
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.schemaVersion).toBe('2.0.0');
    expect(verifyReleaseStateIdentity(result.state, true).state_id).toBe(result.state.state_id);
    expect(store.readHead()).toEqual({
      generation: 0,
      record_digest_sha256: result.state.record_digest_sha256,
    });
    expect(store.readStateRecords()).toHaveLength(1);
    expect(store.readStoreRecords().map((record) => record.record_kind)).toEqual([
      'attempt',
      'completion',
    ]);
  });

  it('refuses invalid authorization before provider availability or invocation', async () => {
    const value = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToExported(store);
    const provider = vi.fn(() => ({ outcome: 'unknown' as const }));
    const result = await executeReleaseLifecycleAction({
      request: value,
      action: 'release evidence-publish',
      store,
      resolveReceipt: () => offlineReceipt(),
      authorization: {
        resolve: () => ({ ok: false, code: 'authorization-identity-mismatch' }),
        consume: () => undefined,
      },
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(result).toMatchObject({
      ok: false,
      phase: 'authorization',
      code: 'authorization-identity-mismatch',
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('consumes a remote grant only after the attempt is durable and never redispatches unknown', async () => {
    const value = request('release evidence-publish');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToExported(store);
    const order: string[] = [];
    const provider = vi.fn(() => {
      order.push('provider');
      return { outcome: 'unknown' as const, provider_handle: 'run-1' };
    });
    const first = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release evidence-publish',
        store,
        resolveReceipt: () => offlineReceipt(),
        authorization: {
          resolve: () => ({ ok: true, grant_event_id: `EA-${'1'.repeat(16)}` }),
          consume: () => {
            order.push(store.readStoreRecords().at(-1)?.record_kind ?? 'missing');
          },
        },
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(first).toMatchObject({ ok: false, phase: 'ambiguous' });
    expect(order.at(-2)).toBe('attempt');
    expect(order.at(-1)).toBe('provider');
    expect(
      store
        .readStoreRecords()
        .slice(-2)
        .map((record) => record.record_kind),
    ).toEqual(['attempt', 'unknown-provider-result']);

    const second = await executeReleaseLifecycleAction({
      request: value,
      action: 'release evidence-publish',
      store,
      resolveReceipt: () => offlineReceipt(),
      authorization: {
        resolve: () => ({ ok: true, grant_event_id: `EA-${'2'.repeat(16)}` }),
        consume: () => undefined,
      },
      provider,
      recorded_at: '2026-09-03T00:00:01.000Z',
    });
    expect(second).toMatchObject({ ok: false, phase: 'reconciliation' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('reports deterministic next actions, failures, and unknown outcomes without writes', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        store,
        resolveReceipt: () => planReceipt(),
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    if (!success.ok) return;
    const before = JSON.stringify(store.readStoreRecords());
    const observation = await resumeReleaseLifecycleExecution({
      states: store.readStateRecords(),
      store_records: store.readStoreRecords(),
      repository: value.repository_locator,
      candidate: success.state.candidate,
    });
    expect(observation).toMatchObject({
      next_action: 'release certify',
      next_outcome: 'ready',
    });
    expect(JSON.stringify(store.readStoreRecords())).toBe(before);

    const attempt = store.readStoreRecords()[0] as StoreRecord;
    const ambiguous = await resumeReleaseLifecycleExecution({
      states: [],
      store_records: [attempt],
      repository: value.repository_locator,
      candidate: success.state.candidate,
    });
    expect(ambiguous).toMatchObject({ next_action: null, next_outcome: 'ambiguous' });
  });

  it('rejects corrupted and forked append-only records and symlinked stores', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        store,
        resolveReceipt: () => planReceipt(),
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    const records = store.readStoreRecords();
    expect(
      reduceStoreRecords([{ ...records[0], request_digest_sha256: 'f'.repeat(64) }, records[1]]).ok,
    ).toBe(false);

    const unsafeRoot = root();
    const target = root();
    symlinkSync(target, join(unsafeRoot, 'linked'));
    const unsafe = new ReleaseLifecycleFileStore(join(unsafeRoot, 'linked'), value);
    await expect(
      withAuthorityHostTestScope(() =>
        executeReleaseLifecycleAction({
          request: value,
          action: 'release preflight',
          store: unsafe,
          resolveReceipt: () => planReceipt(),
          provider: () => ({ outcome: 'success', material: material() }),
          recorded_at: '2026-09-03T00:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, phase: 'append', code: 'release-state-store-unsafe' });
  });

  it('accepts v1 only for observation and writes only content-derived v2 state', async () => {
    const value = request();
    const store = new ReleaseLifecycleFileStore(root(), value);
    const success = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request: value,
        action: 'release preflight',
        store,
        resolveReceipt: () => planReceipt(),
        provider: () => ({ outcome: 'success', material: material() }),
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(success.ok).toBe(true);
    if (!success.ok) return;
    const {
      canonicalization: _canonicalization,
      release_units: _units,
      storage: _storage,
      ...v2
    } = success.state;
    const { record_digest_sha256: _digest, ...v1Draft } = v2;
    const v1 = {
      ...v1Draft,
      schemaVersion: '1.0.0',
      record_digest_sha256: canonicalSha256({ ...v1Draft, schemaVersion: '1.0.0' }),
    };
    expect(verifyReleaseStateIdentity(v1).schemaVersion).toBe('1.0.0');
    expect(() => verifyReleaseStateIdentity(v1, true)).toThrow('release-state-v1-write-refused');
  });

  it('offline-verifies exact v2 package and external trust closure without writing state', async () => {
    const value = request('release export');
    const store = new ReleaseLifecycleFileStore(root(), value);
    await advanceToExported(store);
    const exported = required(store.readStateRecords().at(-1), 'missing exported state');
    const offlineRequest = request('release offline-verify');
    expect(
      await executeOfflineVerification({ request: offlineRequest, exported_state: exported }),
    ).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-offline-verifier-provider-unavailable',
    });

    const provider = () => {
      const legacy = offlineReceipt();
      const draft = {
        ...legacy,
        schemaVersion: '2.0.0',
        canonicalization: {
          ...(legacy['canonicalization'] as Readonly<Record<string, unknown>>),
          kernel_id: 'devai.kernel.release-offline-verification-receipt-canonicalization.v2',
        },
        repository: exported.repository,
        candidate: exported.candidate,
        verified_state: {
          state: exported.state,
          state_id: exported.state_id,
          record_digest_sha256: exported.record_digest_sha256,
        },
        release_units: exported.release_units,
      };
      const { receipt_id: _id, receipt_digest_sha256: _receiptDigest, ...projection } = draft;
      const digest = canonicalSha256(projection);
      return {
        ...projection,
        receipt_id: `ROV-${digest.slice(0, 16)}`,
        receipt_digest_sha256: digest,
      };
    };
    expect(
      await executeOfflineVerification({
        request: offlineRequest,
        exported_state: exported,
        provider,
      }),
    ).toMatchObject({ ok: true });

    const drifted = request('release offline-verify');
    const destination = required(drifted.destination, 'missing offline destination');
    const trust = required(destination.trust, 'missing offline trust');
    const mismatched = {
      ...drifted,
      destination: {
        ...destination,
        trust: { ...trust, key_id: 'different-release-key' },
      },
    };
    expect(
      await executeOfflineVerification({
        request: mismatched,
        exported_state: exported,
        provider,
      }),
    ).toMatchObject({ ok: false, code: 'release-offline-receipt-binding-invalid' });
  });
});
