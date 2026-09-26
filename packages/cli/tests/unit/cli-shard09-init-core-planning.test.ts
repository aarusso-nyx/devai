import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  initApplyArchitect,
  initApplyHarness,
  initApplyOwner,
  initPlan,
} from '../../src/commands/init/index.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];

function fixture(prefix: string, git = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  if (git && spawnSync('git', ['init', '--quiet'], { cwd: root }).status !== 0) {
    throw new Error('test git init failed');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function invoke(
  definition: { register(cli: CAC): void },
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-init-core-planning');
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
      await withAuthorityHostTestScope(() => cli.runMatchedCommand());
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

async function invokeDirect(
  definition: { register(cli: CAC): void },
  options: Record<string, unknown>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-init-core-direct');
  definition.register(cli);
  const action = cli.commands[0]?.commandAction;
  if (action === undefined) throw new Error('command action missing');
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
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
    try {
      await action(options);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('CLI shard 09 init core planning', () => {
  it('registers every lane A command and option with its exact public help contract', () => {
    const common = [
      ['--target <path>', 'Target directory (default: .)'],
      ['--stamp-version <v>', 'DEVAI version stamp for reproducible plans'],
      ['--tier <tier>', 'Adoption tier: tier1 | tier2 | tier3'],
      ['--human', 'Human-readable output'],
    ] as const;
    const cases = [
      [
        initPlan,
        'init-plan',
        'Generate the non-authorizing bootstrap plan',
        [
          ...common,
          ['--introspect', 'Include repository introspection'],
          [
            '--interactive',
            'Author the plan through schema-driven prompts; writes replay as init bind and init apply',
          ],
          ['--mode <mode>', 'Interactive mode: bind | edit (default: bind)'],
        ],
      ],
      [
        initApplyOwner,
        'init-apply-owner',
        'Apply the exact owner bootstrap segment',
        [...common, ['--force', 'Overwrite existing non-provenance files in this segment']],
      ],
      [
        initApplyArchitect,
        'init-apply-architect',
        'Apply the exact architect bootstrap segment',
        [
          ...common,
          ['--force', 'Overwrite existing non-provenance files in this segment'],
          ['--include <component>', 'Also install the hooks component: hooks'],
          ['--hook <name>', 'pre-commit | pre-push | post-merge (default: pre-push)'],
          [
            '--command <cmd>',
            'Hook command (default: ./node_modules/.bin/devai check --only forbidden-actions --strict)',
          ],
        ],
      ],
      [
        initApplyHarness,
        'init-apply-harness',
        'Apply the exact harness bootstrap segment',
        [
          ...common,
          ['--introspect', 'Include repository introspection'],
          ['--force', 'Overwrite existing non-provenance files in this segment'],
          ['--include <component>', 'Also install components: ci | skills'],
          [
            '--output <path>',
            'CI output path (default: <target>/.github/workflows/devai-ledger-verify.yml)',
          ],
        ],
      ],
    ] as const;

    for (const [definition, name, description, options] of cases) {
      const cli = cac('devai-init-core-help');
      definition.register(cli);
      const command = cli.commands[0];
      expect(command?.rawName).toBe(name);
      expect(command?.description).toBe(description);
      expect(command?.options.map(({ rawName, description: text }) => [rawName, text])).toEqual(
        options,
      );
      expect(command?.commandAction).toBeTypeOf('function');
    }
  });

  it('emits exact JSON and newline-terminated human plans with reproducible inputs', async () => {
    const root = fixture('devai-init-core-output-', true);
    const json = await invoke(initPlan, [
      'init-plan',
      '--target',
      root,
      '--stamp-version',
      '9.8.7',
      '--tier',
      'tier1',
    ]);
    expect(json.exit, json.stderr).toBe(0);
    expect(json.stderr).toBe('');
    expect(json.stdout.endsWith('\n')).toBe(true);
    const plan = JSON.parse(json.stdout) as {
      target_root: string;
      devai_version: string;
      entries: Array<{ path: string; action: string }>;
      summary: { create: number; overwrite: number; skip: number };
    };
    expect(plan.target_root).toBe(root);
    expect(plan.devai_version).toBe('9.8.7');
    expect(plan.entries).toHaveLength(15);
    expect(plan.summary).toEqual({ create: plan.entries.length, overwrite: 0, skip: 0 });

    const human = await invoke(initPlan, [
      'init-plan',
      '--target',
      root,
      '--tier',
      'tier1',
      '--human',
    ]);
    expect(human.exit, human.stderr).toBe(0);
    expect(human.stderr).toBe('');
    expect(human.stdout).toMatch(/^init plan: \d+ would be created, 0 already exist\n/u);
    expect(human.stdout.endsWith('\n')).toBe(true);
    expect(human.stdout.split('\n').filter((line) => line.startsWith('  + '))).toHaveLength(
      plan.entries.length,
    );
  });

  it('partitions the canonical plan exactly once with exact segment summaries', async () => {
    const root = fixture('devai-init-core-segments-', true);
    const result = await invoke(initPlan, ['init-plan', '--target', root, '--tier', 'tier2']);
    expect(result.exit, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      entries: Array<{ path: string; action: 'create' | 'overwrite' | 'skip-exists' }>;
      segments: Array<{
        segment: 'owner' | 'architect' | 'harness';
        entries: Array<{ path: string; action: 'create' | 'overwrite' | 'skip-exists' }>;
        summary: { create: number; overwrite: number; skip: number };
      }>;
    };
    expect(plan.segments.map(({ segment }) => segment)).toEqual(['owner', 'architect', 'harness']);
    const paths = plan.segments.flatMap(({ entries }) => entries.map(({ path }) => path));
    expect([...paths].sort()).toEqual(plan.entries.map(({ path }) => path).sort());
    expect(new Set(paths).size).toBe(paths.length);
    for (const { segment, entries, summary } of plan.segments) {
      expect(summary).toEqual({
        create: entries.filter(({ action }) => action === 'create').length,
        overwrite: entries.filter(({ action }) => action === 'overwrite').length,
        skip: entries.filter(({ action }) => action === 'skip-exists').length,
      });
      for (const { path } of entries) {
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
      }
    }
  });

  it('distinguishes invalid tiers files missing roots and nested worktree targets', async () => {
    const outer = fixture('devai-init-core-targets-');
    const file = join(outer, 'target.txt');
    writeFileSync(file, 'not a directory\n');
    const missing = join(outer, 'missing');
    for (const [target, message] of [
      [file, 'Init target must exist and be a directory'],
      [missing, 'Init target must exist and be a directory'],
      [outer, 'Init target is not a Git repository'],
    ] as const) {
      const result = await invoke(initPlan, ['init-plan', '--target', target]);
      expect(result.exit).toBe(5);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual(
        expect.objectContaining({
          code: 'INIT_TARGET_PRECONDITION_UNSATISFIED',
          class: 'precondition',
          exit: 5,
          message: `${message}: ${target}`,
          remediation: 'Choose an existing directory inside a Git work tree and retry.',
          context: { target_root: target },
        }),
      );
    }

    const invalidTier = await invoke(initPlan, ['init-plan', '--target', outer, '--tier', 'tier0']);
    expect(invalidTier).toEqual({
      exit: 2,
      stdout: '',
      stderr: "devai init: --tier must be one of tier1 | tier2 | tier3 (got 'tier0')\n",
    });

    const worktree = join(outer, 'linked');
    const nested = join(worktree, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /fixture/common/worktrees/linked\n');
    const accepted = await invoke(initPlan, ['init-plan', '--target', nested]);
    expect(accepted.exit, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ target_root: nested });
  });

  it('rejects every empty duplicate unknown and cross-segment include before writing', async () => {
    const cases = [
      [initApplyOwner, 'owner', 'ci', 'no components'],
      [initApplyArchitect, 'architect', 'ci', 'hooks'],
      [initApplyArchitect, 'architect', 'hooks,hooks', 'hooks'],
      [initApplyHarness, 'harness', '   ', 'ci | skills'],
      [initApplyHarness, 'harness', 'ci,unknown', 'ci | skills'],
      [initApplyHarness, 'harness', 'skills, skills', 'ci | skills'],
    ] as const;
    for (const [definition, segment, include, expected] of cases) {
      const root = fixture(`devai-init-core-include-${segment}-`);
      const result = await invokeDirect(definition, { target: root, include });
      expect(result).toEqual({
        exit: 2,
        stdout: '',
        stderr: `devai init apply ${segment}: --include accepts ${expected} (got '${include}')\n`,
      });
      expect(readdirSync(root)).toEqual([]);
    }
  });

  it('preserves exact CI and skills include plans targets results and request order', async () => {
    const root = fixture('devai-init-core-components-');
    const output = join(root, '.github/workflows/custom-ledger.yml');
    const result = await invoke(initApplyHarness, [
      'init-apply-harness',
      '--target',
      root,
      '--tier',
      'tier1',
      '--include',
      ' ci, skills ',
      '--output',
      output,
    ]);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as {
      included: Array<{
        component: string;
        plan: Record<string, unknown>;
        result: Record<string, unknown>;
      }>;
    };
    expect(body.included.map(({ component }) => component)).toEqual(['ci', 'skills']);
    expect(body.included[0]).toMatchObject({
      component: 'ci',
      plan: { path: output },
      result: { written: true },
    });
    expect(body.included[1]).toMatchObject({
      component: 'skills',
      plan: { hosts: ['codex', 'claude'], recipes: 7 },
      result: { written: expect.any(Array), unchanged: [] },
    });
    expect(existsSync(output)).toBe(true);
    expect(lstatSync(output).isFile()).toBe(true);
    expect(readFileSync(output, 'utf8')).toContain('devai-ledger-verify');
    expect((body.included[1]?.result['written'] as unknown[]).length).toBe(49);
  });

  it('preflights a later skills conflict before writing CI or core plan targets', async () => {
    const root = fixture('devai-init-core-preflight-');
    const conflict = join(root, '.agents/skills/devai-assess/SKILL.md');
    const output = join(root, '.github/workflows/custom-ledger.yml');
    mkdirSync(join(conflict, '..'), { recursive: true });
    writeFileSync(conflict, 'adopter-owned\n');

    await expect(
      invoke(initApplyHarness, [
        'init-apply-harness',
        '--target',
        root,
        '--include',
        'ci,skills',
        '--output',
        output,
      ]),
    ).rejects.toThrow(/RECIPE_ADAPTER_CONFLICT/u);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, 'record/proofs/chain.json'))).toBe(false);
    expect(readFileSync(conflict, 'utf8')).toBe('adopter-owned\n');
  });
});
