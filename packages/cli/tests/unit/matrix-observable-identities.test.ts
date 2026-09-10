// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-016, INV-DEVAI-018
// Public-boundary acceptance: matrix selection and rendering preserve exact
// default-config, fallback-scope, status, and HTML document identities.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { renderMatrix } from '../../src/commands/render/matrix.js';

interface Invocation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-render-matrix-identities-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/state/test-results'), { recursive: true });
  return root;
}

function writeJson(root: string, path: string, value: unknown): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

function putResult(
  root: string,
  name: string,
  input: Readonly<{
    id: string;
    scope?: string;
    repo?: string;
    status?: 'pass' | 'fail' | 'error' | 'skipped' | 'flaky';
    metrics?: Readonly<Record<string, unknown>>;
  }>,
): void {
  writeJson(root, `.devai/state/test-results/${name}.json`, {
    id: input.id,
    ...(input.scope !== undefined && { scope: input.scope }),
    ...(input.repo !== undefined && { repo: input.repo }),
    tier: 'unit',
    status: input.status ?? 'pass',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    metrics: input.metrics ?? { passed: 1, failed: 0 },
  });
}

async function invoke(root: string, args: readonly string[]): Promise<Invocation> {
  const cli = cac('devai-render-matrix-identities');
  renderMatrix.register(cli);
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args];
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
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr: stderr.replace(/^devai evidence test matrix: TEST_PROCESS_EXIT:\d+\n/gm, ''),
    };
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('render matrix observable public identities', () => {
  it('loads default selection and threshold configs and renders the exact skipped status', async () => {
    const root = repository();
    putResult(root, 'included', {
      id: 'included',
      scope: 'pkg/included',
      status: 'skipped',
      metrics: {},
    });
    writeJson(root, '.devai/state/test-results/coverage.json', {
      id: 'coverage',
      scope: 'pkg/coverage',
      tier: 'coverage',
      status: 'pass',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      metrics: { coverage_pct: { lines: 81.2 } },
    });
    putResult(root, 'excluded', { id: 'excluded', scope: 'outside/scope' });
    writeJson(root, '.devai/config/test-matrix.json', { scopes_include: ['pkg/**'] });
    writeJson(root, '.devai/config/thresholds.json', { coverage: { lines: 80 } });

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--include-thresholds',
    ]);

    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        '# Test matrix\n\n| Scope | unit | coverage |\n|---|---|---|\n' +
        '| pkg/coverage | N/A | PASS 81.2% / req 80.0% |\n' +
        '| pkg/included | SKIP | N/A |\n',
    });
  });

  it('uses the same unknown-scope identity for rendering and strict lookup', async () => {
    const root = repository();
    putResult(root, 'anonymous', { id: 'anonymous' });

    const result = await invoke(root, ['render-matrix', '--repo-root', root, '--strict']);

    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout: '# Test matrix\n\n| Scope | unit |\n|---|---|\n| (unknown) | PASS 1/1 |\n',
    });
  });

  it('renders the exact styled HTML document for every status and an N/A cell', async () => {
    const root = repository();
    putResult(root, 'alpha', {
      id: 'alpha',
      scope: 'alpha-pass',
      metrics: { passed: 2, failed: 0 },
    });
    putResult(root, 'beta', {
      id: 'beta',
      scope: 'beta-fail',
      status: 'fail',
      metrics: { passed: 1, failed: 1 },
    });
    putResult(root, 'gamma', {
      id: 'gamma',
      scope: 'gamma-error',
      status: 'error',
      metrics: {},
    });
    putResult(root, 'delta', {
      id: 'delta',
      scope: 'delta-skipped',
      status: 'skipped',
      metrics: {},
    });
    putResult(root, 'epsilon', {
      id: 'epsilon',
      scope: 'epsilon-flaky',
      status: 'flaky',
      metrics: {},
    });
    writeJson(root, 'matrix.json', {
      tiers: ['unit', 'coverage'],
      na_overrides: [{ scope: 'alpha-pass', tier: 'coverage' }],
    });

    const result = await invoke(root, [
      'render-matrix',
      '--repo-root',
      root,
      '--config',
      'matrix.json',
      '--format',
      'html',
    ]);

    expect(result).toEqual({
      exit: 0,
      stderr: '',
      stdout:
        '<!doctype html><meta charset="utf-8"><title>Test matrix</title><style>' +
        'body{font-family:sans-serif;margin:2rem;}' +
        'table{border-collapse:collapse;}' +
        'th,td{border:1px solid #ccc;padding:.4em .7em;text-align:left;}' +
        '.cell-pass{background:#dfd;}.cell-fail{background:#fdd;}' +
        '.cell-error{background:#fbb;}.cell-skipped,.cell-na{background:#eee;color:#777;}' +
        '.cell-flaky{background:#fed;}' +
        '</style><h1>Test matrix</h1><table>' +
        '<tr><th>Scope</th><th>unit</th><th>coverage</th></tr>' +
        '<tr><th>alpha-pass</th><td class="cell cell-pass">PASS 2/2</td>' +
        '<td class="cell cell-na">N/A</td></tr>' +
        '<tr><th>beta-fail</th><td class="cell cell-fail">FAIL 1/2</td>' +
        '<td class="cell cell-na">N/A</td></tr>' +
        '<tr><th>delta-skipped</th><td class="cell cell-skipped">SKIP</td>' +
        '<td class="cell cell-na">N/A</td></tr>' +
        '<tr><th>epsilon-flaky</th><td class="cell cell-flaky">FLAKY</td>' +
        '<td class="cell cell-na">N/A</td></tr>' +
        '<tr><th>gamma-error</th><td class="cell cell-error">ERR</td>' +
        '<td class="cell cell-na">N/A</td></tr></table>\n',
    });
  });
});
