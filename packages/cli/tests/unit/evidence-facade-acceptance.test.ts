// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-016, INV-DEVAI-018
// Inspector acceptance: canonical evidence facades preserve append-only local
// records, contained rendering, verification, and structured refusals.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { initChain } from '../../../evidence/src/evidence/chain.js';
import {
  ACTIONS_FRESHNESS_JOBS,
  ACTIONS_REUSABLE_JOBS,
} from '../../../evidence/src/local-evidence/actions-run.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  evidenceCollect,
  evidenceRecord,
  evidenceRedact,
  evidenceRender,
  evidenceVerify,
} from '../../src/commands/evidence/facade.js';
import { _resetScenarioValidator, mutationRun } from '../../src/commands/mutation/run.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROOT = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];

interface Definition {
  register(cli: CAC): void;
}

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-evidence-facade-'));
  roots.push(path);
  return path;
}

function put(repo: string, path: string, contents: string): string {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function coverageCounts(total: number, covered: number) {
  return {
    lines: { total, covered },
    branches: { total: total * 2, covered: covered * 2 },
    functions: { total: total + 1, covered: covered + 1 },
    statements: { total: total * 3, covered: covered * 3 },
  };
}

function finalCoverage(path: string, covered: number): string {
  return JSON.stringify({
    [path]: {
      path,
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {},
      branchMap: {},
      s: { '0': covered },
      f: {},
      b: {},
    },
  });
}

function mutationFixture(repo: string, status: 'Killed' | 'Survived'): void {
  put(
    repo,
    'law/schemas/mutation-scenario.schema.json',
    readFileSync(join(ROOT, 'law/schemas/mutation-scenario.schema.json'), 'utf8'),
  );
  put(
    repo,
    'scenarios/current.json',
    JSON.stringify({
      schema_version: '1.0.0',
      id: 'current-contract',
      kind: 'mutation',
      target: { file: 'src/current.ts', symbol: 'currentContract' },
      mutations: [{ type: 'string-replace', find: 'true', replace: 'false' }],
      expectations: [{ assertion: 'tests-detect', specs: ['tests/current.test.ts'] }],
    }),
  );
  put(
    repo,
    'reports/current.json',
    JSON.stringify([{ id: 'current-contract', status, duration_ms: 12 }]),
  );
  _resetScenarioValidator();
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repo, encoding: 'utf8' }).trim();
}

function initializeRepository(repo: string): void {
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Evidence Facade Fixture']);
  git(repo, ['config', 'user.email', 'evidence-facade@example.invalid']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/adopter.git']);
}

function localCollectionFixture(): string {
  const repo = root();
  initializeRepository(repo);
  put(
    repo,
    '.devai/config/project.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      project_type: 'runtime-host',
      authority_enforcement: { mode: 'cli-only' },
      profile: 'tier3',
      ci_economy: {
        local_evidence: {
          max_age_hours: 24,
          required_jobs: ['unit'],
          allowed_platforms: ['darwin/arm64'],
        },
      },
    }),
  );
  put(repo, 'package.json', JSON.stringify({ name: 'fixture', engines: { node: '>=24' } }));
  put(
    repo,
    '.artifacts/unit/metadata.txt',
    `job=unit\nplatform=darwin/arm64\nnode=${process.version}\n`,
  );
  put(repo, '.artifacts/unit/result.txt', 'success\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'local collection fixture']);
  return repo;
}

function actionsCollectionFixture(): { readonly repo: string; readonly mergeSha: string } {
  const repo = root();
  initializeRepository(repo);
  put(repo, 'base.txt', 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const mergeBaseSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-qb', 'feature']);
  put(repo, 'feature.txt', 'feature\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'feature']);
  const headSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', 'main']);
  put(repo, 'main.txt', 'main\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'main']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge']);
  const mergeSha = git(repo, ['rev-parse', 'HEAD']);
  const tree = { algorithm: 'sha1' as const, value: git(repo, ['rev-parse', 'HEAD^{tree}']) };
  const sourceHash = { algorithm: 'sha256' as const, value: 'b'.repeat(64), fileCount: 3 };
  const digests = {
    workflowPolicySha256: '1'.repeat(64),
    lockfileSha256: '2'.repeat(64),
    toolchainContractSha256: '3'.repeat(64),
    testContractSha256: '4'.repeat(64),
    serviceContractSha256: '5'.repeat(64),
  };
  const identity = {
    repository: 'example/adopter',
    workflowRef: 'example/adopter/.github/workflows/ci.yml@refs/pull/1/merge',
    eventName: 'pull_request' as const,
    runId: '123',
    runAttempt: 2,
    actor: 'inspector',
    headSha,
    baseSha,
    mergeBaseSha,
    testedCommitSha: mergeSha,
    testedTree: tree,
    digests,
  };
  const generatedAt = new Date(Date.now());
  const manifest = {
    schemaVersion: 1,
    origin: 'actions-run',
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    subject: { repository: identity.repository, commitSha: mergeSha, tree },
    sourceHash,
    policy: {
      maxAgeHours: 24,
      requiredJobs: [...ACTIONS_REUSABLE_JOBS],
      allowedPlatforms: ['linux/amd64'],
    },
    tools: {},
    platforms: ['linux/amd64'],
    jobs: Object.fromEntries(
      ACTIONS_REUSABLE_JOBS.map((job) => [
        job,
        {
          result: 'success',
          metadata: { job, platform: 'linux/amd64' },
          artifactChecksum: { algorithm: 'sha256', value: '6'.repeat(64), fileCount: 1 },
        },
      ]),
    ),
    actionsRun: identity,
  };
  const fullResult = {
    schemaVersion: 1,
    kind: 'actions-run-full-result',
    result: 'success',
    fullCiAuthoritative: true,
    repository: identity.repository,
    workflowRef: identity.workflowRef,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    testedCommitSha: mergeSha,
    testedTree: tree,
    jobs: Object.fromEntries(ACTIONS_REUSABLE_JOBS.map((job) => [job, 'success'])),
  };
  const decision = {
    schemaVersion: 1,
    kind: 'actions-evidence-shadow-decision',
    mainRunId: '456',
    mainRunAttempt: 1,
    mergedCommitSha: mergeSha,
    fullCiResult: 'success',
    executeFullCi: true,
    disposition: 'promotion-hit',
    shadowFullEquivalent: true,
    reason: 'exact tested tree',
    reusableJobs: [...ACTIONS_REUSABLE_JOBS],
    freshnessJobs: [...ACTIONS_FRESHNESS_JOBS],
  };
  put(repo, 'tuple/manifest.json', JSON.stringify(manifest));
  put(repo, 'tuple/full-result.json', JSON.stringify(fullResult));
  put(repo, 'tuple/decision.json', JSON.stringify(decision));
  return { repo, mergeSha };
}

async function captureInvocation(run: () => Promise<void>): Promise<InvocationResult> {
  const originalArgv = process.argv;
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
    process.exit = ((exitCode?: string | number | null) => {
      process.exitCode = typeof exitCode === 'number' ? exitCode : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    try {
      await run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function invoke(
  definition: Definition,
  argv: readonly string[],
  options: { readonly writeConsent?: boolean } = {},
): Promise<InvocationResult> {
  const cli = cac('devai-evidence-facade-acceptance');
  definition.register(cli);
  return captureInvocation(async () => {
    process.argv = ['node', 'devai', ...argv];
    cli.parse(process.argv, { run: false });
    if (options.writeConsent === true) process.argv.push('--write');
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
  });
}

async function invokeRegisteredAction(
  definition: Definition,
  options: Readonly<Record<string, unknown>>,
): Promise<InvocationResult> {
  const cli = cac('devai-evidence-facade-acceptance');
  definition.register(cli);
  const command = cli.commands[0];
  if (command?.commandAction === undefined) throw new Error('registered command action missing');
  return captureInvocation(async () => {
    await withAuthorityHostTestScope(() => command.commandAction?.(options));
  });
}

afterEach(() => {
  _resetScenarioValidator();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('evidence collect acceptance', () => {
  it.each([
    [
      ['evidence-collect', '--source', 'remote'],
      'devai evidence collect: --source must be actions or local\n',
    ],
    [
      ['evidence-collect', '--source', 'local'],
      'devai evidence collect (error): at least one --job <name:dir> is required for --source local\n',
    ],
    [
      ['evidence-collect', '--source', 'local', '--job', 'bad'],
      'devai evidence collect (error): invalid --job "bad": expected name:dir\n',
    ],
    [
      ['evidence-collect', '--source', 'local', '--job', ':artifacts'],
      'devai evidence collect (error): invalid --job ":artifacts": expected name:dir\n',
    ],
    [
      ['evidence-collect', '--source', 'local', '--job', 'unit:'],
      'devai evidence collect (error): invalid --job "unit:": expected name:dir\n',
    ],
  ] as const)('preserves the exact public refusal for %j', async (argv, stderr) => {
    const repo = root();
    const result = await invoke(evidenceCollect, [...argv, '--repo-root', repo]);
    expect(result).toEqual({ exit: 2, stdout: '', stderr });
  });

  it('forwards a local job and output path and preserves the human rendering switch', async () => {
    const repo = localCollectionFixture();
    const result = await invoke(evidenceCollect, [
      'evidence-collect',
      '--source',
      'local',
      '--job',
      'unit:.artifacts/unit',
      '--output',
      'custom/local.json',
      '--repo-root',
      repo,
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      source: 'local',
      output: 'custom/local.json',
      sourceHash: expect.objectContaining({ algorithm: 'sha256' }),
      jobs: ['unit'],
    });
    expect(existsSync(join(repo, 'custom/local.json'))).toBe(true);
    expect(existsSync(join(repo, 'record/proofs/work/local-evidence/local-ci.json'))).toBe(false);

    const humanRepo = localCollectionFixture();
    const human = await invoke(evidenceCollect, [
      'evidence-collect',
      '--source',
      'local',
      '--job',
      'unit:.artifacts/unit',
      '--repo-root',
      humanRepo,
      '--human',
    ]);
    expect(human).toEqual({
      exit: 0,
      stdout: 'evidence collect: local collected\n',
      stderr: '',
    });
  });

  it('collects an exact Actions tuple with its artifacts and governed proof payload', async () => {
    const { repo, mergeSha } = actionsCollectionFixture();
    const result = await invoke(evidenceCollect, [
      'evidence-collect',
      '--source',
      'actions',
      '--round',
      'R-0114',
      '--tuple',
      'tuple',
      '--repo-root',
      repo,
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: '' });
    const collected = JSON.parse(result.stdout) as Record<string, unknown>;
    const artifacts = [
      {
        path: 'tuple/manifest.json',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      {
        path: 'tuple/full-result.json',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      {
        path: 'tuple/decision.json',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ];
    expect(collected).toMatchObject({
      source: 'actions',
      observation: {
        mergeSha,
        disposition: 'promotion-hit',
        shadowFullEquivalent: true,
        durable: true,
      },
      artifacts,
      proof: {
        line_type: 'record',
        round_id: 'R-0114',
        kind: 'actions',
        payload: {
          source: 'actions',
          observation: { mergeSha, disposition: 'promotion-hit' },
          artifacts,
        },
      },
    });
  });

  it('refuses missing source bindings and malformed local jobs before collection', async () => {
    const repo = root();
    const cases = [
      ['evidence-collect', '--repo-root', repo],
      ['evidence-collect', '--source', 'remote', '--repo-root', repo],
      ['evidence-collect', '--source', 'actions', '--repo-root', repo],
      ['evidence-collect', '--source', 'actions', '--tuple', 'tuple', '--repo-root', repo],
      ['evidence-collect', '--source', 'local', '--repo-root', repo],
      ['evidence-collect', '--source', 'local', '--job', 'bad', '--repo-root', repo],
      ['evidence-collect', '--source', 'local', '--job', 'bad:', '--repo-root', repo],
      ['evidence-collect', '--source', 'local', '--job', 'unit:absent', '--repo-root', repo],
    ] as const;
    for (const argv of cases) {
      const result = await invoke(evidenceCollect, argv);
      expect(result.exit, `${argv.join(' ')}: ${result.stderr}`).toBe(2);
      expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
    }
  });

  it('rejects uncontained and incomplete Actions tuples without external access', async () => {
    const repo = root();
    put(repo, 'tuple/manifest.json', '{}');
    put(repo, 'tuple/full-result.json', '{}');
    put(repo, 'tuple/decision.json', '{}');
    const incomplete = await invoke(evidenceCollect, [
      'evidence-collect',
      '--source',
      'actions',
      '--round',
      'R-0007',
      '--tuple',
      'tuple',
      '--repo-root',
      repo,
    ]);
    expect(incomplete.exit).toBe(2);
    expect(incomplete.stderr).toContain('merge SHA is missing');
    const outside = await invoke(evidenceCollect, [
      'evidence-collect',
      '--source',
      'actions',
      '--round',
      'R-0007',
      '--tuple',
      '..',
      '--repo-root',
      repo,
    ]);
    expect(outside.exit).toBe(2);
    expect(outside.stderr).toContain('contained');
  });
});

describe('evidence record and errata acceptance', () => {
  it('reports mutation usage through the public evidence action', async () => {
    const result = await invoke(mutationRun, ['mutation-run']);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain('devai evidence record --kind mutation');
  });

  it('appends generic payload and input records with both receipt formats', async () => {
    const repo = root();
    put(repo, 'payload.json', '{"source":"input","secret":"second"}\n');
    const first = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'generic',
      '--round',
      'R-0007',
      '--repo-root',
      repo,
      '--payload',
      '{"source":"inline","secret":"first"}',
    ]);
    expect(first).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(first.stdout)).toMatchObject({ kind: 'generic', round_id: 'R-0007' });
    const second = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'generic',
      '--round',
      'R-0007',
      '--repo-root',
      repo,
      '--input',
      'payload.json',
      '--human',
    ]);
    expect(second).toMatchObject({ exit: 0, stderr: '' });
    expect(second.stdout).toContain('generic sequence 2');
    const lines = readFileSync(join(repo, 'record/proofs/work/generic/R-0007.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
  });

  it('refuses incomplete record modes and preserves service outcomes as proofs', async () => {
    const repo = root();
    const cases = [
      ['evidence-record', '--repo-root', repo],
      ['evidence-record', '--kind', 'unknown', '--repo-root', repo],
      ['evidence-record', '--kind', 'generic', '--repo-root', repo],
      ['evidence-record', '--kind', 'generic', '--round', 'R-0007', '--repo-root', repo],
      [
        'evidence-record',
        '--kind',
        'generic',
        '--round',
        'R-0007',
        '--repo-root',
        repo,
        '--payload',
        '{}',
        '--input',
        'payload.json',
      ],
      [
        'evidence-record',
        '--kind',
        'generic',
        '--round',
        'R-0007',
        '--repo-root',
        repo,
        '--payload',
        '[]',
      ],
      [
        'evidence-record',
        '--kind',
        'test',
        '--round',
        'R-0007',
        '--repo-root',
        repo,
        '--tier',
        'unknown',
      ],
      [
        'evidence-record',
        '--kind',
        'test',
        '--round',
        'R-0007',
        '--repo-root',
        repo,
        '--tier',
        'unit',
      ],
      ['evidence-record', '--kind', 'mutation', '--round', 'R-0007', '--repo-root', repo],
      ['evidence-record', '--kind', 'mutation', '--round', 'R-0007', '--repo-root', repo, '--run'],
    ] as const;
    for (const argv of cases) {
      const result = await invoke(evidenceRecord, argv);
      expect(result.exit, `${argv.join(' ')}: ${result.stderr}`).toBe(2);
    }

    const coverage = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'coverage',
      '--round',
      'R-0007',
      '--repo-root',
      repo,
      '--in',
      'missing-coverage',
    ]);
    expect(coverage.exit).toBe(0);
    expect(coverage.stderr).toBe('');
    expect(JSON.parse(coverage.stdout)).toMatchObject({ kind: 'coverage', round_id: 'R-0007' });
    expect(readFileSync(join(repo, 'record/proofs/work/coverage/R-0007.jsonl'), 'utf8')).toContain(
      'service_exit_code',
    );
  });

  it('records a validated mutation result and its governed proof', async () => {
    const repo = root();
    mutationFixture(repo, 'Killed');

    const result = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-1000',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/current.json',
      '--external',
      'reports/current.json',
      '--out',
      '.devai/state/mutation/current.json',
    ]);

    expect(result).toMatchObject({ exit: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: 'mutation',
      round_id: 'R-1000',
      result: {
        ok: true,
        scenarios_loaded: 1,
        killed: 1,
        survived: 0,
        mutation_score: 100,
      },
    });
    expect(
      JSON.parse(readFileSync(join(repo, '.devai/state/mutation/current.json'), 'utf8')),
    ).toMatchObject({
      mutation_score: 100,
      killed: 1,
      survived: 0,
      scenarios: [{ id: 'current-contract', status: 'Killed', ok: true }],
    });
    expect(
      JSON.parse(
        readFileSync(join(repo, 'record/proofs/work/mutation/R-1000.jsonl'), 'utf8').trim(),
      ),
    ).toMatchObject({
      line_type: 'record',
      kind: 'mutation',
      sequence: 1,
      payload: { service_exit_code: 0, result: { mutation_score: 100 } },
    });
  });

  it('forwards every declared coverage option into the aggregate service', async () => {
    const repo = root();
    put(
      repo,
      'cov-in/pkg-a/coverage/coverage-summary.json',
      JSON.stringify({ total: coverageCounts(10, 8) }),
    );
    put(repo, 'cov-final-in/pkg-a/coverage/coverage-final.json', finalCoverage('/src/a.ts', 1));

    const perPackage = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'coverage',
      '--round',
      'R-0100',
      '--repo-root',
      repo,
      '--in',
      'cov-in',
      '--out',
      'cov-out/summary.json',
      '--per-package',
    ]);
    const perPackageResult = (JSON.parse(perPackage.stdout) as { result: Record<string, unknown> })
      .result;
    expect(perPackage).toMatchObject({ exit: 0, stderr: '' });
    expect(perPackageResult).toMatchObject({
      schemaVersion: '1.0.0',
      inputs: ['cov-in/pkg-a/coverage/coverage-summary.json'],
      scopes: { 'cov-in/pkg-a': { lines: 80 } },
    });
    expect(existsSync(join(repo, 'cov-out/summary.json'))).toBe(true);
    expect(existsSync(join(repo, '.devai/state/coverage/summary.json'))).toBe(false);

    const aggregate = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'coverage',
      '--round',
      'R-0101',
      '--repo-root',
      repo,
      '--in',
      'cov-in',
      '--out',
      'cov-out/aggregate.json',
    ]);
    expect(
      (JSON.parse(aggregate.stdout) as { result: Record<string, unknown> }).result,
    ).not.toHaveProperty('scopes');

    const final = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'coverage',
      '--round',
      'R-0102',
      '--repo-root',
      repo,
      '--in',
      'cov-final-in',
      '--out',
      'cov-out/final.json',
      '--final',
    ]);
    expect(final).toMatchObject({ exit: 0, stderr: '' });
    expect((JSON.parse(final.stdout) as { result: Record<string, unknown> }).result).toMatchObject({
      schemaVersion: '1.0.0',
      mode: 'final',
      inputs: ['cov-final-in/pkg-a/coverage/coverage-final.json'],
      out: 'cov-out/final.json',
      files: 1,
    });
    expect(Object.keys(JSON.parse(readFileSync(join(repo, 'cov-out/final.json'), 'utf8')))).toEqual(
      ['/src/a.ts'],
    );
  });

  it('forwards mutation adapter, report path, and survivor policy into the recorder', async () => {
    const repo = root();
    mutationFixture(repo, 'Killed');
    const recorded = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-0110',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/current.json',
      '--external',
      'reports/current.json',
      '--out',
      '.devai/state/mutation/alt.json',
      '--report-path',
      'reports/rich.json',
    ]);
    expect(recorded).toMatchObject({ exit: 0, stderr: '' });
    expect(
      JSON.parse(readFileSync(join(repo, '.devai/state/mutation/alt.json'), 'utf8')),
    ).toMatchObject({ report_path: 'reports/rich.json' });

    const exclusive = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-0111',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/current.json',
      '--mutator',
      './adapter.js',
      '--external',
      'reports/current.json',
    ]);
    expect(exclusive.exit).toBe(2);
    expect(exclusive.stderr).toContain('--mutator and --external are mutually exclusive');

    mutationFixture(repo, 'Survived');
    const allowed = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-0112',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/current.json',
      '--external',
      'reports/current.json',
      '--out',
      '.devai/state/mutation/survived-allowed.json',
    ]);
    expect(allowed).toMatchObject({ exit: 0, stderr: '' });
    const refused = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-0113',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/current.json',
      '--external',
      'reports/current.json',
      '--out',
      '.devai/state/mutation/survived-refused.json',
      '--fail-on-survivors',
    ]);
    expect(refused.exit).toBe(2);
  });

  it('executes the rtd bundle kind and forwards output, strict, and git bindings', async () => {
    const repo = root();
    put(repo, 'README.md', 'fixture\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Inspector Fixture'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'inspector@example.invalid'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'rtd'));
    const output = join(repo, 'rtd/copy.json');

    const bundled = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'rtd',
      '--round',
      'R-0200',
      '--repo-root',
      repo,
      '--output',
      output,
    ]);
    expect(bundled).toMatchObject({ exit: 0, stderr: '' });
    expect(
      (JSON.parse(bundled.stdout) as { result: Record<string, unknown> }).result,
    ).toMatchObject({
      schemaVersion: '1.0.0',
      integration_head: head,
    });
    expect(existsSync(output)).toBe(true);
    expect(
      readdirSync(join(repo, 'record/proofs/compliance/rtd-manifests')).length,
    ).toBeGreaterThan(0);

    const strict = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'rtd',
      '--round',
      'R-0201',
      '--repo-root',
      repo,
      '--strict',
    ]);
    expect(strict).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence record: rtd exited 2; governed proof sequence 1\n',
    });
  });

  it("binds a failing service's diagnostics into the proof and forwards its exit code", async () => {
    const repo = root();
    put(repo, 'scenarios/x.json', '{}');
    _resetScenarioValidator();
    const schemaPath = join(repo, 'law/schemas/mutation-scenario.schema.json');
    const serviceError = `devai evidence record --kind mutation: mutation-scenario schema not found at ${schemaPath} (also tried ${schemaPath})`;
    const result = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-0300',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/x.json',
    ]);
    expect(result).toEqual({
      exit: 65,
      stdout: '',
      stderr: `devai evidence record: mutation exited 65; governed proof sequence 1: ${serviceError}\n`,
    });
    const proof = JSON.parse(
      readFileSync(join(repo, 'record/proofs/work/mutation/R-0300.jsonl'), 'utf8').trim(),
    ) as { payload: Record<string, unknown> };
    expect(proof.payload).toEqual({
      result: { kind: 'mutation', service_exit_code: 65, error: serviceError },
      service_exit_code: 65,
      service_error: serviceError,
    });
  });

  it('appends forward-only field and pattern redactions and rejects invalid targets', async () => {
    const repo = root();
    for (const payload of ['{"secret":"first"}', '{"secret":"second"}']) {
      expect(
        (
          await invoke(evidenceRecord, [
            'evidence-record',
            '--kind',
            'generic',
            '--round',
            'R-0007',
            '--repo-root',
            repo,
            '--payload',
            payload,
          ])
        ).exit,
      ).toBe(0);
    }
    const usageCases = [
      ['evidence-redact', '1', '--repo-root', repo],
      [
        'evidence-redact',
        '0',
        '--round',
        'R-0007',
        '--kind',
        'generic',
        '--reason',
        'fixture',
        '--field',
        'secret',
        '--repo-root',
        repo,
      ],
      [
        'evidence-redact',
        '1',
        '--round',
        'R-0007',
        '--kind',
        'generic',
        '--field',
        'secret',
        '--repo-root',
        repo,
      ],
      [
        'evidence-redact',
        '1',
        '--round',
        'R-0007',
        '--kind',
        'generic',
        '--reason',
        'fixture',
        '--repo-root',
        repo,
      ],
    ] as const;
    for (const argv of usageCases) expect((await invoke(evidenceRedact, argv)).exit).toBe(2);

    const field = await invoke(evidenceRedact, [
      'evidence-redact',
      '1',
      '--round',
      'R-0007',
      '--kind',
      'generic',
      '--reason',
      'remove field',
      '--field',
      'secret',
      '--repo-root',
      repo,
    ]);
    expect(field).toMatchObject({ exit: 0, stderr: '' });
    const pattern = await invoke(evidenceRedact, [
      'evidence-redact',
      '2',
      '--round',
      'R-0007',
      '--kind',
      'generic',
      '--reason',
      'remove pattern',
      '--pattern',
      'second',
      '--repo-root',
      repo,
      '--human',
    ]);
    expect(pattern.exit).toBe(0);
    expect(pattern.stdout).toContain('corrected by 4');
    const invalidPattern = await invoke(evidenceRedact, [
      'evidence-redact',
      '1',
      '--round',
      'R-0007',
      '--kind',
      'generic',
      '--reason',
      'invalid regex',
      '--pattern',
      '[',
      '--repo-root',
      repo,
    ]);
    expect(invalidPattern.exit).toBe(2);
    const forward = await invoke(evidenceRedact, [
      'evidence-redact',
      '3',
      '--round',
      'R-0007',
      '--kind',
      'generic',
      '--reason',
      'invalid target',
      '--field',
      'secret',
      '--repo-root',
      repo,
    ]);
    expect(forward.exit).toBe(2);
    expect(forward.stderr).toContain('not a proof record');
  });
});

describe('evidence render and verify acceptance', () => {
  it('renders canonical decision and round views and contains explicit writes', async () => {
    const repo = root();
    expect((await invoke(evidenceRender, ['evidence-render', '--repo-root', repo])).exit).toBe(2);
    expect(
      (
        await invoke(evidenceRender, [
          'evidence-render',
          '--kind',
          'decisions',
          '--out',
          'record/derived/indexes/decisions.md',
          '--repo-root',
          repo,
        ])
      ).exit,
    ).toBe(2);
    const decisions = await invoke(evidenceRender, [
      'evidence-render',
      '--kind',
      'decisions',
      '--repo-root',
      ROOT,
    ]);
    expect(decisions).toMatchObject({ exit: 0, stderr: '' });
    expect(decisions.stdout).toContain('# Design Decisions');
    const rounds = await invoke(evidenceRender, [
      'evidence-render',
      '--kind',
      'rounds',
      '--repo-root',
      repo,
    ]);
    expect(rounds.stdout).toBe('# Governed Rounds\n');
    const written = await invoke(
      evidenceRender,
      [
        'evidence-render',
        '--kind',
        'decisions',
        '--out',
        'record/derived/indexes/decisions.md',
        '--repo-root',
        repo,
        '--human',
      ],
      { writeConsent: true },
    );
    expect(written).toMatchObject({ exit: 0, stderr: '' });
    expect(written.stdout).toContain('evidence render: wrote decisions');
    expect(readFileSync(join(repo, 'record/derived/indexes/decisions.md'), 'utf8')).toContain(
      '# Design Decisions',
    );
    const matrix = await invoke(evidenceRender, [
      'evidence-render',
      '--kind',
      'test-matrix',
      '--repo-root',
      repo,
      '--in',
      'missing',
      '--strict',
    ]);
    expect(matrix).toMatchObject({ exit: 0, stderr: '' });
    expect(matrix.stdout).not.toBe('');
  });

  it('verifies empty and tampered chains and refuses invalid local verification modes', async () => {
    const repo = root();
    const chain = join(repo, 'record/proofs/chain.json');
    await withAuthorityHostTestScope(() => initChain(chain));
    expect((await invoke(evidenceVerify, ['evidence-verify', '--repo-root', repo])).exit).toBe(2);
    expect(
      (
        await invoke(evidenceVerify, [
          'evidence-verify',
          '--scope',
          'local',
          '--show-head',
          '--repo-root',
          repo,
        ])
      ).exit,
    ).toBe(2);
    const verified = await invoke(evidenceVerify, [
      'evidence-verify',
      '--scope',
      'chain',
      '--show-head',
      '--repo-root',
      repo,
      '--human',
    ]);
    expect(verified).toMatchObject({ exit: 0, stderr: '' });
    expect(verified.stdout).toContain('evidence chain: valid; head');
    writeFileSync(chain, '{"head":"tampered","records":[]}\n');
    const tampered = await invoke(evidenceVerify, [
      'evidence-verify',
      '--scope',
      'chain',
      '--repo-root',
      repo,
    ]);
    expect(tampered.exit).toBe(2);
    expect(tampered.stderr).toContain('invalid chain');
    const mode = await invoke(evidenceVerify, [
      'evidence-verify',
      '--scope',
      'local',
      '--mode',
      'unknown',
      '--repo-root',
      repo,
    ]);
    expect(mode.exit).toBe(2);
    const local = await invoke(evidenceVerify, [
      'evidence-verify',
      '--scope',
      'local',
      '--mode',
      'gate',
      '--event-name',
      'workflow_dispatch',
      '--repo-root',
      repo,
      '--human',
    ]);
    expect(local).toMatchObject({ exit: 0, stderr: '' });
    expect(local.stdout).not.toBe('');
  });
});

describe('evidence record public decision table', () => {
  it('returns exact diagnostics for every rejected input shape before service execution', async () => {
    const repo = root();
    put(repo, 'array.json', '[]\n');
    const cases = [
      {
        argv: ['--kind', 'generic', '--payload', '{}', '--input', 'array.json'],
        diagnostic: '--payload and --input are mutually exclusive',
      },
      {
        argv: ['--kind', 'generic'],
        diagnostic: '--payload <json> or --input <path> is required for --kind generic',
      },
      {
        argv: ['--kind', 'generic', '--payload', 'null'],
        diagnostic: '--payload: expected a JSON object',
      },
      {
        argv: ['--kind', 'generic', '--payload', '7'],
        diagnostic: '--payload: expected a JSON object',
      },
      {
        argv: ['--kind', 'generic', '--input', 'array.json'],
        diagnostic: '--input: expected a JSON object',
      },
      {
        argv: ['--kind', 'test', '--tier', 'unknown'],
        diagnostic:
          '--tier must be one of: unit, api, db, e2e, mutation, perf, lint, typecheck, coverage',
      },
      {
        argv: ['--kind', 'test', '--tier', 'unit'],
        diagnostic: '--cmd is required for --kind test',
      },
      {
        argv: ['--kind', 'mutation'],
        diagnostic: '--run is required for --kind mutation',
      },
      {
        argv: ['--kind', 'mutation', '--run'],
        diagnostic: '--scenarios is required for --kind mutation --run',
      },
    ] as const;

    for (const { argv, diagnostic } of cases) {
      const result = await invoke(evidenceRecord, [
        'evidence-record',
        ...argv,
        '--round',
        'R-1700',
        '--repo-root',
        repo,
      ]);
      expect(result, argv.join(' ')).toEqual({
        exit: 2,
        stdout: '',
        stderr: `devai evidence record: ${diagnostic}\n`,
      });
    }
  });

  it('preserves exact inline and file objects in public generic receipts', async () => {
    const repo = root();
    put(repo, 'payload.json', '{"source":"file","nested":{"enabled":false}}\n');
    const cases = [
      {
        argv: ['--payload', '{"source":"inline","nested":{"enabled":true}}'],
        expected: { source: 'inline', nested: { enabled: true } },
      },
      {
        argv: ['--input', 'payload.json'],
        expected: { source: 'file', nested: { enabled: false } },
      },
    ] as const;

    for (const { argv, expected } of cases) {
      const result = await invoke(evidenceRecord, [
        'evidence-record',
        '--kind',
        'generic',
        '--round',
        'R-1701',
        '--repo-root',
        repo,
        ...argv,
      ]);
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: 'generic',
        round_id: 'R-1701',
        result: expected,
        proof: { kind: 'generic', payload: expected },
      });
    }
  });

  it('rejects an explicit empty test command at the registered public action boundary', async () => {
    const repo = root();
    const result = await invokeRegisteredAction(evidenceRecord, {
      kind: 'test',
      round: 'R-1702',
      repoRoot: repo,
      tier: 'unit',
      cmd: '',
    });
    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence record: --cmd is required for --kind test\n',
    });
  });

  it('preserves a failing service diagnostic in the exact public failure receipt', async () => {
    const repo = root();
    put(repo, 'scenarios/failure.json', '{}');
    _resetScenarioValidator();
    const schemaPath = join(repo, 'law/schemas/mutation-scenario.schema.json');
    const serviceError = `devai evidence record --kind mutation: mutation-scenario schema not found at ${schemaPath} (also tried ${schemaPath})`;
    const result = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'mutation',
      '--round',
      'R-1703',
      '--repo-root',
      repo,
      '--run',
      '--scenarios',
      'scenarios/failure.json',
    ]);
    expect(result).toEqual({
      exit: 65,
      stdout: '',
      stderr: `devai evidence record: mutation exited 65; governed proof sequence 1: ${serviceError}\n`,
    });
  });

  it('omits a fabricated suffix when a failed service emits no diagnostic', async () => {
    const repo = root();
    const result = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'rtd',
      '--round',
      'R-1704',
      '--repo-root',
      repo,
      '--strict',
      '--no-git',
    ]);
    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence record: rtd exited 2; governed proof sequence 1\n',
    });
  });

  it('reports successful service recording through the exact human receipt', async () => {
    const repo = root();
    const result = await invoke(evidenceRecord, [
      'evidence-record',
      '--kind',
      'coverage',
      '--round',
      'R-1702',
      '--repo-root',
      repo,
      '--in',
      'missing-coverage',
      '--human',
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout: 'evidence record: coverage sequence 1\n',
      stderr: '',
    });
  });
});
