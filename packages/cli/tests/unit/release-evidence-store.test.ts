import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
  finalizeCertificationReceipt,
  type CertificationOutputClosureBinding,
} from '../../src/services/release-prepare-kernel.js';
import {
  verifyUnitMutationEvidenceDocuments,
  type UnitMutationEvidenceObject,
  type UnitMutationEvidenceTransaction,
} from '../../src/services/release-unit-mutation-evidence.js';
import {
  bytes as canonicalBytes,
  fixture as unitFixture,
} from '../helpers/release-unit-mutation-evidence-fixture.js';

const roots: string[] = [];
const REPOSITORY_FIXTURE = createReleaseRepositoryTestFixture();
const COMMIT = REPOSITORY_FIXTURE.repository.commit;
const TREE = REPOSITORY_FIXTURE.repository.tree;
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
    repository: { id: REPOSITORY_FIXTURE.repository.id, commit, tree: TREE },
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
  owner: object,
  callback: () => T | Promise<T>,
  adapterAction: 'release certify' | 'release preflight' = 'release certify',
  observeOperation?: () => void,
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
        operation.binding.repository.id !== REPOSITORY_FIXTURE.repository.id ||
        operation.binding.repository.commit !== COMMIT ||
        operation.binding.repository.tree !== TREE ||
        operation.binding.task_policy_digest_sha256 !== TASK_POLICY
      ) {
        throw new Error('TEST_PROTECTED_SINK_OPERATION_REQUIRED');
      }
      observeOperation?.();
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

interface StoredCertificationOutput {
  path: unknown;
  mode: unknown;
  output_blob_handle: Record<string, unknown>;
  certification_evidence_receipt: unknown;
}

interface StoredCertificationClosure {
  outputs: StoredCertificationOutput[];
}

function rewriteCommittedClosure(
  fixture: ReturnType<typeof storeFixture>,
  change: (closure: StoredCertificationClosure) => void,
): void {
  const certificationRoot = join(fixture.evidenceRoot, 'certification');
  const transactions = readdirSync(certificationRoot);
  if (transactions.length !== 1) throw new Error('fixture certification transaction missing');
  const commitPath = join(certificationRoot, transactions[0] ?? '', 'commit.json');
  const document = JSON.parse(readFileSync(commitPath, 'utf8')) as {
    closures: StoredCertificationClosure[];
  };
  const closure = document.closures[0];
  if (closure === undefined) throw new Error('fixture committed closure missing');
  change(closure);
  writeFileSync(commitPath, canonicalJson(document), 'utf8');
}

function rewriteCommittedOutput(
  fixture: ReturnType<typeof storeFixture>,
  change: (output: StoredCertificationOutput) => void,
): void {
  rewriteCommittedClosure(fixture, (closure) => {
    const committedOutput = closure.outputs[0];
    if (committedOutput === undefined) throw new Error('fixture committed output missing');
    change(committedOutput);
  });
}

function rebindStoredOutputReceipt(value: StoredCertificationOutput): void {
  const handle = value.output_blob_handle as Parameters<
    typeof finalizeCertificationReceipt
  >[0]['output_blob_handle'];
  value.certification_evidence_receipt = finalizeCertificationReceipt({
    candidate_commit: COMMIT,
    candidate_tree: TREE,
    task_policy_digest_sha256: TASK_POLICY,
    package_id: '@fixture/generated',
    output_blob_sha256: handle.sha256,
    output_blob_handle: handle,
  });
}

function onlyTransactionDirectory(
  fixture: ReturnType<typeof storeFixture>,
  namespace: 'certification' | 'unit-mutation',
): string {
  const directory = join(fixture.evidenceRoot, namespace);
  const transactions = readdirSync(directory);
  if (transactions.length !== 1) throw new Error(`fixture ${namespace} transaction missing`);
  return join(directory, transactions[0] ?? '');
}

function makeStoredJsonNoncanonical(path: string): void {
  writeFileSync(path, Buffer.concat([Buffer.from(' '), readFileSync(path)]));
}

function addUnexpectedStoredMember(path: string): void {
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  document['unexpected'] = true;
  writeFileSync(path, canonicalJson(document), 'utf8');
}

async function unitEvidence(
  fixture: ReturnType<typeof storeFixture>,
  options: {
    reused?: boolean;
    notRequired?: boolean;
    releaseUnit?: string;
    planDigest?: string;
  } = {},
) {
  return await unitFixture({
    ...options,
    sinkId: fixture.input.evidence_sink_id,
    binding: {
      repository_id: REPOSITORY_FIXTURE.repository.id,
      candidate_commit: COMMIT,
      candidate_tree: TREE,
      release_plan_receipt_digest_sha256: options.planDigest ?? 'd'.repeat(64),
      task_policy_digests_sha256: [TASK_POLICY],
      ...(options.releaseUnit === undefined ? {} : { release_unit: options.releaseUnit }),
    },
  });
}

function unitObjectIdentity({
  path,
  sha256,
  size_bytes,
  evidence_sink_id,
  opaque_handle,
}: UnitMutationEvidenceObject) {
  return { path, sha256, size_bytes, evidence_sink_id, opaque_handle };
}

async function putUnitDocuments(
  fixture: ReturnType<typeof storeFixture>,
  evidence: Awaited<ReturnType<typeof unitEvidence>>,
  transaction: UnitMutationEvidenceTransaction,
) {
  await invokeSink(fixture.store.authority_owner, () => {
    for (const identity of [evidence.projection.output_contract, ...evidence.projection.members]) {
      const bytes = evidence.objects.get(identity.sha256);
      if (bytes === undefined) throw new Error('fixture unit document missing');
      const handle = transaction.put({
        bytes,
        sha256: identity.sha256,
        size_bytes: identity.size_bytes,
      });
      expect({ path: identity.path, ...handle }).toEqual(unitObjectIdentity(identity));
    }
  });
}

async function commitUnitEvidence(fixture: ReturnType<typeof storeFixture>) {
  const evidence = await unitEvidence(fixture);
  const transaction = await invokeSink(fixture.store.authority_owner, () =>
    fixture.store.beginUnitMutationEvidence(evidence.binding),
  );
  await putUnitDocuments(fixture, evidence, transaction);
  await transaction.verify(evidence.projection);
  const closure = await invokeSink(fixture.store.authority_owner, () =>
    transaction.commit(evidence.projection),
  );
  return { closure, evidence, transaction };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

afterAll(() => REPOSITORY_FIXTURE.dispose());

describe('durable external certification evidence store', () => {
  it('requires protected sink authority before it can begin a transaction', async () => {
    const fixture = storeFixture();
    await refusal(() => fixture.store.begin([binding('@fixture/package')]));
    await expect(
      invokeSink(
        fixture.store.authority_owner,
        () => fixture.store.begin([binding('@fixture/package')]),
        'release preflight',
      ),
    ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
  });

  it('binds one sink owner to one live certify call and rejects scope escape', async () => {
    const first = storeFixture();
    const second = storeFixture();
    const selected = binding('@fixture/package');
    let operations = 0;
    const transaction = await invokeSink(
      first.store.authority_owner,
      () => first.store.begin([selected]),
      'release certify',
      () => {
        operations += 1;
      },
    );
    expect(operations).toBe(1);
    const bytes = Buffer.from('one logical put');
    await invokeSink(
      first.store.authority_owner,
      () => transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
      'release certify',
      () => {
        operations += 1;
      },
    );
    expect(operations).toBe(2);

    await refusal(() =>
      invokeSink(first.store.authority_owner, () => second.store.begin([selected])),
    );
    await refusal(() =>
      invokeSink(first.store.authority_owner, async () => {
        await Promise.resolve();
        return first.store.begin([binding('@fixture/later')]);
      }),
    );
  });

  it.each(['terminal transaction', 'non-Buffer bytes'] as const)(
    'refuses a certification object write with %s',
    async (fault) => {
      const fixture = storeFixture();
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([binding('@fixture/package')]),
      );
      const bytes = Buffer.from('certification object');
      if (fault === 'terminal transaction') {
        await invokeSink(fixture.store.authority_owner, () => transaction.abort());
      }
      const supplied = fault === 'non-Buffer bytes' ? new Uint8Array(bytes) : bytes;

      await refusal(() =>
        invokeSink(fixture.store.authority_owner, () =>
          transaction.put({
            bytes: supplied as never,
            sha256: sha256(bytes),
            size_bytes: bytes.length,
          }),
        ),
      );
    },
  );

  it('refuses empty, duplicate-package, and mixed-repository transaction selections', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/package');
    const duplicatePackage = {
      ...selected,
      task_policy_digest_sha256: 'd'.repeat(64),
    };
    const mixedRepository = {
      ...binding('@fixture/other'),
      repository: { ...selected.repository, id: 'fixture/other-repository' },
    };

    for (const bindings of [[], [selected, duplicatePackage], [selected, mixedRepository]]) {
      await refusal(() =>
        invokeSink(fixture.store.authority_owner, () => fixture.store.begin(bindings)),
      );
    }
    expect(readdirSync(fixture.evidenceRoot)).not.toContain('certification');
  });

  it('refuses unknown protected host binding keys before the callback can run', () => {
    const binding = {
      action_id: 'release certify' as const,
      repository: { id: 'fixture/repository', commit: COMMIT, tree: TREE },
      task_policy_digest_sha256: TASK_POLICY,
      plan_receipt_digest_sha256: 'd'.repeat(64),
      helper_identity_sha256: 'e'.repeat(64),
      unrecognized: true,
    };
    expect(() => createProtectedReleaseHostAdapter(binding as never)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it.each([
    ['non-NFC Unicode', 'generated/re\u0301port.json'],
    ['backslash', 'generated\\report.json'],
    ['colon', 'generated/report:alternate.json'],
    ['NUL control', 'generated/report\u0000.json'],
    ['unit-separator control', 'generated/report\u001f.json'],
    ['DEL control', 'generated/report\u007f.json'],
    ['absolute path', '/generated/report.json'],
    ['trailing slash', 'generated/report.json/'],
    ['empty segment', 'generated//report.json'],
    ['dot segment', 'generated/./report.json'],
    ['parent segment', 'generated/../report.json'],
  ] as const)('refuses a generated output path containing %s', async (_case, path) => {
    const fixture = storeFixture();
    const selected = binding('@fixture/path');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const value = Buffer.from('path-bound output');
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes: value, sha256: sha256(value), size_bytes: value.length }),
    );

    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [{ ...output(handle), path }] }]),
      ),
    );
    expect(
      readdirSync(join(fixture.evidenceRoot, 'certification', transaction.transaction_handle)),
    ).not.toContain('commit.json');
  });

  it.each([
    ['100644', 'generated/résumé report.json'],
    ['100755', 'generated/executable report.json'],
  ] as const)('accepts bound %s output at normalized path %s', async (mode, path) => {
    const fixture = storeFixture();
    const selected = binding('unscoped-package');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const value = Buffer.from(`${mode}:${path}`);
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes: value, sha256: sha256(value), size_bytes: value.length }),
    );
    const closures = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit([{ ...selected, outputs: [{ ...output(handle), path, mode }] }]),
    );

    expect(closures[0]).toMatchObject({
      ...selected,
      outputs: [{ path, mode, output_blob_handle: handle }],
    });
    const committedOutput = closures[0]?.outputs[0];
    if (committedOutput === undefined) throw new Error('missing accepted output');
    expect(
      createReleaseCertificationEvidenceStore(fixture.input).readGeneratedBlob({
        repository: selected.repository,
        candidate: { ...selected.candidate, release_units: [] },
        receipt: committedOutput.certification_evidence_receipt,
        output_blob_sha256: handle.sha256,
        output_blob_handle: handle,
      }),
    ).toEqual(value);
  });

  it.each([
    [
      'toolchain injection',
      (value: Record<string, unknown>) => Object.assign(value, { toolchain: { id: 'unbound' } }),
    ],
    [
      'environment injection',
      (value: Record<string, unknown>) => Object.assign(value, { environment: { id: 'unbound' } }),
    ],
    [
      'provider injection',
      (value: Record<string, unknown>) => Object.assign(value, { provider: { id: 'unbound' } }),
    ],
    [
      'repository projection injection',
      (value: Record<string, unknown>) =>
        Object.assign(value.repository as Record<string, unknown>, { provider: 'unbound' }),
    ],
    [
      'candidate projection injection',
      (value: Record<string, unknown>) =>
        Object.assign(value.candidate as Record<string, unknown>, { environment: 'unbound' }),
    ],
    [
      'non-string repository id',
      (value: Record<string, unknown>) =>
        Object.assign(value.repository as Record<string, unknown>, { id: 1 }),
    ],
    [
      'empty repository id',
      (value: Record<string, unknown>) =>
        Object.assign(value.repository as Record<string, unknown>, { id: '' }),
    ],
    [
      'mixed candidate object formats',
      (value: Record<string, unknown>) => {
        const candidate = value.candidate as Record<string, unknown>;
        Object.assign(candidate, { tree: 'a'.repeat(64) });
        Object.assign(value.repository as Record<string, unknown>, { tree: candidate.tree });
      },
    ],
    [
      'repository commit drift',
      (value: Record<string, unknown>) =>
        Object.assign(value.repository as Record<string, unknown>, { commit: 'a'.repeat(40) }),
    ],
    [
      'repository tree drift',
      (value: Record<string, unknown>) =>
        Object.assign(value.repository as Record<string, unknown>, { tree: 'a'.repeat(40) }),
    ],
    [
      'invalid task-policy digest',
      (value: Record<string, unknown>) =>
        Object.assign(value, { task_policy_digest_sha256: 'A'.repeat(64) }),
    ],
    [
      'task-policy digest with leading data',
      (value: Record<string, unknown>) =>
        Object.assign(value, { task_policy_digest_sha256: `g${TASK_POLICY}` }),
    ],
    [
      'task-policy digest with trailing data',
      (value: Record<string, unknown>) =>
        Object.assign(value, { task_policy_digest_sha256: `${TASK_POLICY}g` }),
    ],
    [
      'candidate identities with leading data',
      (value: Record<string, unknown>) => {
        const identity = `g${COMMIT}`;
        Object.assign(value.repository as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
        Object.assign(value.candidate as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
      },
    ],
    [
      'candidate identities with trailing data',
      (value: Record<string, unknown>) => {
        const identity = `${COMMIT}g`;
        Object.assign(value.repository as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
        Object.assign(value.candidate as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
      },
    ],
    [
      'non-hexadecimal 64-character candidate identities',
      (value: Record<string, unknown>) => {
        const identity = 'g'.repeat(64);
        Object.assign(value.repository as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
        Object.assign(value.candidate as Record<string, unknown>, {
          commit: identity,
          tree: identity,
        });
      },
    ],
    [
      'package prefix outside grammar',
      (value: Record<string, unknown>) => Object.assign(value, { package_id: '!fixture/package' }),
    ],
    [
      'package suffix outside grammar',
      (value: Record<string, unknown>) =>
        Object.assign(value, { package_id: '@fixture/package/extra' }),
    ],
  ] as const)('refuses %s before creating a certification transaction', async (_case, change) => {
    const fixture = storeFixture();
    const changed = structuredClone(binding('@fixture/package')) as unknown as Record<
      string,
      unknown
    >;
    change(changed);

    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([changed as unknown as CertificationOutputClosureBinding]),
      ),
    );
    expect(readdirSync(fixture.evidenceRoot)).not.toContain('certification');
  });

  it('accepts full 64-character Git object identities for a certification transaction', async () => {
    const fixture = storeFixture();
    const selected = structuredClone(binding('@fixture/package'));
    const identity = 'a'.repeat(64);
    Object.assign(selected.repository, { commit: identity, tree: identity });
    Object.assign(selected.candidate, { commit: identity, tree: identity });

    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    await invokeSink(fixture.store.authority_owner, () => transaction.abort());
  });

  it('reopens committed closure, receipt and blob, including an explicit empty package', async () => {
    const fixture = storeFixture();
    const empty = binding('@fixture/empty');
    const generated = binding('@fixture/generated');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([empty, generated]),
    );
    const bytes = Buffer.from('{"generated":true}\n');
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closures = await invokeSink(fixture.store.authority_owner, () =>
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

  it.each(['unexpected-name', 'regular-file', 'symbolic-link'] as const)(
    'refuses a %s in the durable certification transaction namespace',
    async (fault) => {
      const fixture = storeFixture();
      const selected = binding('@fixture/generated');
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([selected]),
      );
      await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [] }]),
      );
      const namespace = join(fixture.evidenceRoot, 'certification');
      const transactionDirectory = onlyTransactionDirectory(fixture, 'certification');
      const injected = join(
        namespace,
        fault === 'unexpected-name' ? 'not-a-transaction' : randomUUID(),
      );
      if (fault === 'unexpected-name') mkdirSync(injected);
      else if (fault === 'regular-file') writeFileSync(injected, 'not a transaction');
      else symlinkSync(transactionDirectory, injected, 'dir');

      await refusal(() =>
        createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
          selected,
        ),
      );
    },
  );

  it('ignores an incomplete certification transaction but refuses an unreadable commit', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/generated');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const closure = (
      await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [] }]),
      )
    )[0];
    const namespace = join(fixture.evidenceRoot, 'certification');
    const incomplete = join(namespace, randomUUID());
    mkdirSync(incomplete);
    expect(
      createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
        selected,
      ),
    ).toEqual(closure);

    rmSync(incomplete, { recursive: true });
    const unreadable = join(namespace, randomUUID());
    mkdirSync(join(unreadable, 'commit.json'), { recursive: true });
    await refusal(() =>
      createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
        selected,
      ),
    );
  });

  it.each(['noncanonical-commit', 'extra-commit-member', 'noncanonical-begin', 'abort'] as const)(
    'refuses certification transaction metadata with %s after restart',
    async (fault) => {
      const fixture = storeFixture();
      const selected = binding('@fixture/generated');
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([selected]),
      );
      await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [] }]),
      );
      const directory = onlyTransactionDirectory(fixture, 'certification');
      if (fault === 'noncanonical-commit')
        makeStoredJsonNoncanonical(join(directory, 'commit.json'));
      else if (fault === 'extra-commit-member')
        addUnexpectedStoredMember(join(directory, 'commit.json'));
      else if (fault === 'noncanonical-begin')
        makeStoredJsonNoncanonical(join(directory, 'begin.json'));
      else writeFileSync(join(directory, 'abort.json'), canonicalJson({ aborted: true }), 'utf8');

      await refusal(() =>
        createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
          selected,
        ),
      );
    },
  );

  it('serves two committed certification receipts and blobs only by their own identities', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/generated');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const values = [Buffer.from('first generated blob'), Buffer.from('second generated blob')];
    const handles = await Promise.all(
      values.map((bytes) =>
        invokeSink(fixture.store.authority_owner, () =>
          transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
        ),
      ),
    );
    const closures = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit([
        {
          ...selected,
          outputs: handles.map((handle, index) => ({
            ...output(handle),
            path: `generated/${String(index)}.json`,
          })),
        },
      ]),
    );
    const outputs = closures[0]?.outputs;
    if (outputs?.length !== 2) throw new Error('fixture outputs missing');
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);

    expect(outputs[0]?.certification_evidence_receipt).not.toEqual(
      outputs[1]?.certification_evidence_receipt,
    );
    for (const [index, committed] of outputs.entries()) {
      const receipt = committed.certification_evidence_receipt;
      expect(
        reopened.readCertificationEvidenceReceipt({
          evidence_sink_id: fixture.input.evidence_sink_id,
          receipt_digest_sha256: receipt.receipt_digest_sha256,
        }),
      ).toEqual(receipt);
      expect(
        reopened.readGeneratedBlob({
          repository: selected.repository,
          candidate: { ...selected.candidate, release_units: [] },
          receipt,
          output_blob_sha256: committed.output_blob_handle.sha256,
          output_blob_handle: committed.output_blob_handle,
        }),
      ).toEqual(values[index]);
    }
  });

  it.each([
    ['an unsafe path', (value: StoredCertificationOutput) => (value.path = '../report.json')],
    ['an unsupported mode', (value: StoredCertificationOutput) => (value.mode = '100600')],
    [
      'a malformed digest',
      (value: StoredCertificationOutput) => {
        const malformed = 'g'.repeat(64);
        value.output_blob_handle['sha256'] = malformed;
        value.output_blob_handle['opaque_handle'] = `sha256:${malformed}`;
        rebindStoredOutputReceipt(value);
      },
    ],
    [
      'a fractional size',
      (value: StoredCertificationOutput) => {
        value.output_blob_handle['size_bytes'] = 0.5;
        rebindStoredOutputReceipt(value);
      },
    ],
    [
      'a negative size',
      (value: StoredCertificationOutput) => {
        value.output_blob_handle['size_bytes'] = -1;
        rebindStoredOutputReceipt(value);
      },
    ],
    [
      'an extra handle member',
      (value: StoredCertificationOutput) => {
        value.output_blob_handle['extra'] = true;
        rebindStoredOutputReceipt(value);
      },
    ],
  ] as const)(
    'refuses committed output metadata with %s after store recreation',
    async (_case, change) => {
      const fixture = storeFixture();
      const selected = binding('@fixture/generated');
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([selected]),
      );
      const bytes = Buffer.from('persisted generated output');
      const handle = await invokeSink(fixture.store.authority_owner, () =>
        transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
      );
      await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [output(handle)] }]),
      );
      rewriteCommittedOutput(fixture, change);

      await refusal(() =>
        createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
          selected,
        ),
      );
    },
  );

  it.each(['duplicate', 'out-of-order'] as const)(
    'refuses a %s persisted output population after store recreation',
    async (fault) => {
      const fixture = storeFixture();
      const selected = binding('@fixture/generated');
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.begin([selected]),
      );
      const values = [
        Buffer.from('first persisted output'),
        Buffer.from('second persisted output'),
      ];
      const handles = await Promise.all(
        values.map((bytes) =>
          invokeSink(fixture.store.authority_owner, () =>
            transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
          ),
        ),
      );
      await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([
          {
            ...selected,
            outputs: handles.map((handle, index) => ({
              ...output(handle),
              path: `generated/${String(index)}.json`,
            })),
          },
        ]),
      );
      rewriteCommittedClosure(fixture, (closure) => {
        if (fault === 'duplicate') {
          const first = closure.outputs[0];
          if (first === undefined) throw new Error('fixture committed output missing');
          closure.outputs.push(structuredClone(first));
        } else {
          closure.outputs.reverse();
        }
      });

      await refusal(() =>
        createReleaseCertificationEvidenceStore(fixture.input).readCertificationOutputClosure(
          selected,
        ),
      );
    },
  );

  it('retains and reopens a zero-byte generated output', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/empty-output');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const bytes = Buffer.alloc(0);
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closures = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit([{ ...selected, outputs: [output(handle)] }]),
    );

    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    expect(reopened.readCertificationOutputClosure(selected)).toEqual(closures[0]);
    expect(
      reopened.readGeneratedBlob({
        repository: selected.repository,
        candidate: { ...selected.candidate, release_units: [] },
        receipt: closures[0]?.outputs[0]?.certification_evidence_receipt,
        output_blob_sha256: handle.sha256,
        output_blob_handle: handle,
      }),
    ).toEqual(bytes);
  });

  it('refuses a generated blob whose declared digest differs from its receipt', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/generated');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const bytes = Buffer.from('digest-bound blob');
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closures = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit([{ ...selected, outputs: [output(handle)] }]),
    );
    const receipt = closures[0]?.outputs[0]?.certification_evidence_receipt;
    if (receipt === undefined) throw new Error('fixture receipt missing');

    await refusal(() =>
      createReleaseCertificationEvidenceStore(fixture.input).readGeneratedBlob({
        repository: selected.repository,
        candidate: { ...selected.candidate, release_units: [] },
        receipt,
        output_blob_sha256: 'f'.repeat(64),
        output_blob_handle: handle,
      }),
    );
  });

  it('refuses a generated blob receipt outside the committed closure population', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/generated');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const retained = Buffer.from('retained blob');
    const unreferenced = Buffer.from('unreferenced blob');
    const retainedHandle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({
        bytes: retained,
        sha256: sha256(retained),
        size_bytes: retained.length,
      }),
    );
    const unreferencedHandle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({
        bytes: unreferenced,
        sha256: sha256(unreferenced),
        size_bytes: unreferenced.length,
      }),
    );
    await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit([{ ...selected, outputs: [output(retainedHandle)] }]),
    );
    const receipt = finalizeCertificationReceipt({
      candidate_commit: selected.candidate.commit,
      candidate_tree: selected.candidate.tree,
      task_policy_digest_sha256: selected.task_policy_digest_sha256,
      package_id: selected.package_id,
      output_blob_sha256: unreferencedHandle.sha256,
      output_blob_handle: unreferencedHandle,
    });

    await refusal(() =>
      createReleaseCertificationEvidenceStore(fixture.input).readGeneratedBlob({
        repository: selected.repository,
        candidate: { ...selected.candidate, release_units: [] },
        receipt,
        output_blob_sha256: unreferencedHandle.sha256,
        output_blob_handle: unreferencedHandle,
      }),
    );
  });

  it('keeps pre-commit and aborted evidence unreadable and makes commit terminal', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/package');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const bytes = Buffer.from('staged');
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() => fixture.store.readCertificationOutputClosure(selected));
    await invokeSink(fixture.store.authority_owner, () => transaction.abort());
    await refusal(() => fixture.store.readCertificationOutputClosure(selected));
    await refusal(() => invokeSink(fixture.store.authority_owner, () => transaction.abort()));
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...selected, outputs: [output(handle)] }]),
      ),
    );

    const committed = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const committedHandle = await invokeSink(fixture.store.authority_owner, () =>
      committed.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await invokeSink(fixture.store.authority_owner, () =>
      committed.commit([{ ...selected, outputs: [output(committedHandle)] }]),
    );
    await refusal(() => invokeSink(fixture.store.authority_owner, () => committed.abort()));
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        committed.commit([{ ...selected, outputs: [output(committedHandle)] }]),
      ),
    );
  });

  it('refuses corrupt bytes and foreign candidate or package closure references', async () => {
    const fixture = storeFixture();
    const selected = binding('@fixture/package');
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([selected]),
    );
    const bytes = Buffer.from('verified');
    const handle = await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    const closure = await invokeSink(fixture.store.authority_owner, () =>
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
    const invalid = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([first]),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        invalid.put({ bytes, sha256: '0'.repeat(64), size_bytes: bytes.length }),
      ),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        invalid.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length + 1 }),
      ),
    );

    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([first, second]),
    );
    await invokeSink(fixture.store.authority_owner, () =>
      transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        transaction.commit([{ ...first, outputs: [] }]),
      ),
    );

    const duplicate = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([first]),
    );
    const duplicateHandle = await invokeSink(fixture.store.authority_owner, () =>
      duplicate.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        duplicate.commit([
          { ...first, outputs: [output(duplicateHandle), output(duplicateHandle)] },
        ]),
      ),
    );

    const hostPath = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([first]),
    );
    const hostHandle = await invokeSink(fixture.store.authority_owner, () =>
      hostPath.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        hostPath.commit([
          { ...first, outputs: [{ ...output(hostHandle), path: '/host/controlled/output.json' }] },
        ]),
      ),
    );

    const foreignHandle = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([first]),
    );
    await invokeSink(fixture.store.authority_owner, () =>
      foreignHandle.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
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
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.begin([binding('@fixture/package')]),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        transaction.put({ bytes, sha256: sha256(bytes), size_bytes: bytes.length }),
      ),
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

describe('durable unit mutation evidence (ADR-MUT-0008 IA-002 through IA-004)', () => {
  it('propagates an unreadable durable binding index without creating a transaction', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const bindingIndex = join(
      fixture.evidenceRoot,
      'unit-mutation-index',
      `${canonicalSha256(evidence.binding)}.json`,
    );
    mkdirSync(bindingIndex, { recursive: true });

    await expect(
      invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(evidence.binding),
      ),
    ).rejects.toThrow();
    expect(() => lstatSync(join(fixture.evidenceRoot, 'unit-mutation'))).toThrow();
  });

  it('requires every projected unit document to have been admitted by the transaction', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    for (const [digest, content] of evidence.objects) {
      writeFileSync(join(fixture.evidenceRoot, 'objects', digest), content);
    }

    await refusal(() => transaction.verify(evidence.projection));
  });

  it.each(['terminal', 'non-buffer', 'size-mismatch', 'digest-mismatch'] as const)(
    'refuses a unit object write with %s input',
    async (fault) => {
      const fixture = storeFixture();
      const evidence = await unitEvidence(fixture);
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(evidence.binding),
      );
      const original = evidence.objects.get(evidence.projection.output_contract.sha256);
      if (original === undefined) throw new Error('fixture unit object missing');
      if (fault === 'terminal') {
        await invokeSink(fixture.store.authority_owner, () => transaction.abort());
      }
      const supplied = fault === 'non-buffer' ? new Uint8Array(original) : original;

      await refusal(() =>
        invokeSink(fixture.store.authority_owner, () =>
          transaction.put({
            bytes: supplied as never,
            sha256:
              fault === 'digest-mismatch'
                ? '0'.repeat(64)
                : evidence.projection.output_contract.sha256,
            size_bytes: original.length + (fault === 'size-mismatch' ? 1 : 0),
          }),
        ),
      );
    },
  );

  it('commits one ten-package closure and rereads exact contract, receipt and members after store recreation', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture, { reused: true, notRequired: true });
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    await transaction.verify(evidence.projection);
    const closure = await invokeSink(fixture.store.authority_owner, () => {
      const result = transaction.commit(evidence.projection);
      expect(result).not.toBeInstanceOf(Promise);
      return result;
    });
    expect(closure).toEqual(evidence.closure);
    expect(closure.members).toHaveLength(22);
    expect(closure).not.toHaveProperty('packages');
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    expect(reopened.readUnitMutationEvidenceClosure(evidence.binding)).toEqual(closure);
    expect(
      reopened.readUnitMutationEvidenceReceipt({
        evidence_sink_id: fixture.input.evidence_sink_id,
        receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
      }),
    ).toEqual(closure.receipt);
    for (const identity of [closure.output_contract, ...closure.members]) {
      expect(
        reopened.readUnitMutationEvidenceBlob({
          binding: evidence.binding,
          identity: unitObjectIdentity(identity),
        }),
      ).toEqual(evidence.objects.get(identity.sha256));
    }
    await expect(
      verifyUnitMutationEvidenceDocuments({
        closure,
        expected: evidence.binding,
        maximum_bytes: fixture.input.max_blob_bytes,
        read: (identity) =>
          reopened.readUnitMutationEvidenceBlob({ binding: evidence.binding, identity }),
      }),
    ).resolves.toBeUndefined();
    const summaryMember = closure.members.find((member) => member.path === closure.summary_path);
    if (summaryMember === undefined) throw new Error('fixture summary missing');
    const summary = JSON.parse(
      reopened
        .readUnitMutationEvidenceBlob({
          binding: evidence.binding,
          identity: unitObjectIdentity(summaryMember),
        })
        .toString('utf8'),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      aggregate: {
        packageCount: 11,
        executedPackageCount: 9,
        reusedPackageCount: 1,
        notRequiredPackageCount: 1,
      },
    });
    const escaped = reopened.readUnitMutationEvidenceClosure(evidence.binding);
    Object.assign(escaped.receipt, { receipt_digest_sha256: '0'.repeat(64) });
    expect(reopened.readUnitMutationEvidenceClosure(evidence.binding)).toEqual(closure);
    const packageTransaction = await invokeSink(reopened.authority_owner, () =>
      reopened.begin([binding('@fixture/publishable')]),
    );
    const packages = await invokeSink(reopened.authority_owner, () =>
      packageTransaction.commit([{ ...binding('@fixture/publishable'), outputs: [] }]),
    );
    expect(packages).toEqual([{ ...binding('@fixture/publishable'), outputs: [] }]);
    expect(reopened.readCertificationOutputClosure(binding('@fixture/publishable'))).toEqual(
      packages[0],
    );
  });

  it.each([
    'unexpected-name',
    'leading-valid-uuid',
    'trailing-valid-uuid',
    'regular-file',
    'symbolic-link',
  ] as const)('refuses a %s in the durable unit-mutation transaction namespace', async (fault) => {
    const fixture = storeFixture();
    const { evidence } = await commitUnitEvidence(fixture);
    const namespace = join(fixture.evidenceRoot, 'unit-mutation');
    const transactionDirectory = onlyTransactionDirectory(fixture, 'unit-mutation');
    const injected = join(
      namespace,
      fault === 'unexpected-name'
        ? 'not-a-transaction'
        : fault === 'leading-valid-uuid'
          ? `0${randomUUID()}`
          : fault === 'trailing-valid-uuid'
            ? `${randomUUID()}0`
            : randomUUID(),
    );
    if (fault === 'regular-file') writeFileSync(injected, 'not a transaction');
    else if (fault === 'symbolic-link') symlinkSync(transactionDirectory, injected, 'dir');
    else mkdirSync(injected);

    await refusal(() =>
      createReleaseCertificationEvidenceStore(fixture.input).readUnitMutationEvidenceClosure(
        evidence.binding,
      ),
    );
  });

  it('ignores an incomplete unit transaction but refuses an unreadable commit', async () => {
    const fixture = storeFixture();
    const { closure, evidence } = await commitUnitEvidence(fixture);
    const namespace = join(fixture.evidenceRoot, 'unit-mutation');
    const incomplete = join(namespace, randomUUID());
    mkdirSync(incomplete);
    expect(
      createReleaseCertificationEvidenceStore(fixture.input).readUnitMutationEvidenceClosure(
        evidence.binding,
      ),
    ).toEqual(closure);

    rmSync(incomplete, { recursive: true });
    const unreadable = join(namespace, randomUUID());
    mkdirSync(join(unreadable, 'commit.json'), { recursive: true });
    await refusal(() =>
      createReleaseCertificationEvidenceStore(fixture.input).readUnitMutationEvidenceClosure(
        evidence.binding,
      ),
    );
  });

  it.each(['noncanonical-commit', 'noncanonical-begin', 'noncanonical-index', 'abort'] as const)(
    'refuses unit transaction metadata with %s after restart',
    async (fault) => {
      const fixture = storeFixture();
      const { evidence } = await commitUnitEvidence(fixture);
      const directory = onlyTransactionDirectory(fixture, 'unit-mutation');
      if (fault === 'noncanonical-commit')
        makeStoredJsonNoncanonical(join(directory, 'commit.json'));
      else if (fault === 'noncanonical-begin')
        makeStoredJsonNoncanonical(join(directory, 'begin.json'));
      else if (fault === 'noncanonical-index') {
        const indexDirectory = join(fixture.evidenceRoot, 'unit-mutation-index');
        const indexes = readdirSync(indexDirectory);
        if (indexes.length !== 1) throw new Error('fixture unit-mutation index missing');
        makeStoredJsonNoncanonical(join(indexDirectory, indexes[0] ?? ''));
      } else writeFileSync(join(directory, 'abort.json'), canonicalJson({ aborted: true }), 'utf8');

      await refusal(() =>
        createReleaseCertificationEvidenceStore(fixture.input).readUnitMutationEvidenceClosure(
          evidence.binding,
        ),
      );
    },
  );

  it('requires the same protected sink owner for begin, put, commit and abort', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    await refusal(() => fixture.store.beginUnitMutationEvidence(evidence.binding));
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    const identity = evidence.projection.output_contract;
    const bytes = evidence.objects.get(identity.sha256);
    if (bytes === undefined) throw new Error('fixture contract missing');
    await refusal(() =>
      transaction.put({ bytes, sha256: identity.sha256, size_bytes: identity.size_bytes }),
    );
    await refusal(() => transaction.commit(evidence.projection));
    await refusal(() => transaction.abort());
    const other = storeFixture();
    await refusal(() =>
      invokeSink(other.store.authority_owner, () =>
        transaction.put({
          bytes,
          sha256: identity.sha256,
          size_bytes: identity.size_bytes,
        }),
      ),
    );
    await invokeSink(fixture.store.authority_owner, () => transaction.abort());
    await refusal(() => fixture.store.readUnitMutationEvidenceClosure(evidence.binding));
  });

  it('keeps uncommitted and aborted objects unreadable without a finalized unit receipt', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    for (const store of [fixture.store, createReleaseCertificationEvidenceStore(fixture.input)]) {
      await refusal(() => store.readUnitMutationEvidenceClosure(evidence.binding));
      await refusal(() =>
        store.readUnitMutationEvidenceReceipt({
          evidence_sink_id: fixture.input.evidence_sink_id,
          receipt_digest_sha256: evidence.closure.receipt.receipt_digest_sha256,
        }),
      );
      await refusal(() =>
        store.readUnitMutationEvidenceBlob({
          binding: evidence.binding,
          identity: evidence.projection.output_contract,
        }),
      );
    }
    await invokeSink(fixture.store.authority_owner, () => transaction.abort());
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection)),
    );
    await refusal(() => fixture.store.readUnitMutationEvidenceClosure(evidence.binding));
  });

  it.each(['missing', 'corrupt'] as const)(
    'refuses %s retained bytes after store recreation',
    async (fault) => {
      const fixture = storeFixture();
      const evidence = await unitEvidence(fixture);
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(evidence.binding),
      );
      await putUnitDocuments(fixture, evidence, transaction);
      await transaction.verify(evidence.projection);
      const closure = await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit(evidence.projection),
      );
      const objectPath = join(fixture.evidenceRoot, 'objects', closure.output_contract.sha256);
      if (fault === 'missing') rmSync(objectPath);
      else writeFileSync(objectPath, 'corrupt');
      const reopened = createReleaseCertificationEvidenceStore(fixture.input);
      await refusal(() =>
        reopened.readUnitMutationEvidenceBlob({
          binding: evidence.binding,
          identity: closure.output_contract,
        }),
      );
      await refusal(() =>
        verifyUnitMutationEvidenceDocuments({
          closure,
          expected: evidence.binding,
          maximum_bytes: fixture.input.max_blob_bytes,
          read: (identity) =>
            reopened.readUnitMutationEvidenceBlob({ binding: evidence.binding, identity }),
        }),
      );
    },
  );

  it('refuses foreign candidate, mapping, sink, and retained-object references', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    await transaction.verify(evidence.projection);
    const closure = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit(evidence.projection),
    );
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    for (const changed of [
      { candidate_commit: '0'.repeat(40) },
      { candidate_tree: '0'.repeat(40) },
      { release_unit: '@fixture/other' },
      { release_profile_digest_sha256: '0'.repeat(64) },
      { task_policy_digests_sha256: ['0'.repeat(64)] },
    ]) {
      const foreign = { ...evidence.binding, ...changed };
      await refusal(() => reopened.readUnitMutationEvidenceClosure(foreign));
      await refusal(() =>
        reopened.readUnitMutationEvidenceBlob({
          binding: foreign,
          identity: closure.output_contract,
        }),
      );
    }
    await refusal(() =>
      reopened.readUnitMutationEvidenceReceipt({
        evidence_sink_id: 'foreign-sink',
        receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
      }),
    );
    for (const changed of [
      { path: 'mutation/foreign.json' },
      { sha256: '0'.repeat(64) },
      { size_bytes: closure.output_contract.size_bytes + 1 },
      { evidence_sink_id: 'foreign-sink' },
      { opaque_handle: `sha256:${'0'.repeat(64)}` },
    ]) {
      await refusal(() =>
        reopened.readUnitMutationEvidenceBlob({
          binding: evidence.binding,
          identity: { ...closure.output_contract, ...changed },
        }),
      );
    }
  });

  it('retains failed semantic bytes but consumes the transaction without issuing a receipt or allowing retry', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    const invalid = structuredClone(evidence.projection);
    const reports = invalid.members.filter(
      (member) => member.document_kind === 'mutation-normalized-stryker-report-v2',
    );
    const first = reports[0],
      second = reports[1];
    if (first === undefined || second === undefined) throw new Error('fixture reports missing');
    const firstName = first.package_name;
    Object.assign(first, { package_name: second.package_name });
    Object.assign(second, { package_name: firstName });
    await refusal(() => transaction.verify(invalid));
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => transaction.commit(invalid)),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection)),
    );
    await refusal(() => invokeSink(fixture.store.authority_owner, () => transaction.abort()));
    await refusal(() => fixture.store.readUnitMutationEvidenceClosure(evidence.binding));
    expect(
      readFileSync(
        join(fixture.evidenceRoot, 'objects', evidence.projection.output_contract.sha256),
      ),
    ).toEqual(evidence.objects.get(evidence.projection.output_contract.sha256));
    expect(
      readdirSync(join(fixture.evidenceRoot, 'unit-mutation', transaction.transaction_handle)),
    ).not.toContain('commit.json');
  });

  it('allows exactly one commit for two begun transactions with the same binding', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const first = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    const second = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, first);
    await putUnitDocuments(fixture, evidence, second);
    await first.verify(evidence.projection);
    await second.verify(evidence.projection);
    const closure = await invokeSink(fixture.store.authority_owner, () =>
      first.commit(evidence.projection),
    );
    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => second.commit(evidence.projection)),
    );
    expect(
      createReleaseCertificationEvidenceStore(fixture.input).readUnitMutationEvidenceClosure(
        evidence.binding,
      ),
    ).toEqual(closure);
  });

  it('refuses a new unit transaction after the binding has a durable committed election', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    await transaction.verify(evidence.projection);
    await invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection));
    const before = readdirSync(join(fixture.evidenceRoot, 'unit-mutation')).sort();
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);

    await refusal(() =>
      invokeSink(reopened.authority_owner, () =>
        reopened.beginUnitMutationEvidence(evidence.binding),
      ),
    );
    expect(readdirSync(join(fixture.evidenceRoot, 'unit-mutation')).sort()).toEqual(before);
  });

  it('keeps a committed transaction terminal if its durable election is removed', async () => {
    const fixture = storeFixture();
    const { evidence, transaction } = await commitUnitEvidence(fixture);
    rmSync(
      join(
        fixture.evidenceRoot,
        'unit-mutation-index',
        `${canonicalSha256(evidence.binding)}.json`,
      ),
    );
    rmSync(
      join(fixture.evidenceRoot, 'unit-mutation', transaction.transaction_handle, 'commit.json'),
    );

    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection)),
    );
  });

  it('consumes an unverified transaction after its commit is refused', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);

    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection)),
    );
    await refusal(() => transaction.verify(evidence.projection));
  });

  it('keeps an aborted transaction closed to later object admission', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await invokeSink(fixture.store.authority_owner, () => transaction.abort());
    const identity = evidence.projection.output_contract;
    const content = evidence.objects.get(identity.sha256);
    if (content === undefined) throw new Error('fixture unit contract missing');

    await refusal(() =>
      invokeSink(fixture.store.authority_owner, () =>
        transaction.put({
          bytes: content,
          sha256: identity.sha256,
          size_bytes: identity.size_bytes,
        }),
      ),
    );
  });

  it.each(['unverified', 'changed-projection', 'changed-bytes'] as const)(
    'refuses a synchronous commit with %s evidence',
    async (fault) => {
      const fixture = storeFixture();
      const evidence = await unitEvidence(fixture);
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(evidence.binding),
      );
      await putUnitDocuments(fixture, evidence, transaction);
      if (fault !== 'unverified') await transaction.verify(evidence.projection);
      const projection = structuredClone(evidence.projection);
      if (fault === 'changed-projection') {
        Object.assign(projection.output_contract, { path: 'mutation/renamed-contract.json' });
      } else if (fault === 'changed-bytes') {
        const path = join(fixture.evidenceRoot, 'objects', projection.output_contract.sha256);
        const changed = readFileSync(path);
        changed[0] = 0;
        writeFileSync(path, changed);
      }
      await refusal(() =>
        invokeSink(fixture.store.authority_owner, () => transaction.commit(projection)),
      );
      await refusal(() => fixture.store.readUnitMutationEvidenceClosure(evidence.binding));
      expect(
        readdirSync(join(fixture.evidenceRoot, 'unit-mutation', transaction.transaction_handle)),
      ).not.toContain('commit.json');
    },
  );

  it.each(['completed', 'in-flight'] as const)(
    'invalidates %s semantic verification when a newer verification fails',
    async (state) => {
      const fixture = storeFixture();
      const evidence = await unitEvidence(fixture);
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(evidence.binding),
      );
      await putUnitDocuments(fixture, evidence, transaction);
      const prior = transaction.verify(evidence.projection);
      if (state === 'completed') await prior;
      const invalid = { ...evidence.projection, members: [] };
      const newer = transaction.verify(invalid);
      const outcomes = await Promise.allSettled([prior, newer]);
      expect(outcomes[1]?.status).toBe('rejected');
      await refusal(() =>
        invokeSink(fixture.store.authority_owner, () => transaction.commit(evidence.projection)),
      );
      await refusal(() => fixture.store.readUnitMutationEvidenceClosure(evidence.binding));
    },
  );

  it('refuses a copied second durable transaction even if its closure and binding are identical', async () => {
    const fixture = storeFixture();
    const evidence = await unitEvidence(fixture);
    const transaction = await invokeSink(fixture.store.authority_owner, () =>
      fixture.store.beginUnitMutationEvidence(evidence.binding),
    );
    await putUnitDocuments(fixture, evidence, transaction);
    await transaction.verify(evidence.projection);
    const closure = await invokeSink(fixture.store.authority_owner, () =>
      transaction.commit(evidence.projection),
    );
    const duplicate = randomUUID();
    cpSync(
      join(fixture.evidenceRoot, 'unit-mutation', transaction.transaction_handle),
      join(fixture.evidenceRoot, 'unit-mutation', duplicate),
      { recursive: true },
    );
    writeFileSync(
      join(fixture.evidenceRoot, 'unit-mutation', duplicate, 'begin.json'),
      canonicalBytes({
        evidence_sink_id: fixture.input.evidence_sink_id,
        transaction_handle: duplicate,
        binding: evidence.binding,
      }),
    );
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);
    await refusal(() => reopened.readUnitMutationEvidenceClosure(evidence.binding));
    await refusal(() =>
      reopened.readUnitMutationEvidenceReceipt({
        evidence_sink_id: fixture.input.evidence_sink_id,
        receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
      }),
    );
  });

  it('serves each committed unit-mutation receipt only by its own digest', async () => {
    const fixture = storeFixture();
    const evidence = [
      await unitEvidence(fixture, {
        releaseUnit: '@fixture/first',
        planDigest: '1'.repeat(64),
      }),
      await unitEvidence(fixture, {
        releaseUnit: '@fixture/second',
        planDigest: '2'.repeat(64),
      }),
    ];
    const receipts = [];
    for (const item of evidence) {
      const transaction = await invokeSink(fixture.store.authority_owner, () =>
        fixture.store.beginUnitMutationEvidence(item.binding),
      );
      await putUnitDocuments(fixture, item, transaction);
      await transaction.verify(item.projection);
      const closure = await invokeSink(fixture.store.authority_owner, () =>
        transaction.commit(item.projection),
      );
      receipts.push(closure.receipt);
    }
    const reopened = createReleaseCertificationEvidenceStore(fixture.input);

    expect(receipts[0]).not.toEqual(receipts[1]);
    for (const receipt of receipts) {
      expect(
        reopened.readUnitMutationEvidenceReceipt({
          evidence_sink_id: fixture.input.evidence_sink_id,
          receipt_digest_sha256: receipt.receipt_digest_sha256,
        }),
      ).toEqual(receipt);
    }
  });
});
