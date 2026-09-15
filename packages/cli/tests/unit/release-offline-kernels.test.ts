import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import {
  verifyPinnedCandidateReceiptEvidence,
  verifyPinnedDetachedSignature,
  verifyPinnedArtifactContent,
  type OfflineCandidateEvidenceInput,
} from '../../src/services/mutation-evidence-v21.js';

function evidence() {
  const result = (nodeId: string, dependencyResultDigests: Record<string, string>) => ({
    schemaVersion: '1.0.0',
    nodeId,
    taskKey: canonicalSha256(nodeId),
    status: 'PASS',
    inputDigest: canonicalSha256({ nodeId }),
    dependencyResultDigests,
    outputDigests: {},
    startedAt: '2026-09-06T00:00:00.000Z',
    finishedAt: '2026-09-06T00:00:00.000Z',
  });
  const first = result('first', {});
  const second = result('second', { first: canonicalSha256(first) });
  const results = [first, second];
  const taskPolicy = {
    schemaVersion: '1.0.0',
    repositoryId: 'fixture/repository',
    requiredNodes: [
      { nodeId: 'first', taskKey: first.taskKey, dependencies: [] },
      { nodeId: 'second', taskKey: second.taskKey, dependencies: ['first'] },
    ],
  };
  const repository = { id: 'fixture/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const receipt = {
    schemaVersion: '1.0.0',
    repository,
    profile: 'affected',
    taskPolicyDigest: canonicalSha256(taskPolicy),
    createdAt: '2026-09-06T00:00:00.000Z',
    tasks: results.map((r) => ({
      nodeId: r.nodeId,
      taskKey: r.taskKey,
      resultDigest: canonicalSha256(r),
    })),
  };
  const files = new Map(results.map((r) => [canonicalSha256(r), Buffer.from(canonicalJson(r))]));
  const input: OfflineCandidateEvidenceInput = {
    receipt,
    taskPolicy,
    expectedRepository: repository.id,
    expectedCommit: repository.commit,
    expectedTree: repository.tree,
    expectedPolicyDigest: receipt.taskPolicyDigest,
    readEvidenceFile: (kind, identity) => {
      if (kind !== 'result') throw new Error('unexpected artifact read');
      const bytes = files.get(identity);
      if (bytes === undefined) throw new Error('missing result');
      return bytes;
    },
  };
  return { input, receipt, files, second };
}

describe('activated offline kernels', () => {
  it('checks retained text for credential-shaped material, host paths and invalid encoding', async () => {
    await expect(
      verifyPinnedArtifactContent({ path: 'report.json', bytes: Buffer.from('{}') }),
    ).resolves.toBeUndefined();
    await expect(
      verifyPinnedArtifactContent({
        path: 'report.json',
        bytes: Buffer.from('-----BEGIN PRIVATE KEY-----'),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CREDENTIAL_MATERIAL' });
    await expect(
      verifyPinnedArtifactContent({
        path: 'report.json',
        bytes: Buffer.from('/Users/fixture/private.txt'),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_HOST_PATH' });
    await expect(
      verifyPinnedArtifactContent({ path: 'report.json', bytes: Buffer.from([0xff]) }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('checks the real result DAG entirely through supplied bytes', async () => {
    await expect(verifyPinnedCandidateReceiptEvidence(evidence().input)).resolves.toMatchObject({
      ok: true,
      verifiedNodes: ['first', 'second'],
    });
  });
  it('refuses a freshly rehashed result pointing at the wrong dependency', async () => {
    const f = evidence();
    const changed = { ...f.second, dependencyResultDigests: { first: 'c'.repeat(64) } };
    const digest = canonicalSha256(changed);
    const second = f.receipt.tasks.find((r) => r.nodeId === 'second');
    if (!second) throw new Error('fixture missing');
    second.resultDigest = digest;
    f.files.set(digest, Buffer.from(canonicalJson(changed)));
    await expect(verifyPinnedCandidateReceiptEvidence(f.input)).rejects.toMatchObject({
      code: 'DEPENDENCY_MISMATCH',
    });
  });
  it('refuses absent result bytes and filesystem fallback', async () => {
    const f = evidence();
    f.files.clear();
    await expect(verifyPinnedCandidateReceiptEvidence(f.input)).rejects.toMatchObject({
      code: 'INPUT_MISSING',
    });
    await expect(
      verifyPinnedCandidateReceiptEvidence({
        ...f.input,
        readEvidenceFile: undefined,
      } as unknown as OfflineCandidateEvidenceInput),
    ).rejects.toThrow('release-offline-reader-required');
  });
  it('verifies detached export bytes and rejects forged and revoked signatures', async () => {
    const pair = generateKeyPairSync('ed25519');
    const trustStore = {
      schemaVersion: '1.1.0',
      trustRootId: 'fixture-root',
      trustedSigners: [
        {
          signerId: 'owner',
          keyId: 'key-1',
          publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      ],
      revokedSignerIds: [] as string[],
      revokedKeyIds: [] as string[],
    };
    const payloadBytes = Buffer.from('exact reconstructed transcript');
    const input = {
      trustStore,
      algorithm: 'ed25519' as const,
      expectedSignerId: 'owner',
      expectedTrustRootId: 'fixture-root',
      expectedTrustStoreDigest: canonicalSha256(trustStore),
      expectedKeyId: 'key-1',
      payloadBytes,
      signatureBytes: sign(null, payloadBytes, pair.privateKey),
    };
    await expect(verifyPinnedDetachedSignature(input)).resolves.toMatchObject({
      signerId: 'owner',
    });
    await expect(
      verifyPinnedDetachedSignature({ ...input, payloadBytes: Buffer.from('changed') }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    trustStore.revokedKeyIds.push('key-1');
    await expect(
      verifyPinnedDetachedSignature({
        ...input,
        expectedTrustStoreDigest: canonicalSha256(trustStore),
      }),
    ).rejects.toMatchObject({ code: 'SIGNER_REVOKED' });
  });
});
