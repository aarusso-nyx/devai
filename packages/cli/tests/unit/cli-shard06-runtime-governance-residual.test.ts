import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: host.spawnSync,
}));

import { checkDocsGovernance } from '../../src/commands/check/docs-governance.js';

const roots: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-cli-s06b-residual-'));
  roots.push(root);
  host.spawnSync.mockReset();
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const fixtureRoot of roots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function configure(buildCommand: string, branch = 'release-pages'): void {
  write(
    '.devai/config/project.json',
    `${JSON.stringify({
      repo: { kind: 'application' },
      docs: {
        builder: 'docusaurus',
        build_command: buildCommand,
        gh_pages_branch: branch,
      },
    })}\n`,
  );
}

function result(status: number | null, stdout = '', stderr = '') {
  return { status, stdout, stderr, signal: null, pid: 1, output: [] };
}

function finding(ruleId: string) {
  return checkDocsGovernance({ repoRoot: root }).findings.find(
    (candidate) => candidate.ruleId === ruleId,
  );
}

describe('S06-B residual documentation-governance process outcomes', () => {
  it('requires the second toolchain probe to succeed after a controlled nonzero result', () => {
    configure('custom-docs build');
    host.spawnSync.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'custom-docs') return result(args[0] === '--version' ? 2 : 0);
      return result(0, 'deadbeef\trefs/heads/release-pages\n');
    });

    expect(finding('docs-governance.build-toolchain')).toEqual({
      ruleId: 'docs-governance.build-toolchain',
      severity: 'pass',
      message: 'Build toolchain "custom-docs" is on PATH and responds to --help',
    });
    expect(host.spawnSync.mock.calls.slice(0, 2).map((call) => call.slice(0, 2))).toEqual([
      ['custom-docs', ['--version']],
      ['custom-docs', ['--help']],
    ]);
    for (const call of host.spawnSync.mock.calls.slice(0, 2)) {
      expect(call[2]).toEqual({
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        shell: false,
      });
    }
  });

  it('does not mistake controlled nonzero toolchain exits for successful probes', () => {
    configure('custom-docs build');
    host.spawnSync.mockImplementation((command: string) =>
      command === 'custom-docs' ? result(2) : result(0, 'deadbeef\trefs/heads/release-pages\n'),
    );

    expect(finding('docs-governance.build-toolchain')).toEqual({
      ruleId: 'docs-governance.build-toolchain',
      severity: 'warn',
      message:
        'Build toolchain "custom-docs" may not be on PATH or does not respond to --version/--help',
      remediation:
        'Install the build toolchain for builder="docusaurus". For Docusaurus: ensure Node.js is installed and run "npm install" under docs/site/. For Jekyll: install Ruby and run "bundle install" in docs/site/.',
    });
  });

  it('uses the declared Docusaurus command as an explicit npx-style fallback', () => {
    configure('missing-tool docusaurus build');
    host.spawnSync.mockImplementation((command: string) =>
      command === 'missing-tool' ? result(127) : result(0, 'deadbeef\trefs/heads/release-pages\n'),
    );

    expect(finding('docs-governance.build-toolchain')).toEqual({
      ruleId: 'docs-governance.build-toolchain',
      severity: 'pass',
      message:
        'Build toolchain uses npx — resolved by npx at build time (not validated pre-install)',
    });
  });

  it('recognizes npx itself when the configured arguments do not name Docusaurus', () => {
    configure('npx custom-docs build');
    host.spawnSync.mockImplementation((command: string) =>
      command === 'npx' ? result(127) : result(0, 'deadbeef\trefs/heads/release-pages\n'),
    );

    expect(finding('docs-governance.build-toolchain')).toEqual({
      ruleId: 'docs-governance.build-toolchain',
      severity: 'pass',
      message:
        'Build toolchain uses npx — resolved by npx at build time (not validated pre-install)',
    });
  });

  it('reports the complete remediation for an explicitly empty build command', () => {
    configure('');
    host.spawnSync.mockImplementation(() => result(0, 'deadbeef\trefs/heads/release-pages\n'));

    expect(finding('docs-governance.build-toolchain')).toEqual({
      ruleId: 'docs-governance.build-toolchain',
      severity: 'warn',
      message: 'build_command is empty or unresolvable',
      remediation:
        'Set docs.build_command in .devai/config/project.json to the command that builds the docs site.',
    });
  });

  it('binds an unreachable publication check to the configured branch', () => {
    configure('custom-docs build', 'preview-pages');
    host.spawnSync.mockImplementation((command: string) =>
      command === 'custom-docs' ? result(0) : result(3, '', 'network unavailable'),
    );

    expect(finding('docs-governance.gh-pages-branch')).toEqual({
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'warn',
      message:
        'Cannot check gh-pages branch — git ls-remote returned non-zero (remote may be unreachable)',
      remediation:
        'Create the preview-pages branch only through the separately authorized site-publication process.',
    });
    expect(host.spawnSync).toHaveBeenLastCalledWith(
      'git',
      ['ls-remote', 'origin', 'preview-pages'],
      expect.objectContaining({ cwd: root, encoding: 'utf8', timeout: 15_000 }),
    );
  });

  it.each([
    [undefined, 'gh-pages'],
    ['', 'gh-pages'],
    ['  \n', 'gh-pages'],
  ] as const)('reports an absent default publication branch for stdout %j', (stdout, branch) => {
    configure('custom-docs build', branch);
    host.spawnSync.mockImplementation((command: string) =>
      command === 'custom-docs'
        ? result(0)
        : { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [] },
    );

    expect(finding('docs-governance.gh-pages-branch')).toEqual({
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'warn',
      message:
        'gh-pages branch "gh-pages" does not exist on origin — first publish has not run yet',
      remediation:
        'Create the gh-pages branch only through the separately authorized site-publication process.',
    });
  });

  it('reports the configured publication branch only when ls-remote returns a ref', () => {
    configure('custom-docs build', 'release-pages');
    host.spawnSync.mockImplementation((command: string) =>
      command === 'custom-docs' ? result(0) : result(0, 'deadbeef\trefs/heads/release-pages\n'),
    );

    expect(finding('docs-governance.gh-pages-branch')).toEqual({
      ruleId: 'docs-governance.gh-pages-branch',
      severity: 'pass',
      message: 'gh-pages branch "release-pages" exists on origin',
    });
  });
});

describe('S06-B residual public runtime boundaries', () => {
  it('loads only the selected domain for a machine-format action with flags', async () => {
    const { invokeDevaiCli } = await import('../../src/cli-runtime.js');
    const result = await invokeDevaiCli(['catalog', 'actions', '--format', 'json']);

    expect(result.exit_code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      action_id: 'catalog actions',
      ok: true,
      result: { verdict: 'pass' },
    });
  });

  it('does not initialize unrelated domains for a machine-format action', async () => {
    vi.doMock('../../src/commands/audit/observe.js', () => {
      throw new Error('unrelated-audit-domain-loaded');
    });
    const { invokeDevaiCli } = await import('../../src/cli-runtime.js');
    const result = await invokeDevaiCli(['catalog', 'actions', '--format', 'json']);

    expect(result.exit_code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ action_id: 'catalog actions', ok: true });
  });

  it('rejects a concurrent invocation while the first domain import is pending', async () => {
    const { invokeDevaiCli } = await import('../../src/cli-runtime.js');
    const first = invokeDevaiCli(['catalog', 'actions', '--format', 'json']);

    await expect(invokeDevaiCli(['--version'])).rejects.toThrow(
      'release-host-invocation-in-progress',
    );
    await expect(first).resolves.toMatchObject({ exit_code: 0, stderr: '' });
  });

  it('rejects executable argv without both process and entrypoint words', async () => {
    const { startDevaiCli } = await import('../../src/cli-runtime.js');

    await expect(startDevaiCli([])).rejects.toThrow('release-host-argv-invalid');
    await expect(startDevaiCli([process.execPath])).rejects.toThrow('release-host-argv-invalid');
  });

  it('rejects malformed host arguments without changing process globals', async () => {
    const before = {
      argv: process.argv,
      exitCode: process.exitCode,
      stdout: process.stdout.write,
      stderr: process.stderr.write,
    };
    const { invokeDevaiCli } = await import('../../src/cli-runtime.js');

    await expect(invokeDevaiCli(null as unknown as readonly string[])).rejects.toThrow(
      'release-host-argv-invalid',
    );
    await expect(invokeDevaiCli(['--version', 7] as unknown as readonly string[])).rejects.toThrow(
      'release-host-argv-invalid',
    );
    expect({
      argv: process.argv,
      exitCode: process.exitCode,
      stdout: process.stdout.write,
      stderr: process.stderr.write,
    }).toEqual(before);
  });
});

describe('S06-B residual version fallback', () => {
  it('falls back to 0.0.0 when the package manifest omits version', async () => {
    vi.doMock('@devai-nyx/authority', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
      return {
        ...actual,
        readFileSync: () => '{"name":"fixture"}',
      };
    });
    const { resolveCliVersion } = await import('../../src/version.js');

    expect(resolveCliVersion()).toBe('0.0.0');
    expect(resolveCliVersion()).toBe('0.0.0');
  });
});
