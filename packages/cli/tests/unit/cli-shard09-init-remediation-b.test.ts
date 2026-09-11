import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

type Definition = {
  readonly name: string;
  readonly description: string;
  readonly authority: string;
  register(cli: CAC): void;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function repository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
  return root;
}

type InitDefinitions = typeof import('../../src/commands/init/index.js');
let commands!: InitDefinitions;

beforeAll(async () => {
  commands = await import('../../src/commands/init/index.js');
});

async function invoke(definition: Definition, argv: readonly string[]) {
  const cli = cac('devai-init-remediation-b');
  definition.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
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
            operation: 'unchanged',
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
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('cli shard09 init remediation lane B', () => {
  it('publishes the exact three role definitions and their distinct option surfaces', async () => {
    const { initApplyArchitect, initApplyHarness, initApplyOwner } = commands;
    const cases = [
      {
        definition: initApplyOwner,
        name: 'init apply owner',
        description: 'Apply the Owner-owned initialization projection with explicit write consent.',
        rawName: 'init-apply-owner',
        commandDescription: 'Apply the exact owner bootstrap segment',
        options: ['--target <path>', '--stamp-version <v>', '--tier <tier>', '--human', '--force'],
      },
      {
        definition: initApplyArchitect,
        name: 'init apply architect',
        description:
          'Apply the Architect-owned initialization projection with explicit write consent.',
        rawName: 'init-apply-architect',
        commandDescription: 'Apply the exact architect bootstrap segment',
        options: [
          '--target <path>',
          '--stamp-version <v>',
          '--tier <tier>',
          '--human',
          '--force',
          '--include <component>',
          '--hook <name>',
          '--command <cmd>',
        ],
      },
      {
        definition: initApplyHarness,
        name: 'init apply harness',
        description:
          'Apply the canonical harness projection with explicit Architect-initiated write consent.',
        rawName: 'init-apply-harness',
        commandDescription: 'Apply the exact harness bootstrap segment',
        options: [
          '--target <path>',
          '--stamp-version <v>',
          '--tier <tier>',
          '--human',
          '--introspect',
          '--force',
          '--include <component>',
          '--output <path>',
        ],
      },
    ] as const;

    for (const expected of cases) {
      expect(expected.definition).toMatchObject({
        name: expected.name,
        description: expected.description,
        authority: 'mesh_controller',
      });
      const cli = cac('devai-init-role-surface');
      expected.definition.register(cli);
      const command = cli.commands[0];
      expect(command?.rawName).toBe(expected.rawName);
      expect(command?.description).toBe(expected.commandDescription);
      expect(command?.options.map((option) => option.rawName)).toEqual(expected.options);
    }
  });

  it('emits exact role-pure plans and result summaries for all three apply segments', async () => {
    const { initApplyArchitect, initApplyHarness, initApplyOwner } = commands;
    const cases = [
      [initApplyOwner, 'owner'],
      [initApplyArchitect, 'architect'],
      [initApplyHarness, 'harness'],
    ] as const;
    for (const [definition, segment] of cases) {
      const root = repository(`devai-init-b-${segment}-`);
      const result = await invoke(definition, [
        `init-apply-${segment}`,
        '--target',
        root,
        '--tier',
        'tier3',
        '--stamp-version',
        '9.8.7',
      ]);
      expect(result.exit, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      const payload = JSON.parse(result.stdout) as {
        plan: { target_root: string; devai_version: string; entries: Array<{ path: string }> };
        result: Record<string, string[]>;
        included: unknown[];
      };
      expect(payload.plan.target_root).toBe(root);
      expect(payload.plan.devai_version).toBe('9.8.7');
      expect(payload.plan.entries.length).toBeGreaterThan(0);
      expect(payload.included).toEqual([]);
      expect(Object.keys(payload.result).sort()).toEqual([
        'created',
        'overwritten',
        'preserved',
        'skipped',
      ]);
      expect(payload.result.created.length).toBe(payload.plan.entries.length);
      for (const { path } of payload.plan.entries) {
        if (segment === 'owner') {
          expect(path.startsWith('product/') || path.startsWith('law/glossary/')).toBe(true);
        } else if (segment === 'architect') {
          expect(
            path === 'AGENTS.md' ||
              path === 'CLAUDE.md' ||
              path.startsWith('docs/') ||
              path.startsWith('work/') ||
              (path.startsWith('law/') && !path.startsWith('law/glossary/')),
          ).toBe(true);
        } else {
          expect(
            path !== 'AGENTS.md' &&
              path !== 'CLAUDE.md' &&
              !path.startsWith('product/') &&
              !path.startsWith('docs/') &&
              !path.startsWith('work/') &&
              !path.startsWith('law/'),
          ).toBe(true);
        }
        expect(existsSync(join(root, path))).toBe(true);
      }
    }
  });

  it('binds a custom architect hook and refuses an invalid hook before any write', async () => {
    const { initApplyArchitect } = commands;
    const invalidRoot = repository('devai-init-b-invalid-hook-');
    const invalid = await invoke(initApplyArchitect, [
      'init-apply-architect',
      '--target',
      invalidRoot,
      '--include',
      'hooks',
      '--hook',
      'unknown',
    ]);
    expect(invalid).toEqual({
      exit: 2,
      stdout: '',
      stderr:
        "devai init apply architect: --hook must be one of pre-commit | pre-push | post-merge (got 'unknown')\n",
    });
    expect(existsSync(join(invalidRoot, 'AGENTS.md'))).toBe(false);

    const root = repository('devai-init-b-custom-hook-');
    const command = './node_modules/.bin/devai sense inventory --slice runtime';
    const result = await invoke(initApplyArchitect, [
      'init-apply-architect',
      '--target',
      root,
      '--include',
      'hooks',
      '--hook',
      'pre-commit',
      '--command',
      command,
    ]);
    expect(result.exit, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      included: Array<{ component: string; plan: Record<string, unknown>; result: unknown }>;
    };
    expect(payload.included).toEqual([
      {
        component: 'hooks',
        plan: expect.objectContaining({
          action: 'create',
          hook: 'pre-commit',
          manager: 'git',
          command,
        }),
        result: { executed: true },
      },
    ]);
    const hookPath = String(payload.included[0]?.plan['path']);
    expect(readFileSync(hookPath, 'utf8')).toContain(command);
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
  });

  it('reports exact CI and skills component effects in JSON and human modes', async () => {
    const { initApplyHarness } = commands;
    const root = repository('devai-init-b-includes-');
    const output = join(root, '.github/workflows/custom-devai.yml');
    const first = await invoke(initApplyHarness, [
      'init-apply-harness',
      '--target',
      root,
      '--include',
      'ci, skills',
      '--output',
      output,
    ]);
    expect(first.exit, first.stderr).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      included: Array<{
        component: string;
        plan: Record<string, unknown>;
        result: Record<string, unknown>;
      }>;
    };
    expect(payload.included.map(({ component }) => component)).toEqual(['ci', 'skills']);
    expect(payload.included[0]).toMatchObject({
      component: 'ci',
      plan: { path: output },
      result: { written: true },
    });
    expect(readFileSync(output, 'utf8')).toContain('devai');
    expect(payload.included[1]).toMatchObject({
      component: 'skills',
      plan: { hosts: ['codex', 'claude'], recipes: 7 },
    });
    expect(payload.included[1]?.result['written']).toHaveLength(49);
    expect(payload.included[1]?.result['unchanged']).toEqual([]);

    const repeat = await invoke(initApplyHarness, [
      'init-apply-harness',
      '--target',
      root,
      '--include',
      'ci,skills',
      '--output',
      output,
      '--human',
    ]);
    expect(repeat.exit, repeat.stderr).toBe(0);
    expect(repeat.stdout).toContain('init apply harness:');
    expect(repeat.stdout).toContain(`ci scaffold: skipped ${output}`);
    expect(repeat.stdout).toContain('skills install: 0 written, 49 unchanged');
    expect(repeat.stdout).toContain('2 included component(s)');
  });

  it('rolls back core bootstrap writes when introspection persistence fails', async () => {
    const { initApplyHarness } = commands;
    const root = repository('devai-init-b-rollback-');
    const blocked = join(root, '.devai/state/init-introspection.json');
    mkdirSync(blocked, { recursive: true });
    await expect(
      invoke(initApplyHarness, ['init-apply-harness', '--target', root, '--introspect']),
    ).rejects.toThrow();
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, 'record/proofs/chain.json'))).toBe(false);
    expect(statSync(blocked).isDirectory()).toBe(true);
  });

  it('describes the complete four-segment binding with exact installed-policy identities', async () => {
    const { initBind } = commands;
    const root = repository('devai-init-b-full-plan-');
    const result = await invoke(initBind, ['init-bind', '--target', root, '--full']);
    expect(result.exit, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      plan: Array<{ segment: string; plan: unknown }>;
    };
    expect(payload.plan.map(({ segment }) => segment)).toEqual([
      'constitution',
      'operational-law',
      'subprocess-effects',
      'authority-policy',
    ]);
    const operational = payload.plan[1]?.plan as Array<Record<string, unknown>>;
    expect(operational.map(({ source, target }) => ({ source, target }))).toEqual(
      [
        'domains.json',
        'forbidden-actions.json',
        'glob-guards.json',
        'scorecard-na.json',
        'thresholds.json',
      ].map((file) => ({
        source: `installed:law/policy/${file}`,
        target: `.devai/config/${file}`,
      })),
    );
    expect(
      operational.every(
        (entry) =>
          entry['byte_identity_required'] === true &&
          /^[0-9a-f]{64}$/u.test(String(entry['digest_sha256'])),
      ),
    ).toBe(true);
    expect(payload.plan[2]?.plan).toMatchObject({
      source: 'installed:law/policy/subprocess-effects.json',
      target: '.devai/config/subprocess-effects.json',
      byte_identity_required: true,
      digest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(payload.plan[3]?.plan).toEqual({ target: '.devai/config/authority-policy.json' });
    expect(existsSync(join(root, '.devai'))).toBe(false);

    const human = await invoke(initBind, ['init-bind', '--target', root, '--full', '--human']);
    expect(human).toEqual({
      exit: 0,
      stdout:
        'init bind --full (plan only): constitution → operational-law → subprocess-effects → authority-policy\n',
      stderr: '',
    });
  });

  it('writes every full-bind segment atomically and reports the ordered results', async () => {
    const { initBind } = commands;
    const root = repository('devai-init-b-full-write-');
    const result = await invoke(initBind, [
      'init-bind',
      '--target',
      root,
      '--full',
      '--tier',
      'tier2',
      '--write',
    ]);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout) as {
      segments: Array<{ segment: string; result: unknown }>;
    };
    expect(payload.segments.map(({ segment }) => segment)).toEqual([
      'constitution',
      'operational-law',
      'subprocess-effects',
      'authority-policy',
    ]);
    expect(payload.segments[3]).toEqual({
      segment: 'authority-policy',
      result: {
        path: '.devai/config/authority-policy.json',
        operation: 'unchanged',
        digest_sha256: 'a'.repeat(64),
      },
    });
    expect(readFileSync(join(root, '.devai/pin/constitution.md'), 'utf8')).not.toBe('');
    expect(readFileSync(join(root, '.devai/constitution.md'), 'utf8')).not.toBe('');
    expect(
      JSON.parse(readFileSync(join(root, '.devai/config/project.json'), 'utf8')),
    ).toMatchObject({
      profile: 'tier2',
      constitution: {
        version: expect.any(String),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    for (const file of [
      'domains.json',
      'forbidden-actions.json',
      'glob-guards.json',
      'scorecard-na.json',
      'thresholds.json',
      'subprocess-effects.json',
    ]) {
      expect(readFileSync(join(root, '.devai/config', file), 'utf8')).not.toBe('');
    }
  });

  it('materializes a valid adopter policy with an exact receipt and byte digests', async () => {
    const { initApplyHarness, initBind } = commands;
    const root = repository('devai-init-b-adopter-');
    const bootstrap = await invoke(initApplyHarness, [
      'init-apply-harness',
      '--target',
      root,
      '--tier',
      'tier3',
    ]);
    expect(bootstrap.exit, bootstrap.stderr).toBe(0);
    const source = join(root, 'law/policy/adopter-policy.json');
    mkdirSync(join(root, 'law/policy'), { recursive: true });
    writeFileSync(
      source,
      `${JSON.stringify({
        schemaVersion: '1.0.0',
        policy_id: 'fixture.init-remediation-b',
        policy_version: '1.0.0',
        domains: { client: ['CLI'] },
        thresholds: { coverage: { lines: 91 } },
      })}\n`,
    );
    const result = await invoke(initBind, [
      'init-bind',
      '--target',
      root,
      '--adopter-policy',
      'law/policy/adopter-policy.json',
      '--write',
    ]);
    expect(result.exit, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      receipt_path: string;
      receipt: Record<string, unknown>;
      authority_policy: { path: string; digest_sha256: string; operation: string };
    };
    expect(payload.receipt_path).toBe('.devai/config/adopter-policy-binding.json');
    expect(payload.receipt).toMatchObject({
      schemaVersion: '1.0.0',
      policy_id: 'fixture.init-remediation-b',
      policy_version: '1.0.0',
      source_path: 'law/policy/adopter-policy.json',
      source_digest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(payload.authority_policy).toMatchObject({
      path: expect.stringContaining('.devai/config/authority-policy.json'),
      digest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.parse(readFileSync(join(root, payload.receipt_path), 'utf8'))).toEqual(
      payload.receipt,
    );
    const materialized = payload.receipt['materialized'] as Record<string, string>;
    expect(Object.keys(materialized).sort()).toEqual([
      '.devai/config/domains.json',
      '.devai/config/glob-guards.json',
      '.devai/config/project.json',
      '.devai/config/scorecard-na.json',
      '.devai/config/thresholds.json',
    ]);
    expect(Object.values(materialized).every((digest) => /^[0-9a-f]{64}$/u.test(digest))).toBe(
      true,
    );
  });
});
