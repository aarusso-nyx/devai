import {
  existsSync as nodeExistsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authority = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  existsSync: authority.existsSync,
  readFileSync: authority.readFileSync,
  readdirSync: authority.readdirSync,
  spawnSync: authority.spawnSync,
}));

import {
  checkDocsGovernance,
  checkDocsGovernanceCmd,
  type DocsGovernanceReport,
  type GovernanceFinding,
} from '../../src/commands/check/docs-governance.js';

const roots: string[] = [];
let root = '';
let redirectRelativePaths = false;

function diskPath(path: string): string {
  return redirectRelativePaths && !path.startsWith('/') ? join(root, path) : path;
}

function processResult(status: number | null, stdout = '', stderr = '') {
  return { status, stdout, stderr, signal: null, pid: 1, output: [] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-cli-s06b-docs-governance-'));
  roots.push(root);
  redirectRelativePaths = false;
  authority.existsSync.mockReset();
  authority.existsSync.mockImplementation((path: string) => nodeExistsSync(diskPath(path)));
  authority.readFileSync.mockReset();
  authority.readFileSync.mockImplementation((path: string) =>
    nodeReadFileSync(diskPath(path), 'utf8'),
  );
  authority.readdirSync.mockReset();
  authority.readdirSync.mockImplementation((path: string) => nodeReaddirSync(diskPath(path)));
  authority.spawnSync.mockReset();
  authority.spawnSync.mockImplementation((command: string) =>
    command === 'git' ? processResult(0, 'deadbeef\trefs/heads/gh-pages\n') : processResult(0),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fixtureRoot of roots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  root = '';
});

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function configure(
  kind: 'library' | 'application' | string = 'application',
  builder: 'docusaurus' | 'jekyll' | string = 'docusaurus',
  extraDocs: Record<string, unknown> = {},
): void {
  write(
    '.devai/config/project.json',
    `${JSON.stringify({ repo: { kind }, docs: { builder, build_command: 'docs-tool build', ...extraDocs } })}\n`,
  );
}

function validDocusaurusFixture(): void {
  configure();
  write(
    'docs/site/docusaurus.config.ts',
    "export default {\n  url: 'https://docs.acme.test',\n  organizationName: 'acme',\n};\n",
  );
  write('docs/site/sidebars.ts', "export default [{ label: 'Start', type: 'category' }];\n");
  write('docs/site/package.json', '{"private":true}\n');
  write('docs/start/index.md', '# Start\n');
  write('law/.keep', 'framework\n');
}

function report(
  options: { repoRoot?: string; noPublishCheck?: boolean } = {},
): DocsGovernanceReport {
  return checkDocsGovernance({ repoRoot: root, noPublishCheck: true, ...options });
}

function finding(ruleId: string, options?: { noPublishCheck?: boolean }): GovernanceFinding {
  const value = report(options).findings.find((candidate) => candidate.ruleId === ruleId);
  if (value === undefined) throw new Error(`MISSING_FINDING:${ruleId}`);
  return value;
}

describe('S06-B docs governance configuration decisions', () => {
  it('returns the complete missing-configuration findings and aggregate', () => {
    const value = report();
    expect(value).toMatchObject({ verdict: 'fail', rules_checked: 14 });
    expect(value.findings[0]).toEqual({
      ruleId: 'docs-governance.classification',
      severity: 'fail',
      message: '.devai/config/project.json is missing or unreadable',
      remediation:
        'Create .devai/config/project.json with repo.kind set to one of: library, application. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json'],
    });
    expect(value.findings[1]).toEqual({
      ruleId: 'docs-governance.builder-declared',
      severity: 'fail',
      message: 'Cannot check docs.builder — .devai/config/project.json is missing',
      remediation:
        'Add docs.builder to .devai/config/project.json. Allowed values: docusaurus, jekyll. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json'],
    });
    expect(value.findings[2]).toEqual({
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'pass',
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    expect(value.findings[4]).toEqual({
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'pass',
      message: 'Skipped — builder is unresolvable (see prior findings)',
    });
    expect(value.findings[8]).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'Skipped — rule only applies to docs.builder = "docusaurus"',
    });
  });

  it('binds invalid and valid classification findings to the exact configured kind', () => {
    configure('service');
    expect(finding('docs-governance.classification')).toEqual({
      ruleId: 'docs-governance.classification',
      severity: 'fail',
      message: 'repo.kind must be one of [library, application]; got service',
      remediation:
        'Set repo.kind in .devai/config/project.json to "library" or "application". See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json#/repo/kind'],
    });
    configure('library');
    expect(finding('docs-governance.classification')).toEqual({
      ruleId: 'docs-governance.classification',
      severity: 'pass',
      message: 'repo.kind = "library" — valid',
    });
  });

  it('binds invalid and valid builder findings to the exact configured builder', () => {
    configure('application', 'mkdocs');
    expect(finding('docs-governance.builder-declared')).toEqual({
      ruleId: 'docs-governance.builder-declared',
      severity: 'fail',
      message: 'docs.builder must be one of [docusaurus, jekyll]; got mkdocs',
      remediation:
        'Set docs.builder in .devai/config/project.json. For library repos: "docusaurus" (required). For application repos: "docusaurus" (default) or "jekyll" (requires opt-out ADR). See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json#/docs/builder'],
    });
    configure('application', 'jekyll');
    expect(finding('docs-governance.builder-declared')).toEqual({
      ruleId: 'docs-governance.builder-declared',
      severity: 'pass',
      message: 'docs.builder = "jekyll" — valid',
    });

    write(
      '.devai/config/project.json',
      `${JSON.stringify({ repo: { kind: 'application' }, docs: {} })}\n`,
    );
    expect(finding('docs-governance.builder-declared')).toEqual({
      ruleId: 'docs-governance.builder-declared',
      severity: 'fail',
      message: 'docs.builder must be one of [docusaurus, jekyll]; got undefined',
      remediation:
        'Set docs.builder in .devai/config/project.json. For library repos: "docusaurus" (required). For application repos: "docusaurus" (default) or "jekyll" (requires opt-out ADR). See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json#/docs/builder'],
    });
  });

  it('distinguishes every public library-builder decision', () => {
    expect(finding('docs-governance.library-docusaurus-required')).toEqual({
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'pass',
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    configure('application', 'jekyll');
    expect(finding('docs-governance.library-docusaurus-required')).toEqual({
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'pass',
      message: 'Not a library repo — rule does not apply',
    });
    configure('library', 'jekyll');
    expect(finding('docs-governance.library-docusaurus-required')).toEqual({
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'fail',
      message: 'Library repos MUST use Docusaurus; got docs.builder = "jekyll"',
      remediation:
        'Change docs.builder to "docusaurus" in .devai/config/project.json. Libraries have no opt-out because downstream consumers require searchable, versioned API documentation. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['.devai/config/project.json#/docs/builder'],
    });
    configure('library', 'docusaurus');
    expect(finding('docs-governance.library-docusaurus-required')).toEqual({
      ruleId: 'docs-governance.library-docusaurus-required',
      severity: 'pass',
      message: 'Library correctly uses docusaurus',
    });
  });

  it('keeps dependent rules unavailable when either classification input is invalid', () => {
    configure('application', 'mkdocs');
    expect(finding('docs-governance.library-docusaurus-required')).toMatchObject({
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    expect(finding('docs-governance.opt-out-adr-required')).toMatchObject({
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    write(
      '.devai/config/project.json',
      `${JSON.stringify({ repo: {}, docs: { builder: 'docusaurus', build_command: '' } })}\n`,
    );
    expect(finding('docs-governance.library-docusaurus-required')).toMatchObject({
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    expect(finding('docs-governance.opt-out-adr-required')).toMatchObject({
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
  });
});

describe('S06-B docs governance opt-out and site-shape decisions', () => {
  it('preserves the complete opt-out skip, not-applicable, missing, and accepted findings', () => {
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Skipped — classification or builder is unresolvable (see prior findings)',
    });
    configure('application', 'docusaurus');
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Not applicable — only required for application + jekyll combination',
    });
    configure('application', 'jekyll');
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message: 'Application + jekyll requires law/adr/ADR-DOCS-BUILDER-OPT-OUT.md — file not found',
      remediation:
        'Create law/adr/ADR-DOCS-BUILDER-OPT-OUT.md recording: rationale (why Docusaurus is wrong for this repo), reviewer (named human + date), and sunset trigger. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    });
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', 'Rationale\nReviewer\nDate\nSunset\n');
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Opt-out ADR present with required sections',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    });
  });

  it('reports every missing opt-out section in declared order', () => {
    configure('application', 'jekyll');
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', 'Rationale only\n');
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message:
        'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md is missing required section(s): reviewer, date, sunset',
      remediation:
        'Ensure the opt-out ADR includes: "rationale", "reviewer", "date", and "sunset" sections. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    });
  });

  it('does not require an application opt-out ADR from a Jekyll library', () => {
    configure('library', 'jekyll');
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'pass',
      message: 'Not applicable — only required for application + jekyll combination',
    });
  });

  it('fails closed with the exact unreadable opt-out finding', () => {
    configure('application', 'jekyll');
    const adr = join(root, 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md');
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', 'Rationale\nReviewer\nDate\nSunset\n');
    authority.readFileSync.mockImplementation((path: string) => {
      if (path === adr) throw new Error('fixture-denied');
      return nodeReadFileSync(path, 'utf8');
    });
    expect(finding('docs-governance.opt-out-adr-required')).toEqual({
      ruleId: 'docs-governance.opt-out-adr-required',
      severity: 'fail',
      message: 'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md is unreadable',
      locations: ['law/adr/ADR-DOCS-BUILDER-OPT-OUT.md'],
    });
  });

  it('reports the complete Jekyll shape and each missing member', () => {
    configure('application', 'jekyll');
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', 'Rationale\nReviewer\nDate\nSunset\n');
    expect(finding('docs-governance.site-dir-shape')).toEqual({
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'fail',
      message:
        'docs/site/ is missing expected jekyll file(s): docs/site/_config.yml, docs/site/Gemfile',
      remediation:
        'Initialize a Jekyll site under docs/site/ (jekyll new docs/site). Required: _config.yml, Gemfile. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: ['docs/site/_config.yml', 'docs/site/Gemfile'],
    });
    write('docs/site/_config.yml', 'title: fixture\n');
    expect(finding('docs-governance.site-dir-shape')).toMatchObject({
      message: 'docs/site/ is missing expected jekyll file(s): docs/site/Gemfile',
      locations: ['docs/site/Gemfile'],
    });
    write('docs/site/Gemfile', "source 'https://rubygems.org'\n");
    expect(finding('docs-governance.site-dir-shape')).toEqual({
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'pass',
      message: 'docs/site/ has expected jekyll structure',
    });
  });

  it('reports the complete Docusaurus shape and exact remediation', () => {
    configure();
    expect(finding('docs-governance.site-dir-shape')).toEqual({
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'fail',
      message:
        'docs/site/ is missing expected docusaurus file(s): docs/site/docusaurus.config.ts (or .js), docs/site/sidebars.ts (or .js), docs/site/package.json',
      remediation:
        'Scaffold a Docusaurus site under docs/site/ (npx create-docusaurus@latest docs/site classic --typescript). Required: docusaurus.config.ts, sidebars.ts, package.json. See docs/adopters/docs-layout.md#repository-classification-and-builder.',
      locations: [
        'docs/site/docusaurus.config.ts (or .js)',
        'docs/site/sidebars.ts (or .js)',
        'docs/site/package.json',
      ],
    });
    write('docs/site/docusaurus.config.js', 'module.exports = {};\n');
    write('docs/site/sidebars.js', 'module.exports = {};\n');
    write('docs/site/package.json', '{"private":true}\n');
    expect(finding('docs-governance.site-dir-shape')).toEqual({
      ruleId: 'docs-governance.site-dir-shape',
      severity: 'pass',
      message: 'docs/site/ has expected docusaurus structure',
    });
  });
});

describe('S06-B docs governance filesystem and process effects', () => {
  it.each([
    [null, null, 'warn'],
    [127, 127, 'warn'],
    [1, 1, 'warn'],
    [2, 0, 'pass'],
    [0, 127, 'pass'],
  ] as const)('distinguishes toolchain statuses %s then %s', (first, second, severity) => {
    configure('application', 'docusaurus', { build_command: 'custom-docs build' });
    authority.spawnSync.mockImplementation((command: string, args: readonly string[]) =>
      command === 'custom-docs'
        ? processResult(args[0] === '--version' ? first : second)
        : processResult(0, 'deadbeef\trefs/heads/gh-pages\n'),
    );
    const value = finding('docs-governance.build-toolchain');
    expect(value.severity).toBe(severity);
    expect(value).toEqual(
      severity === 'pass'
        ? {
            ruleId: 'docs-governance.build-toolchain',
            severity: 'pass',
            message: `Build toolchain "custom-docs" is on PATH and responds to ${first === 0 ? '--version' : '--help'}`,
          }
        : {
            ruleId: 'docs-governance.build-toolchain',
            severity: 'warn',
            message:
              'Build toolchain "custom-docs" may not be on PATH or does not respond to --version/--help',
            remediation:
              'Install the build toolchain for builder="docusaurus". For Docusaurus: ensure Node.js is installed and run "npm install" under docs/site/. For Jekyll: install Ruby and run "bundle install" in docs/site/.',
          },
    );
  });

  it('distinguishes absent, unreadable, clean, and violating workflow populations', () => {
    configure();
    expect(finding('docs-governance.no-ci-publish')).toEqual({
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'pass',
      message: 'No .github/workflows/ directory — no CI publish workflow to check',
    });

    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    authority.readdirSync.mockImplementation((path: string) => {
      if (path === join(root, '.github/workflows')) throw new Error('fixture-denied');
      return nodeReaddirSync(path);
    });
    expect(finding('docs-governance.no-ci-publish')).toEqual({
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'pass',
      message: 'Could not read .github/workflows/ directory',
    });

    authority.readdirSync.mockImplementation((path: string) => nodeReaddirSync(path));
    expect(finding('docs-governance.no-ci-publish')).toEqual({
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'pass',
      message: 'No CI docs-publish workflow found',
    });
    write('.github/workflows/notes.txt', 'uses: actions/deploy-pages@v4\n');
    write('.github/workflows/check.yml', 'jobs: {}\n');
    write('.github/workflows/release.yaml', 'uses: actions/deploy-pages@v4\n');
    expect(finding('docs-governance.no-ci-publish')).toEqual({
      ruleId: 'docs-governance.no-ci-publish',
      severity: 'fail',
      message:
        'Found CI docs-publish workflow(s) — documentation publishing must be an explicitly authorized local effect; see docs/adopters/docs-layout.md#publication-boundary',
      remediation:
        'Remove or disable the GH Actions documentation-deployment workflow. CI validates freshness and does not publish the site.',
      locations: ['.github/workflows/release.yaml'],
    });
  });

  it('records one violation per workflow and continues past unreadable files', () => {
    configure();
    write(
      '.github/workflows/a.yml',
      'uses: peaceiris/actions-gh-pages@v4\nuses: actions/deploy-pages@v4\n',
    );
    write('.github/workflows/b.yaml', 'uses: JamesIves/github-pages-deploy-action@v4\n');
    write('.github/workflows/c.yml', 'jobs: {}\n');
    const unreadable = join(root, '.github/workflows/c.yml');
    authority.readFileSync.mockImplementation((path: string) => {
      if (path === unreadable) throw new Error('fixture-denied');
      return nodeReadFileSync(path, 'utf8');
    });
    expect(finding('docs-governance.no-ci-publish')).toMatchObject({
      severity: 'fail',
      locations: ['.github/workflows/a.yml', '.github/workflows/b.yaml'],
    });
  });
});

describe('S06-B docs governance placeholder decisions', () => {
  it.each([
    ['http://example.com', 'url="http://example.com"'],
    ['https://your-docusaurus-site.example.com', 'url="https://your-docusaurus-site.example.com"'],
    ['https://localhost:1234', 'url="https://localhost:1234"'],
  ])('rejects the exact placeholder URL %s', (url, rendered) => {
    configure();
    write(
      'docs/site/docusaurus.config.ts',
      `export default {\n  url: '${url}',\n  organizationName: 'acme',\n};\n`,
    );
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'fail',
      message: `docs/site/docusaurus.config.ts contains placeholder value(s): ${rendered}`,
      remediation:
        'Update `url`/`organizationName` in `docs/site/docusaurus.config.ts` to match your deployment. For GitHub Pages project pages, url should be `https://<org>.github.io` and organizationName should be `<org>`.',
      locations: ['docs/site/docusaurus.config.ts:2'],
    });
  });

  it.each(['facebook', 'organization-name', 'your-org', 'placeholder', 'devai-org'])(
    'rejects the exact placeholder organization %s',
    (organizationName) => {
      configure();
      write(
        'docs/site/docusaurus.config.js',
        `module.exports = {\n  url: 'https://docs.acme.test',\n  organizationName: '${organizationName}',\n};\n`,
      );
      expect(finding('docs-governance.config-not-placeholder')).toEqual({
        ruleId: 'docs-governance.config-not-placeholder',
        severity: 'fail',
        message: `docs/site/docusaurus.config.js contains placeholder value(s): organizationName="${organizationName}"`,
        remediation:
          'Update `url`/`organizationName` in `docs/site/docusaurus.config.js` to match your deployment. For GitHub Pages project pages, url should be `https://<org>.github.io` and organizationName should be `<org>`.',
        locations: ['docs/site/docusaurus.config.js:3'],
      });
    },
  );

  it('does not treat placeholder substrings or extra URL paths as exact placeholders', () => {
    configure();
    write(
      'docs/site/docusaurus.config.ts',
      "export default {\n  url: 'prefix-https://your-docusaurus-site.example.com/extra',\n  organizationName: 'your-org-docs',\n};\n",
    );
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'docs/site/docusaurus.config.ts has no placeholder url or organizationName',
    });
  });

  it('does not match a placeholder URL after a non-URL prefix', () => {
    const url = 'prefix-https://your-docusaurus-site.example.com';
    configure();
    write(
      'docs/site/docusaurus.config.ts',
      `export default {\n  url: '${url}',\n  organizationName: 'acme',\n};\n`,
    );
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'docs/site/docusaurus.config.ts has no placeholder url or organizationName',
    });
  });

  it('rejects localhost without a port as an exact placeholder URL', () => {
    configure();
    write(
      'docs/site/docusaurus.config.ts',
      "export default {\n  url: 'https://localhost',\n  organizationName: 'acme',\n};\n",
    );
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'fail',
      message:
        'docs/site/docusaurus.config.ts contains placeholder value(s): url="https://localhost"',
      remediation:
        'Update `url`/`organizationName` in `docs/site/docusaurus.config.ts` to match your deployment. For GitHub Pages project pages, url should be `https://<org>.github.io` and organizationName should be `<org>`.',
      locations: ['docs/site/docusaurus.config.ts:2'],
    });
  });

  it('warns on unreadable and unparseable configuration with exact locations', () => {
    configure();
    const config = join(root, 'docs/site/docusaurus.config.ts');
    write('docs/site/docusaurus.config.ts', 'export default {};\n');
    authority.readFileSync.mockImplementation((path: string) => {
      if (path === config) throw new Error('fixture-denied');
      return nodeReadFileSync(path, 'utf8');
    });
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'warn',
      message: 'could not read docs/site/docusaurus.config.ts; manual review recommended',
      locations: ['docs/site/docusaurus.config.ts'],
    });

    authority.readFileSync.mockImplementation((path: string) => nodeReadFileSync(path, 'utf8'));
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'warn',
      message:
        'could not parse url/baseUrl/organizationName from docs/site/docusaurus.config.ts; manual review recommended',
      locations: ['docs/site/docusaurus.config.ts'],
    });
  });

  it('skips placeholder inspection for Jekyll and absent Docusaurus configuration', () => {
    configure('application', 'jekyll');
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'Skipped — rule only applies to docs.builder = "docusaurus"',
    });
    configure();
    expect(finding('docs-governance.config-not-placeholder')).toEqual({
      ruleId: 'docs-governance.config-not-placeholder',
      severity: 'pass',
      message: 'Skipped — config file absent (covered by rule 5)',
    });
  });
});

describe('S06-B documentation information-architecture decisions', () => {
  it('selects the first available landing path and reports the normalized repository-relative path', () => {
    configure();
    write('docs/start/index.md', '# Start\n');
    expect(finding('docs-ia.landing-exists')).toEqual({
      ruleId: 'docs-ia.landing-exists',
      severity: 'pass',
      message: 'Landing present (docs/start/index.md)',
    });
    write('docs/site/src/pages/index.tsx', 'export default function Home() { return null; }\n');
    expect(finding('docs-ia.landing-exists')).toEqual({
      ruleId: 'docs-ia.landing-exists',
      severity: 'pass',
      message: 'Landing present (docs/site/src/pages/index.tsx)',
    });
  });

  it('covers constitution absence, missing projection, malformed versions, and missing snapshots', () => {
    configure();
    expect(finding('docs-ia.constitution-published')).toEqual({
      ruleId: 'docs-ia.constitution-published',
      severity: 'pass',
      message: 'No law/constitution.md — rule N/A',
    });
    write('law/constitution.md', '# Constitution\n');
    expect(finding('docs-ia.constitution-published')).toEqual({
      ruleId: 'docs-ia.constitution-published',
      severity: 'fail',
      message: 'Constitution exists at repo root but no Pages destination is set up.',
      remediation: 'Publish the law projection at docs/reference/law.md and run the site sync.',
    });
    write('docs/reference/law.md', '# Projection\n');
    write('docs/site/versions.json', '{bad json\n');
    expect(finding('docs-ia.constitution-published')).toEqual({
      ruleId: 'docs-ia.constitution-published',
      severity: 'pass',
      message: 'Constitution published per docs/adopters/docs-layout.md#information-architecture',
    });
    write('docs/site/versions.json', '["1.4.5","1.3.0"]\n');
    expect(finding('docs-ia.constitution-published')).toEqual({
      ruleId: 'docs-ia.constitution-published',
      severity: 'fail',
      message: 'versioned_docs missing constitution snapshot for: 1.4.5, 1.3.0',
      remediation: 'Re-run docusaurus docs:version <v> for the missing version(s).',
    });
    write('docs/site/versioned_docs/version-1.4.5/framework/constitution.md', '# 1.4.5\n');
    expect(finding('docs-ia.constitution-published')).toMatchObject({
      message: 'versioned_docs missing constitution snapshot for: 1.3.0',
    });
    write('docs/site/versioned_docs/version-1.3.0/framework/constitution.md', '# 1.3.0\n');
    expect(finding('docs-ia.constitution-published')).toMatchObject({
      severity: 'pass',
    });
  });

  it('distinguishes sidebar absence, degenerate autogeneration, labels, and multiple generators', () => {
    configure();
    expect(finding('docs-ia.sidebar-curated')).toEqual({
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'pass',
      message: 'No sidebars.ts/js (Docusaurus default sidebar)',
    });
    write('docs/site/sidebars.ts', "export default [{ type: 'autogenerated' }];\n");
    expect(finding('docs-ia.sidebar-curated')).toEqual({
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'fail',
      message: 'sidebars.ts appears to be fully autogenerated with no explicit category labels.',
      remediation:
        'Author a curated sidebar with explicit `label:` fields. See docs/adopters/docs-layout.md#information-architecture.',
    });
    write('docs/site/sidebars.ts', "export default [{ label: 'Start', type: 'autogenerated' }];\n");
    expect(finding('docs-ia.sidebar-curated')).toEqual({
      ruleId: 'docs-ia.sidebar-curated',
      severity: 'pass',
      message: 'Sidebar carries explicit labels',
    });
    write(
      'docs/site/sidebars.ts',
      "export default [{ type: 'autogenerated' }, { type: 'autogenerated' }];\n",
    );
    expect(finding('docs-ia.sidebar-curated')).toMatchObject({ severity: 'pass' });
  });

  it.each([
    [false, false, 'law/, docs/'],
    [true, false, 'docs/'],
    [false, true, 'law/'],
  ] as const)('reports sibling directory presence law=%s docs=%s', (law, docs, missing) => {
    configure();
    if (law) write('law/.keep', 'law\n');
    if (docs) write('docs/.keep', 'docs\n');
    if (!docs) rmSync(join(root, 'docs'), { recursive: true, force: true });
    expect(finding('docs-ia.framework-meta-split')).toEqual({
      ruleId: 'docs-ia.framework-meta-split',
      severity: 'fail',
      message: `Law/Docs sibling split missing: ${missing}`,
      remediation: 'Create the missing law or documentation directory.',
    });
  });

  it('accepts the complete framework and documentation sibling split', () => {
    configure();
    write('law/.keep', 'law\n');
    write('docs/.keep', 'docs\n');
    expect(finding('docs-ia.framework-meta-split')).toEqual({
      ruleId: 'docs-ia.framework-meta-split',
      severity: 'pass',
      message: 'law/ and docs/ are siblings',
    });
  });

  it('reports dashboard age using exact parsing, arithmetic, ordering, and locations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'));
    configure();
    write(
      'docs/site/docs/theory/framework/aspect-grid.md',
      '---\nlast_built_at: 2026-08-10T00:00:00.000Z\n---\n',
    );
    write(
      'docs/site/docs/reference/test-matrix.md',
      '---\nlast_built_at: 2026-07-01T00:00:00.000Z\n---\n',
    );
    write(
      'docs/site/docs/reference/self-scorecard.md',
      '---\nlast_built_at: 2026-08-12T00:00:00.000Z\n---\n',
    );
    expect(finding('docs-ia.dashboard-current')).toEqual({
      ruleId: 'docs-ia.dashboard-current',
      severity: 'warn',
      message:
        'Dashboards older than 30 days: docs/site/docs/theory/framework/aspect-grid.md (32 days old); docs/site/docs/reference/test-matrix.md (72 days old)',
      remediation:
        'Run npm run sync-docs to refresh build-frozen dashboards before publication. See docs/adopters/docs-layout.md#information-architecture.',
    });
  });

  it('accepts a dashboard timestamp with no whitespace after the field separator', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'));
    configure();
    write(
      'docs/site/docs/reference/self-scorecard.md',
      '---\nlast_built_at:2026-08-10T00:00:00.000Z\n---\n',
    );
    expect(finding('docs-ia.dashboard-current')).toMatchObject({
      severity: 'warn',
      message:
        'Dashboards older than 30 days: docs/site/docs/reference/self-scorecard.md (32 days old)',
    });
  });

  it('skips unreadable, missing, unmarked, malformed, and exactly-30-day dashboards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'));
    configure();
    const dashboard = join(root, 'docs/site/docs/reference/self-scorecard.md');
    write(
      'docs/site/docs/reference/self-scorecard.md',
      'last_built_at: 2026-08-12T00:00:00.000Z\n',
    );
    authority.readFileSync.mockImplementation((path: string) => {
      if (path === dashboard) throw new Error('fixture-denied');
      return nodeReadFileSync(path, 'utf8');
    });
    expect(finding('docs-ia.dashboard-current')).toEqual({
      ruleId: 'docs-ia.dashboard-current',
      severity: 'pass',
      message: 'Dashboards current (or absent)',
    });
    authority.readFileSync.mockImplementation((path: string) => nodeReadFileSync(path, 'utf8'));
    write('docs/site/docs/reference/self-scorecard.md', 'last_built_at: invalid\n');
    expect(finding('docs-ia.dashboard-current')).toMatchObject({ severity: 'pass' });
    write('docs/site/docs/reference/self-scorecard.md', 'no timestamp\n');
    expect(finding('docs-ia.dashboard-current')).toMatchObject({ severity: 'pass' });
  });
});

describe('S06-B docs governance aggregate and public command', () => {
  it('returns exact pass, warning, and failure aggregates', () => {
    validDocusaurusFixture();
    expect(report()).toEqual({
      verdict: 'pass',
      rules_checked: 14,
      findings: expect.any(Array),
      fail_count: 0,
      warn_count: 0,
    });
    authority.spawnSync.mockImplementation((command: string) =>
      command === 'git' ? processResult(3) : processResult(0),
    );
    expect(report({ noPublishCheck: false })).toMatchObject({
      verdict: 'warn',
      fail_count: 0,
      warn_count: 1,
    });
    rmSync(join(root, 'docs/site/package.json'));
    expect(report()).toMatchObject({ verdict: 'fail', fail_count: 1, warn_count: 0 });
  });

  it('uses default public options and emits an exact JSON report with a passing exit', () => {
    validDocusaurusFixture();
    let action: ((options: Record<string, unknown>) => void) | undefined;
    const command = {
      option: vi.fn().mockReturnThis(),
      action: vi.fn((callback: (options: Record<string, unknown>) => void) => {
        action = callback;
        return command;
      }),
    };
    const cli = { command: vi.fn(() => command) } as unknown as CAC;
    checkDocsGovernanceCmd.register(cli);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT:${String(code)}`);
    });
    expect(() => action?.({ repoRoot: root, skipPublishCheck: true })).toThrow('EXIT:0');
    expect(stdout).toHaveBeenCalledTimes(1);
    const emitted = String(stdout.mock.calls[0]?.[0]);
    expect(JSON.parse(emitted)).toEqual(report());
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('binds omitted public options to cwd and performs the publication check', () => {
    validDocusaurusFixture();
    redirectRelativePaths = true;
    authority.spawnSync.mockImplementation((command: string) =>
      command === 'git' ? processResult(3) : processResult(0),
    );
    expect(checkDocsGovernance()).toMatchObject({
      verdict: 'warn',
      fail_count: 0,
      warn_count: 1,
    });
    expect(authority.spawnSync).toHaveBeenCalledWith('git', ['ls-remote', 'origin', 'gh-pages'], {
      cwd: '.',
      encoding: 'utf8',
      timeout: 15_000,
    });
  });

  it.each([
    ['pass', 'PASS', '✓'],
    ['warn', 'WARN', '!'],
    ['fail', 'FAIL', '✗'],
  ] as const)('renders the exact %s human verdict and icon', (mode, label, icon) => {
    validDocusaurusFixture();
    if (mode === 'warn') {
      authority.spawnSync.mockImplementation((command: string) =>
        command === 'git' ? processResult(3) : processResult(0),
      );
    } else if (mode === 'fail') {
      rmSync(join(root, 'docs/site/package.json'));
    }
    let action: ((options: Record<string, unknown>) => void) | undefined;
    const command = {
      option: vi.fn().mockReturnThis(),
      action: vi.fn((callback: (options: Record<string, unknown>) => void) => {
        action = callback;
        return command;
      }),
    };
    checkDocsGovernanceCmd.register({ command: vi.fn(() => command) } as unknown as CAC);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT:${String(code)}`);
    });
    expect(() =>
      action?.({
        repoRoot: root,
        skipPublishCheck: mode !== 'warn',
        human: true,
      }),
    ).toThrow(`EXIT:${mode === 'fail' ? '2' : '0'}`);
    const emitted = String(stdout.mock.calls[0]?.[0]);
    expect(emitted).toMatch(new RegExp(`^check docs-governance: ${label} \\(`));
    expect(emitted).toContain(`  [${icon}] `);
    expect(emitted.endsWith('\n')).toBe(true);
  });
});
