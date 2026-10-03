// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// ADR-AUT-0002 inspector acceptance IA-001, IA-002, IA-003, IA-006: the broker admits exactly
// the declared build argv and the two Pages journal gh api GET shapes, refuses every other
// shape before a process starts, and its literal list mirrors the subprocess templates.
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { senseBuild, senseSiteDrift } from '@devai-nyx/sensors';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = canonicalRegistry();
const senseRun = (() => {
  const entry = entries.find((candidate) => candidate.name === 'sense run');
  if (entry === undefined) throw new Error('missing action sense run');
  return entry;
})();

const JOURNAL_REPOSITORY = 'aarusso-nyx/devai';
const DEPLOYMENTS_PATH = `/repos/${JOURNAL_REPOSITORY}/deployments?environment=devai-pages-publication&per_page=100`;
const statusesPath = (id: string | number): string =>
  `/repos/${JOURNAL_REPOSITORY}/deployments/${id}/statuses?per_page=100`;

/**
 * The gh api GET shapes the broker literal admits after ADR-AUT-0002, written as the
 * template argv_shape strings. The mirror test compares this list with the gh api read
 * templates in law/policy/subprocess-effects.json in both directions and proves the broker
 * admits each instantiated shape, so a template removed while the literal still admits the
 * shape, or a literal removed while the template still declares it, fails here.
 */
const BROKER_GH_API_SHAPES: Readonly<Record<string, readonly string[]>> = {
  'gh-api-pages-deployments': [
    'api',
    '/repos/<owner>/<repo>/deployments?environment=devai-pages-publication&per_page=100',
  ],
  'gh-api-pages-deployment-statuses': [
    'api',
    '/repos/<owner>/<repo>/deployments/<id>/statuses?per_page=100',
  ],
};

interface SubprocessTemplate {
  readonly template_id: string;
  readonly executable: string;
  readonly argv_shape: readonly string[];
  readonly capabilities: readonly string[];
  readonly effect: string;
  readonly argv_precedence?: readonly { readonly source: string; readonly path: string }[];
  readonly conflict_code?: string;
}

function templates(): readonly SubprocessTemplate[] {
  const document = JSON.parse(
    readFileSync(join(ROOT, 'law/policy/subprocess-effects.json'), 'utf8'),
  ) as { readonly templates: readonly SubprocessTemplate[] };
  return document.templates;
}

function instantiate(shape: readonly string[]): readonly string[] {
  return shape.map((argument) =>
    argument
      .replace('<owner>/<repo>', JOURNAL_REPOSITORY)
      .replace('<owner>', 'aarusso-nyx')
      .replace('<repo>', 'devai')
      .replace('<id>', '4242'),
  );
}

function effect(executable: unknown, args: unknown): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

function broker(kind: string, role: 'inspector' | 'auditor' = 'auditor') {
  return createAuthorityHostBroker({
    entry: senseRun,
    entries,
    argv: [process.execPath, 'devai', 'sense', 'run', kind, '--as-role', role],
    role,
    declaration: { as_role: role },
    repository_root: ROOT,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
}

/** Asks the broker about one process request; `apply` stands for the process start. */
function decide(kind: string, executable: unknown, args: unknown) {
  const host = broker(kind);
  const apply = vi.fn(() => 'started');
  try {
    let outcome: unknown;
    let refusal: unknown;
    try {
      outcome = host.scope.apply_effect(effect(executable, args), apply);
    } catch (error) {
      refusal = error;
    }
    return { outcome, refusal, apply };
  } finally {
    host.dispose();
  }
}

function expectRefusedBeforeStart(kind: string, executable: unknown, args: unknown): void {
  const { outcome, refusal, apply } = decide(kind, executable, args);
  expect(outcome).toBeUndefined();
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toBe('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
  expect(apply).not.toHaveBeenCalled();
}

function expectAdmitted(kind: string, executable: unknown, args: unknown): void {
  const { outcome, refusal, apply } = decide(kind, executable, args);
  expect(refusal).toBeUndefined();
  expect(outcome).toBe('started');
  expect(apply).toHaveBeenCalledTimes(1);
}

describe('gh api Pages journal shapes (ADR-AUT-0002 IA-002, IA-003)', () => {
  it.each([
    ['deployments listing', ['api', DEPLOYMENTS_PATH]],
    ['statuses listing for a decimal id', ['api', statusesPath(4242)]],
    ['statuses listing for a one-digit id', ['api', statusesPath(7)]],
  ] as const)('admits the %s under sense run without a host adapter', (_label, args) => {
    expectAdmitted('site_drift', 'gh', args);
  });

  it('admits the same shapes under check, which shares the gh read matcher', () => {
    const check = entries.find((candidate) => candidate.name === 'check');
    if (check === undefined) throw new Error('missing action check');
    const host = createAuthorityHostBroker({
      entry: check,
      entries,
      argv: [process.execPath, 'devai', 'check', '--as-role', 'auditor'],
      role: 'auditor',
      declaration: { as_role: 'auditor' },
      repository_root: ROOT,
      package_version: resolveCliVersion(),
      bootstrap_policy: true,
    });
    try {
      expect(host.scope.apply_effect(effect('gh', ['api', DEPLOYMENTS_PATH]), () => 'ok')).toBe(
        'ok',
      );
    } finally {
      host.dispose();
    }
  });

  const forbiddenOptions: readonly (readonly string[])[] = [
    ['--method', 'GET'],
    ['--method', 'POST'],
    ['--method=GET'],
    ['-X', 'GET'],
    ['-X', 'POST'],
    ['-XPOST'],
    ['-f', 'state=x'],
    ['-F', 'state=x'],
    ['--field', 'state=x'],
    ['--raw-field', 'state=x'],
    ['--input', 'payload.json'],
    ['--paginate'],
    ['--hostname', 'github.com'],
    ['--jq', '.[]'],
    ['-H', 'Accept: application/json'],
  ];

  it.each(forbiddenOptions)(
    'refuses the deployments listing with the option %j appended, before a process starts',
    (...option) => {
      expectRefusedBeforeStart('site_drift', 'gh', ['api', DEPLOYMENTS_PATH, ...option]);
    },
  );

  it.each(forbiddenOptions)(
    'refuses the deployments listing with the option %j placed before the endpoint',
    (...option) => {
      expectRefusedBeforeStart('site_drift', 'gh', ['api', ...option, DEPLOYMENTS_PATH]);
    },
  );

  it.each(forbiddenOptions)(
    'refuses the statuses listing with the option %j appended, before a process starts',
    (...option) => {
      expectRefusedBeforeStart('site_drift', 'gh', ['api', statusesPath(4242), ...option]);
    },
  );

  it.each([
    [
      'another owner',
      '/repos/other-owner/devai/deployments?environment=devai-pages-publication&per_page=100',
    ],
    [
      'another repository',
      '/repos/aarusso-nyx/detran/deployments?environment=devai-pages-publication&per_page=100',
    ],
    [
      'a traversal segment',
      '/repos/aarusso-nyx/devai/../detran/deployments?environment=devai-pages-publication&per_page=100',
    ],
    ['an absolute URL', `https://api.github.com${DEPLOYMENTS_PATH}`],
    ['a missing leading slash', DEPLOYMENTS_PATH.slice(1)],
    [
      'another environment',
      '/repos/aarusso-nyx/devai/deployments?environment=github-pages&per_page=100',
    ],
    [
      'another page size',
      '/repos/aarusso-nyx/devai/deployments?environment=devai-pages-publication&per_page=50',
    ],
    ['an extra query key', `${DEPLOYMENTS_PATH}&page=2`],
    [
      'reordered query keys',
      '/repos/aarusso-nyx/devai/deployments?per_page=100&environment=devai-pages-publication',
    ],
    ['no query', '/repos/aarusso-nyx/devai/deployments'],
    ['a third endpoint (releases)', '/repos/aarusso-nyx/devai/releases?per_page=100'],
    ['a third endpoint (one deployment)', '/repos/aarusso-nyx/devai/deployments/4242'],
    ['a third endpoint (user)', '/user'],
    ['graphql', 'graphql'],
    [
      'statuses of another repository',
      '/repos/aarusso-nyx/detran/deployments/4242/statuses?per_page=100',
    ],
    ['statuses with an extra query key', `${statusesPath(4242)}&page=2`],
    ['statuses without the query', '/repos/aarusso-nyx/devai/deployments/4242/statuses'],
  ] as const)('refuses a GET to %s although the method is GET', (_label, path) => {
    expectRefusedBeforeStart('site_drift', 'gh', ['api', path]);
  });

  it.each([
    ['a word', 'latest'],
    ['a negative number', '-1'],
    ['a fraction', '1.5'],
    ['a hexadecimal literal', '0x10'],
    ['an exponent', '1e3'],
    ['a padded number', ' 42'],
    ['an empty id', ''],
    ['a placeholder', '<id>'],
    ['a nested path', '42/../43'],
  ] as const)('refuses a statuses listing whose deployment id is %s', (_label, id) => {
    expectRefusedBeforeStart('site_drift', 'gh', ['api', statusesPath(id)]);
  });

  it.each([
    ['the endpoint alone', ['api']],
    ['two endpoints', ['api', DEPLOYMENTS_PATH, statusesPath(1)]],
    ['a non-string endpoint', ['api', 42]],
    ['the endpoint without the api subcommand', [DEPLOYMENTS_PATH]],
    ['another subcommand', ['repo', 'view', JOURNAL_REPOSITORY]],
  ] as const)('refuses %s', (_label, args) => {
    expectRefusedBeforeStart('site_drift', 'gh', args);
  });
});

describe('subprocess template mirror (ADR-AUT-0002 IA-006)', () => {
  const ghApiReadTemplates = (): readonly SubprocessTemplate[] =>
    templates().filter(
      (template) =>
        template.executable === 'gh' &&
        template.effect === 'read' &&
        template.argv_shape[0] === 'api' &&
        !template.argv_shape.includes('<dynamic-argv>'),
    );

  it('declares exactly the gh api read templates the broker literal admits', () => {
    const declared = Object.fromEntries(
      ghApiReadTemplates().map((template) => [template.template_id, template.argv_shape]),
    );
    expect(declared).toEqual(BROKER_GH_API_SHAPES);
    for (const template of ghApiReadTemplates()) {
      expect(template.capabilities).toEqual(['proc:gh-read']);
    }
  });

  it('admits every declared gh api read template once instantiated', () => {
    const declared = ghApiReadTemplates();
    expect(declared.length).toBeGreaterThan(0);
    for (const template of declared) {
      expectAdmitted('site_drift', template.executable, instantiate(template.argv_shape));
    }
  });

  it('admits every gh api shape the broker literal mirrors, so a removed literal fails', () => {
    for (const shape of Object.values(BROKER_GH_API_SHAPES)) {
      expectAdmitted('site_drift', 'gh', instantiate(shape));
    }
  });

  it('declares the build template the broker admits under sense run with its precedence', () => {
    const build = templates().find((template) => template.template_id === 'pnpm-recursive-build');
    expect(build).toMatchObject({
      executable: 'pnpm',
      argv_shape: ['-r', 'build'],
      effect: 'local-write',
      conflict_code: 'BUILD_ARGV_CONFLICT',
    });
    expect(build?.capabilities).toEqual(['proc:pnpm-build', 'fs:workspace']);
    expect(build?.argv_precedence?.map((source) => source.path)).toEqual([
      'test-tasks.json',
      '.devai/config/sensor-inputs.json',
    ]);
    expectAdmitted('build', build?.executable, build?.argv_shape);
  });
});

describe('refused sense run process context (#241)', () => {
  it('names the sensor and the sensor-inputs declaration', () => {
    const { refusal } = decide('coverage', 'unlisted-tool', ['--flag']);
    expect((refusal as Error).message).toBe('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    expect((refusal as Error & { context?: object }).context).toEqual({
      executable: 'unlisted-tool',
      argv: ['--flag'],
      action: 'sense run',
      sensor: 'coverage',
      descriptor_path: '.devai/config/sensor-inputs.json',
    });
  });
});

describe('build shape under sense run (ADR-AUT-0002 IA-001)', () => {
  it.each([
    ['a bare pnpm', 'pnpm'],
    ['an absolute pnpm', '/usr/local/bin/pnpm'],
  ] as const)('admits pnpm -r build through %s', (_label, executable) => {
    expectAdmitted('build', executable, ['-r', 'build']);
  });

  it.each([
    ['--filter', ['-r', '--filter', 'cli', 'build']],
    ['a trailing script argument', ['-r', 'build', '--', '--watch']],
    ['another script', ['-r', 'publish']],
    ['exec', ['exec', 'tsc', '-b']],
    ['run', ['run', 'build']],
  ] as const)('refuses pnpm with %s', (_label, args) => {
    expectRefusedBeforeStart('build', 'pnpm', args);
  });

  it.each([
    ['npm', ['run', 'build']],
    ['sh', ['-c', 'pnpm -r build']],
  ] as const)('refuses %s standing in for the build shape', (executable, args) => {
    expectRefusedBeforeStart('build', executable, args);
  });
});

// End-to-end: the real sensors under the real broker scope. The broker decides each
// process request; an admitted gh or pnpm request is answered from a fixture instead of
// starting a process, and admitted git reads run against a temporary repository.
const temporaryRoots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(path);
  return path;
}

interface ProcessFixture {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function underBroker<T>(
  kind: string,
  role: 'inspector' | 'auditor',
  answer: (executable: string, args: readonly string[]) => ProcessFixture | undefined,
  callback: () => T,
): { readonly value: T; readonly requests: readonly (readonly unknown[])[] } {
  const host = broker(kind, role);
  const requests: (readonly unknown[])[] = [];
  const scope: AuthorityHostEffectScope = {
    ...host.scope,
    apply_effect: (request, apply) => {
      if (request.kind === 'process') requests.push(request.arguments);
      return host.scope.apply_effect(request, () => {
        const [executable, args] = request.arguments;
        const fixture =
          typeof executable === 'string' && Array.isArray(args)
            ? answer(executable, args as readonly string[])
            : undefined;
        return fixture === undefined ? apply() : { ...fixture, signal: null };
      });
    },
  };
  try {
    return { value: runWithAuthorityHostEffects(scope, callback), requests };
  } finally {
    host.dispose();
  }
}

function buildRepository(): string {
  const repo = temporaryRoot('devai-broker-build-');
  writeFileSync(
    join(repo, 'test-tasks.json'),
    `${JSON.stringify({ tasks: [{ nodeId: 'build', argv: ['pnpm', '-r', 'build'], cwd: '.' }] })}\n`,
  );
  return repo;
}

/** A PATH whose pnpm is a symlink that resolves to corepack's dist/pnpm.js, as on #155's host. */
function corepackPath(): string {
  const toolchain = temporaryRoot('devai-corepack-');
  const dist = join(toolchain, 'lib', 'node_modules', 'corepack', 'dist');
  mkdirSync(dist, { recursive: true });
  const shim = join(dist, 'pnpm.js');
  writeFileSync(shim, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(shim, 0o755);
  const bin = join(toolchain, 'bin');
  mkdirSync(bin);
  symlinkSync(shim, join(bin, 'pnpm'));
  return bin;
}

/** A PATH whose pnpm is a plain executable file named pnpm. */
function plainPath(): string {
  const bin = temporaryRoot('devai-plain-pnpm-');
  const pnpm = join(bin, 'pnpm');
  writeFileSync(pnpm, '#!/bin/sh\nexit 0\n');
  chmodSync(pnpm, 0o755);
  return bin;
}

const pnpmAnswer =
  (fixture: ProcessFixture) =>
  (executable: string, args: readonly string[]): ProcessFixture | undefined =>
    executable.includes('pnpm') && args.join(' ') === '-r build' ? fixture : undefined;

describe('sense run build through the broker (ADR-AUT-0002 IA-001, #155)', () => {
  it('reads FAIL with the exit code and stderr head when the admitted build fails', () => {
    const repo = buildRepository();
    process.env.PATH = plainPath();
    const stderr = 'packages/cli/src/broken.ts(1,7): error TS2322: Type mismatch.';

    const { value: reading, requests } = underBroker(
      'build',
      'inspector',
      pnpmAnswer({ status: 2, stdout: '', stderr }),
      () => senseBuild({ cwd: repo }),
    );

    expect(requests).toHaveLength(1);
    expect(reading.status).toBe('fail');
    expect(reading.exit_code).toBe(2);
    expect(reading.err_head).toContain('error TS2322');
    expect(reading.err_head).not.toContain('AUTHORITY_');
  });

  it('admits pnpm -r build when PATH pnpm realpaths to corepack dist/pnpm.js', () => {
    const repo = buildRepository();
    process.env.PATH = corepackPath();

    const { value: reading, requests } = underBroker(
      'build',
      'inspector',
      pnpmAnswer({ status: 0, stdout: 'built', stderr: '' }),
      () => senseBuild({ cwd: repo }),
    );

    expect(requests).toHaveLength(1);
    expect((requests[0]?.[1] as readonly string[]).join(' ')).toBe('-r build');
    expect(reading.err_head ?? '').not.toContain('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
    expect(reading.status).toBe('pass');
    expect(reading.exit_code).toBe(0);
  });

  it('reads FAIL, never a refusal, for a failing build through the corepack shim', () => {
    const repo = buildRepository();
    process.env.PATH = corepackPath();

    const { value: reading } = underBroker(
      'build',
      'inspector',
      pnpmAnswer({ status: 1, stdout: '', stderr: 'error TS1005' }),
      () => senseBuild({ cwd: repo }),
    );

    expect(reading.status).toBe('fail');
    expect(reading.exit_code).toBe(1);
    expect(reading.err_head).toContain('error TS1005');
  });
});

describe('sense run site_drift through the broker (ADR-AUT-0002 IA-002, IA-004)', () => {
  function sourceRepository(): { readonly repo: string; readonly head: string } {
    const repo = temporaryRoot('devai-broker-site-drift-');
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '--quiet');
    git(
      '-c',
      'user.name=DEVAI Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'base',
    );
    return { repo, head: git('rev-parse', 'HEAD') };
  }

  it('reads the journal through the admitted shapes and passes on a verified identity', () => {
    const { repo, head } = sourceRepository();
    const deployments = [
      {
        id: 9,
        sha: head,
        environment: 'devai-pages-publication',
        task: 'devai:pages-publication',
        payload: {
          kind: 'devai-pages-publication-intent',
          schemaVersion: '1.0.0',
          identity: { repository: JOURNAL_REPOSITORY, commit: head, tag: 'v1.8.0' },
        },
      },
    ];
    const statuses = [
      {
        id: 3,
        state: 'success',
        environment: 'devai-pages-publication',
        description: 'devai-pages:verified:pages-1',
      },
    ];
    const answer = (executable: string, args: readonly string[]): ProcessFixture | undefined => {
      if (executable !== 'gh') return undefined;
      if (args[1] === DEPLOYMENTS_PATH)
        return { status: 0, stdout: JSON.stringify(deployments), stderr: '' };
      if (args[1] === statusesPath(9))
        return { status: 0, stdout: JSON.stringify(statuses), stderr: '' };
      throw new Error(`unexpected gh argv ${args.join(' ')}`);
    };

    const { value: reading, requests } = underBroker('site_drift', 'auditor', answer, () =>
      senseSiteDrift({ repoRoot: repo }),
    );

    const ghRequests = requests.filter((request) => request[0] === 'gh');
    expect(ghRequests.map((request) => request[1])).toEqual([
      ['api', DEPLOYMENTS_PATH],
      ['api', statusesPath(9)],
    ]);
    expect(JSON.stringify(reading.findings)).not.toContain(
      'SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED',
    );
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      published_source_provenance: 'journal',
      published_source: head,
    });
  });

  it('reads REVIEW journal-not-verified, not adapter-required, for an empty journal', () => {
    const { repo } = sourceRepository();
    const answer = (executable: string, args: readonly string[]): ProcessFixture | undefined =>
      executable === 'gh' && args[1] === DEPLOYMENTS_PATH
        ? { status: 0, stdout: '[]', stderr: '' }
        : undefined;

    const { value: reading } = underBroker('site_drift', 'auditor', answer, () =>
      senseSiteDrift({ repoRoot: repo }),
    );

    expect(JSON.stringify(reading.findings)).not.toContain(
      'SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED',
    );
    expect(reading.status).toBe('review');
    expect(JSON.stringify(reading.findings)).toContain('journal-not-verified');
  });
});
