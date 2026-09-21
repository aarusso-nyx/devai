import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { initBind } from '../../src/commands/init/index.js';
import { loadTrackingPolicyDefaults } from '../../src/services/github-issues-tracking/config.js';
import { renderTrackingWorkflow } from '../../src/services/github-issues-tracking/workflow.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const roots: string[] = [];

function put(root: string, path: string, value: string | object): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function repository(name: string, git = false): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  put(root, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    project_type: 'platform-package',
    name: 'lane-c-fixture',
    profile: 'tier1',
  });
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Lane C Fixture'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/lane-c.git'], {
      cwd: root,
    });
    put(root, 'README.md', '# fixture\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  return root;
}

async function invoke(root: string, args: readonly string[]) {
  const cli = cac('devai-init-bind-lane-c');
  initBind.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', 'init-bind', '--target', root, ...args];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() =>
        runWithAuthorityPolicyMaterialization(
          () => ({
            path: '.devai/config/authority-policy.json',
            operation: 'created',
            digest_sha256: 'a'.repeat(64),
          }),
          () => cli.runMatchedCommand(),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI shard 09 init bind adapter and policy boundaries', () => {
  it('projects and persists every tracking binding field with byte-identical workflow content', async () => {
    const root = repository('devai-init-bind-tracking');
    const plan = await invoke(root, [
      '--tracking-adapter',
      'github-issues',
      '--tracking-repository',
      ' Example/Project ',
    ]);
    expect(plan).toEqual({
      exit: 0,
      stderr: '',
      stdout: expect.any(String),
    });
    const planned = JSON.parse(plan.stdout) as Record<string, unknown>;
    expect(planned).toEqual({
      plan: {
        repository: 'Example/Project',
        config: '.devai/config/github-issues-tracking.json',
        workflow: '.github/workflows/devai-issue-tracking.yml',
        workflow_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(existsSync(join(root, '.devai/config/github-issues-tracking.json'))).toBe(false);

    const written = await invoke(root, [
      '--tracking-adapter',
      'github-issues',
      '--tracking-repository',
      'Example/Project',
      '--write',
    ]);
    expect(written.exit, written.stderr).toBe(0);
    expect(written.stderr).toBe('');
    const result = JSON.parse(written.stdout) as Record<string, unknown>;
    expect(result).toEqual({
      plan: {
        config: '.devai/config/github-issues-tracking.json',
        workflow: '.github/workflows/devai-issue-tracking.yml',
      },
      repository: 'Example/Project',
      workflow_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const defaults = loadTrackingPolicyDefaults();
    const workflow = renderTrackingWorkflow(defaults);
    expect(readFileSync(join(root, '.github/workflows/devai-issue-tracking.yml'), 'utf8')).toBe(
      workflow,
    );
    const config = JSON.parse(
      readFileSync(join(root, '.devai/config/github-issues-tracking.json'), 'utf8'),
    ) as {
      binding: { bound_at: string };
    };
    expect(config).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'github-issues-tracking',
      binding: {
        repository: 'Example/Project',
        repository_id: 'Project',
        bound_by_role: 'architect',
      },
      defaults,
      digests: {
        workflow_sha256: result.workflow_sha256,
      },
    });
    expect(config.binding.bound_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(
      JSON.parse(readFileSync(join(root, '.devai/config/project.json'), 'utf8')),
    ).toMatchObject({
      governance_tracking: {
        adapter: 'github-issues',
        config: '.devai/config/github-issues-tracking.json',
        workflow: '.github/workflows/devai-issue-tracking.yml',
      },
    });
  });

  it('fails tracking writes atomically when the project cannot accept its binding', async () => {
    const root = repository('devai-init-bind-tracking-invalid');
    put(root, '.devai/config/project.json', {});
    const before = readFileSync(join(root, '.devai/config/project.json'), 'utf8');
    const result = await invoke(root, [
      '--tracking-adapter',
      'github-issues',
      '--tracking-repository',
      'example/project',
      '--write',
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^devai init bind --tracking-adapter github-issues: TRACKING_PROJECT_INVALID:/u,
    );
    expect(readFileSync(join(root, '.devai/config/project.json'), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.github/workflows/devai-issue-tracking.yml'))).toBe(false);
    expect(existsSync(join(root, '.devai/config/github-issues-tracking.json'))).toBe(false);
  });

  it('distinguishes exact operational and subprocess plans from their materialized bytes', async () => {
    const root = repository('devai-init-bind-policy');
    const operational = await invoke(root, ['--operational-law']);
    expect(operational.exit, operational.stderr).toBe(0);
    const plan = (JSON.parse(operational.stdout) as { plan: Array<Record<string, unknown>> }).plan;
    expect(plan).toHaveLength(5);
    expect(plan.map((entry) => entry.target)).toEqual([
      '.devai/config/domains.json',
      '.devai/config/forbidden-actions.json',
      '.devai/config/glob-guards.json',
      '.devai/config/scorecard-na.json',
      '.devai/config/thresholds.json',
    ]);
    expect(plan.every((entry) => entry.byte_identity_required === true)).toBe(true);
    const operationalWrite = await invoke(root, ['--operational-law', '--write']);
    expect(operationalWrite.exit, operationalWrite.stderr).toBe(0);
    expect(JSON.parse(operationalWrite.stdout)).toEqual({ materialized: plan });
    for (const entry of plan) {
      const bytes = readFileSync(join(root, String(entry.target)));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.digest_sha256);
    }
    const operationalHuman = await invoke(root, ['--operational-law', '--write', '--human']);
    expect(operationalHuman).toEqual({
      exit: 0,
      stderr: '',
      stdout: 'init bind --operational-law: 5 exact materializations\n',
    });

    const subprocess = await invoke(root, ['--subprocess-effects']);
    expect(subprocess.exit, subprocess.stderr).toBe(0);
    const subprocessPlan = (JSON.parse(subprocess.stdout) as { plan: Record<string, unknown> })
      .plan;
    expect(subprocessPlan).toEqual({
      source: 'installed:law/policy/subprocess-effects.json',
      target: '.devai/config/subprocess-effects.json',
      digest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      byte_identity_required: true,
    });
    const subprocessWrite = await invoke(root, ['--subprocess-effects', '--write', '--human']);
    expect(subprocessWrite).toEqual({
      exit: 0,
      stderr: '',
      stdout: `init bind --subprocess-effects: .devai/config/subprocess-effects.json (${String(subprocessPlan.digest_sha256)})\n`,
    });
    const subprocessBytes = readFileSync(join(root, '.devai/config/subprocess-effects.json'));
    expect(createHash('sha256').update(subprocessBytes).digest('hex')).toBe(
      subprocessPlan.digest_sha256,
    );
  });

  it('projects the constitution transition then writes its pin pointer and reconciled project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-init-bind-constitution-'));
    roots.push(root);
    const plan = await invoke(root, ['--constitution']);
    expect(plan.exit, plan.stderr).toBe(0);
    const transition = JSON.parse(plan.stdout) as Record<string, unknown>;
    expect(transition).toEqual({
      from: 'none',
      to: expect.stringMatching(/^\d+\.\d+\.\d+/u),
      source: expect.any(String),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(existsSync(join(root, '.devai/pin/constitution.md'))).toBe(false);
    const humanPlan = await invoke(root, ['--constitution', '--human']);
    expect(humanPlan).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        `init bind --constitution (plan only): none → ${String(transition.to)} (source: ${String(transition.source)})\n` +
        '  re-run with --write to refresh .devai/pin/constitution.md + the project.json pin\n',
    });

    const written = await invoke(root, ['--constitution', '--tier', 'tier2', '--write']);
    expect(written.exit, written.stderr).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({
      from: 'none',
      to: transition.to,
      source: transition.source,
    });
    const pin = readFileSync(join(root, '.devai/pin/constitution.md'));
    expect(createHash('sha256').update(pin).digest('hex')).toBe(transition.sha256);
    expect(readFileSync(join(root, '.devai/constitution.md'), 'utf8')).toContain(
      '.devai/pin/constitution.md',
    );
    const projectBytes = readFileSync(join(root, '.devai/config/project.json'), 'utf8');
    expect(projectBytes.endsWith('\n')).toBe(true);
    expect(JSON.parse(projectBytes)).toMatchObject({
      profile: 'tier2',
      constitution: { version: transition.to, sha256: transition.sha256 },
    });
  });

  it('preserves an adopter constitution pointer while refreshing the pin and reports prior version', async () => {
    const root = repository('devai-init-bind-existing-constitution');
    put(root, '.devai/constitution.md', '# adopter-managed pointer\n');
    const first = await invoke(root, ['--constitution', '--write']);
    expect(first.exit, first.stderr).toBe(0);
    const version = (JSON.parse(first.stdout) as { to: string }).to;
    const second = await invoke(root, ['--constitution', '--write', '--human']);
    expect(second).toEqual({
      exit: 0,
      stderr: '',
      stdout: expect.stringContaining(`init bind --constitution: ${version} → ${version} (source:`),
    });
    expect(readFileSync(join(root, '.devai/constitution.md'), 'utf8')).toBe(
      '# adopter-managed pointer\n',
    );
  });

  it('renders the default authority materialization artifact in JSON and human modes', async () => {
    const root = repository('devai-init-bind-authority-default');
    const json = await invoke(root, ['--write']);
    expect(json).toEqual({
      exit: 0,
      stderr: '',
      stdout: `${JSON.stringify({
        artifact: {
          path: '.devai/config/authority-policy.json',
          operation: 'created',
          digest_sha256: 'a'.repeat(64),
        },
      })}\n`,
    });
    const human = await invoke(root, ['--write', '--human']);
    expect(human).toEqual({
      exit: 0,
      stderr: '',
      stdout: `authority policy created: .devai/config/authority-policy.json (${'a'.repeat(64)})\n`,
    });
  });

  it('plans and installs both host adapters with exact enforcement and verification receipts', async () => {
    for (const adapter of ['github-actions', 'post-merge'] as const) {
      const root = repository(`devai-init-bind-host-${adapter}`, true);
      if (adapter === 'post-merge') {
        put(root, '.devai/config/authority-policy.json', { schemaVersion: '1.0.0' });
        put(root, 'law/constitution.md', '# Fixture constitution\n');
        put(root, 'node_modules/.bin/devai', '#!/bin/sh\nprintf "devai/1.5.4\\n"\n');
        chmodSync(join(root, 'node_modules/.bin/devai'), 0o755);
      }
      const planResult = await invoke(root, ['--host-adapter', adapter]);
      expect(planResult.exit, planResult.stderr).toBe(0);
      const plan = (JSON.parse(planResult.stdout) as { plan: Record<string, unknown> }).plan;
      if (adapter === 'github-actions') {
        expect(plan).toEqual({
          workflow: '.github/workflows/devai-main-observation.yml',
          config: '.devai/config/github-actions-host-adapter.json',
        });
      } else {
        expect(plan).toMatchObject({ hook: 'post-merge', manager: 'git' });
      }
      const humanPlan = await invoke(root, ['--host-adapter', adapter, '--human']);
      expect(humanPlan.exit, humanPlan.stderr).toBe(0);
      expect(humanPlan.stderr).toBe('');
      expect(humanPlan.stdout).toBe(
        adapter === 'github-actions'
          ? 'init bind --host-adapter github-actions (plan only)\n'
          : `init bind --host-adapter post-merge (plan only): ${String(plan.action)} ${String(plan.path)}\n`,
      );

      const written = await invoke(root, ['--host-adapter', adapter, '--write']);
      expect(written.exit, written.stderr).toBe(0);
      expect(written.stderr).toBe('');
      const result = JSON.parse(written.stdout) as {
        verification: unknown;
        authorityPolicy: unknown;
        plan: unknown;
      };
      expect(result.verification).toMatchObject({ ok: true, errors: [] });
      expect(result.authorityPolicy).toEqual({
        path: '.devai/config/authority-policy.json',
        operation: 'created',
        digest_sha256: 'a'.repeat(64),
      });
      expect(
        JSON.parse(readFileSync(join(root, '.devai/config/project.json'), 'utf8')),
      ).toMatchObject({
        authority_enforcement: {
          mode: 'host-integrated',
          adapter_config:
            adapter === 'github-actions'
              ? '.devai/config/github-actions-host-adapter.json'
              : '.devai/config/post-merge-host-adapter.json',
        },
      });
      if (adapter === 'github-actions') {
        expect(result.plan).toMatchObject({
          workflow: expect.stringContaining('.github/workflows/devai-main-observation.yml'),
          config: expect.stringContaining('.devai/config/github-actions-host-adapter.json'),
        });
        expect(existsSync(join(root, '.github/workflows/devai-main-observation.yml'))).toBe(true);
      } else {
        expect(result.plan).toMatchObject({ hook: 'post-merge', manager: 'git' });
        expect(existsSync(join(root, '.git/hooks/post-merge'))).toBe(true);
      }
    }
  }, 60_000);

  it('rejects invalid host project bindings before adapter files can escape rollback', async () => {
    for (const adapter of ['github-actions', 'post-merge'] as const) {
      const root = repository(`devai-init-bind-host-invalid-${adapter}`, true);
      put(root, '.devai/config/project.json', {});
      if (adapter === 'post-merge') {
        put(root, '.devai/config/authority-policy.json', { schemaVersion: '1.0.0' });
        put(root, 'law/constitution.md', '# Fixture constitution\n');
        put(root, 'node_modules/.bin/devai', '#!/bin/sh\nprintf "devai/1.5.4\\n"\n');
        chmodSync(join(root, 'node_modules/.bin/devai'), 0o755);
      }
      const projectBefore = readFileSync(join(root, '.devai/config/project.json'), 'utf8');
      const result = await invoke(root, ['--host-adapter', adapter, '--write']);
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        adapter === 'github-actions'
          ? /^devai init bind --host-adapter github-actions: HOST_ADAPTER_PROJECT_INVALID:/u
          : /^devai init bind --host-adapter: HOST_ADAPTER_PROJECT_INVALID:/u,
      );
      expect(readFileSync(join(root, '.devai/config/project.json'), 'utf8')).toBe(projectBefore);
      expect(existsSync(join(root, '.devai/config/github-actions-host-adapter.json'))).toBe(false);
      expect(existsSync(join(root, '.devai/config/post-merge-host-adapter.json'))).toBe(false);
    }
  });
});
