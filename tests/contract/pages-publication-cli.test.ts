import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function fixture(live = false, loseResponse = false) {
  const root = mkdtempSync(join(tmpdir(), 'devai Pages ação-'));
  roots.push(root);
  const assets = join(root, 'assets'),
    site = join(root, 'site');
  mkdirSync(assets);
  mkdirSync(site);
  writeFileSync(join(site, 'index.html'), 'retained site');
  const artifact = (name: string, bytes: string) => {
    writeFileSync(join(assets, name), bytes);
    return { file: name, sha256: sha(bytes) };
  };
  const manifest = {
    schemaVersion: '1.0.0',
    release: {
      repository: 'aarusso-nyx/devai',
      package: '@aarusso-nyx/devai',
      tag: 'v1.5.0',
      version: '1.5.0',
    },
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    artifacts: {
      package: artifact('devai.tgz', 'rehearsed package'),
      sbom: artifact('sbom.json', '{}'),
      site: artifact('site.tgz', 'rehearsed site archive'),
    },
  };
  writeFileSync(join(assets, 'release-manifest.json'), JSON.stringify(manifest));
  const sums = ['devai.tgz', 'sbom.json', 'site.tgz', 'release-manifest.json']
    .map((name) => `${sha(readFileSync(join(assets, name), 'utf8'))}  ${name}\n`)
    .join('');
  writeFileSync(join(assets, 'SHA256SUMS'), sums);
  const state = join(root, 'api-state.json'),
    calls = join(root, 'api-calls.jsonl');
  writeFileSync(
    state,
    JSON.stringify({ live, loseResponse, deployments: [], statuses: [], submissions: 0 }),
  );
  const audit = JSON.stringify({
    schemaVersion: '1.0.0',
    repository: 'aarusso-nyx/devai',
    tag: 'v1.5.0',
    controlCommit: 'e'.repeat(40),
    legacyEffects: 'confirmed-absent-for-tag',
    singleWriterGroup: 'devai-pages-publication',
    reviewedAt: '2026-09-07T00:00:00Z',
  });
  let attempt = 0;
  function run() {
    const records = join(root, `records-${++attempt}`);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('tests/fixtures/pages-api-preload.mjs')).href,
        resolve('scripts/process/publish-pages.mjs'),
        assets,
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
          GITHUB_RUN_ID: '456',
          GITHUB_RUN_ATTEMPT: String(attempt),
          GH_TOKEN: 'fixture-secret-github',
          RELEASE_TAG: 'v1.5.0',
          REHEARSAL_RUN: '123',
          REHEARSAL_ATTEMPT: '2',
          CONTROL_COMMIT: 'e'.repeat(40),
          PAGES_ARTIFACT_ID: '45',
          PAGES_MIGRATION_AUDIT_JSON: audit,
          PAGES_MIGRATION_AUDIT_SHA256: sha(audit),
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-secret-request',
          GITHUB_OUTPUT: join(root, 'outputs'),
        },
      },
    );
    return { result, records: readFileSync(join(records, 'pages-publication.jsonl'), 'utf8') };
  }
  return { run, state, calls };
}
it('publishes through the actual CLI while all subprocess/build commands are forbidden', () => {
  const f = fixture();
  const { result, records } = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'verified', buildInvocations: 0 });
  expect(JSON.parse(readFileSync(f.state, 'utf8')).submissions).toBe(1);
  expect(records).toContain('pages-17');
  expect(records).not.toContain('fixture-secret');
  const retried = f.run();
  expect(retried.result.status, retried.result.stderr).toBe(0);
  expect(JSON.parse(retried.result.stdout).outcome).toBe('no-op');
  expect(JSON.parse(readFileSync(f.state, 'utf8')).submissions).toBe(1);
});
it('reconciles exact already-published bytes with zero API writes', () => {
  const f = fixture(true);
  const { result } = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe('no-op');
  expect(readFileSync(f.calls, 'utf8')).not.toContain('POST');
});
it('preserves a lost response across fresh CLI invocations without resubmission', () => {
  const f = fixture(false, true);
  const first = f.run(),
    retry = f.run();
  expect(first.result.status).toBe(1);
  expect(retry.result.status).toBe(1);
  expect(JSON.parse(readFileSync(f.state, 'utf8')).submissions).toBe(1);
  expect(retry.records).toContain('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
  expect(first.result.stderr).not.toContain('fixture-secret');
  expect(first.records).not.toContain('fixture-secret');
});
