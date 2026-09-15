import { describe, expect, it, vi } from 'vitest';
import {
  createReleaseOfflineVerifierProvider,
  type ReleaseOfflineProviderControls,
} from '../../src/services/release-offline-provider.js';
import type {
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
} from '../../src/services/release-lifecycle-execution.js';

function controls(): ReleaseOfflineProviderControls {
  return {
    candidate: { repository_id: 'fixture/repo', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    reader: {
      readArtifact: vi.fn(() => {
        throw new Error('unexpected artifact read');
      }),
    },
    dag: {
      identity: { source_commit: 'c'.repeat(40), archive_sha256: 'd'.repeat(64) },
      verify: vi.fn(() => {
        throw new Error('unexpected DAG call');
      }),
    },
    task_policies: [],
    trust_store: {},
    signer_id: 'fixture',
    verifier: {
      package_name: 'fixture',
      package_version: '1.0.0',
      registry: 'https://registry.invalid',
      integrity_sri: 'sha512-AA==',
      provenance_sha256: 'e'.repeat(64),
      source_commit: 'f'.repeat(40),
    },
    limits: {
      maximum_packages: 1,
      maximum_provider_result_bytes: 1024,
      maximum_transcript_bytes: 1024,
    },
    maximum_archive_bytes: 1024,
    maximum_total_bytes: 4096,
  };
}

describe('concrete offline provider control boundary', () => {
  it('refuses missing controls and unbounded resource declarations at construction', () => {
    const value = controls();
    expect(() =>
      createReleaseOfflineVerifierProvider({ ...value, maximum_total_bytes: Infinity }),
    ).toThrow();
    expect(() =>
      createReleaseOfflineVerifierProvider({ ...value, maximum_archive_bytes: 0 }),
    ).toThrow();
    expect(() =>
      createReleaseOfflineVerifierProvider({
        ...value,
        dag: { ...value.dag, identity: { ...value.dag.identity, archive_sha256: 'latest' } },
      }),
    ).toThrow();
    expect(() =>
      createReleaseOfflineVerifierProvider({
        ...value,
        task_policies: [
          { release_unit: 'duplicate', policy: {} },
          { release_unit: 'duplicate', policy: {} },
        ],
      }),
    ).toThrow();
  });
  it('refuses a fabricated validation context before reads or trusted kernel invocation', async () => {
    const value = controls();
    const provider = createReleaseOfflineVerifierProvider(value);
    await expect(
      provider({} as ReleaseLifecycleRequest, {} as ReleaseLifecycleStateV2, {
        kind: 'verified-release-offline-context',
      }),
    ).rejects.toThrow('release-offline-verification-context-invalid');
    expect(value.reader.readArtifact).not.toHaveBeenCalled();
    expect(value.dag.verify).not.toHaveBeenCalled();
  });
});
