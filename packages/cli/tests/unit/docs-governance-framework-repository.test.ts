// ADR-CHK-0003, Inspector Adversarial Acceptance IA-003: the docs-governance
// rule set passes on the framework's own checkout, which declares repo.kind
// and docs.builder (#166); removing either declaration fails it, and the
// failure reaches the gate because docs:validate runs every member the docs
// class lists. The no-ci-publish rule says publication goes only through the
// governed Pages journal (#167), whose two files are present here; the
// gh-pages-branch advisory is satisfied by that journal instead of by a branch
// (cli-shard06-docs-governance-residual.test.ts pins the rule itself).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { checkDocsGovernance } from '../../src/commands/check/docs-governance.js';
import { checkNoCiPublish } from '../../src/commands/check/docs-governance-publish-checks.js';
import { loadChangeTaxonomy } from '../../src/services/change-taxonomy.js';
import { selectorMatches } from '../../src/services/check-runner/policy.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const PROJECT_CONFIG = '.devai/config/project.json';
const DOCS_PATH = 'docs/adopters/docs-layout.md';
const PAGES_JOURNAL = ['.github/workflows/site-publish.yml', 'scripts/process/publish-site.mjs'];

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

type ProjectConfig = Record<string, unknown> & {
  repo?: Record<string, unknown>;
  docs?: Record<string, unknown>;
};

function projectConfig(): ProjectConfig {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, PROJECT_CONFIG), 'utf8')) as ProjectConfig;
}

/** The checkout seen through symlinks, with the named files replaced. */
function mirrorRepository(overrides: Readonly<Record<string, string>>): string {
  const mirror = mkdtempSync(join(tmpdir(), 'devai-docs-governance-mirror-'));
  temporary.push(mirror);
  const paths = Object.keys(overrides);
  const build = (relative: string): void => {
    for (const name of readdirSync(join(REPOSITORY_ROOT, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (Object.hasOwn(overrides, path)) {
        writeFileSync(join(mirror, path), overrides[path] ?? '');
      } else if (paths.some((override) => override.startsWith(`${path}/`))) {
        mkdirSync(join(mirror, path));
        build(path);
      } else {
        symlinkSync(join(REPOSITORY_ROOT, path), join(mirror, path));
      }
    }
  };
  build('');
  return mirror;
}

function mirrorWithout(section: 'repo' | 'docs', key: string): string {
  const config = projectConfig();
  const { [key]: _removed, ...rest } = config[section] ?? {};
  return mirrorRepository({
    [PROJECT_CONFIG]: `${JSON.stringify({ ...config, [section]: rest }, null, 2)}\n`,
  });
}

function governance(repoRoot: string) {
  return withAuthorityHostTestScope(() => checkDocsGovernance({ repoRoot, noPublishCheck: true }));
}

interface DescriptorTask {
  readonly nodeId: string;
  readonly argv: readonly string[];
  readonly inputSelectors: readonly Readonly<{ kind: string; pattern: string }>[];
}

/** Descriptor nodes that select a docs-class path and run `check --only <member>`. */
function docsMemberNodes(member: string): readonly DescriptorTask[] {
  const descriptor = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'test-tasks.json'), 'utf8')) as {
    tasks: readonly DescriptorTask[];
  };
  const taxonomy = loadChangeTaxonomy(REPOSITORY_ROOT);
  const classify = (path: string) => taxonomy.classify(path);
  return descriptor.tasks.filter((task) => {
    const argv = task.argv.join(' ');
    const runsMember = new RegExp(`--only(?:\\s+|=)${member}(?:\\s|$)`, 'u').test(argv);
    const selectsDocs = task.inputSelectors.some((selector) =>
      selectorMatches(selector as Parameters<typeof selectorMatches>[0], DOCS_PATH, classify),
    );
    return runsMember && selectsDocs;
  });
}

function docsClassMembers(): readonly string[] {
  const taxonomy = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'law/policy/change-taxonomy.json'), 'utf8'),
  ) as { classes: Record<string, { check_members: readonly string[] }> };
  return taxonomy.classes.docs?.check_members ?? [];
}

describe('docs-governance on the framework repository (ADR-CHK-0003)', () => {
  it('declares repo.kind library and docs.builder docusaurus (#166)', () => {
    const config = projectConfig();
    expect(config.repo?.kind).toBe('library');
    expect(config.docs?.builder).toBe('docusaurus');
  });

  it('passes every docs-governance rule on the framework checkout (IA-003)', async () => {
    const report = await governance(REPOSITORY_ROOT);
    const failing = report.findings
      .filter((finding) => finding.severity === 'fail')
      .map((finding) => `${finding.ruleId}: ${finding.message}`);
    expect(failing).toEqual([]);
    expect(report.verdict).not.toBe('fail');
  });

  it.each([
    ['repo', 'kind', 'docs-governance.classification'],
    ['docs', 'builder', 'docs-governance.builder-declared'],
  ] as const)('fails when %s.%s is removed from project.json', async (section, key, ruleId) => {
    const report = await governance(mirrorWithout(section, key));
    expect(report.verdict).toBe('fail');
    expect(report.findings.find((finding) => finding.ruleId === ruleId)?.severity).toBe('fail');
  });

  it('binds every member the docs class lists to a node docs changes select', () => {
    const members = docsClassMembers();
    expect(members).toContain('docs-governance');
    const unbound = members.filter((member) => docsMemberNodes(member).length === 0);
    expect(unbound, 'docs class members no docs:validate node runs').toEqual([]);
  });

  it('fails docs:validate through docs-governance when repo.kind is removed (IA-003)', () => {
    const nodes = docsMemberNodes('docs-governance');
    expect(
      nodes.map((task) => task.nodeId),
      'a node docs changes select runs check --only docs-governance',
    ).not.toEqual([]);
    const mirror = mirrorWithout('repo', 'kind');
    for (const task of nodes) {
      const [command = '', ...args] = task.argv;
      const result = spawnSync(command === 'node' ? process.execPath : command, args, {
        cwd: mirror,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(result.status, `${task.nodeId} fails without repo.kind`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('docs-governance.classification');
    }
  });

  it('admits no workflow that uses a documentation-deployment action', async () => {
    const finding = await withAuthorityHostTestScope(() => checkNoCiPublish(REPOSITORY_ROOT));
    expect(finding.severity).toBe('pass');
  });

  it('names the governed Pages journal in the no-ci-publish remediation (#167)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-no-ci-publish-'));
    temporary.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/docs.yml'),
      'jobs:\n  deploy:\n    steps:\n      - uses: actions/deploy-pages@v4\n',
    );
    const finding = await withAuthorityHostTestScope(() => checkNoCiPublish(root));
    expect(finding.severity).toBe('fail');
    expect(finding.remediation ?? '').toContain('governed Pages journal');
    expect(`${finding.message} ${finding.remediation ?? ''}`).not.toContain(
      'does not publish the site',
    );
  });

  it('publishes through the governed Pages journal on the framework checkout', () => {
    const missing = PAGES_JOURNAL.filter((path) => !existsSync(join(REPOSITORY_ROOT, path)));
    expect(missing, 'governed Pages journal files').toEqual([]);
  });
});
