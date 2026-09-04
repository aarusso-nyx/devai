import { afterAll, describe, expect, it } from 'vitest';
import {
  createAuthorityDecisionIssuer,
  createProtectedExportSignerAdapter,
  createProtectedExportSinkAdapter,
  createProtectedReleaseSinkOwner,
  protectedExportHostEffect,
  withProtectedReleaseExportCapacity,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportCapacityBinding,
  type ProtectedReleaseExportBinding,
} from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  captureProtectedReleaseExportBinding,
  type ExportMutationUnitProjection,
  type ProtectedReleaseExportBindingV3,
} from '../../src/boundaries/release-export-binding.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

const REPOSITORY_FIXTURE = createReleaseRepositoryTestFixture();
const COMMIT = REPOSITORY_FIXTURE.repository.commit;
const TREE = REPOSITORY_FIXTURE.repository.tree;
const DIGEST = (character: string) => character.repeat(64);
const EXPORT_SPEC_V3_DIGEST = 'aac1c75a539516a38b567aea9be4490eb3f82fe0ab7b75e46e55e46d3166e37f';

function present<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function binding(): ProtectedReleaseExportBinding {
  return {
    action_id: 'release export',
    repository: REPOSITORY_FIXTURE.repository,
    candidate: { commit: COMMIT, tree: TREE },
    plan_receipt_digest_sha256: DIGEST('c'),
    parent_artifact_sink: {
      sink_id: 'fixture-sink',
      transaction_handle: 'transaction-1',
      committed_manifest_handle: 'commit-1',
      committed_manifest_sha256: DIGEST('d'),
      committed_manifest_size_bytes: 1,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    },
    sink_id: 'fixture-sink',
    destination: { kind: 'evidence-destination', exact_identifier: 's3://fixture/export' },
    trust: {
      trust_root_id: 'fixture/trust',
      trust_store_digest_sha256: DIGEST('e'),
      key_id: 'fixture-key',
      signature_algorithm: 'ed25519',
    },
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98',
    closure_inputs: [
      {
        package_id: '@fixture/package',
        sha256: DIGEST('f'),
        size_bytes: 1,
        expected_installed_package: {
          name: '@aarusso-nyx/devai',
          version: '1.5.0',
          archive_sha256: DIGEST('1'),
          content_manifest_sha256: DIGEST('2'),
        },
        policy_resolution_digest_sha256: DIGEST('3'),
      },
    ],
  };
}

function mutationObject(path: string, character: string) {
  const sha256 = DIGEST(character);
  return {
    path,
    sha256,
    size_bytes: 1,
    evidence_sink_id: 'fixture-sink',
    opaque_handle: `sha256:${sha256}`,
  };
}

function mutationUnit(
  releaseUnit: string,
  carrierPackageId: string,
  memberCharacter: string,
): ProtectedReleaseExportBindingV3['mutation_units'][number] {
  const members = [
    {
      ...mutationObject(`mutation/${releaseUnit}/01-report.json`, memberCharacter),
      document_kind: 'mutation-normalized-stryker-report-v2' as const,
      package_name: carrierPackageId,
    },
    {
      ...mutationObject(`mutation/${releaseUnit}/02-result.json`, 'a'),
      document_kind: 'mutation-package-result-v2' as const,
      package_name: carrierPackageId,
    },
    {
      ...mutationObject(`mutation/${releaseUnit}/03-summary.json`, 'b'),
      document_kind: 'mutation-composed-report-set-v2' as const,
      package_name: null,
    },
    {
      ...mutationObject(`mutation/${releaseUnit}/04-receipt.json`, 'c'),
      document_kind: 'mutation-semantic-verification-receipt-v2' as const,
      package_name: null,
    },
  ];
  return {
    release_unit: releaseUnit,
    mutation_evidence: {
      carrier_package_id: carrierPackageId,
      binding: {
        repository_id: REPOSITORY_FIXTURE.repository.id,
        candidate_commit: COMMIT,
        candidate_tree: TREE,
        release_unit: releaseUnit,
        release_plan_receipt_digest_sha256: DIGEST('c'),
        release_profile_digest_sha256: DIGEST('d'),
        mutation_policy_digest_sha256: DIGEST('e'),
        task_policy_digests_sha256: [DIGEST('1'), DIGEST('2')],
      },
      closure: { sha256: DIGEST('3'), size_bytes: 1 },
      receipt: {
        sha256: DIGEST('4'),
        size_bytes: 1,
        receipt_digest_sha256: DIGEST('5'),
      },
      output_contract: mutationObject(`mutation/${releaseUnit}/00-output-contract.json`, '6'),
      members,
      member_projection_digest_sha256: canonicalSha256(members),
    },
  };
}

function bindingV3(): ProtectedReleaseExportBindingV3 {
  const legacy = binding();
  const closure = present(legacy.closure_inputs[0], 'missing legacy closure input');
  return {
    ...legacy,
    export_spec_digest_sha256: EXPORT_SPEC_V3_DIGEST,
    closure_inputs: [
      {
        ...closure,
        package_id: '@fixture/carrier',
        release_unit: 'fixture/required',
      },
      {
        ...closure,
        package_id: '@fixture/none',
        sha256: DIGEST('7'),
        release_unit: 'fixture/none',
      },
    ],
    mutation_units: [
      { release_unit: 'fixture/none', mutation_evidence: null },
      mutationUnit('fixture/required', '@fixture/carrier', '8'),
    ],
  };
}

function capacityBinding(
  value: ProtectedReleaseExportBinding,
): ProtectedReleaseExportCapacityBinding {
  return {
    action_id: 'release export',
    repository: value.repository,
    candidate: value.candidate,
    plan_receipt_digest_sha256: value.plan_receipt_digest_sha256,
  };
}

function scope(
  actionId: 'release export' | 'release certify' = 'release export',
  applyEffect: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown = (
    request,
    apply,
  ) => {
    if (protectedExportHostEffect(request) === undefined)
      throw new Error('TEST_PROTECTED_EXPORT_OPERATION_REQUIRED');
    return apply();
  },
  expected = binding(),
) {
  const invocationId = `release-export-boundary-${Math.random().toString(16).slice(2)}`;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'release-export-boundary-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256,
    randomId: () => 'release-export-boundary-id',
    now: () => '2026-09-03T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const expectedCapacity = capacityBinding(expected);
  let capacityReads = 0;
  return {
    issuer,
    capacityReads: () => capacityReads,
    scope: {
      action_id: actionId,
      invocation_id: invocationId,
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: applyEffect,
      read_export_capacity: (selected) => {
        capacityReads += 1;
        if (canonicalSha256(selected) !== canonicalSha256(expectedCapacity))
          throw new Error('release-export-capacity-unavailable');
        return { remaining_batches: 128, remaining_targets: 8192 };
      },
    } satisfies AuthorityHostEffectScope,
  };
}

async function within<T>(
  value: AuthorityHostEffectScope,
  callback: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await REPOSITORY_FIXTURE.run(
    async () => await runWithAuthorityHostEffects(value, callback),
  );
}

afterAll(() => REPOSITORY_FIXTURE.dispose());

async function withinCapacity<T>(
  current: AuthorityHostEffectScope,
  value: ProtectedReleaseExportBinding,
  callback: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await within(
    current,
    async () =>
      await withProtectedReleaseExportCapacity(
        capacityBinding(value),
        async () => await callback(),
      ),
  );
}

describe('protected release export boundary', () => {
  it('keeps export sink and signer operations distinct and captures an immutable binding', async () => {
    const frozen = binding();
    const source = { ...frozen, parent_artifact_sink: { ...frozen.parent_artifact_sink } };
    const sink = createProtectedExportSinkAdapter(source);
    const signer = createProtectedExportSignerAdapter(source);
    source.sink_id = 'mutated-sink';
    source.parent_artifact_sink.sink_id = 'mutated-sink';
    const owner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    const observed: string[] = [];
    const current = scope(
      'release export',
      (request, apply) => {
        const operation = protectedExportHostEffect(request);
        if (operation === undefined) throw new Error('TEST_PROTECTED_EXPORT_OPERATION_REQUIRED');
        observed.push(`${operation.kind}:${operation.binding.sink_id}`);
        return apply();
      },
      source,
    );
    try {
      await withinCapacity(current.scope, source, async () => {
        sink.invokeSink(() => 'sink', owner);
        signer.invokeSigner(() => 'signature');
      });
      expect(observed).toEqual(['export-sink:fixture-sink', 'export-signer:fixture-sink']);
      expect(current.capacityReads()).toBe(3);
    } finally {
      current.issuer.dispose();
    }
  });

  it('rejects cross-action and cross-owner use before any export callback', async () => {
    const adapter = createProtectedExportSinkAdapter(binding());
    const wrongOwner = createProtectedReleaseSinkOwner('certification', 'fixture-sink');
    const validOwner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    const wrongAction = scope('release certify');
    let called = false;
    try {
      await expect(
        within(wrongAction.scope, () =>
          adapter.invokeSink(() => {
            called = true;
          }, validOwner),
        ),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
    } finally {
      wrongAction.issuer.dispose();
    }
    const correctAction = scope();
    try {
      await expect(
        withinCapacity(correctAction.scope, binding(), () =>
          adapter.invokeSink(() => {
            called = true;
          }, wrongOwner),
        ),
      ).rejects.toThrow('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
      expect(called).toBe(false);
    } finally {
      correctAction.issuer.dispose();
    }
  });

  it('rejects non-native closure-input arrays before inherited hooks can run', () => {
    const value = binding();
    const closures = [...value.closure_inputs];
    let maps = 0;
    Object.setPrototypeOf(closures, {
      map: () => {
        maps += 1;
        return [];
      },
    });

    expect(() =>
      createProtectedExportSinkAdapter({
        ...value,
        closure_inputs: closures as unknown as ProtectedReleaseExportBinding['closure_inputs'],
      }),
    ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    expect(maps).toBe(0);
  });

  it('refuses unwrapped export operations before requesting a protected effect', async () => {
    const adapter = createProtectedExportSinkAdapter(binding());
    const owner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    let effects = 0;
    let callback = false;
    const current = scope('release export', (request, apply) => {
      effects += 1;
      if (protectedExportHostEffect(request) === undefined)
        throw new Error('TEST_PROTECTED_EXPORT_OPERATION_REQUIRED');
      return apply();
    });
    try {
      await expect(
        within(current.scope, () =>
          adapter.invokeSink(() => {
            callback = true;
          }, owner),
        ),
      ).rejects.toThrow('release-export-capacity-unavailable');
      expect(effects).toBe(0);
      expect(callback).toBe(false);
    } finally {
      current.issuer.dispose();
    }
  });

  it('consumes each protected operation token once and refuses filesystem escape from its callback', async () => {
    const adapter = createProtectedExportSinkAdapter(binding());
    const owner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    let callbacks = 0;
    const doubleApply = scope('release export', (request, apply) => {
      if (protectedExportHostEffect(request) === undefined)
        throw new Error('TEST_PROTECTED_EXPORT_OPERATION_REQUIRED');
      const first = apply();
      expect(() => apply()).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      return first;
    });
    try {
      await withinCapacity(doubleApply.scope, binding(), () =>
        adapter.invokeSink(() => {
          callbacks += 1;
        }, owner),
      );
      expect(callbacks).toBe(1);
    } finally {
      doubleApply.issuer.dispose();
    }

    const escaped = scope();
    try {
      await expect(
        withinCapacity(escaped.scope, binding(), () =>
          adapter.invokeSink(
            () =>
              escaped.scope.apply_effect(
                { kind: 'filesystem', symbol: 'writeFileSync', arguments: [] },
                () => {
                  callbacks += 1;
                },
              ),
            owner,
          ),
        ),
      ).rejects.toThrow('TEST_PROTECTED_EXPORT_OPERATION_REQUIRED');
      expect(callbacks).toBe(1);
    } finally {
      escaped.issuer.dispose();
    }
  });

  it('spends the aggregate signer after success or a throw across every adapter in one live account', async () => {
    const first = createProtectedExportSignerAdapter(binding());
    const second = createProtectedExportSignerAdapter(binding());
    const current = scope();
    try {
      await withinCapacity(current.scope, binding(), async () => {
        expect(() =>
          first.invokeSigner(() => {
            throw new Error('signer transport failed');
          }),
        ).toThrow('signer transport failed');
        expect(() => second.invokeSigner(() => 'retry')).toThrow(
          'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
        );
      });
    } finally {
      current.issuer.dispose();
    }

    const successful = scope();
    try {
      const fresh = createProtectedExportSignerAdapter(binding());
      await withinCapacity(successful.scope, binding(), async () => {
        fresh.invokeSigner(() => 'signature');
        expect(() =>
          createProtectedExportSignerAdapter(binding()).invokeSigner(() => 'retry'),
        ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      });
    } finally {
      successful.issuer.dispose();
    }
  });

  it('keeps the v2 binding population exact while requiring the complete v3 unit projection', () => {
    const legacy = binding();
    expect(captureProtectedReleaseExportBinding(legacy)).toEqual(legacy);
    expect(() =>
      captureProtectedReleaseExportBinding({
        ...legacy,
        mutation_units: [],
      }),
    ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    expect(() =>
      captureProtectedReleaseExportBinding({
        ...legacy,
        export_spec_digest_sha256: EXPORT_SPEC_V3_DIGEST,
      }),
    ).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');

    const current = bindingV3();
    const captured = captureProtectedReleaseExportBinding(current);
    expect(captured).toEqual(current);
    expect(captured.export_spec_digest_sha256).toBe(EXPORT_SPEC_V3_DIGEST);
    expect('mutation_units' in captured).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.closure_inputs)).toBe(true);
    expect(
      Object.isFrozen(present(captured.closure_inputs[0], 'missing captured closure input')),
    ).toBe(true);
    if (!('mutation_units' in captured)) throw new Error('missing captured v3 projection');
    expect(Object.isFrozen(captured.mutation_units)).toBe(true);
    const capturedRequired = present(captured.mutation_units[1], 'missing captured required unit');
    expect(Object.isFrozen(capturedRequired.mutation_evidence?.members)).toBe(true);

    expect(
      Reflect.set(
        present(current.closure_inputs[0], 'missing mutable closure input'),
        'release_unit',
        'fixture/substituted',
      ),
    ).toBe(true);
    const required = present(
      current.mutation_units[1],
      'missing mutable required unit',
    ).mutation_evidence;
    if (required === null) throw new Error('missing required mutation fixture');
    expect(Reflect.set(required.binding, 'release_profile_digest_sha256', DIGEST('0'))).toBe(true);
    expect(
      Reflect.set(present(required.members[0], 'missing mutable member'), 'sha256', DIGEST('0')),
    ).toBe(true);
    expect(captured).not.toEqual(current);
  });

  it('refuses v3 mapping, election, projection, and hostile-input drift before host effects exist', () => {
    const malformed = (mutate: (value: ProtectedReleaseExportBindingV3) => void) => {
      const value = structuredClone(bindingV3()) as ProtectedReleaseExportBindingV3;
      mutate(value);
      expect(() => captureProtectedReleaseExportBinding(value)).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    };
    malformed((value) => {
      expect(
        Reflect.deleteProperty(
          present(value.closure_inputs[0], 'missing closure input'),
          'release_unit',
        ),
      ).toBe(true);
    });
    malformed((value) => {
      (value.mutation_units as ExportMutationUnitProjection[]).reverse();
    });
    malformed((value) => {
      const evidence = present(value.mutation_units[1], 'missing required unit').mutation_evidence;
      if (evidence === null) throw new Error('missing required mutation fixture');
      expect(Reflect.set(evidence, 'carrier_package_id', '@fixture/none')).toBe(true);
    });
    malformed((value) => {
      const evidence = present(value.mutation_units[1], 'missing required unit').mutation_evidence;
      if (evidence === null) throw new Error('missing required mutation fixture');
      expect(Reflect.set(evidence.binding, 'candidate_tree', '0'.repeat(40))).toBe(true);
    });
    malformed((value) => {
      expect(Reflect.set(value, 'plan_receipt_digest_sha256', DIGEST('0'))).toBe(true);
    });
    malformed((value) => {
      expect(
        Reflect.set(
          present(value.closure_inputs[0], 'missing closure input'),
          'release_unit',
          'fixture/foreign',
        ),
      ).toBe(true);
    });
    malformed((value) => {
      const evidence = present(value.mutation_units[1], 'missing required unit').mutation_evidence;
      if (evidence === null) throw new Error('missing required mutation fixture');
      const members = evidence.members as unknown as Array<(typeof evidence.members)[number]>;
      members.push(structuredClone(present(evidence.members[0], 'missing mutation member')));
      expect(
        Reflect.set(evidence, 'member_projection_digest_sha256', canonicalSha256(evidence.members)),
      ).toBe(true);
    });
    malformed((value) => {
      const evidence = present(value.mutation_units[1], 'missing required unit').mutation_evidence;
      if (evidence === null) throw new Error('missing required mutation fixture');
      expect(Reflect.set(evidence, 'member_projection_digest_sha256', DIGEST('0'))).toBe(true);
    });
    const extra = bindingV3() as ProtectedReleaseExportBindingV3 & Record<string, unknown>;
    extra['unexpected'] = true;
    expect(() => captureProtectedReleaseExportBinding(extra)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );

    const sparse = bindingV3();
    delete (sparse.mutation_units as ExportMutationUnitProjection[])[0];
    expect(() => captureProtectedReleaseExportBinding(sparse)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );

    const sparseMembers = bindingV3();
    const sparseEvidence = present(
      present(sparseMembers.mutation_units[1], 'missing required unit').mutation_evidence,
      'missing required mutation fixture',
    );
    delete (sparseEvidence.members as unknown as Array<(typeof sparseEvidence.members)[number]>)[0];
    expect(() => captureProtectedReleaseExportBinding(sparseMembers)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );

    let reads = 0;
    const accessor = bindingV3();
    Object.defineProperty(accessor, 'mutation_units', {
      enumerable: true,
      get: () => {
        reads += 1;
        return [];
      },
    });
    expect(() => captureProtectedReleaseExportBinding(accessor)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(reads).toBe(0);

    const decorated = bindingV3();
    Object.setPrototypeOf(decorated.mutation_units, { map: () => [] });
    expect(() => captureProtectedReleaseExportBinding(decorated)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });

  it('rejects proxy bindings before validation can observe a benign value and capture a substituted one', () => {
    const root = bindingV3();
    let rootReads = 0;
    const rootProxy = new Proxy(root, {
      get(target, key, receiver) {
        rootReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => captureProtectedReleaseExportBinding(rootProxy)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(rootReads).toBe(0);

    const unitToggle = bindingV3();
    let unitReads = 0;
    const originalUnit = present(unitToggle.mutation_units[1], 'missing required unit');
    const proxiedUnit = new Proxy(originalUnit, {
      get(target, key, receiver) {
        if (key === 'mutation_evidence') {
          unitReads += 1;
          return unitReads === 1 ? null : { unvalidated_field: true };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    (unitToggle.mutation_units as ExportMutationUnitProjection[])[1] = proxiedUnit;
    expect(() => captureProtectedReleaseExportBinding(unitToggle)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(unitReads).toBe(0);

    const nested = bindingV3();
    const evidence = present(
      present(nested.mutation_units[1], 'missing required unit').mutation_evidence,
      'missing required mutation evidence',
    );
    let bindingReads = 0;
    const toggledBinding = new Proxy(evidence.binding, {
      get(target, key, receiver) {
        bindingReads += 1;
        return key === 'candidate_tree' && bindingReads > 1
          ? '0'.repeat(40)
          : Reflect.get(target, key, receiver);
      },
    });
    expect(Reflect.set(evidence, 'binding', toggledBinding)).toBe(true);
    expect(() => captureProtectedReleaseExportBinding(nested)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(bindingReads).toBe(0);

    const member = bindingV3();
    const memberEvidence = present(
      present(member.mutation_units[1], 'missing required unit').mutation_evidence,
      'missing required mutation evidence',
    );
    let memberReads = 0;
    const proxiedMember = new Proxy(present(memberEvidence.members[0], 'missing member'), {
      get(target, key, receiver) {
        memberReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    (memberEvidence.members as unknown as Array<(typeof memberEvidence.members)[number]>)[0] =
      proxiedMember;
    expect(() => captureProtectedReleaseExportBinding(member)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(memberReads).toBe(0);

    const arrays = bindingV3();
    let arrayReads = 0;
    const proxiedUnits = new Proxy([...arrays.mutation_units], {
      get(target, key, receiver) {
        arrayReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(Reflect.set(arrays, 'mutation_units', proxiedUnits)).toBe(true);
    expect(() => captureProtectedReleaseExportBinding(arrays)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
    expect(arrayReads).toBe(0);
  });
});
