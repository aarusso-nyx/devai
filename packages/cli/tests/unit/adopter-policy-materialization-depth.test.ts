import { describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import { resolveCanonicalPolicyContent } from '@devai-nyx/skills';
import {
  isJsonObject,
  jsonBytes,
  resolveAdopterPolicyMaterialization,
  type AdopterPolicyMaterializationSources,
} from '../../src/services/adopter-policy.js';

const basePolicy = {
  schemaVersion: '1.0.0',
  policy_id: 'fixture.adopter-policy',
  policy_version: '1.0.0',
} as const;

const currentProject = {
  schemaVersion: '1.0.0',
  project_type: 'framework',
} as const;

const releaseVerification = {
  schemaVersion: '1.0.0',
  policy_id: 'fixture.release-profile',
  policy_version: '1.0.0',
  release_unit: '@fixture/package',
  version_source: 'package.json',
  default_support: 'current',
  capability_tasks: { lint: ['lint'] },
  risk_capabilities: {},
  mutation_roster: [],
} as const;

function sourcesWithReleaseBytes(bytes: string): AdopterPolicyMaterializationSources {
  return {
    getValidator,
    readPolicy: (file) =>
      file === 'release-verification.json' ? bytes : resolveCanonicalPolicyContent(file),
  };
}

describe('adopter policy materialization depth', () => {
  it('rejects arrays and null as mergeable policy objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  it('refuses client domains that collide with immutable framework policy', () => {
    expect(() =>
      resolveAdopterPolicyMaterialization({
        policy: { ...basePolicy, domains: { client: ['AUTH'] } },
        currentProject,
        frameworkVersion: '1.5.0',
      }),
    ).toThrow('ADOPTER_POLICY_DOMAIN_COLLISION:AUTH');
  });

  it('sorts distinct client domains into deterministic materialized bytes', () => {
    const resolved = resolveAdopterPolicyMaterialization({
      policy: { ...basePolicy, domains: { client: ['ZETA', 'ALPHA'] } },
      currentProject,
      frameworkVersion: '1.5.0',
    });

    expect(JSON.parse(resolved.get('.devai/config/domains.json') ?? 'null')).toMatchObject({
      client: ['ALPHA', 'ZETA'],
    });
  });

  it('refuses a materialized project whose framework version violates the project schema', () => {
    expect(() =>
      resolveAdopterPolicyMaterialization({
        policy: basePolicy,
        currentProject,
        frameworkVersion: 'not-a-semver',
      }),
    ).toThrow(/^ADOPTER_POLICY_PROJECT_INVALID:/u);
  });

  it('falls back to deterministic bytes when optional canonical policy bytes are malformed', () => {
    const resolved = resolveAdopterPolicyMaterialization(
      {
        policy: { ...basePolicy, release_verification: releaseVerification },
        currentProject,
        frameworkVersion: '1.5.0',
      },
      sourcesWithReleaseBytes('{'),
    );

    expect(resolved.get('.devai/config/release-verification.json')).toBe(
      jsonBytes(releaseVerification),
    );
  });

  it('preserves optional canonical policy bytes when their parsed value is unchanged', () => {
    const canonicalBytes = JSON.stringify(releaseVerification);
    const resolved = resolveAdopterPolicyMaterialization(
      {
        policy: { ...basePolicy, release_verification: releaseVerification },
        currentProject,
        frameworkVersion: '1.5.0',
      },
      sourcesWithReleaseBytes(canonicalBytes),
    );

    expect(resolved.get('.devai/config/release-verification.json')).toBe(canonicalBytes);
  });
});
