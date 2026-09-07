import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseHostAdapter,
  createProtectedReleaseSinkOwner,
  protectedArtifactSinkHostEffect,
  protectedReleaseHostEffect,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
import { createReleaseRepositoryTestFixture } from './release-repository-test-fixture.js';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function harness(
  kind: 'artifact' | 'certification',
  broker?: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown,
) {
  const repository = createReleaseRepositoryTestFixture();
  disposers.push(repository.dispose);
  const issuer = createIssuer(await runtimeApi());
  const owner = createProtectedReleaseSinkOwner(kind, 'expected-sink');
  const action = kind === 'artifact' ? 'release prepare' : 'release certify';
  const artifactBinding = {
    action_id: 'release prepare' as const,
    repository: { ...repository.repository },
    plan_receipt_digest_sha256: 'a'.repeat(64),
    pack_spec_digest_sha256: 'b'.repeat(64),
    sink_id: 'expected-sink',
  };
  const certificationBinding = {
    action_id: 'release certify' as const,
    repository: { ...repository.repository },
    plan_receipt_digest_sha256: 'a'.repeat(64),
    task_policy_digest_sha256: 'b'.repeat(64),
    helper_identity_sha256: 'c'.repeat(64),
  };
  const adapter =
    kind === 'artifact'
      ? createProtectedArtifactSinkAdapter(artifactBinding)
      : createProtectedReleaseHostAdapter(certificationBinding);
  const inspect =
    kind === 'artifact' ? protectedArtifactSinkHostEffect : protectedReleaseHostEffect;
  const requests: AuthorityHostEffectRequest[] = [];
  return {
    owner,
    adapter,
    inspect,
    requests,
    artifactBinding,
    certificationBinding,
    run: async <T>(
      callback: () => T,
      selectedAction = action,
      effect: 'read' | 'local-write' = 'local-write',
    ) =>
      await repository.run(() =>
        runWithAuthorityHostEffects(
          {
            action_id: selectedAction,
            invocation_id: 'invocation-1',
            effect,
            receipt_store: issuer,
            apply_effect: (request, apply) => {
              requests.push(request);
              expect(inspect(request)?.binding.repository).toEqual(repository.repository);
              return broker ? broker(request, apply) : apply();
            },
          },
          callback,
        ),
      ),
  };
}

describe.each(['artifact', 'certification'] as const)('%s protected host adapter', (kind) => {
  it('uses a fresh single-use token and does not expose it to the callback', async () => {
    const f = await harness(kind);
    expect(Object.isFrozen(f.adapter)).toBe(true);
    const results = await f.run(() =>
      [1, 2].map((value) =>
        f.adapter.invokeSink(() => {
          const request = f.requests.at(-1);
          if (!request) throw Error('broker request missing');
          expect(f.inspect(request)).toBeUndefined();
          return value;
        }, f.owner),
      ),
    );
    expect(results).toEqual([1, 2]);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.arguments[0]).not.toBe(f.requests[1]?.arguments[0]);
    for (const request of f.requests) expect(f.inspect(request)).toBeUndefined();
  });

  it('refuses a callback replay within the same broker invocation', async () => {
    let callbacks = 0;
    const f = await harness(kind, (_request, apply) => {
      const value = apply();
      expect(() => apply()).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      return value;
    });
    expect(
      await f.run(() =>
        f.adapter.invokeSink(() => {
          callbacks += 1;
          return 'once';
        }, f.owner),
      ),
    ).toBe('once');
    expect(callbacks).toBe(1);
  });

  it('invalidates the token when a broker throws before invoking the callback', async () => {
    let escaped: (() => unknown) | undefined;
    let callbacks = 0;
    const failure = Error('broker refusal');
    const f = await harness(kind, (_request, apply) => {
      escaped = apply;
      throw failure;
    });
    await expect(
      f.run(() =>
        f.adapter.invokeSink(() => {
          callbacks += 1;
        }, f.owner),
      ),
    ).rejects.toBe(failure);
    if (!escaped) throw Error('missing captured broker callback');
    expect(escaped).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    expect(callbacks).toBe(0);
    for (const request of f.requests) expect(f.inspect(request)).toBeUndefined();
  });

  it('refuses absent scope, read authority, and a different action', async () => {
    const f = await harness(kind);
    let callbacks = 0;
    const invoke = () =>
      f.adapter.invokeSink(() => {
        callbacks += 1;
      }, f.owner);
    expect(invoke).toThrow('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
    await expect(f.run(invoke, undefined, 'read')).rejects.toThrow(
      'AUTHORITY_READ_ACTION_MUTATION_FORBIDDEN',
    );
    await expect(f.run(invoke, 'release export')).rejects.toThrow(
      'AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH',
    );
    expect(callbacks).toBe(0);
    expect(f.requests).toHaveLength(0);
  });

  it('rejects forged owners and owners for a different sink kind', async () => {
    const f = await harness(kind);
    let callbacks = 0;
    for (const owner of [
      {},
      createProtectedReleaseSinkOwner(
        kind === 'artifact' ? 'certification' : 'artifact',
        'expected-sink',
      ),
    ])
      await expect(
        f.run(() =>
          f.adapter.invokeSink(() => {
            callbacks += 1;
          }, owner),
        ),
      ).rejects.toThrow('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
    expect(callbacks).toBe(0);
  });

  it('does not accept fabricated or copied operation tokens', async () => {
    const inspect =
      kind === 'artifact' ? protectedArtifactSinkHostEffect : protectedReleaseHostEffect;
    const f = await harness(kind, (request, apply) => {
      expect(inspect(request)).toBeDefined();
      for (const token of [null, 'token', {}, { ...Object(request.arguments[0]) }])
        expect(inspect({ ...request, arguments: [token] })).toBeUndefined();
      expect(inspect({ ...request, symbol: 'different-operation' })).toBeUndefined();
      expect(inspect({ ...request, kind: 'filesystem' })).toBeUndefined();
      return apply();
    });
    await f.run(() => f.adapter.invokeSink(() => 'result', f.owner));
    const request = f.requests[0];
    if (!request) throw Error('broker request missing');
    expect(inspect(request)).toBeUndefined();
  });

  it('captures binding identity before the caller mutates its input', async () => {
    const f = await harness(kind);
    f.artifactBinding.repository.commit = 'd'.repeat(40);
    f.certificationBinding.repository.commit = 'd'.repeat(40);
    expect(await f.run(() => f.adapter.invokeSink(() => 'original-binding', f.owner))).toBe(
      'original-binding',
    );
  });
});

it('binds artifact owners to the exact sink id', async () => {
  const f = await harness('artifact');
  await expect(
    f.run(() =>
      f.adapter.invokeSink(
        () => 'must not run',
        createProtectedReleaseSinkOwner('artifact', 'other-sink'),
      ),
    ),
  ).rejects.toThrow('AUTHORITY_PROTECTED_SINK_OWNER_INVALID');
});
