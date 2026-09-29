import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
const siteIdentity = {
  repository: 'aarusso-nyx/devai',
  mode: 'site-only',
  tag: 'v1.6.0',
  commit: 'f'.repeat(40),
  tree: 'b'.repeat(40),
  siteSha256: 'd'.repeat(64),
  sourceRun: '789',
  controlCommit: 'f'.repeat(40),
};
function fixture(selected: Record<string, unknown> = identity) {
  const records: Record<string, unknown>[] = [];
  const events: string[] = [];
  const controls = {
    readJournal: vi.fn(async () => ({ complete: true, migrationAudited: true, records })),
    readEffect: vi.fn(async () => 'confirmed-missing'),
    createIntent: vi.fn(async () => {
      events.push('intent');
      records.push({
        schemaVersion: '1.0.0',
        identity: selected,
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
  return {
    records,
    events,
    controls,
    args: { identity: selected, artifactId: '45', controls },
  };
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
it('refuses an intent with unknown submission even when the live bytes match', async () => {
  const f = fixture();
  f.controls.submit.mockRejectedValue(new Error('connection lost'));
  await expect(publishPages(f.args)).rejects.toThrow();
  f.controls.readEffect.mockResolvedValue('matching');
  await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
  expect(f.controls.submit).toHaveBeenCalledTimes(1);
  expect(f.controls.observe).not.toHaveBeenCalled();
  expect(f.controls.recordVerified).not.toHaveBeenCalled();
  expect(f.records[0]?.phase).toBe('intent');
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
it('publishes a site-only identity through the same journaled controller', async () => {
  const f = fixture(siteIdentity);
  expect(await publishPages(f.args)).toMatchObject({
    outcome: 'verified',
    pagesId: 'pages-17',
    buildInvocations: 0,
  });
  expect(f.events).toEqual(['intent', 'submit', 'submitted', 'observe', 'verify', 'verified']);
});
it('accepts a prerelease package version tag on a site-only identity', async () => {
  const f = fixture({ ...siteIdentity, tag: 'v1.7.0-rc.1' });
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });
});
const { tree: _omittedTree, ...siteIdentityWithoutTree } = siteIdentity;
it.each([
  ['an extra rehearsalRun key', { ...siteIdentity, rehearsalRun: '123' }],
  ['a sourceAttempt key', { ...siteIdentity, sourceAttempt: '1' }],
  ['a rehearsalAttempt key', { ...siteIdentity, rehearsalAttempt: '2' }],
  ['a manifestSha256 key', { ...siteIdentity, manifestSha256: 'c'.repeat(64) }],
  ['a release mode', { ...siteIdentity, mode: 'release' }],
  ['a non-string tag', { ...siteIdentity, tag: 160 }],
  ['a tag without the v prefix', { ...siteIdentity, tag: '1.6.0' }],
  ['a numeric source run', { ...siteIdentity, sourceRun: 789 }],
  ['a short commit', { ...siteIdentity, commit: 'f'.repeat(39) }],
  ['a missing tree', siteIdentityWithoutTree],
])('rejects a site-only identity with %s before any control', async (_label, selected) => {
  const f = fixture(selected);
  await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_IDENTITY_INVALID');
  expect(f.controls.readJournal).not.toHaveBeenCalled();
});
it('rejects a release identity which carries a mode key', async () => {
  const f = fixture({ ...identity, mode: 'release' });
  await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_IDENTITY_INVALID');
  expect(f.controls.readJournal).not.toHaveBeenCalled();
});

// ADR-REL-0032: a re-run computes the same identity and follows the phase table.
const reruns: [string, Record<string, unknown>][] = [
  ['a release identity', identity],
  ['a site-only identity', siteIdentity],
];
describe.each(reruns)('re-run of %s', (_label, selected) => {
  async function submitted(f: ReturnType<typeof fixture>, state = 'pending') {
    f.controls.observe.mockResolvedValueOnce(state);
    await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
    expect(f.records[0]?.phase).toBe('submitted');
    f.events.length = 0;
    f.controls.submit.mockClear();
    f.controls.observe.mockClear();
  }
  it('observes a submitted record and verifies non-matching live bytes without submitting', async () => {
    const f = fixture(selected);
    await submitted(f);
    f.controls.readEffect.mockResolvedValue('unknown');
    expect(await publishPages(f.args)).toMatchObject({
      outcome: 'verified',
      pagesId: 'pages-17',
      buildInvocations: 0,
    });
    expect(f.events).toEqual(['observe', 'verify', 'verified']);
    expect(f.controls.observe).toHaveBeenCalledWith('pages-17');
    expect(f.controls.submit).not.toHaveBeenCalled();
    expect(f.controls.createIntent).toHaveBeenCalledTimes(1);
    expect(f.records[0]?.phase).toBe('verified');
  });
  it('observes a submitted record with matching live bytes and closes it as a no-op', async () => {
    const f = fixture(selected);
    await submitted(f);
    f.controls.readEffect.mockResolvedValue('matching');
    expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op', buildInvocations: 0 });
    expect(f.events).toEqual(['observe', 'verified']);
    expect(f.controls.observe).toHaveBeenCalledWith('pages-17');
    expect(f.controls.submit).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({ phase: 'verified', pagesId: 'pages-17' });
  });
  it('keeps the record submitted when the named deployment stays unresolved', async () => {
    const f = fixture(selected);
    await submitted(f);
    f.controls.observe.mockResolvedValue('unresolved');
    await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_DEPLOYMENT_UNRESOLVED');
    expect(f.records[0]?.phase).toBe('submitted');
    expect(f.controls.recordVerified).not.toHaveBeenCalled();
    expect(f.controls.submit).not.toHaveBeenCalled();
  });
  it('keeps the record submitted when the live bytes never verify', async () => {
    const f = fixture(selected);
    await submitted(f);
    f.controls.readEffect.mockResolvedValue('unknown');
    f.controls.verifyLiveBytes.mockRejectedValue(new Error('hash mismatch'));
    await expect(publishPages(f.args)).rejects.toThrow('hash mismatch');
    expect(f.records[0]?.phase).toBe('submitted');
    expect(f.controls.recordVerified).not.toHaveBeenCalled();
  });
  it('treats a verified record with matching bytes as a no-op with no control write', async () => {
    const f = fixture(selected);
    await publishPages(f.args);
    f.events.length = 0;
    f.controls.readEffect.mockResolvedValue('matching');
    f.controls.observe.mockClear();
    expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op', buildInvocations: 0 });
    expect(f.events).toEqual([]);
    expect(f.controls.observe).not.toHaveBeenCalled();
    expect(f.controls.submit).toHaveBeenCalledTimes(1);
    expect(f.controls.recordVerified).toHaveBeenCalledTimes(1);
  });
  it('refuses a verified record whose bytes are no longer live, sending nothing', async () => {
    const f = fixture(selected);
    await publishPages(f.args);
    f.events.length = 0;
    f.controls.readEffect.mockResolvedValue('unknown');
    await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_VERIFIED_EFFECT_MISSING');
    expect(f.events).toEqual([]);
    expect(f.controls.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['matching', 'unknown'])(
    'refuses an intent with unknown submission when the live bytes read %s',
    async (effect) => {
      const f = fixture(selected);
      f.controls.submit.mockRejectedValueOnce(new Error('connection lost'));
      await expect(publishPages(f.args)).rejects.toThrow('connection lost');
      f.events.length = 0;
      f.controls.readEffect.mockResolvedValue(effect);
      await expect(publishPages(f.args)).rejects.toThrow('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
      expect(f.events).toEqual([]);
      expect(f.controls.submit).toHaveBeenCalledTimes(1);
      expect(f.controls.observe).not.toHaveBeenCalled();
      expect(f.records[0]?.phase).toBe('intent');
    },
  );
});
