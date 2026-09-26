// ADR-CHK-0001, Inspector Adversarial Acceptance IA-004: a probe that redacts
// its observed value cannot leak the raw value through the failure diagnostics
// path. The raw observation here carries a GitHub-token-shaped value and a
// TOKEN=value assignment; neither may reach the report execution entries, the
// diagnostic files under the cache root, or the output of
// scripts/pr-failure-diagnostics.mjs that the pull-request lane prints.
//
// The secret-shaped marker is assembled at runtime so no tracked file carries a
// token literal (scripts/check-release-static-integrity.mjs scans for one).
//
// Red today: the runner refuses a `preflight-v1` node (no argv) with
// CHECK_RUNNER_DESCRIPTOR: malformed task preflight, and prFailureDiagnostics
// copies stdoutTail, stderrTail, and reason verbatim with no redaction.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheckTasks, type TaskExecutionResult } from '../../src/services/check-runner/index.js';

type PrFailureDiagnostics = (
  root: string,
  execution?: readonly unknown[],
) => readonly Readonly<Record<string, unknown>>[];

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const GITHUB_TOKEN_MARKER = ['ghp', 'abcdefghijklmnopqrst'].join('_');
const PLAIN_MARKER = 'SECRET-MARKER-7f3a';
const OBSERVED = `PROBE_TOKEN=${PLAIN_MARKER}\n${GITHUB_TOKEN_MARKER}\n`;
const MARKERS = [GITHUB_TOKEN_MARKER, PLAIN_MARKER] as const;
const PREFLIGHT = 'preflight';
const DIAGNOSTICS = '.devai/state/check-cache/v1/diagnostics';

async function loadPrFailureDiagnostics(): Promise<PrFailureDiagnostics> {
  const module = (await import(
    pathToFileURL(join(REPOSITORY_ROOT, 'scripts/pr-failure-diagnostics.mjs')).href
  )) as { prFailureDiagnostics: PrFailureDiagnostics };
  return module.prFailureDiagnostics;
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let invocationOrdinal = 0;
function withRunnerScope<T>(callback: () => T): T {
  invocationOrdinal += 1;
  const invocationId = `preflight-diagnostics-redaction-test-${String(invocationOrdinal)}`;
  let receiptOrdinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'preflight-diagnostics-redaction-test',
    issuer_version: '1.0.0',
    invocation_id: invocationId,
    canonicalSha256: () => 'c'.repeat(64),
    randomId: () => `${invocationId}-${String(++receiptOrdinal)}`,
    now: () => '2026-09-26T00:00:00.000Z',
    receipt_ttl_ms: 30_000,
  });
  const scope: AuthorityHostEffectScope = {
    action_id: 'check',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

/**
 * A command probe that prints the raw observation (read from a tracked file, so
 * the argv itself carries no marker) on both streams and exits 1.
 */
function leakingProbe(probeClass: 'extrinsic' | 'intrinsic') {
  const script =
    "const v=require('node:fs').readFileSync('observed.txt','utf8');" +
    'process.stdout.write(v);process.stderr.write(v);process.exit(1)';
  return {
    id: 'leaking-command',
    class: probeClass,
    probe: { kind: 'command', argv: ['node', '-e', script], expected_exit: 0 },
    expected: 'the command exits 0',
    observed: null,
    status: 'pass',
    remediation: 'Make the command exit 0.',
    depends_on: [],
  };
}

function repository(probeClass: 'extrinsic' | 'intrinsic'): string {
  // prFailureDiagnostics compares realpaths, so the fixture root is resolved first.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-preflight-redaction-')));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  const descriptor = {
    schemaVersion: '1.0.0',
    descriptorVersion: 'preflight-redaction-fixture',
    repositoryId: 'fixture/preflight',
    fallbackNodeId: 'test:local-full',
    dynamicFallbackSelectors: [],
    tasks: [
      {
        nodeId: PREFLIGHT,
        dependencies: [],
        cwd: '.',
        runner: 'preflight-v1',
        probes: [leakingProbe(probeClass)],
        inputSelectors: [{ kind: 'exact', pattern: 'observed.txt' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'probes', requiredStatus: 'pass' },
      },
      {
        nodeId: 'test:local-full',
        dependencies: [PREFLIGHT],
        argv: ['node', '-e', 'process.exit(0)'],
        cwd: '.',
        runner: 'vitest-v1',
        inputSelectors: [{ kind: 'glob', pattern: '**' }],
        toolchainKeys: ['node'],
        allowlistedEnv: [],
        outputContract: { kind: 'marker', value: 'local' },
      },
    ],
    profiles: [{ profileId: 'affected', mode: 'affected', requiredNodes: [], eligibleNodes: [] }],
  };
  put(root, '.gitignore', '.devai/state/*\n');
  put(root, 'test-tasks.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  put(root, 'observed.txt', OBSERVED);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

function run(root: string) {
  return withRunnerScope(() =>
    runCheckTasks({
      repoRoot: root,
      target: 'local',
      operation: 'run',
      toolchain: { node: 'v-test' },
      environment: {},
      executeTask: (argv, cwd, timeoutMs): TaskExecutionResult => {
        const result = spawnSync(argv[0] ?? '', argv.slice(1), {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          env: { PATH: process.env.PATH ?? '' },
        });
        return {
          status: result.status,
          signal: result.signal,
          stdout: String(result.stdout ?? ''),
          stderr: String(result.stderr ?? ''),
        };
      },
      now: () => '2026-09-26T00:00:00.000Z',
    }),
  );
}

function diagnosticFileBytes(root: string): string {
  const directory = join(root, DIAGNOSTICS);
  if (!existsSync(directory)) return '';
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n');
}

function expectNoMarker(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of MARKERS) {
    expect(text.includes(marker), `${label} must not contain the raw observed marker`).toBe(false);
  }
}

describe('preflight diagnostics redaction (ADR-CHK-0001 IA-004)', () => {
  it('redacts an intrinsic FAIL probe observation in the report, cache, and PR diagnostics', async () => {
    const prFailureDiagnostics = await loadPrFailureDiagnostics();
    const root = repository('intrinsic');
    const report = run(root);
    const probe = report.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    expect(probe?.outcome, 'the intrinsic probe fails').toBe('FAIL');

    const diagnostics = prFailureDiagnostics(root, report.execution ?? []);
    const entry = diagnostics.find((candidate) => candidate.nodeId === PREFLIGHT);
    expect(entry, 'the failing probe node reaches the PR diagnostics').toBeDefined();
    expect(entry?.diagnostic, 'the probe diagnostic is bound and readable').not.toBe('unavailable');
    expectNoMarker('report execution', report.execution);
    expectNoMarker('diagnostic files under the cache root', diagnosticFileBytes(root));
    expectNoMarker('prFailureDiagnostics output', diagnostics);
  });

  it('redacts an extrinsic BLOCKED probe observation in the report and PR diagnostics', async () => {
    const prFailureDiagnostics = await loadPrFailureDiagnostics();
    const root = repository('extrinsic');
    const report = run(root);
    const probe = report.execution?.find((entry) => entry.nodeId === PREFLIGHT);
    expect(probe?.outcome, 'the extrinsic probe blocks').toBe('BLOCKED');

    const diagnostics = prFailureDiagnostics(root, report.execution ?? []);
    expect(
      diagnostics.some((candidate) => candidate.nodeId === PREFLIGHT),
      'the blocked probe node reaches the PR diagnostics',
    ).toBe(true);
    expectNoMarker('report execution', report.execution);
    expectNoMarker('diagnostic files under the cache root', diagnosticFileBytes(root));
    expectNoMarker('prFailureDiagnostics output', diagnostics);
  });

  it('never echoes a secret-shaped raw observation that reached a diagnostic file', async () => {
    const prFailureDiagnostics = await loadPrFailureDiagnostics();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-preflight-redaction-file-')));
    roots.push(root);
    const path = join(root, DIAGNOSTICS, 'preflight.json');
    const task = {
      nodeId: PREFLIGHT,
      taskKey: 'a'.repeat(64),
      outcome: 'BLOCKED',
      reason: `probe leaking-command observed ${OBSERVED}`,
      diagnosticPath: path,
    };
    put(
      root,
      `${DIAGNOSTICS}/preflight.json`,
      JSON.stringify({ ...task, stdoutTail: OBSERVED, stderrTail: OBSERVED }),
    );
    const diagnostics = prFailureDiagnostics(root, [task]);
    expect(diagnostics, 'the blocked task is reported').toHaveLength(1);
    expect(diagnostics[0]?.nodeId).toBe(PREFLIGHT);
    expectNoMarker('prFailureDiagnostics output', diagnostics);
  });
});
