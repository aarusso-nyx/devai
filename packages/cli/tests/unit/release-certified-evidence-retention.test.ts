import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  createProtectedReleaseHostAdapter,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { createReleaseRepositoryTestFixture } from '../../../authority/tests/unit/release-repository-test-fixture.js';
import { createReleaseCertificationEvidenceStore } from '../../src/services/release-evidence-store.js';
import {
  createCertifiedEvidenceCarrier,
  finalizeCertifiedEvidenceNamespaceCensus,
  readCertifiedEvidenceCarrier,
} from '../../src/services/release-certified-evidence-carrier.js';
import type { CertificationOutputClosureBinding } from '../../src/services/release-prepare-kernel.js';

const roots: string[] = [];
const REPOSITORY_FIXTURE = createReleaseRepositoryTestFixture();
const COMMIT = REPOSITORY_FIXTURE.repository.commit;
const TREE = REPOSITORY_FIXTURE.repository.tree;
const REFUSAL = 'release-certification-generated-output-untrusted';
const UNIT = '@fixture/unit';
const MAX_BLOB = 1024 * 1024;

const TASK_POLICY_DOCUMENT = {
  schemaVersion: '1.2.0',
  tasks: [{ nodeId: 'build', taskKey: 'build@1' }],
};
const TASK_POLICY = canonicalSha256(TASK_POLICY_DOCUMENT);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}

afterAll(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});

const derivation = {
  repository: { id: REPOSITORY_FIXTURE.repository.id, commit: COMMIT, tree: TREE },
  candidate: { commit: COMMIT, tree: TREE },
  task_policy_digest_sha256: TASK_POLICY,
};

function binding(packageId: string): CertificationOutputClosureBinding {
  return { ...derivation, package_id: packageId };
}

const taskResult = {
  schemaVersion: '1.0.0' as const,
  nodeId: 'build',
  taskKey: 'build@1',
  status: 'PASS' as const,
  inputDigest: 'a'.repeat(64),
  dependencyResultDigests: {},
  outputDigests: { 'generated/report.json': 'b'.repeat(64) },
  startedAt: '2026-09-04T00:00:00.000Z',
  finishedAt: '2026-09-04T00:00:01.000Z',
};

const candidateReceipt = {
  schemaVersion: '1.1.0',
  repository: { id: REPOSITORY_FIXTURE.repository.id, commit: COMMIT, tree: TREE },
  profile: 'rc',
  taskPolicyDigest: TASK_POLICY,
  createdAt: '2026-09-04T00:00:02.000Z',
  tasks: [{ nodeId: 'build', taskKey: 'build@1', resultDigest: canonicalSha256(taskResult) }],
};

const census = finalizeCertifiedEvidenceNamespaceCensus({
  release_unit: UNIT,
  derivation,
  entries: [
    {
      path: 'generated/report.json',
      mode: '100644',
      sha256: 'b'.repeat(64),
      size_bytes: 15,
      task_node: 'build',
    },
  ],
});

function carrierBytes(overrides: Record<string, unknown> = {}): Buffer {
  return createCertifiedEvidenceCarrier({
    release_unit: UNIT,
    derivation,
    candidate_receipt: candidateReceipt,
    task_policy: TASK_POLICY_DOCUMENT,
    task_results: [taskResult],
    namespace_census: census,
    maximum_bytes: MAX_BLOB,
    ...overrides,
  });
}

function storeFixture() {
  const evidenceRoot = root('devai carrier evidence');
  const candidateRoot = root('devai carrier candidate');
  const input = {
    root: evidenceRoot,
    evidence_sink_id: 'carrier-evidence-sink',
    repository_roots: [candidateRoot],
    max_blob_bytes: MAX_BLOB,
  } as const;
  return { input, store: createReleaseCertificationEvidenceStore(input) };
}

async function invokeSink<T>(owner: object, callback: () => T | Promise<T>): Promise<Awaited<T>> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-carrier-retention-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-carrier-retention-test',
    canonicalSha256,
    randomId: () => `release-carrier-retention-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'release certify',
    invocation_id: 'release-carrier-retention-test',
    effect: 'harness-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const operation = protectedReleaseHostEffect(request);
      if (operation?.kind !== 'sink') throw new Error('TEST_PROTECTED_SINK_OPERATION_REQUIRED');
      return apply();
    },
  };
  const adapter = createProtectedReleaseHostAdapter({
    action_id: 'release certify',
    repository: REPOSITORY_FIXTURE.repository,
    task_policy_digest_sha256: TASK_POLICY,
    plan_receipt_digest_sha256: 'd'.repeat(64),
    helper_identity_sha256: 'e'.repeat(64),
  });
  try {
    return await REPOSITORY_FIXTURE.run(
      async () =>
        await runWithAuthorityHostEffects(scope, () => adapter.invokeSink(callback, owner)),
    );
  } finally {
    issuer.dispose();
  }
}

const generated = Buffer.from('{"generated":true}');

async function retain(
  fixture: ReturnType<typeof storeFixture>,
  bytes: Buffer,
  release_unit = UNIT,
) {
  const owner = fixture.store.authority_owner;
  const transaction = await invokeSink(owner, () => fixture.store.begin([binding('@fixture/pkg')]));
  const handle = await invokeSink(owner, () =>
    transaction.put({
      bytes: generated,
      sha256: sha256(generated),
      size_bytes: generated.length,
    }),
  );
  const identity = await invokeSink(owner, () => {
    if (typeof transaction.putCertifiedEvidenceCarrier !== 'function')
      throw new Error('carrier retention unavailable');
    return transaction.putCertifiedEvidenceCarrier({
      release_unit,
      bytes,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    });
  });
  return { transaction, handle, identity, owner };
}

function outputs(handle: { readonly sha256: string }) {
  return [
    {
      path: 'generated/report.json',
      mode: '100644' as const,
      output_blob_handle: handle as never,
    },
  ];
}

describe('durable certified evidence retention', () => {
  it('commits the carrier atomically with the certification closure', async () => {
    const fixture = storeFixture();
    const bytes = carrierBytes();
    const { transaction, handle, identity, owner } = await retain(fixture, bytes);
    expect(identity).toEqual({
      evidence_sink_id: fixture.input.evidence_sink_id,
      release_unit: UNIT,
      opaque_handle: `sha256:${sha256(bytes)}`,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    });
    // Uncommitted evidence is not readable: the atomic commit records the identity.
    expect(() =>
      fixture.store.readCertifiedEvidenceCarrier?.({ ...derivation, release_unit: UNIT }),
    ).toThrow(REFUSAL);
    await invokeSink(owner, () =>
      transaction.commit([{ ...binding('@fixture/pkg'), outputs: outputs(handle) }]),
    );
    const read = fixture.store.readCertifiedEvidenceCarrier?.({
      ...derivation,
      release_unit: UNIT,
    }) as Buffer;
    expect(read.equals(bytes)).toBe(true);
    expect(readCertifiedEvidenceCarrier(read, MAX_BLOB).carrier.release_unit).toBe(UNIT);
  });

  it('serves committed evidence to a restarted reader that executes no task', async () => {
    const fixture = storeFixture();
    const bytes = carrierBytes();
    const { transaction, handle, owner } = await retain(fixture, bytes);
    await invokeSink(owner, () =>
      transaction.commit([{ ...binding('@fixture/pkg'), outputs: outputs(handle) }]),
    );
    // A fresh store over the same durable root, with no live transaction or cache.
    const restarted = createReleaseCertificationEvidenceStore(fixture.input);
    const read = restarted.readCertifiedEvidenceCarrier?.({
      ...derivation,
      release_unit: UNIT,
    }) as Buffer;
    expect(read.equals(bytes)).toBe(true);
    const decoded = readCertifiedEvidenceCarrier(read, MAX_BLOB);
    expect(JSON.parse(decoded.candidate_receipt.toString('utf8'))).toEqual(candidateReceipt);
    expect(JSON.parse(decoded.task_policy.toString('utf8'))).toEqual(TASK_POLICY_DOCUMENT);
    expect(decoded.task_results).toHaveLength(1);
    expect(decoded.census.entries[0]?.path).toBe('generated/report.json');
  });

  it('preserves committed evidence after a later reader failure', async () => {
    const fixture = storeFixture();
    const bytes = carrierBytes();
    const { transaction, handle, owner } = await retain(fixture, bytes);
    await invokeSink(owner, () =>
      transaction.commit([{ ...binding('@fixture/pkg'), outputs: outputs(handle) }]),
    );
    // A downstream consumer asking for a unit that was never certified must refuse
    // without disturbing the retained population.
    expect(() =>
      fixture.store.readCertifiedEvidenceCarrier?.({
        ...derivation,
        release_unit: '@fixture/other',
      }),
    ).toThrow(REFUSAL);
    const read = fixture.store.readCertifiedEvidenceCarrier?.({
      ...derivation,
      release_unit: UNIT,
    }) as Buffer;
    expect(read.equals(bytes)).toBe(true);
  });

  it('refuses a cross-unit, duplicate, or foreign-derivation carrier', async () => {
    const fixture = storeFixture();
    const owner = fixture.store.authority_owner;
    const bytes = carrierBytes();
    const { transaction } = await retain(fixture, bytes);
    // The producer cannot rename a unit: the sink decodes the bytes itself.
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: '@fixture/other',
          bytes,
          sha256: sha256(bytes),
          size_bytes: bytes.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
    // One carrier per unit per transaction.
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: UNIT,
          bytes,
          sha256: sha256(bytes),
          size_bytes: bytes.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
    // A self-consistent carrier under a different task policy is still foreign to
    // this transaction's elected derivation and never joins it.
    const foreignPolicy = {
      schemaVersion: '1.2.0',
      tasks: [{ nodeId: 'build', taskKey: 'build@2' }],
    };
    const foreignDerivation = {
      ...derivation,
      task_policy_digest_sha256: canonicalSha256(foreignPolicy),
    };
    const foreign = createCertifiedEvidenceCarrier({
      release_unit: UNIT,
      derivation: foreignDerivation,
      candidate_receipt: {
        ...candidateReceipt,
        taskPolicyDigest: canonicalSha256(foreignPolicy),
      },
      task_policy: foreignPolicy,
      task_results: [taskResult],
      namespace_census: finalizeCertifiedEvidenceNamespaceCensus({
        release_unit: UNIT,
        derivation: foreignDerivation,
        entries: census.entries,
      }),
      maximum_bytes: MAX_BLOB,
    });
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: UNIT,
          bytes: foreign,
          sha256: sha256(foreign),
          size_bytes: foreign.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
  });

  it('refuses altered carrier bytes and bytes exceeding the protected bound', async () => {
    const fixture = storeFixture();
    const owner = fixture.store.authority_owner;
    const transaction = await invokeSink(owner, () =>
      fixture.store.begin([binding('@fixture/pkg')]),
    );
    const bytes = carrierBytes();
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: UNIT,
          bytes,
          sha256: 'a'.repeat(64),
          size_bytes: bytes.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
    const truncated = bytes.subarray(0, bytes.length - 2);
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: UNIT,
          bytes: truncated,
          sha256: sha256(truncated),
          size_bytes: truncated.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
    const oversized = Buffer.from(canonicalJson({ padded: 'x'.repeat(MAX_BLOB + 16) }), 'utf8');
    await expect(
      invokeSink(owner, () =>
        transaction.putCertifiedEvidenceCarrier?.({
          release_unit: UNIT,
          bytes: oversized,
          sha256: sha256(oversized),
          size_bytes: oversized.length,
        }),
      ),
    ).rejects.toThrow(REFUSAL);
  });

  it('retains nothing when the transaction aborts', async () => {
    const fixture = storeFixture();
    const bytes = carrierBytes();
    const { transaction, owner } = await retain(fixture, bytes);
    await invokeSink(owner, () => transaction.abort());
    expect(() =>
      fixture.store.readCertifiedEvidenceCarrier?.({ ...derivation, release_unit: UNIT }),
    ).toThrow(REFUSAL);
  });
});
