// Invariants: INV-SEC-002
// ADR-REL-0034 IA-004/005: real journal reducer, offline approved-host controls.
// These fixtures never authenticate a remote deployment or a live journal.
import { describe, expect, it, vi } from 'vitest';
const { publishPages } = await import('../../scripts/process/pages-publication.mjs');
const identity = () => ({
  repository: 'aarusso-nyx/devai',
  mode: 'site-only',
  tag: 'v1.8.0',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  siteSha256: 'c'.repeat(64),
  sourceRun: '101',
  controlCommit: 'd'.repeat(40),
});
function fixture(phase: 'intent' | 'submitted' | 'verified' | null = null) {
  const record = {
    schemaVersion: '1.0.0',
    identity: identity(),
    intentId: '11',
    artifactId: '21',
    pagesId: phase === 'intent' ? null : 'original-pages-id',
    phase,
  };
  const controls = {
    readJournal: vi.fn(async () => ({
      complete: true,
      migrationAudited: true,
      records: phase === null ? [] : [record],
    })),
    readEffect: vi.fn(async () => 'confirmed-missing'),
    createIntent: vi.fn(async () => '11'),
    submit: vi.fn(async () => 'new-pages-id'),
    recordSubmitted: vi.fn(async () => {}),
    observe: vi.fn(async () => 'succeeded'),
    verifyLiveBytes: vi.fn(async () => {}),
    recordVerified: vi.fn(async () => {}),
  };
  return { record, controls };
}
describe('Pages cancellation and exact journal resume (offline)', () => {
  it('resumes a known submission using its original Pages ID and artifact despite a rerun argument', async () => {
    const { controls } = fixture('submitted');
    const result = await publishPages({ identity: identity(), artifactId: '999', controls });
    expect(result).toMatchObject({
      outcome: 'verified',
      pagesId: 'original-pages-id',
      buildInvocations: 0,
    });
    expect(controls.observe).toHaveBeenCalledWith('original-pages-id');
    expect(controls.recordVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: '21',
        pagesId: 'original-pages-id',
        phase: 'verified',
      }),
    );
    expect(controls.submit).not.toHaveBeenCalled();
    expect(controls.createIntent).not.toHaveBeenCalled();
  });
  it.each(['matching', 'confirmed-missing', 'unknown'])(
    'preserves an unknown intent even when observed effect is %s',
    async (effect) => {
      const { controls } = fixture('intent');
      controls.readEffect.mockResolvedValue(effect);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
      expect(controls.submit).not.toHaveBeenCalled();
      expect(controls.recordVerified).not.toHaveBeenCalled();
    },
  );
  it.each(['cancelled', 'failed', 'unknown'])(
    'cannot promote %s observation to a verified record',
    async (outcome) => {
      const { controls } = fixture('submitted');
      controls.observe.mockResolvedValue(outcome);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_DEPLOYMENT_UNRESOLVED');
      expect(controls.recordVerified).not.toHaveBeenCalled();
      expect(controls.submit).not.toHaveBeenCalled();
    },
  );
  it('propagates cancellation between observation and byte verification without manufacturing verified history', async () => {
    const { controls } = fixture('submitted');
    controls.verifyLiveBytes.mockRejectedValue(new Error('offline cancellation'));
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('offline cancellation');
    expect(controls.recordVerified).not.toHaveBeenCalled();
  });
  it('preserves an independently verified predecessor across interruption', async () => {
    const { record, controls } = fixture('verified');
    controls.readEffect.mockResolvedValue('matching');
    expect(await publishPages({ identity: identity(), artifactId: '21', controls })).toMatchObject({
      outcome: 'no-op',
      buildInvocations: 0,
    });
    expect(record.phase).toBe('verified');
    expect(controls.recordVerified).not.toHaveBeenCalled();
    expect(controls.submit).not.toHaveBeenCalled();
  });
  it('refuses a cross-run predecessor rather than duplicating publication', async () => {
    const { record, controls } = fixture('submitted');
    record.identity.sourceRun = '100';
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('PAGES_PUBLICATION_JOURNAL_INVALID');
    expect(controls.submit).not.toHaveBeenCalled();
    expect(controls.recordVerified).not.toHaveBeenCalled();
  });
  it('requires durable intent before the irreversible submission', async () => {
    const { controls } = fixture();
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('PAGES_PUBLICATION_INTENT_NOT_DURABLE');
    expect(controls.submit).not.toHaveBeenCalled();
  });
  it('refuses incomplete or unaudited journal snapshots', async () => {
    for (const journal of [
      { complete: false, migrationAudited: true, records: [] },
      { complete: true, migrationAudited: false, records: [] },
    ]) {
      const { controls } = fixture();
      controls.readJournal.mockResolvedValue(journal);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_JOURNAL_UNKNOWN');
      expect(controls.submit).not.toHaveBeenCalled();
    }
  });
});

// INV-SEC-002 exact release identity clause only. The site-only concurrency/
// interruption cases above need separate Architect trace adjudication.
describe('release publication component binds exact candidate/tree identities (offline)', () => {
  it.each(['commit', 'tree', 'controlCommit', 'manifestSha256'] as const)(
    'refuses a near-match release %s before resubmission',
    async (field) => {
      const { record, controls } = fixture('submitted');
      const release = {
        repository: 'aarusso-nyx/devai',
        tag: 'v1.8.0',
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        controlCommit: 'd'.repeat(40),
        siteSha256: 'c'.repeat(64),
        manifestSha256: 'f'.repeat(64),
        rehearsalRun: '101',
        rehearsalAttempt: '1',
      };
      const near = { ...release, [field]: 'e'.repeat(field === 'manifestSha256' ? 64 : 40) };
      controls.readJournal.mockResolvedValue({
        complete: true,
        migrationAudited: true,
        records: [{ ...record, identity: near }],
      } as never);
      await expect(publishPages({ identity: release, artifactId: '21', controls })).rejects.toThrow(
        'PAGES_PUBLICATION_JOURNAL_INVALID',
      );
      expect(controls.submit).not.toHaveBeenCalled();
      expect(controls.recordVerified).not.toHaveBeenCalled();
    },
  );
});
