// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-018
// Public-boundary acceptance: an adopter's validated CI economy policy is
// transferred under its exact project key during deterministic materialization.
import { describe, expect, it } from 'vitest';
import { resolveAdopterPolicyMaterialization } from '../../src/services/adopter-policy.js';

describe('adopter policy CI economy boundary', () => {
  it('materializes the exact policy-owned CI economy object into project bytes', () => {
    const ciEconomy = {
      profile: 'gate-staged',
      local_evidence: {
        required_jobs: ['unit'],
        allowed_platforms: ['linux/amd64'],
      },
    } as const;

    const resolved = resolveAdopterPolicyMaterialization({
      policy: {
        schemaVersion: '1.0.0',
        policy_id: 'fixture.adopter-policy',
        policy_version: '1.0.0',
        ci_economy: ciEconomy,
      },
      currentProject: {
        schemaVersion: '1.0.0',
        project_type: 'framework',
      },
      frameworkVersion: '1.5.0',
    });

    expect(JSON.parse(resolved.get('.devai/config/project.json') ?? 'null')).toEqual({
      schemaVersion: '1.0.0',
      project_type: 'framework',
      ci_economy: ciEconomy,
      devai_version: '1.5.0',
    });
  });
});
