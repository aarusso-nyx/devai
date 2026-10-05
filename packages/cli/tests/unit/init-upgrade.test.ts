// Issue #264: init upgrade plans the move from the bound devai_version to the installed version
// from the shipped migration manifest, refuses an undeclared owned-key retirement before any
// write, applies the bind segments with the doctor post-checks, and is idempotent. The fixture is
// STYNX-shaped: tier1, platform-package, host-integrated through the GitHub Actions adapter, and
// ci_economy.attested_rc, rolled back to the 1.6.0 state STYNX is upgrading from.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCliVersion } from '../../src/version.js';

type JsonObject = Record<string, unknown>;

const SOURCE = 'law/policy/devai-adoption.json';
const ATTESTED_RC = {
  profile: 'rc',
  transport: 'protected-tag-v1',
  tag_prefix: 'devai-local-evidence/',
  binding: 'exact-tree',
  required_check: 'verified-local-rc',
  failure_mode: 'fail-closed',
  local_only_nodes: ['test:rc'],
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

function put(repo: string, path: string, value: string | object): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function json(repo: string, path: string): JsonObject {
  return JSON.parse(readFileSync(join(repo, path), 'utf8')) as JsonObject;
}

/** Every file under the repository except Git's own state, as path -> bytes. */
function snapshot(repo: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.set(relative(repo, path), readFileSync(path, 'utf8'));
    }
  };
  visit(repo);
  return files;
}

function value(result: { stdout: string }): JsonObject {
  const envelope = JSON.parse(result.stdout) as { result: { value: JsonObject } };
  return envelope.result.value;
}

async function bindOrFail(args: readonly string[]): Promise<void> {
  const result = await runCli(args);
  expect(result.exit, result.stderr).toBe(0);
}

/**
 * A STYNX-shaped adopter bound at the installed version, then rolled back to its 1.6.0 state:
 * devai_version 1.6.0, a host adapter stamped 1.4.5, thresholds without soft_gate, and
 * ci_economy.attested_rc in project.json that the old deep merge preserved.
 */
async function stynxAt160(sourceDeclaresAttestedRc: boolean): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-init-upgrade-')));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/stynx-nyx/stynx.git');
  const target = ['--target', repo, '--as-role', 'architect', '--write'];
  await bindOrFail(['init', 'bind', '--full', '--tier', 'tier1', ...target]);
  put(repo, SOURCE, {
    schemaVersion: '1.0.0',
    policy_id: 'stynx.devai-adoption',
    policy_version: '1.0.0',
    project: { project_type: 'platform-package' },
    ci_economy: sourceDeclaresAttestedRc
      ? { profile: 'gate-staged', attested_rc: ATTESTED_RC }
      : { profile: 'gate-staged' },
  });
  await bindOrFail(['init', 'bind', '--adopter-policy', SOURCE, ...target]);
  await bindOrFail(['init', 'bind', '--host-adapter', 'github-actions', ...target]);
  const project = json(repo, '.devai/config/project.json');
  put(repo, '.devai/config/project.json', {
    ...project,
    devai_version: '1.6.0',
    ci_economy: { profile: 'gate-staged', attested_rc: ATTESTED_RC },
  });
  const adapter = json(repo, '.devai/config/github-actions-host-adapter.json');
  put(repo, '.devai/config/github-actions-host-adapter.json', {
    ...adapter,
    adapter_version: '1.4.5',
    package_binding: { name: '@aarusso-nyx/devai', version: '1.4.5' },
  });
  const { soft_gate: _softGate, ...thresholds } = json(repo, '.devai/config/thresholds.json');
  put(repo, '.devai/config/thresholds.json', thresholds);
  return repo;
}

describe('#264: init upgrade on a STYNX-shaped adopter from 1.6.0', () => {
  it('plans every release in range, then upgrades with zero retired keys and passing post-checks', async () => {
    const repo = await stynxAt160(true);
    const installed = resolveCliVersion();
    const before = snapshot(repo);

    const planned = await runCli(['init', 'upgrade', '--target', repo, '--as-role', 'architect']);
    expect(planned.exit, planned.stderr).toBe(0);
    // Planning is the default and writes nothing.
    expect(snapshot(repo)).toEqual(before);
    const plan = value(planned)['plan'] as JsonObject;
    expect(plan).toMatchObject({ from: '1.6.0', to: installed, status: 'ready', retired_keys: [] });
    const versions = (plan['releases'] as JsonObject[]).map((release) => release['version']);
    expect(versions.slice(0, 3)).toEqual(['1.7.0', '1.8.0', '1.9.0']);
    expect(plan['stale_version_stamps']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.devai/config/project.json', version: '1.6.0' }),
        expect.objectContaining({
          path: '.devai/config/github-actions-host-adapter.json',
          field: 'package_binding.version',
          version: '1.4.5',
        }),
      ]),
    );
    expect(plan['obligations']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: 'MIG-1.9.0-thresholds-soft-gate',
          status: 'satisfied-by-upgrade',
        }),
      ]),
    );

    const applied = await runCli([
      'init',
      'upgrade',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(applied.exit, applied.stderr).toBe(0);
    const receipt = json(repo, '.devai/config/upgrade-receipt.json');
    expect(receipt).toMatchObject({ from: '1.6.0', to: installed, retired_keys: [] });
    expect(receipt['postchecks']).toEqual([
      { name: 'policy-materialization-current', ok: true },
      { name: 'authority-enforcement', ok: true },
      { name: 'constitution-binding', ok: true },
    ]);
    const project = json(repo, '.devai/config/project.json');
    expect(project['devai_version']).toBe(installed);
    expect((project['ci_economy'] as JsonObject)['attested_rc']).toEqual(ATTESTED_RC);
    expect(json(repo, '.devai/config/github-actions-host-adapter.json')['package_binding']).toEqual(
      { name: '@aarusso-nyx/devai', version: installed },
    );
    expect(json(repo, '.devai/config/thresholds.json')['soft_gate']).toBeDefined();
    expect(
      readFileSync(join(repo, '.github/workflows/devai-local-rc-verify.yml'), 'utf8'),
    ).toContain('verified-local-rc');

    // Idempotent: a second run at the same version is a no-op that writes no byte.
    const settled = snapshot(repo);
    const again = await runCli([
      'init',
      'upgrade',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(again.exit, again.stderr).toBe(0);
    expect((value(again)['plan'] as JsonObject)['status']).toBe('no-op');
    expect(snapshot(repo)).toEqual(settled);
  }, 120_000);

  it('refuses before any write when the source does not declare ci_economy.attested_rc', async () => {
    const repo = await stynxAt160(false);
    const before = snapshot(repo);

    const planned = await runCli(['init', 'upgrade', '--target', repo, '--as-role', 'architect']);
    expect(planned.exit).toBe(1);
    const plan = value(planned)['plan'] as JsonObject;
    expect(plan).toMatchObject({ status: 'refused', retired_keys: ['/ci_economy/attested_rc'] });
    expect(plan['refusals']).toEqual([
      expect.objectContaining({
        code: 'INIT_UPGRADE_RETIREMENT_UNDECLARED',
        key: 'ci_economy.attested_rc',
      }),
    ]);

    const applied = await runCli([
      'init',
      'upgrade',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(applied.exit).toBe(5);
    const error = (JSON.parse(applied.stderr) as { error: JsonObject }).error;
    expect(error).toMatchObject({ code: 'INIT_UPGRADE_RETIREMENT_UNDECLARED' });
    expect(String(error['message'])).toContain('ci_economy.attested_rc');
    expect(snapshot(repo)).toEqual(before);
  }, 120_000);

  it('refuses a bound version below the manifest baseline before planning', async () => {
    const repo = await stynxAt160(true);
    const project = json(repo, '.devai/config/project.json');
    put(repo, '.devai/config/project.json', { ...project, devai_version: '1.5.7' });
    const before = snapshot(repo);

    const applied = await runCli([
      'init',
      'upgrade',
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(applied.exit).toBe(5);
    expect((JSON.parse(applied.stderr) as { error: JsonObject }).error).toMatchObject({
      code: 'INIT_UPGRADE_FROM_VERSION_UNSUPPORTED',
    });
    expect(snapshot(repo)).toEqual(before);
  }, 120_000);
});
