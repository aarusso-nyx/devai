import { describe, expect, it, vi } from 'vitest';
import {
  createReleaseCertificationProvider,
  isProtectedReleaseCertificationProvider,
} from '../../src/services/release-lifecycle-certification.js';

const protectedProvider = {
  kind: 'protected-certification-provider-v3',
  certify: vi.fn(),
};
const evidenceSink = {
  kind: 'certification-evidence-sink-v3',
  protocol: 'two-phase-content-addressed',
  begin: vi.fn(),
  readCertificationEvidenceReceipt: vi.fn(),
  readCertificationOutputClosure: vi.fn(),
  readGeneratedBlob: vi.fn(),
};
const contentSource = { readGitObject: vi.fn(), readGitBlob: vi.fn() };

describe('release certification provider construction', () => {
  it('reports the exact missing protected capability', () => {
    expect(() => createReleaseCertificationProvider({ provider: undefined } as never)).toThrow(
      'release-certification-provider-unavailable',
    );
    expect(() =>
      createReleaseCertificationProvider({
        provider: protectedProvider,
        evidence_sink: undefined,
      } as never),
    ).toThrow('release-certification-evidence-sink-unavailable');
    expect(() =>
      createReleaseCertificationProvider({
        provider: protectedProvider,
        evidence_sink: evidenceSink,
        content_source: undefined,
      } as never),
    ).toThrow('release-prepare-git-tree-membership-invalid');
  });

  it('brands a provider only after all construction capabilities are present', () => {
    const provider = createReleaseCertificationProvider({
      provider: protectedProvider,
      evidence_sink: evidenceSink,
      content_source: contentSource,
      task_policies: [],
    } as never);
    expect(isProtectedReleaseCertificationProvider(provider)).toBe(true);
    expect(isProtectedReleaseCertificationProvider(() => ({ outcome: 'failure' }))).toBe(false);
  });

  it('coerces native provider-boundary failures to the stable ledger code', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const provider = createReleaseCertificationProvider({
        provider: protectedProvider,
        evidence_sink: evidenceSink,
        content_source: contentSource,
        task_policies: [],
      } as never);
      await expect(
        provider({ action_id: 'release certify', candidate_locator: null } as never),
      ).resolves.toEqual({
        outcome: 'failure',
        code: 'release-certification-generated-output-untrusted',
      });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });
});
