import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  createProtectedReleaseHostAdapter,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createReleaseCertificationEvidenceStore } from '../../src/services/release-evidence-store.js';
import type { CertificationOutputClosureBinding } from '../../src/services/release-prepare-kernel.js';

const roots: string[] = [];
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const TASK_POLICY = 'c'.repeat(64);
const REFUSAL = 'release-certification-generated-output-untrusted';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function root(prefix: string): string {
  // macOS tmpdir commonly begins at /var, a compatibility symlink. Evidence
  // roots must be canonical paths whose ancestors have no symlink traversal.
  const value = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}

function binding(packageId: string, commit = COMMIT): CertificationOutputClosureBinding {
  return {
    repository: { id: 'fixture/repository', commit, tree: TREE },
    candidate: { commit, tree: TREE },
    task_policy_digest_sha256: TASK_POLICY,
    package_id: packageId,
  };
}

function storeFixture() {
  const evidenceRoot = root('devai external evidence');
  const candidateRoot = root('devai candidate root');
  const input = {
    root: evidenceRoot,
    evidence_sink_id: 'fixture-evidence-sink',
    repository_roots: [candidateRoot],
    max_blob_bytes: 1024 * 1024,
  } as const;
  return {
    evidenceRoot,
    input,
    store: createReleaseCertificationEvidenceStore(input),
  };
}

async function invokeSink<T>(
  callback: () => T | Promise<T>,
  adapterAction: 'release certify' | 'release preflight' = 'release certify',
): Promise<Awaited<T>> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-evidence-store-test',
    issuer_version: '1.0.0',
    invocation_id: 'release-evidence-store-test',
    canonicalSha256,
    randomId: () => `release-evidence-store-${String(++ordinal)}`,
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: adapterAction,
    invocation_id: 'release-evidence-store-test',
    effect: 'harness-write',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const operation = protectedReleaseHostEffect(request);
      if (
        operation?.kind !== 'sink' ||
        operation.binding.action_id !== 'release certify' ||
        operation.binding.repository.id !== 'fixture/repository' ||
        operation.binding.repository.commit !== COMMIT ||
        operation.binding.repository.tree !== TREE ||
        operation.binding.task_policy_digest_sha256 !== TASK_POLICY
      ) {
        throw new Error('TEST_PROTECTED_SINK_OPERATION_REQUIRED');
      }
      return apply();
    },
  };
  const adapter = createProtectedReleaseHostAdapter({
    action_id: 'release certify',
    repository: { id: 'fixture/repository', commit: COMMIT, tree: TREE },
    task_policy_digest_sha256: TASK_POLICY,
    plan_receipt_digest_sha256: 'd'.repeat(64),
    helper_identity_sha256: 'e'.repeat(64),
  });
  try {
    return await runWithAuthorityHostEffects(scope, () => adapter.invokeSink(callback));
  } finally {
    issuer.dispose();
  }
}

async function refusal(callback: () => unknown | Promise<unknown>): Promise<void> {
  await expect(Promise.resolve().then(callback)).rejects.toThrow(REFUSAL);
}

function output(handle: {
  readonly evidence_sink_id: string;
  readonly opaque_handle: string;
  readonly sha256: string;
  readonly size_bytes: number;
}) {
  return { path: 'generated/report.json', mode: '100644' as const, output_blob_handle: handle };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('durable external certification evidence store', () => {
  it('requires protected sink authority before it can begin a transaction', async () => {
    const fixture = storeFixture();
    await refusal(() => fixture.store.begin([binding('@fixture/package')]));
    await expect(
      invokeSink(() => fixture.store.begin([binding('@fixture/package')]), 'release preflight'),
    ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
  });

  it('reopens committed closure, receipt and blob, including an explicit empty package', async () => {
    const fixture = storeFixture();
    const empty = binding('@fixture/empty');
    const generated = binding('@fixture/generated');
    const transaction = await invokeSink(() => fixture.store.begin([empty, generated]));
    const bytes = Buffer.from('{"generated":true}\n');
    const handle = await invokeSink(() =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closures = await invokeSink(() =>
      transaction.commit([
        { ...empty, outputs: [] },
        { ...generated, outputs: [output(handle)] },
      ]),
    );
    const generatedClosure = closures[1];
    const generatedOutput = generatedClosure?.outputs[0];
    if (generatedClosure === undefined || generatedOutput === undefined)
      throw new Error('fixture closure is incomplete');

    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    expect(await reopened.readCertificationOutputClosure(empty)).toEqual({ ...empty, outputs: [] });
    expect(await reopened.readCertificationOutputClosure(generated)).toEqual(generatedClosure);
    expect(
      await reopened.readCertificationEvidenceReceipt({
        evidence_sink_id: fixture.input.evidence_sink_id,
        receipt_digest_sha256: generatedOutput.certification_evidence_receipt.receipt_digest_sha256,
      }),
    ).toEqual(generatedOutput.certification_evidence_receipt);
    expect(
      await reopened.readGeneratedBlob({
        repository: generated.repository,
        candidate: { ...generated.candidate, release_units: [] },
        receipt: generatedOutput.certification_evidence_receipt,
        output_blob_sha256: handle.sha256,
        output_blob_handle: handle,
      }),
    ).toEqual(bytes);
  });

  it('keeps pre-commit and aborted evidence unreadable and makes commit terminal', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/package');
    const transaction = await invokeSink(() => fixture.store.begin([selected]));
    const bytes = Buffer.from('staged');
    const handle = await invokeSink(() =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() => fixture.store.readCertificationOutputClosure(selected));
    await invokeSink(() => transaction.abort());
    await refusal(() => fixture.store.readCertificationOutputClosure(selected));
    await refusal(() => invokeSink(() => transaction.abort()));
    await refusal(() =>
      invokeSink(() => transaction.commit([{ ...selected, outputs: [output(handle)] }])),
    );

    const committed = await invokeSink(() => fixture.store.begin([selected]));
    const committedHandle = await invokeSink(() =>
      committed.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await invokeSink(() => committed.commit([{ ...selected, outputs: [output(committedHandle)] }]));
    await refusal(() => invokeSink(() => committed.abort()));
    await refusal(() =>
      invokeSink(() => committed.commit([{ ...selected, outputs: [output(committedHandle)] }])),
    );
  });

  it('refuses corrupt bytes and foreign candidate or package closure references', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/package');
    const transaction = await invokeSink(() => fixture.store.begin([selected]));
    const bytes = Buffer.from('verified');
    const handle = await invokeSink(() =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closure = await invokeSink(() =>
      transaction.commit([{ ...selected, outputs: [output(handle)] }]),
    );
    const receipt = closure[0]?.outputs[0]?.certification_evidence_receipt;
    if (receipt === undefined) throw new Error('fixture receipt is missing');
    writeFileSync(join(fixture.evidenceRoot, 'objects', handle.sha256), 'corrupt');
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    await refusal(() =>
      reopened.readGeneratedBlob({
        repository: selected.repository,
        candidate: { ...selected.candidate, release_units: [] },
        receipt,
        output_blob_sha256: handle.sha256,
        output_blob_handle: handle,
      }),
    );
    await refusal(() =>
      reopened.readCertificationOutputClosure(binding('@fixture/package', 'd'.repeat(40))),
    );
    await refusal(() => reopened.readCertificationOutputClosure(binding('@fixture/other')));
  });

  it('refuses bad digest, size, roster, duplicate path, host path, and unissued handles', async () => {
    const fixture = storeFixture();
    const first = binding('@fixture/one');
    const second = binding('@fixture/two');
    const bytes = Buffer.from('body');
    const invalid = await invokeSink(() => fixture.store.begin([first]));
    await refusal(() =>
      invokeSink(() => invalid.put({ bytes, sha256: '0'.repeat(64), size_bytes: bytes.length })),
    );
    await refusal(() =>
      invokeSink(() => invalid.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length + 1 })),
    );

    const transaction = await invokeSink(() => fixture.store.begin([first, second]));
    await invokeSink(() =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() => invokeSink(() => transaction.commit([{ ...first, outputs: [] }])));

    const duplicate = await invokeSink(() => fixture.store.begin([first]));
    const duplicateHandle = await invokeSink(() =>
      duplicate.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(() =>
        duplicate.commit([
          { ...first, outputs: [output(duplicateHandle), output(duplicateHandle)] },
        ]),
      ),
    );

    const hostPath = await invokeSink(() => fixture.store.begin([first]));
    const hostHandle = await invokeSink(() =>
      hostPath.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(() =>
        hostPath.commit([
          { ...first, outputs: [{ ...output(hostHandle), path: '/host/controlled/output.json' }] },
        ]),
      ),
    );

    const foreignHandle = await invokeSink(() => fixture.store.begin([first]));
    await invokeSink(() =>
      foreignHandle.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(() =>
        foreignHandle.commit([
          {
            ...first,
            outputs: [
              output({
                evidence_sink_id: fixture.input.evidence_sink_id,
                opaque_handle: `sha256:${'0'.repeat(64)}`,
                sha256: sha256(bytes),
                size_bytes: bytes.length,
              }),
            ],
          },
        ]),
      ),
    );
  });

  it('never overwrites a conflicting object and preserves failed staging evidence', async () => {
    const fixture = storeFixture();
    const bytes = Buffer.from('expected');
    const conflicting = Buffer.from('conflicting');
    mkdirSync(join(fixture.evidenceRoot, 'objects'), { mode: 0o700 });
    mkdirSync(join(fixture.evidenceRoot, 'staging'), { mode: 0o700 });
    writeFileSync(join(fixture.evidenceRoot, 'objects', sha256(bytes)), conflicting, {
      mode: 0o600,
    });
    const transaction = await invokeSink(() => fixture.store.begin([binding('@fixture/package')]));
    await refusal(() =>
      invokeSink(() => transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length })),
    );
    expect(lstatSync(join(fixture.evidenceRoot, 'objects', sha256(bytes))).isFile()).toBe(true);
    expect(readdirSync(join(fixture.evidenceRoot, 'staging'))).not.toHaveLength(0);
  });

  it('refuses repository-contained roots and root or ancestor symlinks', async () => {
    const candidate = root('devai candidate');
    const contained = join(candidate, 'evidence');
    mkdirSync(contained, { mode: 0o700 });
    await refusal(() =>
      createReleaseCertificationEvidenceStore({
        root: contained,
        evidence_sink_id: 'fixture-evidence-sink',
        repository_roots: [candidate],
        max_blob_bytes: 1024,
      }),
    );

    const external = root('devai external');
    const linkedRoot = join(root('devai links'), 'sink');
    symlinkSync(external, linkedRoot);
    await refusal(() =>
      createReleaseCertificationEvidenceStore({
        root: linkedRoot,
        evidence_sink_id: 'fixture-evidence-sink',
        repository_roots: [candidate],
        max_blob_bytes: 1024,
      }),
    );

    const ancestorTarget = root('devai ancestor target');
    const ancestorLink = join(root('devai ancestor link'), 'linked');
    symlinkSync(ancestorTarget, ancestorLink);
    const descendant = join(ancestorLink, 'sink');
    mkdirSync(join(ancestorTarget, 'sink'), { mode: 0o700 });
    await refusal(() =>
      createReleaseCertificationEvidenceStore({
        root: descendant,
        evidence_sink_id: 'fixture-evidence-sink',
        repository_roots: [candidate],
        max_blob_bytes: 1024,
      }),
    );
  });
});
