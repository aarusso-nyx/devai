#!/usr/bin/env node
// Site-only Pages publication from a main commit (ADR-REL-0029). Same journal,
// single-writer group and live-byte verification as the release deploy; no
// release manifest, rehearsal, control-commit repoint, or migration audit.
// No subprocesses: the site is built and verified locally by earlier steps.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { githubPagesControls } from './github-pages-journal.mjs';
import { publishPages } from './pages-publication.mjs';
import { getOidcToken, retainRecord as retainRecordTo } from './pages-runtime.mjs';
import { readPublicFile, siteMembers, verifyPagesBytes } from './verify-pages-bytes.mjs';

const [siteDirectory, recordDirectory] = process.argv.slice(2);
if (!siteDirectory || !recordDirectory || process.argv.length !== 4)
  throw new Error('SITE_PUBLICATION_USAGE');
const env = process.env;
const hex40 = /^[a-f0-9]{40}$/u;
if (
  env.GITHUB_REPOSITORY !== 'aarusso-nyx/devai' ||
  env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  env.GITHUB_REF !== 'refs/heads/main' ||
  !hex40.test(env.GITHUB_SHA ?? '') ||
  !hex40.test(env.SOURCE_TREE ?? '')
)
  throw new Error('SITE_PUBLICATION_CONTEXT');
const { version } = JSON.parse(
  readFileSync(new URL('../../packages/cli/package.json', import.meta.url), 'utf8'),
);
const site = resolve(siteDirectory);
const identity = {
  repository: 'aarusso-nyx/devai',
  mode: 'site-only',
  tag: `v${version}`,
  commit: env.GITHUB_SHA,
  tree: env.SOURCE_TREE,
  siteSha256: createHash('sha256')
    .update(JSON.stringify(siteMembers(site)))
    .digest('hex'),
  sourceRun: env.GITHUB_RUN_ID,
  sourceAttempt: env.GITHUB_RUN_ATTEMPT,
  controlCommit: env.GITHUB_SHA,
};
mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
const descriptor = openSync(join(recordDirectory, 'site-publication.jsonl'), 'ax', 0o600);
const retainRecord = (record) => retainRecordTo(descriptor, record);
try {
  const controls = githubPagesControls({
    token: env.GH_TOKEN,
    identity,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    getOidcToken: () => getOidcToken(env),
    retainRecord,
    verifyLiveBytes: () => verifyPagesBytes(site, readPublicFile),
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
  throw new Error('SITE_PUBLICATION_INCOMPLETE_RECONCILE_RETAINED_IDENTIFIERS');
} finally {
  closeSync(descriptor);
}
