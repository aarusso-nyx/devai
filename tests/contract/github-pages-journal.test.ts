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
function fixture() {
  const auditBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: '1.0.0',
      repository: identity.repository,
      tag: identity.tag,
      controlCommit: identity.controlCommit,
      legacyEffects: 'confirmed-absent-for-tag',
      singleWriterGroup: environment,
      reviewedAt: '2026-09-07T00:00:00Z',
    }),
  );
  const auditSha256 = createHash('sha256').update(auditBytes).digest('hex');
  const deployments: Record<string, unknown>[] = [],
    statuses: Record<string, unknown>[] = [],
    records: unknown[] = [],
    calls: { url: string; method: string; body: string }[] = [];
  let pagesState = 'succeed',
    pagesStates: string[] = [],
    live = false,
    loseSubmission = false;
  const fetchImpl = vi.fn(async (url: string, options: { method: string; body?: string }) => {
    calls.push({ url, method: options.method, body: options.body ?? '' });
    const parsed = new URL(url);
    const path = parsed.pathname;
    const data = options.body ? JSON.parse(options.body) : null;
    if (options.method === 'GET' && path.endsWith('/statuses')) return Response.json(statuses);
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
      const status = { ...data, id: statuses.length + 1, deployment_url: `${root}/deployments/9` };
      statuses.push(status);
      return Response.json(status, { status: 201 });
    }
    if (options.method === 'POST' && path.endsWith('/deployments')) {
      const deployment = { ...data, id: 9, sha: data.ref };
      deployments.push(deployment);
      return Response.json(deployment, { status: 201 });
    }
    throw new Error('unexpected API call');
  });
  const options = {
    token: 'secret-github-token',
    identity,
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
    records,
    calls,
    args: { identity, artifactId: '45', controls },
    setLive: () => {
      live = true;
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
