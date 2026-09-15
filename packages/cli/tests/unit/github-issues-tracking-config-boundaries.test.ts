// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';

const authorityState = vi.hoisted(() => ({
  policy: 'actual' as 'actual' | 'missing' | 'invalid',
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  const isTrackingPolicy = (path: unknown): boolean =>
    String(path).endsWith('/law/policy/github-issues-tracking.json');
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]): boolean {
      if (authorityState.policy === 'missing' && isTrackingPolicy(path)) return false;
      return actual.existsSync(path);
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: unknown): unknown {
      const value = actual.readFileSync(path, options as never);
      if (authorityState.policy !== 'invalid' || !isTrackingPolicy(path)) return value;
      const policy = JSON.parse(String(value)) as {
        defaults: { workflow: { permissions: { contents: string } } };
      };
      policy.defaults.workflow.permissions.contents = 'write';
      return JSON.stringify(policy);
    },
  };
});

import {
  loadTrackingPolicyDefaults,
  normalizeTrackingRepository,
  TrackingConfigError,
  trackingDefaultsDigest,
  verifyTrackingBinding,
  type BoundTrackingConfig,
  type TrackingPolicyDefaults,
} from '../../src/services/github-issues-tracking/config.js';
import {
  renderTrackingWorkflow,
  trackingWorkflowDigest,
} from '../../src/services/github-issues-tracking/workflow.js';

function boundConfig(): BoundTrackingConfig {
  const defaults = loadTrackingPolicyDefaults();
  return {
    schemaVersion: '1.0.0',
    id: 'github-issues-tracking',
    binding: {
      repository: 'example/adopter',
      repository_id: 'adopter',
      package_version: '1.5.0',
      bound_at: '2026-09-10T12:00:00.000Z',
      bound_by_role: 'architect',
    },
    defaults,
    digests: {
      policy_defaults_sha256: trackingDefaultsDigest(defaults),
      workflow_sha256: trackingWorkflowDigest(renderTrackingWorkflow(defaults)),
    },
  };
}

function capturedError(operation: () => unknown): TrackingConfigError {
  try {
    operation();
    throw new Error('operation unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(TrackingConfigError);
    return error as TrackingConfigError;
  }
}

afterEach(() => {
  authorityState.policy = 'actual';
});

describe('GitHub Issues tracking configuration boundaries', () => {
  it('preserves exact configuration error identities', () => {
    expect(capturedError(() => normalizeTrackingRepository('not-a-repository'))).toMatchObject({
      name: 'TrackingConfigError',
      message: 'TRACKING_TARGET_REPOSITORY_INVALID',
      code: 'TRACKING_TARGET_REPOSITORY_INVALID',
    });

    authorityState.policy = 'missing';
    expect(capturedError(() => loadTrackingPolicyDefaults())).toMatchObject({
      name: 'TrackingConfigError',
      message: 'TRACKING_POLICY_MISSING',
      code: 'TRACKING_POLICY_MISSING',
    });

    authorityState.policy = 'invalid';
    expect(capturedError(() => loadTrackingPolicyDefaults())).toMatchObject({
      name: 'TrackingConfigError',
      message: 'TRACKING_POLICY_INVALID',
      code: 'TRACKING_POLICY_INVALID',
    });
  });

  it('returns the complete policy-drift finding and no unrelated findings', () => {
    const config = boundConfig();
    const driftedDefaults: TrackingPolicyDefaults = {
      ...config.defaults,
      retry: {
        ...config.defaults.retry,
        max_attempts: config.defaults.retry.max_attempts + 1,
      },
    };
    const drifted: BoundTrackingConfig = {
      ...config,
      defaults: driftedDefaults,
      digests: {
        ...config.digests,
        policy_defaults_sha256: canonicalSha256(driftedDefaults),
      },
    };

    expect(
      verifyTrackingBinding({
        repoRoot: process.cwd(),
        config: drifted,
        workflow: renderTrackingWorkflow(config.defaults),
      }),
    ).toEqual([
      {
        code: 'TRACKING_BINDING_POLICY_DRIFT',
        detail: 'bound defaults differ from law/policy/github-issues-tracking.json',
      },
    ]);
  });

  it('returns the complete embedded-default digest finding and no unrelated findings', () => {
    const config = boundConfig();
    const mismatched: BoundTrackingConfig = {
      ...config,
      digests: {
        ...config.digests,
        policy_defaults_sha256: '0'.repeat(64),
      },
    };

    expect(
      verifyTrackingBinding({
        repoRoot: process.cwd(),
        config: mismatched,
        workflow: renderTrackingWorkflow(config.defaults),
      }),
    ).toEqual([
      {
        code: 'TRACKING_BINDING_DIGEST_MISMATCH',
        detail: 'recorded defaults digest does not match the embedded defaults',
      },
    ]);
  });
});
