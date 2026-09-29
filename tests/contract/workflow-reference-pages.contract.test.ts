// ADR-GOV-0021: one reference page per admitted workflow under
// docs/dev/operations/workflows/, kept to its workflow file by a metadata block.
//
// Pinned contracts (the Engineer implements to these):
//  - The docs-governance check member gains an information-architecture rule in the docs-ia.*
//    family whose id names workflows (for example docs-ia.workflow-page-set). It fails, and its
//    message or remediation carries DOCS_WORKFLOW_PAGE_MISSING, when a file under
//    .github/workflows/ has no page docs/dev/operations/workflows/<stem>.md, and it fails when a
//    page (any *.md there except README.md) has no workflow file. The finding names the workflow
//    file or the page it refers to.
//  - scripts/check-workflows.mjs checkWorkflowTree(root) emits a finding with code
//    DOCS_WORKFLOW_METADATA_DRIFT when the metadata block of a page (the first fenced code block
//    after <!-- devai:workflow-metadata -->) lists triggers or jobs that differ from the keys of
//    the file's on: and jobs: mappings, as a list in file order. The finding's file is the page
//    path or the workflow path, and its detail names the offending trigger or job.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../packages/authority/tests/unit/authority-host-test-scope.js';
import { checkDocsGovernance } from '../../packages/cli/src/commands/check/docs-governance.js';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS = '.github/workflows';
const PAGES = 'docs/dev/operations/workflows';

interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const workflowStems = (): string[] =>
  readdirSync(join(ROOT, WORKFLOWS))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.replace(/\.yml$/u, ''))
    .sort();

/** The checkout seen through symlinks, except that the workflow and page directories are real
 * copies a case may add to, remove from, or edit. */
function mirror(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-workflow-pages-'));
  roots.push(root);
  const realDirs = [WORKFLOWS, PAGES];
  const build = (relative: string): void => {
    for (const name of readdirSync(join(ROOT, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (realDirs.includes(path)) {
        cpSync(join(ROOT, path), join(root, path), { recursive: true });
      } else if (realDirs.some((dir) => dir.startsWith(`${path}/`))) {
        mkdirSync(join(root, path));
        build(path);
      } else {
        symlinkSync(join(ROOT, path), join(root, path));
      }
    }
  };
  build('');
  return root;
}

async function governance(repoRoot: string) {
  return withAuthorityHostTestScope(() => checkDocsGovernance({ repoRoot, noPublishCheck: true }));
}

const failing = (report: Awaited<ReturnType<typeof governance>>) =>
  report.findings.filter((finding) => finding.severity === 'fail');

const workflowRule = (report: Awaited<ReturnType<typeof governance>>) =>
  report.findings.filter(
    (finding) => finding.ruleId.startsWith('docs-ia.') && /workflow/iu.test(finding.ruleId),
  );

const text = (finding: { message: string; remediation?: string }) =>
  `${finding.message} ${finding.remediation ?? ''}`;

describe('workflow page-set gate through docs-governance (docs-workflow-page-set)', () => {
  it('passes on the committed tree with a workflow rule present in the docs-ia family', async () => {
    const report = await governance(ROOT);
    expect(failing(report).map((finding) => `${finding.ruleId}: ${finding.message}`)).toEqual([]);
    const rules = workflowRule(report);
    expect(rules.length, 'a docs-ia.* rule about workflow pages must report').toBeGreaterThan(0);
    expect(rules.every((finding) => finding.severity === 'pass')).toBe(true);
  });

  it('fails a workflow file that has no page, naming DOCS_WORKFLOW_PAGE_MISSING and the file', async () => {
    const root = mirror();
    writeFileSync(
      join(root, WORKFLOWS, 'nightly-audit.yml'),
      'name: Nightly\non:\n  workflow_dispatch:\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n',
    );
    const report = await governance(root);
    expect(report.verdict).toBe('fail');
    const missing = workflowRule(report).filter((finding) => finding.severity === 'fail');
    expect(missing.length).toBeGreaterThan(0);
    const named = missing.find((finding) => text(finding).includes('DOCS_WORKFLOW_PAGE_MISSING'));
    expect(named, 'finding carries DOCS_WORKFLOW_PAGE_MISSING').toBeDefined();
    expect(text(named!)).toContain('nightly-audit');
  });

  it.each(workflowStems())('fails when the page for %s is removed', async (stem) => {
    const root = mirror();
    rmSync(join(root, PAGES, `${stem}.md`));
    const report = await governance(root);
    expect(report.verdict).toBe('fail');
    const named = workflowRule(report).find(
      (finding) =>
        finding.severity === 'fail' && text(finding).includes('DOCS_WORKFLOW_PAGE_MISSING'),
    );
    expect(named, 'finding carries DOCS_WORKFLOW_PAGE_MISSING').toBeDefined();
    expect(text(named!)).toContain(stem);
  });

  it('fails an orphan page that has no workflow file', async () => {
    const root = mirror();
    writeFileSync(
      join(root, PAGES, 'ghost-workflow.md'),
      '# ghost-workflow.yml\n\nNo such workflow.\n',
    );
    const report = await governance(root);
    expect(report.verdict).toBe('fail');
    const orphan = workflowRule(report).find(
      (finding) => finding.severity === 'fail' && text(finding).includes('ghost-workflow'),
    );
    expect(orphan, 'a docs-ia workflow rule names the orphan page').toBeDefined();
  });

  it('does not treat the index page README.md as an orphan', async () => {
    const report = await governance(mirror());
    expect(failing(report)).toEqual([]);
  });
});

/** A scratch tree for checkWorkflowTree: workflows, composite actions, both manifests, pages. */
function checkerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-workflow-drift-'));
  roots.push(root);
  cpSync(join(ROOT, '.github'), join(root, '.github'), { recursive: true });
  mkdirSync(join(root, '.devai/config'), { recursive: true });
  cpSync(join(ROOT, '.devai/config/toolchain.json'), join(root, '.devai/config/toolchain.json'));
  mkdirSync(join(root, 'law/policy'), { recursive: true });
  cpSync(
    join(ROOT, 'law/policy/credential-requirements.json'),
    join(root, 'law/policy/credential-requirements.json'),
  );
  cpSync(join(ROOT, PAGES), join(root, PAGES), { recursive: true });
  return root;
}

function editPage(root: string, stem: string, edit: (block: string) => string): void {
  const path = join(root, PAGES, `${stem}.md`);
  const source = readFileSync(path, 'utf8');
  const pattern = /(<!-- devai:workflow-metadata -->\s*```yaml\n)([\s\S]*?)(\n```)/u;
  const match = pattern.exec(source);
  expect(match, `${stem}.md carries the metadata block`).not.toBeNull();
  const original = match?.[2] ?? '';
  const edited = edit(original);
  expect(edited, 'the mutation changes the block').not.toBe(original);
  writeFileSync(
    path,
    source.replace(
      pattern,
      (_all, open: string, _block: string, close: string) => `${open}${edited}${close}`,
    ),
  );
}

const drift = (root: string) =>
  checkWorkflowTree(root).findings.filter(
    (finding) => finding.code === 'DOCS_WORKFLOW_METADATA_DRIFT',
  );

describe('workflow metadata drift (docs-workflow-metadata-drift)', () => {
  it('reports no drift and no finding at all on the committed tree', () => {
    const result = checkWorkflowTree(ROOT);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(drift(checkerFixture())).toEqual([]);
  });

  it('names a trigger the page lists and the file does not have', () => {
    const root = checkerFixture();
    editPage(root, 'pull-request-checks', (block) =>
      block.replace('  - merge_group', '  - merge_group\n  - schedule'),
    );
    const found = drift(root);
    expect(found.length).toBeGreaterThan(0);
    expect(`${found[0]?.file} ${found[0]?.detail}`).toContain('schedule');
    expect(checkWorkflowTree(root).ok).toBe(false);
  });

  it('names a trigger the file has and the page omits', () => {
    const root = checkerFixture();
    editPage(root, 'release', (block) => block.replace('  - workflow_dispatch\n', ''));
    const found = drift(root);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((finding) => finding.detail).join(' ')).toContain('workflow_dispatch');
  });

  it('names a job the page lists and the file does not have', () => {
    const root = checkerFixture();
    editPage(root, 'devai-ledger-verify', (block) => `${block}\n  - phantom-job`);
    const found = drift(root);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((finding) => finding.detail).join(' ')).toContain('phantom-job');
  });

  it('names a job the file has and the page omits', () => {
    const root = checkerFixture();
    editPage(root, 'release', (block) => block.replace('  - deploy-pages', ''));
    const found = drift(root);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((finding) => finding.detail).join(' ')).toContain('deploy-pages');
  });

  it('fails when the same jobs are listed in another order than the file', () => {
    const root = checkerFixture();
    editPage(root, 'release', (block) =>
      block.replace(
        '  - build-release\n  - finalize-release',
        '  - finalize-release\n  - build-release',
      ),
    );
    expect(drift(root).length).toBeGreaterThan(0);
  });

  it('fails when the workflow key names another file than the page stem', () => {
    const root = checkerFixture();
    editPage(root, 'site-publish', (block) => block.replace('site-publish.yml', 'release.yml'));
    expect(drift(root).length).toBeGreaterThan(0);
  });

  it('ignores prose and tables: an edited table cell with a current block is not drift', () => {
    const root = checkerFixture();
    const path = join(root, PAGES, 'release.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nAn added paragraph that names no job.\n`);
    expect(drift(root)).toEqual([]);
  });
});

describe('workflows index page', () => {
  it('links every page and every link resolves to a page', () => {
    const index = readFileSync(join(ROOT, PAGES, 'README.md'), 'utf8');
    const linked = [...index.matchAll(/\]\(\.\/([a-z0-9-]+)\.md\)/gu)]
      .map((match) => match[1])
      .sort();
    const pages = readdirSync(join(ROOT, PAGES))
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => name.replace(/\.md$/u, ''))
      .sort();
    expect(linked).toEqual(pages);
    expect(pages).toEqual(workflowStems());
  });
});
