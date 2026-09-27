// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// ADR-SCR-0005 IA-004: gh run list with the declared argv shape is admitted as a
// read-only process without a host adapter; gh with any other subcommand is refused.
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as { executable: string; args: string[] }[]);

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawnSync: (executable: string, args: readonly string[]) => {
      spawned.push({ executable, args: [...args] });
      return { status: 1, stdout: '', stderr: 'recorded', error: undefined };
    },
  };
});

const { createAuthorityHostBroker } = await import('../../src/authority/broker.js');
const { canonicalRegistry } = await import('../../src/define-command.js');
const { resolveCliVersion } = await import('../../src/version.js');
const { senseHarnessGreenMain, senseHarnessPerformance, senseHarnessRobustness } =
  await import('@devai-nyx/sensors');

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = canonicalRegistry();
function action(name: string) {
  const entry = entries.find((entry) => entry.name === name);
  if (entry === undefined) throw new Error(`missing action ${name}`);
  return entry;
}

function effect(executable: unknown, args: unknown): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

function invoke(
  kind: string,
  executable: unknown,
  args: unknown,
  actionName = 'sense run',
): () => unknown {
  const host = createAuthorityHostBroker({
    entry: action(actionName),
    entries,
    argv:
      actionName === 'sense run'
        ? [process.execPath, 'devai', 'sense', 'run', kind]
        : [process.execPath, 'devai', 'check'],
    role: 'auditor',
    declaration: { as_role: 'auditor' },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  return () => {
    try {
      return host.scope.apply_effect(effect(executable, args), () => 'allowed');
    } finally {
      host.dispose();
    }
  };
}

afterEach(() => {
  spawned.length = 0;
});

describe('gh run list is a declared read-only host process (ADR-SCR-0005 IA-004)', () => {
  it.each([
    ['harness_green_main', () => senseHarnessGreenMain({ repoRoot: ROOT })],
    [
      'harness_green_main',
      () => senseHarnessGreenMain({ repoRoot: ROOT, since: '2026-09-01', limit: 20 }),
    ],
    ['harness_performance', () => senseHarnessPerformance({ repoRoot: ROOT })],
    ['harness_robustness', () => senseHarnessRobustness({ repoRoot: ROOT })],
  ] as const)('admits the argv %s actually emits', (kind, sense) => {
    sense();
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call?.executable).toBe('gh');
    expect(call?.args.slice(0, 2)).toEqual(['run', 'list']);
    expect(invoke(kind, call?.executable, call?.args)()).toBe('allowed');
  });

  it.each([
    [
      'harness_green_main',
      ['run', 'list', '--branch', 'main', '--json', 'conclusion,createdAt', '--limit', '50'],
    ],
    [
      'harness_green_main',
      [
        'run',
        'list',
        '--branch',
        'release/v1.2',
        '--json',
        'conclusion,createdAt',
        '--limit',
        '50',
        '--created',
        '>=2026-09-01T00:00:00Z',
      ],
    ],
    [
      'harness_performance',
      [
        'run',
        'list',
        '--branch',
        'main',
        '--json',
        'conclusion,createdAt,updatedAt',
        '--limit',
        '50',
      ],
    ],
    [
      'harness_robustness',
      ['run', 'list', '--branch', 'main', '--json', 'conclusion,attempt', '--limit', '100'],
    ],
    ['runtime_probe_auth', ['auth', 'status']],
    ['runtime_probe_api', ['--version']],
  ] as const)('admits %s: gh %j', (kind, args) => {
    expect(invoke(kind, 'gh', args)()).toBe('allowed');
  });

  const refused: readonly (readonly unknown[])[] = [
    // Mutating subcommands stay refused.
    ['run', 'cancel', '123'],
    ['run', 'rerun', '123'],
    ['run', 'delete', '123'],
    ['run', 'watch', '123'],
    ['workflow', 'run', 'ci.yml'],
    ['workflow', 'disable', 'ci.yml'],
    ['pr', 'create', '--fill'],
    ['pr', 'merge', '1', '--admin'],
    ['release', 'create', 'v1.0.0'],
    ['release', 'delete', 'v1.0.0'],
    ['repo', 'delete', 'owner/repo', '--yes'],
    ['repo', 'edit', '--visibility', 'public'],
    ['issue', 'create', '--title', 't'],
    ['secret', 'set', 'TOKEN'],
    ['variable', 'set', 'NAME'],
    ['api', '-X', 'POST', 'repos/owner/repo/dispatches'],
    ['api', 'repos/owner/repo/actions/runs'],
    ['auth', 'login'],
    ['auth', 'logout'],
    ['auth', 'refresh'],
    ['auth', 'setup-git'],
    ['auth', 'token'],
    ['auth', 'status', '--show-token'],
    ['extension', 'install', 'owner/gh-ext'],
    ['alias', 'set', 'x', 'run cancel'],
    ['config', 'set', 'editor', 'vim'],
    // Read-only verbs outside the declared allowlist are refused too.
    ['run', 'view', '123'],
    ['pr', 'list'],
    ['run', 'list'],
    // gh run list outside the declared shape.
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '50', '--jq', '.'],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '50', '--web', 'x'],
    ['run', 'list', '--repo', 'o/r', '--json', 'conclusion', '--limit', '50', '--x', 'y'],
    ['run', 'list', '--json', 'conclusion', '--branch', 'main', '--limit', '50'],
    ['run', 'list', '--branch', '--web', '--json', 'conclusion', '--limit', '50'],
    ['run', 'list', '--branch', '../main', '--json', 'conclusion', '--limit', '50'],
    ['run', 'list', '--branch', 'main', '--json', 'a;b', '--limit', '50'],
    ['run', 'list', '--branch', 'main', '--json', '', '--limit', '50'],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '0'],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '-1'],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '99999'],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '50', '--created'],
    [
      'run',
      'list',
      '--branch',
      'main',
      '--json',
      'conclusion',
      '--limit',
      '50',
      '--created',
      '<=2026-09-01',
    ],
    [
      'run',
      'list',
      '--branch',
      'main',
      '--json',
      'conclusion',
      '--limit',
      '50',
      '--status',
      'failure',
    ],
    ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', 50],
    ['-R', 'owner/repo', 'run', 'list', '--branch', 'main', '--json', 'c', '--limit', '5'],
  ];

  // `gh pr list` resolves to a governed process target and is refused for consent
  // instead; every refusal is an authority error and the process never runs.
  it.each(refused.map((args) => [args.join(' '), args] as const))(
    'refuses gh %s',
    (_label, args) => {
      expect(invoke('harness_green_main', 'gh', args)).toThrow(/^AUTHORITY_[A-Z_]+$/u);
    },
  );

  it.each([
    ['/tmp/gh', ['run', 'list', '--branch', 'main', '--json', 'conclusion', '--limit', '50']],
    ['./gh', ['auth', 'status']],
    ['gh', 'run list --branch main --json conclusion --limit 50'],
  ] as const)('refuses a non-exact gh executable or argv: %s %j', (executable, args) => {
    expect(invoke('harness_green_main', executable, args)).toThrow(
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    );
  });

  it('admits the harness_performance argv under check, where it also runs', () => {
    senseHarnessPerformance({ repoRoot: ROOT });
    const [call] = spawned;
    expect(invoke('harness_performance', call?.executable, call?.args, 'check')()).toBe('allowed');
    expect(invoke('harness_performance', 'gh', ['run', 'cancel', '1'], 'check')).toThrow(
      /^AUTHORITY_[A-Z_]+$/u,
    );
  });

  it('admits exactly the argv shapes the subprocess-effects templates declare', () => {
    const samples: Readonly<Record<string, string>> = {
      '<ref>': 'main',
      '<fields>': 'conclusion,createdAt',
      '<n>': '50',
      '>=<date>': '>=2026-09-01',
    };
    for (const path of [
      'law/policy/subprocess-effects.json',
      '.devai/config/subprocess-effects.json',
    ]) {
      const registry = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as {
        templates: { template_id: string; executable: string; argv_shape: string[] }[];
      };
      const declared = registry.templates.filter((template) =>
        ['gh-auth-status', 'gh-run-list', 'gh-run-list-created'].includes(template.template_id),
      );
      expect(declared.map((template) => template.template_id).sort()).toEqual([
        'gh-auth-status',
        'gh-run-list',
        'gh-run-list-created',
      ]);
      for (const template of declared) {
        const argv = template.argv_shape.map((token) => samples[token] ?? token);
        expect(template.executable).toBe('gh');
        expect(invoke('harness_green_main', 'gh', argv)()).toBe('allowed');
        expect(invoke('harness_green_main', 'gh', [...argv, '--web'])).toThrow(
          /^AUTHORITY_[A-Z_]+$/u,
        );
      }
    }
  });
});
