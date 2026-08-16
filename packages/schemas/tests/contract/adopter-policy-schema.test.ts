import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const attestedRc = {
  profile: 'rc',
  transport: 'protected-tag-v1',
  tag_prefix: 'devai-local-evidence/',
  binding: 'exact-tree',
  required_check: 'verified-local-rc',
  failure_mode: 'fail-closed',
  local_only_nodes: ['test:mutation'],
};

describe('adopter policy schema', () => {
  it('accepts the canonical attested RC policy and rejects a remote fallback', () => {
    const validate = getValidator('adopter-policy.schema.json');
    const policy = {
      schemaVersion: '1.0.0',
      policy_id: 'stynx.devai-adoption',
      policy_version: '1.1.0',
      ci_economy: { attested_rc: attestedRc },
    };

    expect(validate(policy), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...policy,
        ci_economy: {
          attested_rc: { ...attestedRc, failure_mode: 'remote-fallback' },
        },
      }),
    ).toBe(false);
  });
});
