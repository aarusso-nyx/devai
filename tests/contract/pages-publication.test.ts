import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
const { publishPages } = await import(
  pathToFileURL(resolve('scripts/process/pages-publication.mjs')).href
);
const identity = {
  repository: 'aarusso-nyx/devai',
  tag: 'v1.5.0',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  rehearsalRun: '123',
  rehearsalAttempt: '2',
  manifestSha256: 'c'.repeat(64),
  siteSha256: 'd'.repeat(64),
  controlCommit: 'e'.repeat(40),
};
function fixture() {
  const records: Record<string, unknown>[] = [];
  const events: string[] = [];
  const controls = {
    readJournal: vi.fn(async () => ({ complete: true, migrationAudited: true, records })),
    readEffect: vi.fn(async () => 'confirmed-missing'),
    createIntent: vi.fn(async () => {
      events.push('intent');
      records.push({
        schemaVersion: '1.0.0',
        identity,
        intentId: '9',
        artifactId: '45',
        pagesId: null,
        phase: 'intent',
      });
      return '9';
    }),
    submit: vi.fn(async () => {
      events.push('submit');
      return 'pages-17';
    }),
    recordSubmitted: vi.fn(async (record: Record<string, unknown>) => {
      events.push('submitted');
      records[0] = record;
    }),
    observe: vi.fn(async () => {
      events.push('observe');
      return 'succeeded';
    }),
    verifyLiveBytes: vi.fn(async () => {
      events.push('verify');
    }),
    recordVerified: vi.fn(async (record: Record<string, unknown>) => {
      events.push('verified');
      records[0] = record;
    }),
  };
  return { records, events, controls, args: { identity, artifactId: '45', controls } };
}
it('persists intent before submitting, then records the exact ID before observing and verifying', async () => {
  const f = fixture();
  expect(await publishPages(f.args)).toMatchObject({
    outcome: 'verified',
    pagesId: 'pages-17',
    buildInvocations: 0,
  });
  expect(f.events).toEqual(['intent', 'submit', 'submitted', 'observe', 'verify', 'verified']);
});
it('matching live bytes are a no-op with no publication writes', async () => {
  const f = fixture();
  f.controls.readEffect.mockResolvedValue('matching');
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op', buildInvocations: 0 });
  expect(f.events).toEqual([]);
});
it('a lost POST response leaves intent and blocks a second submission', async () => {
  const f = fixture();
  f.controls.submit.mockRejectedValue(new Error('connection lost'));
  await expect(publishPages(f.args)).rejects.toThrow('connection lost');
  await expect(publishPages(f.args)).rejects.toThrow('SUBMISSION_UNKNOWN');
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
});
it('a known interrupted submission resumes observation only', async () => {
  const f = fixture();
  f.controls.observe.mockResolvedValueOnce('pending');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
  expect(f.controls.observe).toHaveBeenLastCalledWith('pages-17');
});
it('failed persistence of the returned ID blocks automatic resubmission', async () => {
  const f = fixture();
  f.controls.recordSubmitted.mockRejectedValue(new Error('journal unavailable'));
  await expect(publishPages(f.args)).rejects.toThrow('journal unavailable');
  await expect(publishPages(f.args)).rejects.toThrow('SUBMISSION_UNKNOWN');
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
});
it('never marks completion when live byte verification fails', async () => {
  const f = fixture();
  f.controls.verifyLiveBytes.mockRejectedValue(new Error('hash mismatch'));
  await expect(publishPages(f.args)).rejects.toThrow('hash mismatch');
  expect(f.controls.recordVerified).not.toHaveBeenCalled();
});
it.each(['unknown', '404', 'failed'])('does not infer missing effects from %s', async (effect) => {
  const f = fixture();
  f.controls.readEffect.mockResolvedValue(effect);
  await expect(publishPages(f.args)).rejects.toThrow('EFFECT_UNKNOWN');
  expect(f.events).toEqual([]);
});
it.each([
  'commit',
  'tree',
  'manifestSha256',
  'siteSha256',
  'rehearsalRun',
  'rehearsalAttempt',
  'controlCommit',
])('rejects journal substitution of %s before any effect', async (key) => {
  const f = fixture();
  f.records.push({
    schemaVersion: '1.0.0',
    identity: { ...identity, [key]: '1' },
    intentId: '9',
    artifactId: '45',
    pagesId: null,
    phase: 'intent',
  });
  await expect(publishPages(f.args)).rejects.toThrow();
  expect(f.events).toEqual([]);
});
it('fails when intent is not visible durably before submission', async () => {
  const f = fixture();
  f.controls.createIntent.mockResolvedValue('9');
  await expect(publishPages(f.args)).rejects.toThrow('INTENT_NOT_DURABLE');
  expect(f.controls.submit).not.toHaveBeenCalled();
});
it.each(['complete', 'migrationAudited'])('requires %s journal evidence', async (key) => {
  const f = fixture();
  f.controls.readJournal.mockResolvedValue({
    complete: true,
    migrationAudited: true,
    records: [],
    [key]: false,
  });
  await expect(publishPages(f.args)).rejects.toThrow('JOURNAL_UNKNOWN');
  expect(f.events).toEqual([]);
});
it('can observe a known deployment during a transient live-site read failure without resubmission', async () => {
  const f = fixture();
  f.controls.observe.mockResolvedValueOnce('pending');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  f.controls.readEffect.mockResolvedValue('unknown');
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
});
it('does not replace a completed effect which has disappeared', async () => {
  const f = fixture();
  await publishPages(f.args);
  await expect(publishPages(f.args)).rejects.toThrow('VERIFIED_EFFECT_MISSING');
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
});
it('recognizes matching bytes after an ambiguous submission without a second write', async () => {
  const f = fixture();
  f.controls.submit.mockRejectedValue(new Error('connection lost'));
  await expect(publishPages(f.args)).rejects.toThrow();
  f.controls.readEffect.mockResolvedValue('matching');
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op' });
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
});
it('rejects duplicate journal records even when live bytes match', async () => {
  const f = fixture();
  await f.controls.createIntent();
  await f.controls.createIntent();
  f.controls.readEffect.mockResolvedValue('matching');
  await expect(publishPages(f.args)).rejects.toThrow('JOURNAL_UNKNOWN');
  expect(f.controls.submit).not.toHaveBeenCalled();
});
it.each([null, '', '../17', 17])(
  'refuses an invalid Pages ID %s after preserving intent',
  async (pagesId) => {
    const f = fixture();
    f.controls.submit.mockResolvedValue(pagesId as string);
    await expect(publishPages(f.args)).rejects.toThrow('JOURNAL_INVALID');
    expect(f.records[0]?.phase).toBe('intent');
    expect(f.controls.observe).not.toHaveBeenCalled();
  },
);
it('requires strings for external identifiers before invoking any control', async () => {
  const f = fixture();
  await expect(
    publishPages({ ...f.args, identity: { ...identity, rehearsalRun: 123 } }),
  ).rejects.toThrow('IDENTITY_INVALID');
  expect(f.controls.readJournal).not.toHaveBeenCalled();
});
