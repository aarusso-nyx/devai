import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
const { githubPagesControls, inspectPagesMigrationAudit } = await import(
  pathToFileURL(resolve('scripts/process/github-pages-journal.mjs')).href
);
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
const root = 'https://api.github.com/repos/aarusso-nyx/devai';
const environment = 'devai-pages-publication';
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
function auditFor(audited: Record<string, unknown>) {
  const auditBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: '1.0.0',
      repository: audited.repository,
      tag: audited.tag,
      controlCommit: audited.controlCommit,
      legacyEffects: 'confirmed-absent-for-tag',
      singleWriterGroup: environment,
      reviewedAt: '2026-09-07T00:00:00Z',
    }),
  );
  return { auditBytes, auditSha256: createHash('sha256').update(auditBytes).digest('hex') };
}
function fixture(selected: Record<string, unknown> = identity) {
  const { auditBytes, auditSha256 } = auditFor(identity);
  const deployments: Record<string, unknown>[] = [],
    statuses: Record<string, unknown>[] = [],
    records: unknown[] = [],
    calls: { url: string; method: string; body: string }[] = [];
  // `statuses` is the history of the first intent this fixture creates (id 9);
  // seeded or later intents keep their own status histories.
  const statusesById = new Map<number, Record<string, unknown>[]>([[9, statuses]]);
  const statusesOf = (id: number) => {
    if (!statusesById.has(id)) statusesById.set(id, []);
    return statusesById.get(id) as Record<string, unknown>[];
  };
  let pagesState = 'succeed',
    pagesStates: string[] = [],
    live = false,
    loseSubmission = false;
  const fetchImpl = vi.fn(async (url: string, options: { method: string; body?: string }) => {
    calls.push({ url, method: options.method, body: options.body ?? '' });
    const parsed = new URL(url);
    const path = parsed.pathname;
    const data = options.body ? JSON.parse(options.body) : null;
    const deploymentId = Number(/\/deployments\/(\d+)\/statuses$/u.exec(path)?.[1]);
    if (options.method === 'GET' && path.endsWith('/statuses'))
      return Response.json(statusesOf(deploymentId));
    if (options.method === 'GET' && path.endsWith('/deployments'))
      return Response.json(deployments);
    if (options.method === 'GET' && path.endsWith('/pages/deployments/pages-17')) {
      const state = pagesStates.shift() ?? pagesState;
      if (state === 'succeed') live = true;
      return Response.json({ status: state });
    }
    if (options.method === 'POST' && path.endsWith('/pages/deployments')) {
      if (loseSubmission) throw new Error('secret-provider-response');
      return Response.json({ id: 'pages-17' }, { status: 200 });
    }
    if (options.method === 'POST' && path.endsWith('/statuses')) {
      const history = statusesOf(deploymentId);
      const status = {
        ...data,
        id: history.length + 1,
        deployment_url: `${root}/deployments/${deploymentId}`,
      };
      history.push(status);
      return Response.json(status, { status: 201 });
    }
    if (options.method === 'POST' && path.endsWith('/deployments')) {
      const id = Math.max(8, ...deployments.map((item) => Number(item.id))) + 1;
      const deployment = { ...data, id, sha: data.ref };
      deployments.push(deployment);
      return Response.json(deployment, { status: 201 });
    }
    throw new Error('unexpected API call');
  });
  const options = {
    token: 'secret-github-token',
    identity: selected,
    runId: '456',
    attempt: '1',
    auditBytes,
    auditSha256,
    fetchImpl,
    verifyLiveBytes: vi.fn(async () => {
      if (!live) throw new Error('bytes unavailable');
    }),
    getOidcToken: vi.fn(async () => 'secret-oidc-token'),
    retainRecord: vi.fn(async (value: unknown) => {
      records.push(value);
    }),
    sleep: vi.fn(async () => {}),
  };
  const controls = githubPagesControls(options);
  return {
    options,
    controls,
    deployments,
    statuses,
    statusesOf,
    records,
    calls,
    args: { identity: selected, artifactId: '45', controls },
    // A later publication of another identity against the same journal state.
    argsFor: (next: Record<string, unknown>) => ({
      identity: next,
      artifactId: '46',
      controls: githubPagesControls({ ...options, ...auditFor(next), identity: next }),
    }),
    setLive: (value = true) => {
      live = value;
    },
    loseSubmission: () => {
      loseSubmission = true;
    },
    setPagesState: (value: string) => {
      pagesState = value;
    },
    setPagesStates: (values: string[]) => {
      pagesStates = [...values];
    },
  };
}
it('runs controller through real adapter request serialization and durable read-backs', async () => {
  const f = fixture();
  expect(await publishPages(f.args)).toMatchObject({
    outcome: 'verified',
    pagesId: 'pages-17',
    buildInvocations: 0,
  });
  const posts = f.calls.filter((c) => c.method === 'POST');
  expect(posts.map((c) => c.url)).toEqual([
    `${root}/deployments`,
    `${root}/pages/deployments`,
    `${root}/deployments/9/statuses`,
    `${root}/deployments/9/statuses`,
  ]);
  expect(JSON.parse(posts[0]?.body ?? '')).toMatchObject({
    auto_merge: false,
    ref: identity.commit,
    required_contexts: [],
    task: 'devai:pages-publication',
  });
  expect(JSON.parse(posts[1]?.body ?? '')).toEqual({
    artifact_id: 45,
    pages_build_version: identity.commit,
    oidc_token: 'secret-oidc-token',
  });
  expect(JSON.parse(posts[2]?.body ?? '').auto_inactive).toBe(false);
  expect(JSON.stringify(f.records)).not.toContain('secret-');
});
it('does no write or OIDC request when exact bytes already match', async () => {
  const f = fixture();
  f.setLive();
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op' });
  expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  expect(f.options.getOidcToken).not.toHaveBeenCalled();
});
it('lost Pages POST response retains the durable intent and cannot retry POST', async () => {
  const f = fixture();
  f.loseSubmission();
  await expect(publishPages(f.args)).rejects.toThrow('API_OUTCOME_UNKNOWN');
  await expect(publishPages(f.args)).rejects.toThrow('SUBMISSION_UNKNOWN');
  expect(
    f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages/deployments')),
  ).toHaveLength(1);
});
it('retains and resumes a known deployment without a new Pages POST', async () => {
  const f = fixture();
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  f.setPagesState('succeed');
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });
  expect(
    f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages/deployments')),
  ).toHaveLength(1);
  expect(f.calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
});
it('closes a submitted intent when the live bytes already match', async () => {
  const f = fixture();
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  f.setPagesState('succeed');
  f.setLive();
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op', buildInvocations: 0 });
  expect(f.statuses.at(-1)).toMatchObject({
    state: 'success',
    description: 'devai-pages:verified:pages-17',
  });
  expect(
    f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages/deployments')),
  ).toHaveLength(1);
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'no-op' });
  expect(f.statuses).toHaveLength(2);
});
it('waits for a building Pages deployment before verifying it', async () => {
  const f = fixture();
  f.setPagesStates(['building', 'succeed']);
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified', pagesId: 'pages-17' });
  expect(f.options.sleep).toHaveBeenCalledTimes(1);
});
it('waits through every in-flight Pages deployment status before verifying it', async () => {
  const f = fixture();
  f.setPagesStates([
    'deployment_in_progress',
    'syncing_files',
    'finished_file_sync',
    'updating_pages',
    'purging_cdn',
    'succeed',
  ]);
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified', pagesId: 'pages-17' });
  expect(f.options.sleep).toHaveBeenCalledTimes(5);
});
it.each([401, 403, 404, 500])(
  'API status %s cannot establish missing publication',
  async (status) => {
    const f = fixture();
    f.options.fetchImpl.mockResolvedValue(Response.json({ message: 'secret' }, { status }));
    await expect(publishPages(f.args)).rejects.toThrow('API_OUTCOME_UNKNOWN');
    expect(f.options.getOidcToken).not.toHaveBeenCalled();
  },
);
it('refuses a failed read of the second collection page', async () => {
  const f = fixture();
  f.options.fetchImpl.mockResolvedValueOnce(
    Response.json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))),
  );
  f.options.fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 500 }));
  await expect(publishPages(f.args)).rejects.toThrow('API_OUTCOME_UNKNOWN');
  expect(f.options.getOidcToken).not.toHaveBeenCalled();
});
it('blocks a pending publication for another version', async () => {
  const f = fixture();
  f.deployments.push({
    id: 8,
    task: 'devai:pages-publication',
    environment,
    sha: identity.commit,
    payload: {
      kind: 'devai-pages-publication-intent',
      schemaVersion: '1.0.0',
      identity: { ...identity, tag: 'v1.4.9' },
      artifactId: '44',
      runId: '455',
      attempt: '1',
    },
  });
  await expect(publishPages(f.args)).rejects.toThrow('OTHER_PUBLICATION_UNRESOLVED');
  expect(f.options.getOidcToken).not.toHaveBeenCalled();
});
it('treats a verified prior rehearsal for the same release as history when live bytes match', async () => {
  const f = fixture();
  await publishPages(f.args);
  const priorDeployment = f.deployments[0];
  if (priorDeployment === undefined) throw new Error('fixture deployment missing');
  (priorDeployment.payload as { identity: typeof identity }).identity = {
    ...identity,
    rehearsalRun: '999',
  };
  f.setLive();
  await expect(publishPages(f.args)).resolves.toMatchObject({ outcome: 'no-op' });
  expect(f.options.getOidcToken).toHaveBeenCalledTimes(1);
});
it('checks the externally approved audit digest and exact tag', () => {
  const f = fixture();
  expect(() => inspectPagesMigrationAudit(f.options.auditBytes, 'f'.repeat(64), identity)).toThrow(
    'AUDIT_DIGEST',
  );
  expect(() =>
    inspectPagesMigrationAudit(f.options.auditBytes, f.options.auditSha256, {
      ...identity,
      tag: 'v1.5.1',
    }),
  ).toThrow('AUDIT_INVALID');
});
it('rejects a status which substitutes a Pages deployment ID', async () => {
  const f = fixture();
  await publishPages(f.args);
  f.statuses.push({ ...f.statuses[1], id: 3, description: 'devai-pages:verified:other' });
  await expect(publishPages(f.args)).rejects.toThrow('STATUS_INVALID');
});
it('an unavailable OIDC token fails before any durable intent or Pages POST', async () => {
  const f = fixture();
  f.options.getOidcToken.mockRejectedValue(new Error('OIDC unavailable'));
  await expect(publishPages(f.args)).rejects.toThrow('OIDC unavailable');
  expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
  expect(f.deployments).toHaveLength(0);
});

/**
 * ADR-SCR-0005 IA-005: the site_drift sensor (packages/sensors/src/site-drift.ts)
 * reads published-source provenance through a read-only `gh api` GitHub
 * deployments read for environment devai-pages-publication, rather than
 * requiring a `docs: publish from <sha>` gh-pages branch commit the Pages
 * deployment API path never writes. It filters the deployment and status
 * records this journal writes to exactly this shape; this test pins the
 * journal's real output against that filter so the two paths cannot silently
 * diverge.
 */
function selectSiteDriftProvenance(
  deployments: readonly Record<string, unknown>[],
  statusesOf: (id: number) => readonly Record<string, unknown>[],
): { readonly commit: string; readonly tag: string; readonly intentId: string } | undefined {
  // Like the sensor: the highest-id matching deployment is the latest intent.
  const matchedDeployment = deployments
    .filter(
      (deployment) =>
        typeof deployment.id === 'number' &&
        deployment.environment === environment &&
        deployment.task === 'devai:pages-publication' &&
        (deployment.payload as Record<string, unknown> | undefined)?.kind ===
          'devai-pages-publication-intent' &&
        (deployment.payload as Record<string, unknown>).schemaVersion === '1.0.0' &&
        ((deployment.payload as Record<string, unknown>).identity as Record<string, unknown>)
          ?.repository === identity.repository &&
        typeof ((deployment.payload as Record<string, unknown>).identity as Record<string, unknown>)
          .commit === 'string' &&
        ((deployment.payload as Record<string, unknown>).identity as Record<string, unknown>)
          .commit === deployment.sha &&
        typeof ((deployment.payload as Record<string, unknown>).identity as Record<string, unknown>)
          .tag === 'string',
    )
    .sort((a, b) => (b.id as number) - (a.id as number))[0];
  if (matchedDeployment === undefined) return undefined;
  const verified = statusesOf(matchedDeployment.id as number).find(
    (status) =>
      status.environment === environment &&
      status.state === 'success' &&
      typeof status.description === 'string' &&
      /^devai-pages:verified:[A-Za-z0-9_-]{1,100}$/.test(status.description),
  );
  if (verified === undefined) return undefined;
  const matchedIdentity = (matchedDeployment.payload as Record<string, unknown>).identity as Record<
    string,
    unknown
  >;
  return {
    commit: matchedIdentity.commit as string,
    tag: matchedIdentity.tag as string,
    intentId: String(matchedDeployment.id),
  };
}

it('journals a verified deployment record the site_drift sensor can read as published-source provenance', async () => {
  const f = fixture();
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });

  const provenance = selectSiteDriftProvenance(f.deployments, f.statusesOf);
  expect(provenance).toEqual({
    commit: identity.commit,
    tag: identity.tag,
    intentId: String(f.deployments[0]?.id),
  });
});

it('leaves no site_drift-readable provenance for a submitted-but-unverified intent', async () => {
  const f = fixture();
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');

  expect(selectSiteDriftProvenance(f.deployments, f.statusesOf)).toBeUndefined();
});

/** ADR-REL-0029: site-only publication from main under the same journal. */
type JournalFixture = ReturnType<typeof fixture>;
function seedVerifiedRelease(f: JournalFixture, id = 5) {
  f.deployments.push({
    id,
    task: 'devai:pages-publication',
    environment,
    sha: identity.commit,
    payload: {
      kind: 'devai-pages-publication-intent',
      schemaVersion: '1.0.0',
      identity,
      artifactId: '40',
      runId: '400',
      attempt: '1',
    },
  });
  const deploymentUrl = `${root}/deployments/${id}`;
  f.statusesOf(id).push(
    {
      id: 1,
      state: 'in_progress',
      environment,
      deployment_url: deploymentUrl,
      description: 'devai-pages:submitted:pages-5',
    },
    {
      id: 2,
      state: 'success',
      environment,
      deployment_url: deploymentUrl,
      description: 'devai-pages:verified:pages-5',
    },
  );
}
const pagesPosts = (f: JournalFixture) =>
  f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages/deployments'));

it('refuses a site-only publication without a verified release baseline before any write', async () => {
  const f = fixture(siteIdentity);
  await expect(publishPages(f.args)).rejects.toThrow('PAGES_JOURNAL_SITE_BASELINE_MISSING');
  expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  expect(f.options.getOidcToken).not.toHaveBeenCalled();
});
it('does not count a verified site-only record as a site-only baseline', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  await publishPages(f.args);
  f.deployments.shift();
  f.setLive(false);
  const next = { ...siteIdentity, commit: 'c'.repeat(40), controlCommit: 'c'.repeat(40) };
  await expect(publishPages(f.argsFor(next))).rejects.toThrow(
    'PAGES_JOURNAL_SITE_BASELINE_MISSING',
  );
  expect(pagesPosts(f)).toHaveLength(1);
});
it('does not count an unverified release intent as a site-only baseline', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  f.statusesOf(5).pop();
  await expect(publishPages(f.args)).rejects.toThrow('OTHER_PUBLICATION_UNRESOLVED');
  expect(pagesPosts(f)).toHaveLength(0);
});
it('publishes a site-only identity over a verified release baseline without a migration audit', async () => {
  const f = fixture(siteIdentity);
  f.options.auditBytes = Buffer.from('');
  seedVerifiedRelease(f);
  const controls = githubPagesControls(f.options);
  expect(await publishPages({ ...f.args, controls })).toMatchObject({
    outcome: 'verified',
    pagesId: 'pages-17',
  });
  const intent = JSON.parse(f.calls.find((c) => c.method === 'POST')?.body ?? '');
  expect(intent).toMatchObject({
    ref: siteIdentity.commit,
    payload: { identity: siteIdentity },
    description: `Pages publication intent for v1.6.0 (site-only from ${siteIdentity.commit})`,
  });
  expect(f.statusesOf(9).at(-1)).toMatchObject({ description: 'devai-pages:verified:pages-17' });
  expect(pagesPosts(f)).toHaveLength(1);
});
it('keeps the migration audit mandatory for release identities', () => {
  const f = fixture();
  expect(() => githubPagesControls({ ...f.options, auditBytes: Buffer.from('') })).toThrow(
    'MIGRATION_AUDIT_DIGEST',
  );
});
it('treats a verified site-only record as plain history for a later release', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  await publishPages(f.args);
  f.setLive(false);
  const release = { ...identity, tag: 'v1.7.0', commit: 'c'.repeat(40) };
  expect(await publishPages(f.argsFor(release))).toMatchObject({ outcome: 'verified' });
  expect(f.deployments.map((d) => d.id)).toEqual([5, 9, 10]);
  expect(pagesPosts(f)).toHaveLength(2);
});
it('blocks a release identity while a site-only intent is submitted but unverified', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  const release = { ...identity, tag: 'v1.7.0', commit: 'c'.repeat(40) };
  const later = f.argsFor(release);
  await expect(publishPages(later)).rejects.toThrow('OTHER_PUBLICATION_UNRESOLVED');
  expect(pagesPosts(f)).toHaveLength(1);
});
it('blocks a site-only identity while a release intent is submitted but unverified', async () => {
  const f = fixture();
  seedVerifiedRelease(f);
  f.setPagesState('deployment_failed');
  const pending = { ...identity, tag: 'v1.7.0', commit: 'c'.repeat(40) };
  const first = f.argsFor(pending);
  await expect(publishPages(first)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  await expect(publishPages(f.argsFor(siteIdentity))).rejects.toThrow(
    'OTHER_PUBLICATION_UNRESOLVED',
  );
  expect(pagesPosts(f)).toHaveLength(1);
});
it('reads a verified site-only publication with the highest id as site_drift provenance', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  expect(await publishPages(f.args)).toMatchObject({ outcome: 'verified' });
  expect(selectSiteDriftProvenance(f.deployments, f.statusesOf)).toEqual({
    commit: siteIdentity.commit,
    tag: siteIdentity.tag,
    intentId: '9',
  });
});

/** ADR-REL-0032: a re-run attempt of the same run finds its own record. */
const rerunOf = (f: JournalFixture, next: Record<string, unknown>, attempt = '2') => ({
  identity: next,
  artifactId: '47',
  controls: githubPagesControls({ ...f.options, ...auditFor(next), identity: next, attempt }),
});
const writes = (f: JournalFixture) => f.calls.filter((c) => c.method !== 'GET');
const named = (f: JournalFixture) =>
  f.calls.filter((c) => c.url.endsWith('/pages/deployments/pages-17'));
const attemptUrl = (attempt: string, run = '456') =>
  `https://github.com/aarusso-nyx/devai/actions/runs/${run}/attempts/${attempt}`;
it.each([
  ['release', () => identity, false],
  ['site-only', () => siteIdentity, true],
])(
  '%s: a new attempt resumes a submitted record by observing the named deployment',
  async (_label, pick, baseline) => {
    const f = fixture(pick());
    if (baseline) seedVerifiedRelease(f);
    f.setPagesState('deployment_failed');
    await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
    f.setPagesState('succeed');
    f.calls.length = 0;
    expect(await publishPages(rerunOf(f, pick()))).toMatchObject({
      outcome: 'verified',
      pagesId: 'pages-17',
      buildInvocations: 0,
    });
    expect(pagesPosts(f)).toHaveLength(0);
    expect(named(f)).toHaveLength(1);
    expect(f.deployments.filter((d) => d.task === 'devai:pages-publication')).toHaveLength(
      baseline ? 2 : 1,
    );
    expect(f.statuses).toHaveLength(2);
    expect(f.statuses.at(-1)).toMatchObject({
      state: 'success',
      description: 'devai-pages:verified:pages-17',
      log_url: attemptUrl('2'),
    });
    expect(f.statuses[0]).toMatchObject({ log_url: attemptUrl('1') });
  },
);
it('site-only: a new attempt closes a submitted record with matching bytes as a no-op', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  f.setPagesState('succeed');
  f.setLive();
  f.calls.length = 0;
  expect(await publishPages(rerunOf(f, siteIdentity))).toMatchObject({
    outcome: 'no-op',
    buildInvocations: 0,
  });
  expect(pagesPosts(f)).toHaveLength(0);
  expect(named(f)).toHaveLength(1);
  expect(f.statuses.at(-1)).toMatchObject({ description: 'devai-pages:verified:pages-17' });
});
it('site-only: an intent payload keeps the attempt as provenance, never in the identity', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  await publishPages(f.args);
  const payload = f.deployments.find((d) => d.id === 9)?.payload as Record<string, unknown>;
  expect(payload).toMatchObject({ runId: '456', attempt: '1' });
  expect(Object.keys(payload.identity as object)).toEqual(Object.keys(siteIdentity));
  expect(payload.identity).not.toHaveProperty('sourceAttempt');
});
it.each([
  ['release', () => identity, false],
  ['site-only', () => siteIdentity, true],
])(
  '%s: a verified record with matching bytes is a no-op with no journal or Pages write',
  async (_label, pick, baseline) => {
    const f = fixture(pick());
    if (baseline) seedVerifiedRelease(f);
    await publishPages(f.args);
    f.setLive();
    f.calls.length = 0;
    f.options.getOidcToken.mockClear();
    expect(await publishPages(rerunOf(f, pick()))).toMatchObject({
      outcome: 'no-op',
      buildInvocations: 0,
    });
    expect(writes(f)).toEqual([]);
    expect(named(f)).toHaveLength(0);
    expect(f.options.getOidcToken).not.toHaveBeenCalled();
    expect(f.statuses).toHaveLength(2);
    expect(f.options.retainRecord).toHaveBeenCalledTimes(f.records.length);
  },
);
it.each([
  ['release', () => identity, false],
  ['site-only', () => siteIdentity, true],
])(
  '%s: a verified record whose bytes are gone refuses a new attempt and sends nothing',
  async (_label, pick, baseline) => {
    const f = fixture(pick());
    if (baseline) seedVerifiedRelease(f);
    await publishPages(f.args);
    f.setLive(false);
    f.calls.length = 0;
    await expect(publishPages(rerunOf(f, pick()))).rejects.toThrow(
      'PAGES_PUBLICATION_VERIFIED_EFFECT_MISSING',
    );
    expect(writes(f)).toEqual([]);
    expect(f.statuses).toHaveLength(2);
  },
);
it.each([
  ['release, matching bytes', () => identity, false, true],
  ['release, other bytes', () => identity, false, false],
  ['site-only, matching bytes', () => siteIdentity, true, true],
  ['site-only, other bytes', () => siteIdentity, true, false],
])(
  '%s: a new attempt refuses an intent with unknown submission',
  async (_label, pick, baseline, matching) => {
    const f = fixture(pick());
    if (baseline) seedVerifiedRelease(f);
    f.loseSubmission();
    await expect(publishPages(f.args)).rejects.toThrow('API_OUTCOME_UNKNOWN');
    if (matching) f.setLive();
    f.calls.length = 0;
    await expect(publishPages(rerunOf(f, pick()))).rejects.toThrow(
      'PAGES_PUBLICATION_SUBMISSION_UNKNOWN',
    );
    expect(writes(f)).toEqual([]);
    expect(f.statuses).toHaveLength(0);
    expect(pagesPosts(f)).toHaveLength(0);
  },
);
it('site-only: an open record of another run still blocks a new run identity', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  f.setPagesState('deployment_failed');
  await expect(publishPages(f.args)).rejects.toThrow('DEPLOYMENT_UNRESOLVED');
  const otherRun = { ...siteIdentity, sourceRun: '790' };
  await expect(publishPages(rerunOf(f, otherRun, '1'))).rejects.toThrow(
    'OTHER_PUBLICATION_UNRESOLVED',
  );
  expect(pagesPosts(f)).toHaveLength(1);
});
it('site-only: a legacy record carrying sourceAttempt blocks the run identity as another publication', async () => {
  const f = fixture(siteIdentity);
  seedVerifiedRelease(f);
  const legacy = { ...siteIdentity, sourceAttempt: '1' };
  f.deployments.push({
    id: 6,
    task: 'devai:pages-publication',
    environment,
    sha: siteIdentity.commit,
    payload: {
      kind: 'devai-pages-publication-intent',
      schemaVersion: '1.0.0',
      identity: legacy,
      artifactId: '44',
      runId: '789',
      attempt: '1',
    },
  });
  f.statusesOf(6).push({
    id: 1,
    state: 'in_progress',
    environment,
    deployment_url: `${root}/deployments/6`,
    description: 'devai-pages:submitted:pages-6',
  });
  await expect(publishPages(rerunOf(f, siteIdentity, '2'))).rejects.toThrow(
    'OTHER_PUBLICATION_UNRESOLVED',
  );
  expect(pagesPosts(f)).toHaveLength(0);
});
