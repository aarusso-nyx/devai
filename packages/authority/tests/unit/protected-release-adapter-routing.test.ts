import { describe, expect, it, vi } from 'vitest';
import { protectedReleaseBoundaryAdapterId } from '../../src/boundaries/index.js';

const lanes = [
  [
    'devai-protected-certification-provider-v3',
    'execute',
    'release preflight',
    'protected-certification-provider-v3',
  ],
  [
    'devai-protected-certification-provider-v3',
    'execute',
    'release certify',
    'protected-certification-provider-v3',
  ],
  [
    'trusted-certification-evidence-sink-v1',
    'write',
    'release certify',
    'trusted-certification-evidence-sink-v1',
  ],
  ['trusted-artifact-sink-v3', 'write', 'release prepare', 'trusted-artifact-sink-v3'],
] as const;

function fixture(lane: (typeof lanes)[number]) {
  const binding: Record<string, unknown> = {
    action_id: lane[2],
    authority_repository_id: 'fixture-authority',
    expected_release_repository_id: 'owner/repository',
    origin_url: 'https://github.com/owner/repository.git',
    repository: { id: 'owner/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    plan_receipt_digest_sha256: 'c'.repeat(64),
    ...(lane[2] === 'release prepare'
      ? { pack_spec_digest_sha256: 'd'.repeat(64), sink_id: 'fixture-sink' }
      : { task_policy_digest_sha256: 'd'.repeat(64), helper_identity_sha256: 'e'.repeat(64) }),
  };
  return {
    kind: 'remote',
    system_id: lane[0],
    endpoint_id: 'host',
    operation_id: lane[1],
    publication: false,
    protected_operation_id: 'fixture-operation',
    protected_release_binding: binding,
  };
}

for (const lane of lanes)
  describe(`${lane[0]} ${lane[2]} exact routing`, () => {
    it('recognizes only the exact protected projection', () => {
      expect(protectedReleaseBoundaryAdapterId(fixture(lane))).toBe(lane[3]);
    });
    it.each([
      ['kind', 'fs'],
      ['system_id', 'arbitrary-service'],
      ['endpoint_id', 'remote-host'],
      ['publication', true],
      ['publication', undefined],
      ['operation_id', 'arbitrary-operation'],
      ['protected_operation_id', ''],
      ['protected_operation_id', undefined],
    ])('refuses substituted target field %s', (key, value) => {
      expect(
        protectedReleaseBoundaryAdapterId({ ...fixture(lane), [String(key)]: value }),
      ).toBeUndefined();
    });
    it('requires every protected binding field and rejects additional authority', () => {
      const target = fixture(lane);
      for (const key of Object.keys(target.protected_release_binding)) {
        const changed = structuredClone(target);
        Reflect.deleteProperty(changed.protected_release_binding, key);
        expect(protectedReleaseBoundaryAdapterId(changed), key).toBeUndefined();
      }
      expect(
        protectedReleaseBoundaryAdapterId({
          ...target,
          protected_release_binding: { ...target.protected_release_binding, allow_publish: true },
        }),
      ).toBeUndefined();
    });
    it.each([
      'plan_receipt_digest_sha256',
      ...(lane[2] === 'release prepare'
        ? ['pack_spec_digest_sha256']
        : ['task_policy_digest_sha256', 'helper_identity_sha256']),
    ])('rejects malformed protected digest %s', (key) => {
      for (const value of [null, 1, 'a'.repeat(63), 'a'.repeat(65), 'G'.repeat(64)]) {
        const target = fixture(lane);
        target.protected_release_binding[key] = value;
        expect(protectedReleaseBoundaryAdapterId(target)).toBeUndefined();
      }
    });
    it.each(['origin_url', 'expected_release_repository_id', 'action_id'])(
      'refuses binding substitution %s',
      (key) => {
        const target = fixture(lane);
        target.protected_release_binding[key] =
          key === 'origin_url' ? 'https://untrusted.example/owner/repository.git' : 'unrelated';
        expect(protectedReleaseBoundaryAdapterId(target)).toBeUndefined();
      },
    );
    it('does not execute accessor bindings while deciding a privileged adapter', () => {
      const target = fixture(lane),
        getter = vi.fn(() => {
          throw new Error('unexpected getter');
        });
      Object.defineProperty(target.protected_release_binding, 'action_id', {
        get: getter,
        enumerable: true,
      });
      expect(protectedReleaseBoundaryAdapterId(target)).toBeUndefined();
      expect(getter).not.toHaveBeenCalled();
    });
  });
