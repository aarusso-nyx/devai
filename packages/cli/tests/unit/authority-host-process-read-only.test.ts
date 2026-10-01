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

/** DEVAI's declared population (.devai/config/sensor-inputs.json), ADR-SCR-0010. */
const DEVAI_POPULATION = {
  workflow: 'pull-request-checks.yml',
  event: 'pull_request',
  headBranch: '*',
  baseBranch: 'main',
  attempts: 'last',
  includeCancelled: false,
  lookbackDays: 30,
  excludedJobs: [
    { workflow: 'release.yml', job: 'verify-ledger' },
    { workflow: 'release.yml', job: 'build-release' },
    { workflow: 'release.yml', job: 'finalize-release' },
    { workflow: 'release.yml', job: 'deploy-pages' },
  ],
} as const;

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

/** The admitted gh run list shape: workflow and event, then json and limit (ADR-SCR-0010). */
const BASE = ['run', 'list', '--workflow', 'pull-request-checks.yml', '--event', 'pull_request'];
const TAIL = ['--json', 'conclusion', '--limit', '50'];

describe('gh run list is a declared read-only host process (ADR-SCR-0005 IA-004)', () => {
  it.each([
    [
      'harness_green_main',
      () => senseHarnessGreenMain({ repoRoot: ROOT, ...DEVAI_POPULATION, minimumSample: 20 }),
    ],
    [
      'harness_green_main',
      () =>
        senseHarnessGreenMain({
          repoRoot: ROOT,
          ...DEVAI_POPULATION,
          minimumSample: 20,
          headBranch: 'release/v1.2',
          since: '2026-09-01',
          limit: 20,
        }),
    ],
    [
      'harness_performance',
      () => senseHarnessPerformance({ repoRoot: ROOT, ...DEVAI_POPULATION, minimumSample: 10 }),
    ],
    [
      'harness_robustness',
      () => senseHarnessRobustness({ repoRoot: ROOT, ...DEVAI_POPULATION, minimumSample: 20 }),
    ],
  ] as const)('admits the argv %s actually emits', (kind, sense) => {
    sense();
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call?.executable).toBe('gh');
    expect(call?.args.slice(0, 2)).toEqual(['run', 'list']);
    expect(call?.args).toContain('--workflow');
    expect(call?.args).toContain('--event');
    expect(invoke(kind, call?.executable, call?.args)()).toBe('allowed');
  });

  it.each([
    ['harness_green_main', [...BASE, ...TAIL]],
    ['harness_green_main', [...BASE, '--branch', 'release/v1.2', ...TAIL]],
    ['harness_green_main', [...BASE, ...TAIL, '--created', '>=2026-09-01T00:00:00Z']],
    [
      'harness_green_main',
      [...BASE, '--branch', 'release/v1.2', ...TAIL, '--created', '>=2026-09-01'],
    ],
    [
      'harness_performance',
      [
        'run',
        'list',
        '--workflow',
        'ci.yml',
        '--event',
        'push',
        '--branch',
        'main',
        '--json',
        'conclusion,createdAt,updatedAt',
        '--limit',
        '50',
      ],
    ],
    ['harness_robustness', [...BASE, '--json', 'conclusion,attempt', '--limit', '100']],
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
    [...BASE, ...TAIL, '--jq', '.'],
    [...BASE, ...TAIL, '--web', 'x'],
    ['run', 'list', '--repo', 'o/r', ...TAIL, '--x', 'y'],
    // The old shape without --workflow and --event is no longer admitted.
    ['run', 'list', '--branch', 'main', ...TAIL],
    // A second --branch, or --branch out of order.
    [...BASE, '--branch', 'main', '--branch', 'dev', ...TAIL],
    [...BASE, ...TAIL.slice(0, 2), '--branch', 'main', ...TAIL.slice(2)],
    // Options out of order.
    ['run', 'list', '--event', 'pull_request', '--workflow', 'pull-request-checks.yml', ...TAIL],
    ['run', 'list', ...TAIL, '--workflow', 'pull-request-checks.yml', '--event', 'pull_request'],
    ['run', 'list', '--workflow', 'pull-request-checks.yml', ...TAIL, '--event', 'pull_request'],
    // A bad event or workflow file.
    ['run', 'list', '--workflow', 'pull-request-checks.yml', '--event', 'issues', ...TAIL],
    ['run', 'list', '--workflow', 'pull-request-checks.yml', '--event', '--web', ...TAIL],
    ['run', 'list', '--workflow', '../ci.yml', '--event', 'pull_request', ...TAIL],
    ['run', 'list', '--workflow', '.github/ci.yml', '--event', 'pull_request', ...TAIL],
    ['run', 'list', '--workflow', 'ci.txt', '--event', 'pull_request', ...TAIL],
    ['run', 'list', '--workflow', '--web', '--event', 'pull_request', ...TAIL],
    // A bad branch, fields, limit, or created filter.
    [...BASE, '--branch', '--web', ...TAIL],
    [...BASE, '--branch', '../main', ...TAIL],
    [...BASE, '--json', 'a;b', '--limit', '50'],
    [...BASE, '--json', '', '--limit', '50'],
    [...BASE, '--json', 'conclusion', '--limit', '0'],
    [...BASE, '--json', 'conclusion', '--limit', '-1'],
    [...BASE, '--json', 'conclusion', '--limit', '99999'],
    [...BASE, ...TAIL, '--created'],
    [...BASE, ...TAIL, '--created', '<=2026-09-01'],
    [...BASE, ...TAIL, '--status', 'failure'],
    [...BASE, '--json', 'conclusion', '--limit', 50],
    ['-R', 'owner/repo', ...BASE, '--json', 'c', '--limit', '5'],
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
    ['/tmp/gh', [...BASE, ...TAIL]],
    ['./gh', ['auth', 'status']],
    ['gh', `${BASE.join(' ')} ${TAIL.join(' ')}`],
  ] as const)('refuses a non-exact gh executable or argv: %s %j', (executable, args) => {
    expect(invoke('harness_green_main', executable, args)).toThrow(
      'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED',
    );
  });

  it('admits the harness_performance argv under check, where it also runs', () => {
    senseHarnessPerformance({ repoRoot: ROOT, ...DEVAI_POPULATION, minimumSample: 10 });
    const [call] = spawned;
    expect(invoke('harness_performance', call?.executable, call?.args, 'check')()).toBe('allowed');
    expect(invoke('harness_performance', 'gh', ['run', 'cancel', '1'], 'check')).toThrow(
      /^AUTHORITY_[A-Z_]+$/u,
    );
  });

  it('admits exactly the argv shapes the subprocess-effects templates declare', () => {
    const samples: Readonly<Record<string, string>> = {
      '<file>': 'pull-request-checks.yml',
      '<event>': 'pull_request',
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
        [
          'gh-auth-status',
          'gh-run-list',
          'gh-run-list-created',
          'gh-run-list-branch',
          'gh-run-list-branch-created',
        ].includes(template.template_id),
      );
      expect(declared.map((template) => template.template_id).sort()).toEqual([
        'gh-auth-status',
        'gh-run-list',
        'gh-run-list-branch',
        'gh-run-list-branch-created',
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
