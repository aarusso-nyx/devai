import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// ADR-REL-0029: the site-only publication CLI runs against the same deterministic
// API boundary as the release CLI; every subprocess/build command is forbidden.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const version = JSON.parse(readFileSync(resolve('packages/cli/package.json'), 'utf8')).version;
const commit = 'f'.repeat(40);
const release = {
  repository: 'aarusso-nyx/devai',
  tag: 'v1.6.0',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  rehearsalRun: '123',
  rehearsalAttempt: '2',
  manifestSha256: 'c'.repeat(64),
  siteSha256: 'd'.repeat(64),
  controlCommit: 'e'.repeat(40),
};
function baseline() {
  const deploymentUrl = 'https://api.github.com/repos/aarusso-nyx/devai/deployments/5';
  const status = (id: number, phase: string, state: string) => ({
    id,
    state,
    environment: 'devai-pages-publication',
    deployment_url: deploymentUrl,
    description: `devai-pages:${phase}:pages-5`,
  });
  return {
    deployments: [
      {
        id: 5,
        task: 'devai:pages-publication',
        environment: 'devai-pages-publication',
        sha: release.commit,
        payload: {
          kind: 'devai-pages-publication-intent',
          schemaVersion: '1.0.0',
          identity: release,
          artifactId: '40',
          runId: '400',
          attempt: '1',
        },
      },
    ],
    seededStatuses: {
      '5': [status(1, 'submitted', 'in_progress'), status(2, 'verified', 'success')],
    },
  };
}
function fixture({ live = false, loseResponse = false, seeded = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devai Site ação-'));
  roots.push(root);
  const site = join(root, 'site');
  mkdirSync(site);
  writeFileSync(join(site, 'index.html'), 'retained site');
  const state = join(root, 'api-state.json'),
    calls = join(root, 'api-calls.jsonl');
  const journal = seeded ? baseline() : { deployments: [], seededStatuses: {} };
  writeFileSync(
    state,
    JSON.stringify({ live, loseResponse, ...journal, statuses: [], submissions: 0 }),
  );
  writeFileSync(calls, '');
  let invocation = 0;
  function run(overrides: Record<string, string> = {}) {
    const records = join(root, `records-${++invocation}`);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('tests/fixtures/pages-api-preload.mjs')).href,
        resolve('scripts/process/publish-site.mjs'),
        site,
        records,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          PAGES_FIXTURE_STATE: state,
          PAGES_FIXTURE_CALLS: calls,
          GITHUB_REPOSITORY: 'aarusso-nyx/devai',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: commit,
          SOURCE_TREE: 'b'.repeat(40),
          GITHUB_RUN_ID: '789',
          GITHUB_RUN_ATTEMPT: '1',
          GH_TOKEN: 'fixture-secret-github',
          PAGES_ARTIFACT_ID: '46',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-secret-request',
          GITHUB_OUTPUT: join(root, 'outputs'),
          ...overrides,
        },
      },
    );
    const recordFile = join(records, 'site-publication.jsonl');
    return {
      result,
      records: existsSync(recordFile) ? readFileSync(recordFile, 'utf8') : '',
    };
  }
  const api = () => JSON.parse(readFileSync(state, 'utf8'));
  return { run, api, calls, outputs: join(root, 'outputs') };
}
it('publishes the site-only identity through the actual CLI while subprocesses are forbidden', () => {
  const f = fixture();
  const { result, records } = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'verified', buildInvocations: 0 });
  const state = f.api();
  expect(state.submissions).toBe(1);
  const intent = state.deployments.find((d: { id: number }) => d.id === 9);
  expect(intent).toMatchObject({
    sha: commit,
    description: `Pages publication intent for v${version} (site-only from ${commit})`,
  });
  expect(Object.keys(intent.payload.identity)).toEqual([
    'repository',
    'mode',
    'tag',
    'commit',
    'tree',
    'siteSha256',
    'sourceRun',
    'sourceAttempt',
    'controlCommit',
  ]);
  expect(intent.payload.identity).toMatchObject({
    mode: 'site-only',
    tag: `v${version}`,
    commit,
    controlCommit: commit,
    sourceRun: '789',
    sourceAttempt: '1',
  });
  expect(intent.payload.identity.siteSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(state.statuses.at(-1)).toMatchObject({ description: 'devai-pages:verified:pages-17' });
  expect(readFileSync(f.outputs, 'utf8')).toBe('page_url=https://aarusso-nyx.github.io/devai/\n');
  expect(records).toContain('pages-17');
  expect(records).not.toContain('fixture-secret');
  const retried = f.run();
  expect(retried.result.status, retried.result.stderr).toBe(0);
  expect(JSON.parse(retried.result.stdout).outcome).toBe('no-op');
  expect(f.api().submissions).toBe(1);
});
it('refuses to publish without a verified release baseline before any API write', () => {
  const f = fixture({ seeded: false });
  const { result, records } = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('SITE_PUBLICATION_INCOMPLETE_RECONCILE_RETAINED_IDENTIFIERS');
  expect(records).toContain('PAGES_JOURNAL_SITE_BASELINE_MISSING');
  expect(readFileSync(f.calls, 'utf8')).not.toContain('POST');
  expect(f.api().submissions).toBe(0);
});
it.each([
  ['a non-main ref', { GITHUB_REF: 'refs/heads/feature' }],
  ['a push event', { GITHUB_EVENT_NAME: 'push' }],
  ['another repository', { GITHUB_REPOSITORY: 'someone/devai' }],
  ['a short source sha', { GITHUB_SHA: 'f'.repeat(39) }],
  ['a missing source tree', { SOURCE_TREE: '' }],
])('refuses %s before any record or API call', (_label, overrides) => {
  const f = fixture();
  const { result, records } = f.run(overrides);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('SITE_PUBLICATION_CONTEXT');
  expect(records).toBe('');
  expect(readFileSync(f.calls, 'utf8')).toBe('');
});
it('reconciles exact already-published bytes with zero API writes', () => {
  const f = fixture({ live: true });
  const { result } = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe('no-op');
  expect(readFileSync(f.calls, 'utf8')).not.toContain('POST');
});
it('preserves a lost response across fresh CLI invocations without resubmission', () => {
  const f = fixture({ loseResponse: true });
  const first = f.run(),
    retry = f.run();
  expect(first.result.status).toBe(1);
  expect(retry.result.status).toBe(1);
  expect(f.api().submissions).toBe(1);
  expect(retry.records).toContain('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
  expect(first.result.stderr).not.toContain('fixture-secret');
  expect(first.records).not.toContain('fixture-secret');
  // A re-run attempt is a new identity: the unresolved intent blocks it, fail closed.
  const rerun = f.run({ GITHUB_RUN_ATTEMPT: '2' });
  expect(rerun.result.status).toBe(1);
  expect(rerun.records).toContain('PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED');
  expect(f.api().submissions).toBe(1);
});
