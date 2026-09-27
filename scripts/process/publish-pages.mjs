#!/usr/bin/env node
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectAssets } from './rehearsal.mjs';
import { githubPagesControls } from './github-pages-journal.mjs';
import { publishPages } from './pages-publication.mjs';
import { getOidcToken, retainRecord as retainRecordTo } from './pages-runtime.mjs';
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
const retainRecord = (record) => retainRecordTo(descriptor, record);
try {
  const controls = githubPagesControls({
    token: env.GH_TOKEN,
    identity,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    auditBytes: Buffer.from(env.PAGES_MIGRATION_AUDIT_JSON ?? ''),
    auditSha256: env.PAGES_MIGRATION_AUDIT_SHA256,
    getOidcToken: () => getOidcToken(env),
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
