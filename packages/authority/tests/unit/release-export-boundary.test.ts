import { describe, expect, it } from 'vitest';
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

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = (character: string) => character.repeat(64);

function binding(): ProtectedReleaseExportBinding {
  return {
    action_id: 'release export',
    repository: { id: 'fixture/repository', commit: COMMIT, tree: TREE },
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
  return await runWithAuthorityHostEffects(value, callback);
}

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
});
