import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedExportSignerAdapter,
  createProtectedExportSinkAdapter,
  createProtectedReleaseSinkOwner,
  protectedExportHostEffect,
  runWithAuthorityHostEffects,
  withProtectedReleaseExportCapacity,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
  type ProtectedReleaseExportBinding,
} from '../../src/boundaries/host-effects.js';
import { captureExportCertificationUnitProjections } from '../../src/boundaries/release-export-certification.js';
import {
  createIssuer,
  runtimeApi,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

// Export adapter and certification projection contracts written against the retained
// authority mutation diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the
// report's.

const REPOSITORY = createReleaseRepositoryTestFixture();
afterAll(() => REPOSITORY.dispose());
const issuers: AuthorityDecisionIssuer[] = [];
afterEach(() => {
  for (const issuer of issuers.splice(0)) issuer.dispose();
});
const DIGEST = (character: string) => character.repeat(64);

function binding(): ProtectedReleaseExportBinding {
  return {
    action_id: 'release export',
    repository: REPOSITORY.repository,
    candidate: { commit: REPOSITORY.repository.commit, tree: REPOSITORY.repository.tree },
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

const capacityBinding = (value: ProtectedReleaseExportBinding) => ({
  action_id: 'release export' as const,
  repository: value.repository,
  candidate: value.candidate,
  plan_receipt_digest_sha256: value.plan_receipt_digest_sha256,
});

async function exportScope(
  invocationId: string,
  applyEffect: AuthorityHostEffectScope['apply_effect'] = (_request, apply) => apply(),
): Promise<AuthorityHostEffectScope> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: `export-adapter-${invocationId}`,
    invocation_id: invocationId,
  });
  issuers.push(issuer);
  return {
    action_id: 'release export',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: applyEffect,
    read_export_capacity: () => ({ remaining_batches: 128, remaining_targets: 8192 }),
  };
}

/** Runs the callback inside the repository context, the export scope and its capacity sequence. */
async function withinExport<T>(scope: AuthorityHostEffectScope, callback: () => T): Promise<T> {
  return await REPOSITORY.run(
    async () =>
      await runWithAuthorityHostEffects(
        scope,
        async () =>
          await withProtectedReleaseExportCapacity(capacityBinding(binding()), async () =>
            callback(),
          ),
      ),
  );
}

describe('protected export operation inspection', () => {
  // Mutants 907-912: a live export token is recognized only under the protected-release
  // kind and the export symbol; either field alone is not enough.
  it('recognizes a live token only with the exact kind and symbol', async () => {
    let inspected = 0;
    const scope = await exportScope('invocation-1', (request, apply) => {
      expect(protectedExportHostEffect(request)?.kind).toBe('export-sink');
      expect(protectedExportHostEffect({ ...request, kind: 'filesystem' })).toBeUndefined();
      expect(protectedExportHostEffect({ ...request, kind: 'process' })).toBeUndefined();
      expect(
        protectedExportHostEffect({ ...request, symbol: 'protectedReleaseHostOperation' }),
      ).toBeUndefined();
      inspected += 1;
      return apply();
    });
    const adapter = createProtectedExportSinkAdapter(binding());
    const owner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    expect(await withinExport(scope, () => adapter.invokeSink(() => 'exported', owner))).toBe(
      'exported',
    );
    expect(inspected).toBe(1);
  });

  // Mutant 923: a live export token is hidden from any other scope.
  it('hides a live export token from a nested foreign scope', async () => {
    const foreign = await exportScope('invocation-2');
    let abandoned: AuthorityHostEffectRequest | undefined;
    const scope = await exportScope('invocation-1', (request, apply) => {
      abandoned = request;
      expect(runWithAuthorityHostEffects(foreign, () => protectedExportHostEffect(request))).toBe(
        undefined,
      );
      return apply();
    });
    const adapter = createProtectedExportSinkAdapter(binding());
    const owner = createProtectedReleaseSinkOwner('export', 'fixture-sink');
    await withinExport(scope, () => adapter.invokeSink(() => 'exported', owner));
    if (!abandoned) throw new Error('request missing');
    expect(protectedExportHostEffect(abandoned)).toBeUndefined();
  });
});

describe('aggregate signer spend', () => {
  // Mutant 967: a signer adapter is spent by its own first invocation, even under a later
  // scope with a fresh receipt store.
  it('stays spent across a fresh receipt store', async () => {
    const signer = createProtectedExportSignerAdapter(binding());
    const first = await exportScope('invocation-1');
    expect(await withinExport(first, () => signer.invokeSigner(() => 'signature'))).toBe(
      'signature',
    );
    const second = await exportScope('invocation-2');
    await expect(withinExport(second, () => signer.invokeSigner(() => 'again'))).rejects.toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );
  });
});

describe('certification projection population', () => {
  const identity = (hex = 'a') => ({ sha256: hex.repeat(64), size_bytes: 1 });
  const unit = (release_unit = 'unit', carrier_package_id = '@fixture/a') => ({
    release_unit,
    carrier_package_id,
    carrier: identity(),
    derivation_binding_digest_sha256: 'a'.repeat(64),
    candidate_receipt: identity(),
    task_policy: identity(),
    task_results: [identity('a'), identity('b')],
    namespace_census: identity(),
    census_member_projection_digest_sha256: 'b'.repeat(64),
    census_member_count: 0,
  });
  const packages = [{ package_id: '@fixture/a', release_unit: 'unit' }];
  const capture = (value: unknown, roster: unknown = packages, maximum = 10) =>
    captureExportCertificationUnitProjections(value, roster as typeof packages, maximum);
  const refused = (value: unknown, roster: unknown = packages, maximum = 10) =>
    expect(() => capture(value, roster, maximum)).toThrow(
      'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
    );

  // Mutant 3879: the population must be a plain array, not an array-like with another
  // prototype.
  it('refuses a population with a foreign prototype', () => {
    refused(Object.setPrototypeOf([unit()], { map: () => [] }));
  });

  // Mutants 3915, 3959, 3960: the package bound is inclusive and a bound of one admits one
  // package.
  it('admits exactly the bound and one package under a bound of one', () => {
    expect(capture([unit()], packages, 1)).toHaveLength(1);
    refused([unit()], [...packages, { package_id: '@fixture/b', release_unit: 'unit' }], 1);
  });

  // Mutant 3978: an empty roster admits no population, not even an empty one.
  it('refuses an empty roster with an empty population', () => {
    refused([], []);
  });
});

// Mutant 4025 (duplicate release units after capture) is subsumed: `ordered` refuses any
// non-ascending pair, so two equal units never reach the final uniqueness check.
