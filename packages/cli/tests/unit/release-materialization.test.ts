import { describe, expect, it } from 'vitest';
import { resolveAdopterPolicyMaterialization } from '../../src/services/adopter-policy.js';

const basePolicy = {
  schemaVersion: '1.0.0',
  policy_id: 'example.adoption',
  policy_version: '1.0.0',
} as const;

const currentProject = {
  schemaVersion: '1.0.0',
  project_type: 'framework',
} as const;

const releaseVerification = {
  schemaVersion: '1.0.0',
  policy_id: 'example.release',
  policy_version: '1.0.0',
  release_unit: '@example/package',
  version_source: 'package.json',
  default_support: 'current',
  capability_tasks: { lint: ['lint'] },
  risk_capabilities: {},
  mutation_roster: [],
} as const;

describe('release verification adopter materialization', () => {
  it('does not add release configuration for existing adopters that did not opt in', () => {
    const resolved = resolveAdopterPolicyMaterialization({
      policy: basePolicy,
      currentProject,
      frameworkVersion: '1.4.0',
    });
    expect(resolved.has('.devai/config/release-verification.json')).toBe(false);
  });

  it('materializes exact package-owned release policy bytes when explicitly declared', () => {
    const resolved = resolveAdopterPolicyMaterialization({
      policy: { ...basePolicy, release_verification: releaseVerification },
      currentProject,
      frameworkVersion: '1.4.0',
    });
    expect(JSON.parse(resolved.get('.devai/config/release-verification.json') ?? 'null')).toEqual(
      releaseVerification,
    );
    expect(JSON.parse(resolved.get('.devai/config/project.json') ?? 'null')).toMatchObject({
      project_type: 'framework',
      devai_version: '1.4.0',
    });
  });
});
