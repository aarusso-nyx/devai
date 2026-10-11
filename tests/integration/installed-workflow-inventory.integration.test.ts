// ADR-SCR-0018: actual tarball, package-declared public bin, no private module imports.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';
import { hash, populate, put, snapshot, workflow } from '../helpers/workflow-inventory-fixture.js';

const ROOT = resolve(import.meta.dirname, '../..');
const roots: string[] = [];
let installation: string;
let binary: string;
type WorkflowInventory = {
  schemaVersion: string;
  status: string;
  reason: string | null;
  workflows: {
    path: string;
    sha256: string | null;
    status: string;
    steps: {
      job: string;
      index: number;
      occurrence: string;
      name: string;
      sha256: string | null;
      closure: {
        status: string;
        reason: string | null;
        files: { path: string; sha256: string }[] | null;
      };
    }[];
  }[];
};
type Slice = {
  slice: string;
  members: string[];
  status: string;
  implicit_persistence: boolean;
  results: { member: string; status: string; value: WorkflowInventory }[];
};

beforeAll(() => {
  installation = mkdtempSync(join(tmpdir(), 'devai packed workflow espaços-'));
  const pack = join(installation, 'pack');
  mkdirSync(pack);
  let tarball = process.env['DEVAI_TEST_INSTALLED_TARBALL'];
  if (tarball === undefined) {
    const result = spawnSync('pnpm', ['pack', '--pack-destination', pack, '--json'], {
      cwd: join(ROOT, 'packages/cli'),
      encoding: 'utf8',
      env: { ...subprocessCoverageEnvironment(), COPYFILE_DISABLE: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const packed = JSON.parse(result.stdout) as { filename: string };
    tarball = resolve(join(ROOT, 'packages/cli'), packed.filename);
  }
  expect(existsSync(tarball)).toBe(true);
  const members = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  expect(members.status, members.stderr).toBe(0);
  const names = members.stdout.trim().split('\n');
  expect(names.length).toBeGreaterThan(100);
  for (const name of names) {
    expect(name.startsWith('package/'), name).toBe(true);
    expect(
      name.split('/').some((part) => part === '..'),
      name,
    ).toBe(false);
  }
  const entries = spawnSync('tar', ['-tvzf', tarball], { encoding: 'utf8' });
  expect(entries.status, entries.stderr).toBe(0);
  for (const line of entries.stdout.trim().split('\n')) expect(line).toMatch(/^[-d][rwx-]{9}/u);
  console.info(
    'Installed workflow artifact',
    JSON.stringify({ sha256: hash(readFileSync(tarball)), members: names.length }),
  );
  const installed = join(installation, 'node_modules/@aarusso-nyx/devai');
  mkdirSync(installed, { recursive: true });
  const extraction = spawnSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed], {
    encoding: 'utf8',
  });
  expect(extraction.status, extraction.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    name: string;
    bin: { devai: string };
  };
  expect(manifest.name).toBe('@aarusso-nyx/devai');
  binary = resolve(installed, manifest.bin.devai);
  expect(existsSync(binary)).toBe(true);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (installation !== undefined) rmSync(installation, { recursive: true, force: true });
});

function fixture(bindAuthority = true): string {
  const root = mkdtempSync(join(tmpdir(), 'devai workflow adopter ç '));
  roots.push(root);
  populate(root);
  put(
    root,
    '.devai/config/project.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      project_type: 'platform-package',
      name: 'fixture',
      profile: 'tier1',
      authority_enforcement: { mode: 'cli-only' },
    }),
  );
  if (bindAuthority) bindRuntime(root);
  return root;
}
function bindRuntime(root: string): void {
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = run(root, [
      'init',
      'bind',
      ...selector,
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(bound.status, bound.stderr || bound.stdout).toBe(0);
  }
}
function run(root: string, args: readonly string[]) {
  return spawnSync(process.execPath, [binary, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: subprocessCoverageEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
}
function inspect(root: string, status: 'pass' | 'review' = 'pass'): Slice {
  const before = snapshot(root);
  const result = run(root, [
    'sense',
    'inventory',
    '--slice',
    'workflows',
    '--repo-root',
    root,
    '--format',
    'json',
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(status === 'pass' ? 0 : 1);
  expect(result.stderr).toBe('');
  const envelope = JSON.parse(result.stdout) as {
    action_id: string;
    ok: boolean;
    result?: { verdict: string; value: Slice };
  };
  expect(envelope.action_id).toBe('sense inventory');
  expect(envelope.ok).toBe(true);
  expect(envelope.result?.verdict).toBe(status);
  const value = envelope.result?.value;
  expect(value).toMatchObject({
    slice: 'workflows',
    members: ['workflow-step-inventory'],
    status,
    implicit_persistence: false,
  });
  expect(value?.results).toHaveLength(1);
  expect(value?.results[0]).toMatchObject({ member: 'workflow-step-inventory', status });
  expect(snapshot(root)).toEqual(before);
  expect(existsSync(join(root, 'EXECUTED'))).toBe(false);
  if (value === undefined) throw new Error('workflow slice payload missing');
  return value;
}

describe('installed public workflow inventory slice', () => {
  it('preserves the existing missing-authority refusal before observing an unbound candidate', () => {
    const root = fixture(false);
    const before = snapshot(root);
    const result = run(root, [
      'sense',
      'inventory',
      '--slice',
      'workflows',
      '--repo-root',
      root,
      '--format',
      'json',
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'AUTHORITY_POLICY_MISSING' },
    });
    expect(snapshot(root)).toEqual(before);
  });
  it('uses the packed public bin to expose exact digests and duplicate occurrences without a review binding, writes or execution', () => {
    const root = fixture();
    put(root, '.github/workflows/a.yml', workflow().replace('  verify:', '  first:'));
    const first = inspect(root);
    const value = first.results[0]?.value;
    expect(value).toMatchObject({ schemaVersion: '1.0.0', status: 'complete', reason: null });
    expect(value?.workflows.map((row) => row.path)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/check.yml',
    ]);
    expect(value?.workflows.flatMap((row) => row.steps.map((step) => step.occurrence))).toEqual([
      '.github/workflows/a.yml#first[0]',
      '.github/workflows/check.yml#verify[0]',
    ]);
    for (const row of value?.workflows ?? []) {
      expect(row.sha256).toBe(hash(readFileSync(join(root, row.path))));
      expect(row.steps[0]?.sha256).toBe(
        hash(JSON.stringify({ name: 'Inspect', run: 'node scripts/main.mjs' })),
      );
      expect(row.steps[0]?.closure).toEqual({
        status: 'complete',
        reason: null,
        files: ['package.json', 'scripts/leaf.mjs', 'scripts/main.mjs'].map((path) => ({
          path,
          sha256: hash(readFileSync(join(root, path))),
        })),
      });
    }
    expect(existsSync(join(root, '.devai/config/reviewed-workflow-steps.json'))).toBe(false);
    expect(existsSync(join(root, 'record'))).toBe(false);
    expect(inspect(root)).toEqual(first);
  });

  it.each([
    'node scripts/main.mjs && echo hidden',
    'bash scripts/main.mjs',
    'node scripts/missing.mjs',
  ])('preserves UNKNOWN and null closure through the installed review envelope: %s', (command) => {
    const root = fixture();
    put(root, '.github/workflows/check.yml', workflow(command));
    const value = inspect(root, 'review').results[0]?.value;
    expect(value).toMatchObject({ status: 'unknown', reason: 'WORKFLOW_INVENTORY_INCOMPLETE' });
    expect(value?.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
  });

  it('keeps transitive linked source UNKNOWN rather than reading the external target', () => {
    const root = fixture();
    const outside = fixture(false);
    rmSync(join(root, 'scripts/leaf.mjs'));
    symlinkSync(join(outside, 'scripts/leaf.mjs'), join(root, 'scripts/leaf.mjs'));
    const outsideBefore = snapshot(outside);
    const value = inspect(root, 'review').results[0]?.value;
    expect(value?.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
    expect(snapshot(outside)).toEqual(outsideBefore);
  });

  it('preserves invalid YAML and missing workflow populations as review, with no implicit persistence', () => {
    const root = fixture();
    put(root, '.github/workflows/check.yml', 'jobs: [\n');
    const invalid = inspect(root, 'review').results[0]?.value;
    expect(invalid?.workflows).toHaveLength(1);
    expect(invalid?.workflows[0]).toMatchObject({
      path: '.github/workflows/check.yml',
      status: 'unknown',
      steps: [],
    });
    rmSync(join(root, '.github/workflows'), { recursive: true });
    expect(inspect(root, 'review').results[0]?.value).toEqual({
      schemaVersion: '1.0.0',
      status: 'unknown',
      reason: 'WORKFLOW_INVENTORY_EMPTY',
      workflows: [],
    });
  });

  it('uses only the registered bound computed-import projection and refuses its later byte drift', () => {
    const root = fixture();
    put(root, 'scripts/main.mjs', "const selected = './leaf.mjs'; await import(selected);\n");
    const unknown = inspect(root, 'review').results[0]?.value;
    const digest = unknown?.workflows[0]?.steps[0]?.sha256;
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const source = 'law/policy/workflow-adoption.json';
    put(
      root,
      source,
      JSON.stringify({
        schemaVersion: '1.0.0',
        policy_id: 'fixture.workflow',
        policy_version: '1.0.0',
        reviewed_workflow_steps: {
          schemaVersion: '1.0.0',
          steps: [
            {
              sha256: digest,
              effect: 'read-only',
              workflow: '.github/workflows/check.yml#verify[0]',
              step: 'Inspect',
              review: 'Only this literal candidate helper is selected.',
              files: ['package.json', 'scripts/leaf.mjs', 'scripts/main.mjs'].map((path) => ({
                path,
                sha256: hash(readFileSync(join(root, path))),
              })),
              computed_imports: [
                {
                  from: 'scripts/main.mjs',
                  reason: 'The selected module is the contained leaf.',
                  files: ['scripts/leaf.mjs'],
                },
              ],
            },
          ],
        },
      }),
    );
    for (const selector of [['--adopter-policy', source]]) {
      const bound = run(root, [
        'init',
        'bind',
        ...selector,
        '--target',
        root,
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
      expect(bound.status, bound.stderr || bound.stdout).toBe(0);
    }
    expect(inspect(root).results[0]?.value.workflows[0]?.steps[0]?.closure.status).toBe('complete');
    put(root, '.devai/config/reviewed-workflow-steps.json', '{"schemaVersion":"1.0.0","steps":[]}');
    expect(inspect(root, 'review').results[0]?.value.status).toBe('unknown');
  }, 60_000);
});

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...subprocessCoverageEnvironment(),
      GIT_AUTHOR_NAME: 'DEVAI Inspector',
      GIT_AUTHOR_EMAIL: 'inspector@devai.local',
      GIT_COMMITTER_NAME: 'DEVAI Inspector',
      GIT_COMMITTER_EMAIL: 'inspector@devai.local',
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function hookFixture() {
  const root = fixture(false);
  git(root, ['init', '--quiet']);
  git(root, ['add', 'package.json']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  mkdirSync(join(root, '.husky'));
  put(
    root,
    '.devai/config/project.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      project_type: 'platform-package',
      name: 'fixture',
      profile: 'tier1',
      authority_enforcement: {
        mode: 'host-integrated',
        adapter_config: '.devai/config/github-actions-host-adapter.json',
      },
    }),
  );
  for (const selector of [
    ['--constitution', '--tier', 'tier1'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = run(root, [
      'init',
      'bind',
      ...selector,
      '--target',
      root,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(bound.status, bound.stderr || bound.stdout).toBe(0);
  }
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(binary, join(root, 'node_modules/.bin/devai'));
  return root;
}
function refreshHook(root: string) {
  const refreshed = run(root, [
    'init',
    'apply',
    'architect',
    '--target',
    root,
    '--only',
    'hooks',
    '--hook',
    'post-merge',
    '--as-role',
    'architect',
    '--write',
    '--format',
    'json',
  ]);
  expect(refreshed.status, refreshed.stderr || refreshed.stdout).toBe(0);
  const envelope = JSON.parse(refreshed.stdout) as {
    result: { value: { plan: unknown; result: unknown; included: { component: string }[] } };
  };
  expect(envelope.result.value.plan).toBeNull();
  expect(envelope.result.value.result).toEqual({
    created: [],
    overwritten: [],
    skipped: [],
    preserved: [],
  });
  expect(envelope.result.value.included).toHaveLength(1);
  expect(envelope.result.value.included[0]?.component).toBe('hooks');
}

describe('installed registered scoped post-merge hook refresh', () => {
  it('refreshes only local hook bindings, preserves selected policy and skips a fresh linked GitHub checkout without helpers', () => {
    const root = hookFixture();
    put(root, 'law/retained.md', '# Existing adopted law\n');
    const project = readFileSync(join(root, '.devai/config/project.json'));
    const policy = readFileSync(join(root, '.devai/config/authority-policy.json'));
    const before = snapshot(root);
    refreshHook(root);
    const allowed = (row: string) =>
      row.startsWith('.husky/post-merge:') ||
      row.startsWith('.devai/config/post-merge-host-adapter.json:') ||
      row.startsWith('.git/devai:') ||
      row.startsWith('.git/devai/');
    expect(snapshot(root).filter((row) => !allowed(row))).toEqual(
      before.filter((row) => !allowed(row)),
    );
    expect(readFileSync(join(root, '.devai/config/project.json'))).toEqual(project);
    expect(readFileSync(join(root, '.devai/config/authority-policy.json'))).toEqual(policy);
    expect(existsSync(join(root, 'law/operational.md'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    const key = readFileSync(join(root, '.git/devai/post-merge.key'));
    refreshHook(root);
    expect(readFileSync(join(root, '.git/devai/post-merge.key'))).toEqual(key);
    expect(readFileSync(join(root, '.devai/config/project.json'))).toEqual(project);
    git(root, ['add', '.husky/post-merge', '.devai/config', '.devai/pin', 'law/retained.md']);
    git(root, ['commit', '--quiet', '-m', 'fixture selected GitHub shared hook']);
    const linked = join(root, 'linked checkout ç');
    git(root, ['worktree', 'add', '--quiet', '-b', 'linked-inventory-test', linked]);
    const admin = git(linked, ['rev-parse', '--absolute-git-dir']);
    expect(existsSync(join(admin, 'devai'))).toBe(false);
    const linkedBefore = snapshot(linked);
    const hook = spawnSync('sh', ['.husky/post-merge'], {
      cwd: linked,
      encoding: 'utf8',
      env: subprocessCoverageEnvironment(),
    });
    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.stderr).toContain('POST_MERGE_HOOK_NOT_SELECTED');
    expect(snapshot(linked)).toEqual(linkedBefore);
    expect(existsSync(join(admin, 'devai'))).toBe(false);
    expect(existsSync(join(linked, '.devai/rounds/history'))).toBe(false);
  }, 60_000);

  it('retains actual installed HMAC verification when the local adapter is selected', () => {
    const root = hookFixture();
    const project = JSON.parse(
      readFileSync(join(root, '.devai/config/project.json'), 'utf8'),
    ) as Record<string, unknown>;
    project['authority_enforcement'] = {
      mode: 'host-integrated',
      adapter_config: '.devai/config/post-merge-host-adapter.json',
    };
    put(root, '.devai/config/project.json', JSON.stringify(project));
    refreshHook(root);
    const path = '.git/devai/post-merge-host-adapter.json';
    const attestation = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(attestation['signature_hmac_sha256']).toMatch(/^[a-f0-9]{64}$/u);
    attestation['signature_hmac_sha256'] = '0'.repeat(64);
    put(root, path, JSON.stringify(attestation));
    const hook = spawnSync('sh', ['.husky/post-merge'], {
      cwd: root,
      encoding: 'utf8',
      env: subprocessCoverageEnvironment(),
    });
    expect(hook.status).not.toBe(0);
    expect(hook.stderr).not.toContain('POST_MERGE_HOOK_NOT_SELECTED');
    expect(hook.stderr).toContain('host receipt unverified');
    expect(existsSync(join(root, '.devai/rounds/history'))).toBe(false);
  }, 60_000);

  it.each([
    ['--only', 'unknown'],
    ['--only', 'hooks', '--include', 'hooks'],
    ['--only', 'hooks', '--force'],
    ['--only', 'hooks', '--command', 'echo hidden'],
  ])('refuses unsupported scoped refresh before effects: %j', (...selection) => {
    const root = fixture();
    const before = snapshot(root);
    const result = run(root, [
      'init',
      'apply',
      'architect',
      '--target',
      root,
      ...selection,
      '--as-role',
      'architect',
      '--write',
      '--format',
      'json',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--only accepts hooks');
    expect(snapshot(root)).toEqual(before);
  });
});
