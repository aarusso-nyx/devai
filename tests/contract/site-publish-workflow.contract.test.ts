// ADR-REL-0029: the site-only Pages lane (.github/workflows/site-publish.yml)
// publishes the documentation site from the dispatched main commit through the
// Pages journal. scripts/check-workflows.mjs pins its trigger, main guard,
// build sequence and publication steps; each case below mutates one of them in
// a scratch copy of the real tree and names the finding the checker must emit.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNoCiPublish } from '../../packages/cli/src/commands/check/docs-governance-publish-checks.js';

const ROOT = resolve(import.meta.dirname, '../..');
interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

const SITE_WORKFLOW_FILE = 'site-publish.yml';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Copies the real workflow and composite action trees plus both manifests, so
 * only the mutation under test can produce a finding. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-site-publish-check-'));
  roots.push(root);
  cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
  cpSync(join(ROOT, '.github/actions'), join(root, '.github/actions'), { recursive: true });
  mkdirSync(join(root, '.devai/config'), { recursive: true });
  writeFileSync(
    join(root, '.devai/config/toolchain.json'),
    readFileSync(join(ROOT, '.devai/config/toolchain.json')),
  );
  mkdirSync(join(root, 'law/policy'), { recursive: true });
  writeFileSync(
    join(root, 'law/policy/credential-requirements.json'),
    readFileSync(join(ROOT, 'law/policy/credential-requirements.json')),
  );
  return root;
}

function mutateSiteWorkflow(root: string, from: string, to: string): void {
  const path = join(root, '.github/workflows', SITE_WORKFLOW_FILE);
  const source = readFileSync(path, 'utf8');
  expect(source).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

function siteFindings(root: string): WorkflowFinding[] {
  return checkWorkflowTree(root).findings.filter((item) => item.file === SITE_WORKFLOW_FILE);
}

describe('site publication workflow contract', () => {
  it('passes the workflow checker and the no-CI-publish rule unmodified', () => {
    const root = fixture();
    const result = checkWorkflowTree(root);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    expect(checkNoCiPublish(root).severity).toBe('pass');
  });

  it('refuses a job guard that admits a ref other than main', () => {
    const root = fixture();
    mutateSiteWorkflow(
      root,
      "github.ref == 'refs/heads/main' }}",
      "github.ref == 'refs/heads/feature' }}",
    );

    const findings = siteFindings(root);

    expect(
      findings.some((item) => item.code === 'SITE_WORKFLOW_MAIN_GUARD_MISSING'),
      JSON.stringify(findings),
    ).toBe(true);
  });

  it('refuses a push trigger beside the manual dispatch', () => {
    const root = fixture();
    mutateSiteWorkflow(
      root,
      'on:\n  workflow_dispatch: {}\n',
      'on:\n  push:\n    branches:\n      - main\n  workflow_dispatch: {}\n',
    );

    const findings = siteFindings(root);

    expect(
      findings.some((item) => item.code === 'SITE_WORKFLOW_TRIGGER_INVALID'),
      JSON.stringify(findings),
    ).toBe(true);
  });

  it('refuses the upstream deploy action in place of the journal-bound deployment step', () => {
    const root = fixture();
    mutateSiteWorkflow(
      root,
      [
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '          PAGES_ARTIFACT_ID: ${{ needs.prepare-site.outputs.artifact_id }}',
        '          SOURCE_TREE: ${{ needs.prepare-site.outputs.source_tree }}',
        '          SITE_SHA256: ${{ needs.prepare-site.outputs.site_sha256 }}',
        '        run: |',
        '          set -euo pipefail',
        '          node scripts/process/verify-site-preparation-artifact.mjs fetch docs/site/build',
        '          node scripts/process/publish-site.mjs docs/site/build site-publication-record',
      ].join('\n'),
      [
        '        uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
      ].join('\n'),
    );

    const findings = siteFindings(root);

    expect(
      findings.some((item) => item.code === 'SITE_WORKFLOW_PUBLISH_STEP_UNBOUND'),
      JSON.stringify(findings),
    ).toBe(true);
    expect(checkNoCiPublish(root).severity).toBe('fail');
  });

  it('refuses a site build that skips the security check', () => {
    const root = fixture();
    mutateSiteWorkflow(root, '          npm --prefix docs/site run security:check\n', '');

    const findings = siteFindings(root);

    expect(
      findings.some((item) => item.code === 'SITE_WORKFLOW_BUILD_REQUIRED'),
      JSON.stringify(findings),
    ).toBe(true);
  });
});
