#!/usr/bin/env node
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectAssets } from './rehearsal.mjs';
import { githubPagesControls } from './github-pages-journal.mjs';
import { publishPages } from './pages-publication.mjs';
import { readPublicFile, siteMembers, verifyPagesBytes } from './verify-pages-bytes.mjs';

const [assetsDirectory, siteDirectory, recordDirectory] = process.argv.slice(2);
if (!assetsDirectory || !siteDirectory || !recordDirectory || process.argv.length !== 5)
  throw new Error('PAGES_PUBLICATION_USAGE');
const env = process.env;
if (env.GITHUB_REPOSITORY !== 'aarusso-nyx/devai' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
  throw new Error('PAGES_PUBLICATION_CONTEXT');
// Workflow invokes only after exact rehearsal promotion and final release verification.
const { manifest, files } = inspectAssets(resolve(assetsDirectory));
if (manifest.release.tag !== env.RELEASE_TAG) throw new Error('PAGES_PUBLICATION_TAG');
siteMembers(resolve(siteDirectory));
const identity = {
  repository: manifest.release.repository,
  tag: manifest.release.tag,
  commit: manifest.source.commit,
  tree: manifest.source.tree,
  rehearsalRun: env.REHEARSAL_RUN,
  rehearsalAttempt: env.REHEARSAL_ATTEMPT,
  manifestSha256: files['release-manifest.json'],
  siteSha256: manifest.artifacts.site.sha256,
  controlCommit: env.CONTROL_COMMIT,
};
mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
const recordPath = join(recordDirectory, 'pages-publication.jsonl');
const descriptor = openSync(recordPath, 'ax', 0o600);
function retainRecord(record) {
  appendFileSync(descriptor, `${JSON.stringify(record)}\n`);
  fsyncSync(descriptor);
}
async function getOidcToken() {
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (
    endpoint.protocol !== 'https:' ||
    !endpoint.hostname.endsWith('.actions.githubusercontent.com') ||
    endpoint.username ||
    endpoint.password ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error('PAGES_OIDC_CONTEXT');
  const response = await fetch(endpoint, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (response.status !== 200 || !response.body) throw new Error('PAGES_OIDC_UNAVAILABLE');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('PAGES_OIDC_UNAVAILABLE');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof result.value !== 'string' || !result.value) throw new Error('PAGES_OIDC_UNAVAILABLE');
  return result.value;
}
try {
  const controls = githubPagesControls({
    token: env.GH_TOKEN,
    identity,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    auditBytes: Buffer.from(env.PAGES_MIGRATION_AUDIT_JSON ?? ''),
    auditSha256: env.PAGES_MIGRATION_AUDIT_SHA256,
    getOidcToken,
    retainRecord,
    verifyLiveBytes: () => verifyPagesBytes(resolve(siteDirectory), readPublicFile),
  });
  retainRecord({ phase: 'start', identity, artifactId: env.PAGES_ARTIFACT_ID });
  const result = await publishPages({ identity, artifactId: env.PAGES_ARTIFACT_ID, controls });
  retainRecord({ phase: 'complete', ...result });
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, 'page_url=https://aarusso-nyx.github.io/devai/\n');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const reason =
    error instanceof Error && /^PAGES_(?:PUBLICATION|JOURNAL|OIDC)_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'PAGES_PUBLICATION_UNVERIFIED';
  retainRecord({ reason, phase: 'incomplete', reconciliationRequired: true });
  // API errors may contain credential-bearing objects. Keep logs and retained
  // records closed; the exact intent/Pages IDs are already retained separately.
  throw new Error('PAGES_PUBLICATION_INCOMPLETE_RECONCILE_RETAINED_IDENTIFIERS');
} finally {
  closeSync(descriptor);
}
