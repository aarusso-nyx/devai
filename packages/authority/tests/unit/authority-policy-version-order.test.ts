import { describe, expect, it } from 'vitest';
import {
  expectFailure,
  expectSuccess,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Loading must compare complete policy versions without numeric precision loss.
const orderedPairs = [
  ['1.0.0', '2.0.0'],
  ['1.9.9', '1.10.0'],
  ['1.0.9', '1.0.10'],
  ['9007199254740992.0.0', '9007199254740993.0.0'],
  ['1.9007199254740992.0', '1.9007199254740993.0'],
  ['1.0.9007199254740992', '1.0.9007199254740993'],
  ['1.0.0-alpha', '1.0.0-alpha.1'],
  ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
  ['1.0.0-alpha.beta', '1.0.0-beta'],
  ['1.0.0-beta', '1.0.0-beta.2'],
  ['1.0.0-beta.2', '1.0.0-beta.11'],
  ['1.0.0-beta.11', '1.0.0-rc.1'],
  ['1.0.0-rc.1', '1.0.0'],
  ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
] as const;

async function load(version: string, minimum: string) {
  const api = await runtimeApi();
  const plant = makePolicyPlant({ policyVersion: version });
  return api.loadAuthorityPolicy(
    { document: plant.document },
    {
      ...plant.deps,
      expected_minimum_policy_version: minimum,
    },
  );
}

describe('authority policy downgrade prevention', () => {
  it.each(orderedPairs)('refuses %s below %s and accepts the reverse', async (lower, higher) => {
    expectFailure(await load(lower, higher), 'refused', 'AUTHORITY_POLICY_DOWNGRADE');
    const accepted = expectSuccess<{ provenance: { policy_version: string } }>(
      await load(higher, lower),
    );
    expect(accepted.provenance.policy_version).toBe(higher);
  });

  it.each(['1.0.0', '1.0.0-alpha.1', '1.0.0+build.007', '1.0.0-alpha.1+build.007'])(
    'accepts exact minimum %s and retains its complete identity',
    async (version) => {
      const accepted = expectSuccess<{ provenance: { policy_version: string } }>(
        await load(version, version),
      );
      expect(accepted.provenance.policy_version).toBe(version);
    },
  );

  it.each([
    ['1.0.0+aaa', '1.0.0+zzz'],
    ['1.0.0-alpha+zzz', '1.0.0-alpha+aaa'],
  ])('does not assign precedence to build metadata %s versus %s', async (version, minimum) => {
    expectSuccess(await load(version, minimum));
    expectSuccess(await load(minimum, version));
  });

  it.each([
    '',
    '1',
    '1.0',
    '01.0.0',
    '1.00.0',
    '1.0.00',
    '1.0.0-01',
    '1.0.0-alpha.01',
    '1.0.0-',
    '1.0.0+',
    '1.0.0-alpha..1',
    '1.0.0+build..1',
    'v1.0.0',
    ' 1.0.0',
    '1.0.0 ',
  ])('refuses malformed policy version %s before downgrade comparison', async (version) => {
    expectFailure(await load(version, '1.0.0'), 'refused', 'AUTHORITY_POLICY_SEMANTIC_INVALID');
  });
});
