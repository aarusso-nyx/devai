// Issue #264: init upgrade plans the move from the bound devai_version to the installed version
// from the shipped migration manifest, refuses an undeclared owned-key retirement before any
// write, applies the bind segments with the doctor post-checks, and is idempotent. The fixture is
// STYNX-shaped: tier1, platform-package, host-integrated through the GitHub Actions adapter, and
// ci_economy.attested_rc, rolled back to the 1.6.0 state STYNX is upgrading from.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  BIND_JOURNAL,
  BIND_JOURNAL_PATHS,
  openBindJournal,
  releaseBindJournal,
} from '../../src/commands/init/bind-adapters.js';
import { UPGRADE_LOCK } from '../../src/commands/init/upgrade-lock.js';
import { postMergeAdapterFiles } from '../../src/services/hooks-install/index.js';
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
async function stynxAt160(
  sourceDeclaresAttestedRc: boolean,
  options: { readonly adopterPolicy?: boolean; readonly postMerge?: boolean } = {},
): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-init-upgrade-')));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Upgrade Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/stynx-nyx/stynx.git');
  git('commit', '-q', '--allow-empty', '-m', 'fixture');
  const target = ['--target', repo, '--as-role', 'architect', '--write'];
  await bindOrFail(['init', 'bind', '--full', '--tier', 'tier1', ...target]);
  if (options.adopterPolicy !== false) {
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
  }
  await bindOrFail(['init', 'bind', '--host-adapter', 'github-actions', ...target]);
  if (options.postMerge === true) {
    // The post-merge adapter verifies the project-local binary at the installed version.
    put(repo, 'node_modules/.bin/devai', `#!/bin/sh\nprintf "devai/${resolveCliVersion()}\\n"\n`);
    chmodSync(join(repo, 'node_modules/.bin/devai'), 0o755);
    await bindOrFail(['init', 'bind', '--host-adapter', 'post-merge', ...target]);
  }
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

const RECEIPT = '.devai/config/upgrade-receipt.json';
const WRITE = (repo: string) => [
  'init',
  'upgrade',
  '--target',
  repo,
  '--as-role',
  'architect',
  '--write',
];
const PLAN = (repo: string) => ['init', 'upgrade', '--target', repo, '--as-role', 'architect'];

function withoutReceipt(files: Map<string, string>): Map<string, string> {
  return new Map([...files].filter(([path]) => path !== RECEIPT));
}

describe('#264 review: durability, decisions, exclusion and the measured receipt', () => {
  it('recovers an upgrade interrupted before its receipt commit instead of reporting no-op', async () => {
    const repo = await stynxAt160(true);
    const installed = resolveCliVersion();
    const pre = snapshot(repo);
    const first = await runCli(WRITE(repo));
    expect(first.exit, first.stderr).toBe(0);
    const post = snapshot(repo);

    // The state a crash leaves after every write landed but before the receipt commit: the
    // new version is stamped, the journal still holds the previous bytes, and no receipt.
    put(repo, BIND_JOURNAL, {
      entries: BIND_JOURNAL_PATHS.map((path) => ({ path, previous: pre.get(path) ?? null })),
    });
    rmSync(join(repo, RECEIPT));
    expect(json(repo, '.devai/config/project.json')['devai_version']).toBe(installed);

    const planned = await runCli(PLAN(repo));
    expect(planned.exit, planned.stderr).toBe(0);
    expect(value(planned)['plan']).toMatchObject({ interrupted_bind: true, receipt: 'missing' });
    expect((value(planned)['plan'] as JsonObject)['status']).not.toBe('no-op');

    const recovered = await runCli(WRITE(repo));
    expect(recovered.exit, recovered.stderr).toBe(0);
    expect(value(recovered)['recovered_interrupted_bind']).toBe('rolled-back');
    expect(json(repo, RECEIPT)).toMatchObject({ from: '1.6.0', to: installed, retired_keys: [] });
    expect(existsSync(join(repo, BIND_JOURNAL))).toBe(false);
    expect(withoutReceipt(snapshot(repo))).toEqual(withoutReceipt(post));
  }, 180_000);

  it('re-derives a missing receipt for an already bound version instead of a no-op', async () => {
    const repo = await stynxAt160(true);
    const installed = resolveCliVersion();
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    rmSync(join(repo, RECEIPT));

    const planned = await runCli(PLAN(repo));
    const plan = value(planned)['plan'] as JsonObject;
    expect(plan).toMatchObject({ from: installed, status: 'ready', receipt: 'missing' });
    expect(plan['changed_files']).toEqual([
      { path: RECEIPT, operation: 'create', segment: 'receipt' },
    ]);

    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    expect(json(repo, RECEIPT)).toMatchObject({ from: installed, to: installed, rederived: true });
    const settled = await runCli(PLAN(repo));
    expect(value(settled)['plan']).toMatchObject({ status: 'no-op', receipt: 'current' });
  }, 180_000);

  it('refuses while a decision-required obligation is pending and keeps it visible on retry', async () => {
    const repo = await stynxAt160(true);
    put(repo, 'record/proofs/work/generic/R-0001.jsonl', '{"kind":"generic","sequence":1}\n');
    const before = snapshot(repo);
    const pending = expect.objectContaining({
      code: 'INIT_UPGRADE_DECISION_PENDING',
      change: 'MIG-1.9.0-proof-anchor-baseline',
      command: 'devai evidence verify --scope chain --write',
    });

    const planned = await runCli(PLAN(repo));
    expect(planned.exit).toBe(1);
    expect(value(planned)['plan']).toMatchObject({ status: 'refused' });
    expect((value(planned)['plan'] as JsonObject)['refusals']).toEqual([pending]);

    const applied = await runCli(WRITE(repo));
    expect(applied.exit).toBe(5);
    const error = (JSON.parse(applied.stderr) as { error: JsonObject }).error;
    expect(error).toMatchObject({ code: 'INIT_UPGRADE_DECISION_PENDING' });
    expect(String(error['remediation'])).toContain('devai evidence verify --scope chain --write');
    expect(snapshot(repo)).toEqual(before);

    // Nothing was stamped, so the retry names the same unresolved obligation.
    const retried = await runCli(PLAN(repo));
    expect((value(retried)['plan'] as JsonObject)['refusals']).toEqual([pending]);
  }, 180_000);

  it('refuses an unreviewed constitution move until --constitution settles it', async () => {
    const repo = await stynxAt160(true);
    const pin = readFileSync(join(repo, '.devai/pin/constitution.md'), 'utf8').replaceAll(
      '1.0.2',
      '1.0.1',
    );
    put(repo, '.devai/pin/constitution.md', pin);
    const project = json(repo, '.devai/config/project.json');
    put(repo, '.devai/config/project.json', {
      ...project,
      constitution: { version: '1.0.1', sha256: createHash('sha256').update(pin).digest('hex') },
    });

    const refused = await runCli(WRITE(repo));
    expect(refused.exit).toBe(5);
    expect((JSON.parse(refused.stderr) as { error: JsonObject }).error).toMatchObject({
      code: 'INIT_UPGRADE_DECISION_PENDING',
      context: expect.objectContaining({
        refusals: [expect.objectContaining({ change: 'MIG-1.8.0-constitution-1-0-2' })],
      }),
    });

    const applied = await runCli([...WRITE(repo), '--constitution']);
    expect(applied.exit, applied.stderr).toBe(0);
    expect(json(repo, '.devai/config/project.json')['constitution']).toMatchObject({
      version: '1.0.2',
    });
    expect(json(repo, RECEIPT)['constitution']).toEqual({ from: '1.0.1', to: '1.0.2' });
  }, 180_000);

  it('keeps an obligation the receipt left pending visible after the upgrade', async () => {
    const repo = await stynxAt160(true, { adopterPolicy: false });
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    const settled = await runCli(PLAN(repo));
    const plan = value(settled)['plan'] as JsonObject;
    expect(plan['status']).toBe('no-op');
    expect(plan['obligations']).toEqual([
      expect.objectContaining({
        change: 'MIG-1.7.0-repository-kind-from-receipt',
        status: 'pending',
        source: 'receipt',
      }),
    ]);
  }, 180_000);

  it('refuses while another live upgrade holds the lock and never takes over a stale one', async () => {
    const repo = await stynxAt160(true);
    put(repo, UPGRADE_LOCK, {
      schemaVersion: '1.0.0',
      action_id: 'init upgrade',
      token: 'another-run',
      pid: process.pid,
      host: hostname(),
      acquired_at: new Date().toISOString(),
    });
    const before = snapshot(repo);

    const refused = await runCli(WRITE(repo));
    expect(refused.exit).toBe(5);
    expect((JSON.parse(refused.stderr) as { error: JsonObject }).error).toMatchObject({
      code: 'INIT_UPGRADE_LOCKED',
    });
    expect(snapshot(repo)).toEqual(before);
    // A bind that would recover the journal refuses as well while the upgrade runs.
    const bind = await runCli([
      'init',
      'bind',
      '--adopter-policy',
      SOURCE,
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(bind.exit).not.toBe(0);
    expect(bind.stderr).toContain('INIT_UPGRADE_LOCKED');
    expect(snapshot(repo)).toEqual(before);

    // A lock whose owner has exited is never taken over: two contenders could both judge it
    // stale. The run refuses with its own code, the recorded owner and the removal step.
    const exited = spawnSync(process.execPath, ['--version']);
    const stale = {
      schemaVersion: '1.0.0',
      action_id: 'init upgrade',
      token: 'crashed-run',
      pid: exited.pid,
      host: hostname(),
      acquired_at: new Date().toISOString(),
    };
    put(repo, UPGRADE_LOCK, stale);
    const staleBefore = snapshot(repo);
    const staleRefusal = await runCli(WRITE(repo));
    expect(staleRefusal.exit).toBe(5);
    const error = (JSON.parse(staleRefusal.stderr) as { error: JsonObject }).error;
    expect(error).toMatchObject({
      code: 'INIT_UPGRADE_LOCK_STALE',
      context: expect.objectContaining({
        holder: expect.objectContaining({ token: 'crashed-run', pid: exited.pid }),
        removal: `rm "${join(repo, UPGRADE_LOCK)}"`,
      }),
    });
    expect(String(error['message'])).toContain(`pid ${String(exited.pid)}`);
    expect(snapshot(repo)).toEqual(staleBefore);
    const staleBind = await runCli([
      'init',
      'bind',
      '--adopter-policy',
      SOURCE,
      '--target',
      repo,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(staleBind.stderr).toContain('INIT_UPGRADE_LOCK_STALE');
    expect(snapshot(repo)).toEqual(staleBefore);

    // The documented manual removal, then the upgrade runs and releases only its own lock.
    rmSync(join(repo, UPGRADE_LOCK));
    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    expect(existsSync(join(repo, UPGRADE_LOCK))).toBe(false);
  }, 180_000);

  it('rolls the post-merge hook back with the configuration when an upgrade is interrupted', async () => {
    const repo = await stynxAt160(true, { postMerge: true });
    const hookPath = join(repo, '.git/hooks/post-merge');
    const marker = '# >>> devai hooks install >>>\n';
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replace(marker, `${marker}# installed by DEVAI 1.6.0\n`),
    );
    const staleHook = readFileSync(hookPath);

    // Record the journal an upgrade opens over this pre-upgrade state, hook included, and
    // set it aside while the upgrade runs to completion.
    await withAuthorityHostTestScope(() => {
      openBindJournal(repo, postMergeAdapterFiles(repo));
      releaseBindJournal();
    });
    const journal = readFileSync(join(repo, BIND_JOURNAL));
    const recorded = (JSON.parse(journal.toString('utf8')) as { entries: JsonObject[] }).entries;
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: hookPath,
          encoding: 'base64',
          previous: staleHook.toString('base64'),
        }),
      ]),
    );
    rmSync(join(repo, BIND_JOURNAL));
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    expect(readFileSync(hookPath)).not.toEqual(staleHook);

    // The crash state: every write landed, the journal still holds the previous bytes, no
    // receipt. Recovery restores the stale hook with the configuration, and the replay
    // reinstalls it, so the receipt lists the hook as replaced.
    writeFileSync(join(repo, BIND_JOURNAL), journal);
    rmSync(join(repo, RECEIPT));
    const recovered = await runCli(WRITE(repo));
    expect(recovered.exit, recovered.stderr).toBe(0);
    expect(value(recovered)['recovered_interrupted_bind']).toBe('rolled-back');
    const receipt = json(repo, RECEIPT);
    expect(receipt).toMatchObject({ from: '1.6.0' });
    expect(receipt['changed_files']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.git/hooks/post-merge', operation: 'update' }),
      ]),
    );
    expect(readFileSync(hookPath)).not.toEqual(staleHook);
  }, 180_000);

  it('refuses to re-derive a receipt while a decision from earlier releases is open', async () => {
    const repo = await stynxAt160(true);
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    rmSync(join(repo, RECEIPT));
    put(repo, 'record/proofs/work/generic/R-0001.jsonl', '{"kind":"generic","sequence":1}\n');
    const before = snapshot(repo);

    const planned = await runCli(PLAN(repo));
    expect(planned.exit).toBe(1);
    const plan = value(planned)['plan'] as JsonObject;
    expect(plan).toMatchObject({ status: 'refused', receipt: 'missing' });
    expect(plan['obligations']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: 'MIG-1.9.0-proof-anchor-baseline',
          status: 'pending',
          source: 'history',
        }),
      ]),
    );
    const applied = await runCli(WRITE(repo));
    expect(applied.exit).toBe(5);
    expect((JSON.parse(applied.stderr) as { error: JsonObject }).error).toMatchObject({
      code: 'INIT_UPGRADE_DECISION_PENDING',
    });
    expect(snapshot(repo)).toEqual(before);
  }, 180_000);

  it('lists the replaced post-merge hook with its digest among the changed files', async () => {
    const repo = await stynxAt160(true, { postMerge: true });
    const hookPath = join(repo, '.git/hooks/post-merge');
    const marker = '# >>> devai hooks install >>>\n';
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replace(marker, `${marker}# installed by DEVAI 1.6.0\n`),
    );

    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    const changed = json(repo, RECEIPT)['changed_files'] as JsonObject[];
    expect(changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.git/hooks/post-merge',
          operation: 'update',
          segment: 'host-adapters',
          sha256: createHash('sha256').update(readFileSync(hookPath)).digest('hex'),
        }),
      ]),
    );
    // Only bytes that moved are listed: the attestation still binds the canonical hook.
    expect(changed.map((entry) => entry['path'])).not.toContain(
      '.devai/config/post-merge-host-adapter.json',
    );
    expect(changed.map((entry) => entry['path'])).not.toContain(RECEIPT);
  }, 180_000);
});

describe('#264: the journal records the post-merge hook where it is installed', () => {
  it('resolves the git hooks directory, or .husky/post-merge in a Husky repository', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-upgrade-hook-path-')));
    roots.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    const runtime = join(repo, '.git/devai');
    expect(postMergeAdapterFiles(repo)).toEqual([
      join(repo, '.git/hooks/post-merge'),
      join(runtime, 'post-merge.key'),
      join(runtime, 'issue-post-merge-receipt.cjs'),
      join(runtime, 'post-merge-host-adapter.json'),
    ]);
    mkdirSync(join(repo, '.husky'));
    expect(postMergeAdapterFiles(repo)).toEqual([
      join(repo, '.husky/post-merge'),
      join(runtime, 'post-merge.key'),
      join(runtime, 'issue-post-merge-receipt.cjs'),
      join(runtime, 'post-merge-host-adapter.json'),
    ]);
  });
});

describe('#291: init upgrade converts a committed checkout-bound post-merge binding', () => {
  const DECLARATION = '.devai/config/post-merge-host-adapter.json';
  const LOCAL = '.git/devai/post-merge-host-adapter.json';

  /**
   * An adopter upgraded to the installed version, then put back in the layout before #291 and
   * stamped with 2.0.0, the last release that committed the checkout-bound attestation.
   */
  async function legacyLayout(): Promise<{ readonly repo: string; readonly legacy: string }> {
    const repo = await stynxAt160(true, { postMerge: true });
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    const legacy = readFileSync(join(repo, LOCAL), 'utf8');
    put(repo, DECLARATION, legacy);
    rmSync(join(repo, LOCAL));
    const project = json(repo, '.devai/config/project.json');
    put(repo, '.devai/config/project.json', { ...project, devai_version: '2.0.0' });
    return { repo, legacy };
  }

  it('moves the binding into the git directory of the checkout that holds its key, idempotently', async () => {
    const { repo, legacy } = await legacyLayout();
    const planned = await runCli(PLAN(repo));
    expect(planned.exit, planned.stderr).toBe(0);
    const plan = value(planned)['plan'] as JsonObject;
    expect(plan['status']).toBe('ready');
    // The 2.1.0 conversion lies above the bound 2.0.0, so the plan names it.
    expect((plan['releases'] as JsonObject[]).map((release) => release['version'])).toContain(
      '2.1.0',
    );
    expect(plan['changed_files']).toEqual(
      expect.arrayContaining([
        { path: DECLARATION, operation: 'update', segment: 'host-adapters' },
        { path: LOCAL, operation: 'create', segment: 'host-adapters' },
      ]),
    );

    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    const declaration = readFileSync(join(repo, DECLARATION), 'utf8');
    expect(declaration).not.toContain(repo);
    expect(JSON.parse(declaration)).toMatchObject({ required: true, local_state: 'git-dir' });
    // The attestation still verifies here, so it moves with its installed_at_head baseline.
    expect(json(repo, LOCAL)['installed_at_head']).toBe(
      (JSON.parse(legacy) as JsonObject)['installed_at_head'],
    );
    // The receipt records the conversion that ran.
    expect(json(repo, RECEIPT)['migrations']).toContain('MIG-2.1.0-post-merge-local-state');
    expect(json(repo, RECEIPT)['postchecks']).toEqual([
      { name: 'policy-materialization-current', ok: true },
      { name: 'authority-enforcement', ok: true },
      { name: 'constitution-binding', ok: true },
    ]);

    const settled = snapshot(repo);
    const local = readFileSync(join(repo, LOCAL), 'utf8');
    const again = await runCli(WRITE(repo));
    expect(again.exit, again.stderr).toBe(0);
    expect((value(again)['plan'] as JsonObject)['status']).toBe('no-op');
    expect(snapshot(repo)).toEqual(settled);
    expect(readFileSync(join(repo, LOCAL), 'utf8')).toBe(local);
  }, 180_000);

  it('restores the declaration of a selected live binding whose declaration was deleted', async () => {
    const repo = await stynxAt160(true, { postMerge: true });
    expect((await runCli(WRITE(repo))).exit).toBe(0);
    rmSync(join(repo, DECLARATION));
    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    expect(readFileSync(join(repo, DECLARATION), 'utf8')).not.toContain(repo);
    expect(json(repo, RECEIPT)['changed_files']).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: DECLARATION, operation: 'create' })]),
    );
    const settled = snapshot(repo);
    const again = await runCli(WRITE(repo));
    expect(again.exit, again.stderr).toBe(0);
    expect((value(again)['plan'] as JsonObject)['status']).toBe('no-op');
    expect(snapshot(repo)).toEqual(settled);
  }, 180_000);

  it('only rewrites the declaration in a checkout that never held the binding', async () => {
    const { repo } = await legacyLayout();
    // A clone carries the tracked files but none of the bound checkout's git directory state.
    for (const file of ['post-merge.key', 'issue-post-merge-receipt.cjs']) {
      rmSync(join(repo, '.git/devai', file));
    }
    const applied = await runCli(WRITE(repo));
    expect(applied.exit, applied.stderr).toBe(0);
    expect(readFileSync(join(repo, DECLARATION), 'utf8')).not.toContain(repo);
    expect(existsSync(join(repo, LOCAL))).toBe(false);
    expect(existsSync(join(repo, '.git/devai/post-merge.key'))).toBe(false);
    const changed = (json(repo, RECEIPT)['changed_files'] as JsonObject[]).map(
      (entry) => entry['path'],
    );
    expect(changed).toContain(DECLARATION);
    expect(changed).not.toContain(LOCAL);

    const settled = snapshot(repo);
    const again = await runCli(WRITE(repo));
    expect(again.exit, again.stderr).toBe(0);
    expect((value(again)['plan'] as JsonObject)['status']).toBe('no-op');
    expect(snapshot(repo)).toEqual(settled);
  }, 180_000);
});
