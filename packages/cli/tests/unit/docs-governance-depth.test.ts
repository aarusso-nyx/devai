import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { checkDocsGovernance } from '../../src/commands/check/docs-governance.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-docs-governance-depth-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function report() {
  return checkDocsGovernance({ repoRoot: root, noPublishCheck: true });
}

function finding(ruleId: string) {
  return report().findings.find((entry) => entry.ruleId === ruleId);
}

describe('docs-governance public report boundaries', () => {
  it('resolves the default Docusaurus toolchain when no build command is configured', async () => {
    write(
      '.devai/config/project.json',
      JSON.stringify({
        repo: { kind: 'application' },
        docs: { builder: 'docusaurus' },
      }),
    );
    write('bin/npx', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'bin/npx'), 0o700);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = join(root, 'bin');
      const result = await withAuthorityHostTestScope(() =>
        finding('docs-governance.build-toolchain'),
      );
      expect(result).toMatchObject({
        severity: 'pass',
        message: 'Build toolchain "npx" is on PATH and responds to --version',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
  it('fails closed when project configuration is absent or malformed', () => {
    expect(finding('docs-governance.classification')).toMatchObject({ severity: 'fail' });
    expect(finding('docs-governance.builder-declared')).toMatchObject({ severity: 'fail' });

    write('.devai/config/project.json', '{"repo":');
    expect(finding('docs-governance.classification')).toMatchObject({
      severity: 'fail',
      message: expect.stringContaining('missing or unreadable'),
    });
    expect(report().verdict).toBe('fail');
  });

  it('reports invalid kind and builder as distinct configuration failures', () => {
    write(
      '.devai/config/project.json',
      JSON.stringify({ repo: { kind: 'service' }, docs: { builder: 'mkdocs' } }),
    );

    expect(finding('docs-governance.classification')).toMatchObject({
      severity: 'fail',
      message: expect.stringContaining('repo.kind must be one of'),
    });
    expect(finding('docs-governance.builder-declared')).toMatchObject({
      severity: 'fail',
      message: expect.stringContaining('docs.builder must be one of'),
    });
  });

  it('requires the opt-out ADR for application Jekyll projects and accepts all required sections', () => {
    write(
      '.devai/config/project.json',
      JSON.stringify({
        repo: { kind: 'application' },
        docs: { builder: 'jekyll', build_command: '' },
      }),
    );
    expect(finding('docs-governance.opt-out-adr-required')).toMatchObject({ severity: 'fail' });

    write(
      'law/adr/ADR-DOCS-BUILDER-OPT-OUT.md',
      '# Rationale\n\n## Reviewer\n\n## Date\n\n## Sunset\n',
    );
    expect(finding('docs-governance.opt-out-adr-required')).toMatchObject({
      severity: 'pass',
      message: expect.stringContaining('required sections'),
    });
  });

  it('reports a concrete CI documentation publisher while skipping remote branch lookup', () => {
    write(
      '.devai/config/project.json',
      JSON.stringify({
        repo: { kind: 'application' },
        docs: { builder: 'jekyll', build_command: '' },
      }),
    );
    write('law/adr/ADR-DOCS-BUILDER-OPT-OUT.md', '# rationale\nreviewer\ndate\nsunset\n');
    write('.github/workflows/publish-docs.yml', 'uses: peaceiris/actions-gh-pages@v4\n');

    expect(finding('docs-governance.gh-pages-branch')).toMatchObject({
      severity: 'pass',
      message: expect.stringContaining('skipped'),
    });
    expect(finding('docs-governance.no-ci-publish')).toMatchObject({ severity: 'fail' });
    expect(finding('docs-governance.no-ci-publish')?.locations).toEqual([
      '.github/workflows/publish-docs.yml',
    ]);
  });
});

it('requires libraries to use Docusaurus while accepting the valid library builder', () => {
  write(
    '.devai/config/project.json',
    JSON.stringify({
      repo: { kind: 'library' },
      docs: { builder: 'jekyll', build_command: '' },
    }),
  );
  expect(finding('docs-governance.library-docusaurus-required')).toMatchObject({
    severity: 'fail',
    message: 'Library repos MUST use Docusaurus; got docs.builder = "jekyll"',
  });

  write(
    '.devai/config/project.json',
    JSON.stringify({
      repo: { kind: 'library' },
      docs: { builder: 'docusaurus', build_command: '' },
    }),
  );
  expect(finding('docs-governance.library-docusaurus-required')).toMatchObject({
    severity: 'pass',
    message: 'Library correctly uses docusaurus',
  });
});

it('accepts either Docusaurus config/sidebar extension and reports each missing required member', () => {
  write(
    '.devai/config/project.json',
    JSON.stringify({
      repo: { kind: 'application' },
      docs: { builder: 'docusaurus', build_command: '' },
    }),
  );
  write(
    'docs/site/docusaurus.config.ts',
    'export default { url: "https://docs.example.test", organizationName: "acme" };\n',
  );
  write('docs/site/sidebars.js', 'module.exports = {};\n');
  write('docs/site/package.json', '{"private":true}\n');
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({
    severity: 'pass',
    message: 'docs/site/ has expected docusaurus structure',
  });

  rmSync(join(root, 'docs/site/docusaurus.config.ts'));
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({
    severity: 'fail',
    locations: ['docs/site/docusaurus.config.ts (or .js)'],
  });
  write('docs/site/docusaurus.config.js', 'module.exports = {};\n');
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({ severity: 'pass' });

  rmSync(join(root, 'docs/site/sidebars.js'));
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({
    severity: 'fail',
    locations: ['docs/site/sidebars.ts (or .js)'],
  });
  write('docs/site/sidebars.ts', 'export default {};\n');
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({ severity: 'pass' });

  rmSync(join(root, 'docs/site/package.json'));
  expect(finding('docs-governance.site-dir-shape')).toMatchObject({
    severity: 'fail',
    locations: ['docs/site/package.json'],
  });
});
