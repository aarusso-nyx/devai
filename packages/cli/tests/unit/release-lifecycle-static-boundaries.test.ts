import { describe, expect, it, vi } from 'vitest';

describe('release lifecycle static command boundaries', () => {
  it('exports the exact immutable command identities and descriptions', async () => {
    vi.resetModules();
    const lifecycle = await import('../../src/commands/release/lifecycle.js');
    expect([
      lifecycle.releasePlan,
      lifecycle.releasePreflight,
      lifecycle.releaseCertify,
      lifecycle.releasePrepare,
      lifecycle.releaseExport,
      lifecycle.releaseEvidencePublish,
      lifecycle.releasePublish,
      lifecycle.releaseOfflineVerify,
      lifecycle.releaseResume,
    ]).toEqual([
      expect.objectContaining({
        name: 'release plan',
        description: 'Resolve the deterministic nine-action release plan and emit its receipt.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release preflight',
        description: 'Run the cheap mandatory floor and bind a passing plan receipt.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release certify',
        description: 'Run the selected candidate-bound certification DAG.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release prepare',
        description: 'Prepare deterministic packages, manifests, and software bills of materials.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release export',
        description: 'Export release evidence through the authorized verifier-provider boundary.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release evidence-publish',
        description: 'Publish exact offline-verified evidence with one-time Owner authorization.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release publish',
        description: 'Dispatch publication through the protected workflow boundary.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release offline-verify',
        description:
          'Verify exported artifacts without network access and emit a deterministic receipt.',
        authority: 'release_controller',
      }),
      expect.objectContaining({
        name: 'release resume',
        description:
          'Observe and reconcile the release lifecycle without executing the next action.',
        authority: 'release_controller',
      }),
    ]);
  });
});
