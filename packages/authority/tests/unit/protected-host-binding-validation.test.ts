import { describe, expect, it, vi } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseHostAdapter,
} from '../../src/boundaries/host-effects.js';

for (const kind of ['artifact', 'certification'] as const) {
  const create = (binding: Record<string, unknown>) =>
    kind === 'artifact'
      ? createProtectedArtifactSinkAdapter(
          binding as unknown as Parameters<typeof createProtectedArtifactSinkAdapter>[0],
        )
      : createProtectedReleaseHostAdapter(
          binding as unknown as Parameters<typeof createProtectedReleaseHostAdapter>[0],
        );
  const fixture = () => ({
    action_id: kind === 'artifact' ? 'release prepare' : 'release certify',
    repository: { id: 'owner/repository', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    plan_receipt_digest_sha256: 'c'.repeat(64),
    ...(kind === 'artifact'
      ? { pack_spec_digest_sha256: 'd'.repeat(64), sink_id: 'fixture-sink' }
      : { task_policy_digest_sha256: 'd'.repeat(64), helper_identity_sha256: 'e'.repeat(64) }),
  });
  describe(`${kind} installed host binding validation`, () => {
    it.each([40, 64])('accepts exact matching %s-character Git identities', (length) => {
      const binding = fixture();
      binding.repository.commit = 'a'.repeat(length);
      binding.repository.tree = 'b'.repeat(length);
      expect(() => create(binding)).not.toThrow();
    });
    it('requires every declared key and rejects extra top-level or repository authority', () => {
      for (const key of Object.keys(fixture())) {
        const binding = fixture();
        Reflect.deleteProperty(binding, key);
        expect(() => create(binding), key).toThrow();
      }
      expect(() => create({ ...fixture(), publish: true })).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
      const binding = fixture();
      Reflect.set(binding.repository, 'remote', 'unapproved');
      expect(() => create(binding)).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    });
    it.each([{ value: '' }, { value: 17 }, { value: null }, { value: {} }])(
      'rejects a non-string or empty repository ID $value',
      ({ value }) => {
        const binding = fixture();
        Reflect.set(binding.repository, 'id', value);
        expect(() => create(binding)).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      },
    );
    it.each(['commit', 'tree'] as const)('requires the full, lowercase %s identity', (key) => {
      for (const value of [
        'a'.repeat(39),
        'a'.repeat(41),
        'G'.repeat(40),
        'prefix' + 'a'.repeat(40),
        'a'.repeat(40) + 'suffix',
        'a'.repeat(64),
      ]) {
        const binding = fixture();
        binding.repository[key] = value;
        expect(() => create(binding), value).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      }
    });
    it('rejects every malformed protected digest independently', () => {
      for (const key of Object.keys(fixture()).filter((key) => key.endsWith('_sha256'))) {
        for (const value of [
          'a'.repeat(63),
          'a'.repeat(65),
          'G'.repeat(64),
          'x' + 'a'.repeat(64),
          'a'.repeat(64) + 'x',
        ]) {
          const binding = fixture();
          Reflect.set(binding, key, value);
          expect(() => create(binding), key).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        }
      }
    });
    it.each(['commit', 'tree'] as const)(
      'rejects coercible %s objects without executing conversion hooks',
      (key) => {
        const binding = fixture();
        const toString = vi.fn(() => 'a'.repeat(40));
        Reflect.set(binding.repository, key, { length: 40, toString });
        expect(() => create(binding)).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        expect(toString).not.toHaveBeenCalled();
      },
    );

    it('rejects coercible digest objects without executing conversion hooks', () => {
      for (const key of Object.keys(fixture()).filter((key) => key.endsWith('_sha256'))) {
        const binding = fixture();
        const toString = vi.fn(() => 'a'.repeat(64));
        Reflect.set(binding, key, { toString });
        expect(() => create(binding), key).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        expect(toString).not.toHaveBeenCalled();
      }
    });

    it('does not accept an action from another release phase', () => {
      expect(() => create({ ...fixture(), action_id: 'release export' })).toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
    });
    if (kind === 'artifact') {
      it.each([{ value: '' }, { value: 123 }, { value: '../sink' }, { value: 'a'.repeat(401) }])(
        'rejects invalid sink identity $value',
        ({ value }) => {
          expect(() => create({ ...fixture(), sink_id: value })).toThrow(
            'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
          );
        },
      );
    }
  });
}
