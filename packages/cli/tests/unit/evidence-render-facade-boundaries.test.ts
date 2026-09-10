// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-016, INV-DEVAI-018
// Public-boundary acceptance: evidence render preserves delegated matrix options,
// service failures, canonical stdout, and contained projection receipts.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

const matrixService = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  stdout: '',
  stderr: '',
  exitCode: 0,
}));

vi.mock('../../src/commands/render/matrix.js', () => ({
  renderMatrix: {
    name: 'render matrix',
    description: 'test matrix service boundary',
    authority: 'mesh_controller',
    register(cli: CAC): void {
      cli
        .command('render-matrix', 'test matrix service boundary')
        .action((options: Record<string, unknown>) => {
          matrixService.options.push(options);
          process.stdout.write(matrixService.stdout);
          process.stderr.write(matrixService.stderr);
          process.exitCode = matrixService.exitCode;
        });
    },
  },
}));

import { evidenceRender } from '../../src/commands/evidence/facade.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface InvocationResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-evidence-render-boundaries-'));
  roots.push(path);
  return path;
}

function put(repo: string, path: string, contents: string): string {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

async function invoke(
  argv: readonly string[],
  options: { readonly writeConsent?: boolean } = {},
): Promise<InvocationResult> {
  const cli = cac('devai-evidence-render-boundaries');
  evidenceRender.register(cli);
  const originalArgv = process.argv;
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
    cli.parse(process.argv, { run: false });
    if (options.writeConsent === true) process.argv.push('--write');
    await withAuthorityHostTestScope(() => cli.runMatchedCommand());
    await new Promise<void>((done) => setImmediate(done));
    return {
      exit: typeof process.exitCode === 'number' ? process.exitCode : 0,
      stdout,
      stderr,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

afterEach(() => {
  matrixService.options.length = 0;
  matrixService.stdout = '';
  matrixService.stderr = '';
  matrixService.exitCode = 0;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('evidence render public facade boundaries', () => {
  it('forwards every selected matrix option and emits the exact contained write receipt', async () => {
    const repo = root();
    matrixService.stdout = 'service output is contained\n';

    const result = await invoke(
      [
        'evidence-render',
        '--kind',
        'test-matrix',
        '--repo-root',
        repo,
        '--out',
        'record/derived/matrix.html',
        '--in',
        'reports/tests',
        '--format',
        'html',
        '--filter',
        'tier=unit',
        '--config',
        'test-matrix.json',
        '--view',
        'release',
        '--include-duration',
        '--include-thresholds',
        '--thresholds-path',
        'thresholds.json',
        '--strict',
      ],
      { writeConsent: true },
    );

    expect(matrixService.options).toEqual([
      {
        repoRoot: resolve(repo),
        out: 'record/derived/matrix.html',
        in: 'reports/tests',
        format: 'html',
        filter: 'tier=unit',
        config: 'test-matrix.json',
        view: 'release',
        includeDuration: true,
        includeThresholds: true,
        thresholdsPath: 'thresholds.json',
        strict: true,
        human: false,
      },
    ]);
    expect(result).toEqual({
      exit: 0,
      stdout: '{"kind":"test-matrix","out":"record/derived/matrix.html"}\n',
      stderr: '',
    });
  });

  it('forwards a successful matrix service stdout without rewriting it', async () => {
    const repo = root();
    matrixService.stdout = 'matrix payload without a facade newline';

    const result = await invoke(['evidence-render', '--kind', 'test-matrix', '--repo-root', repo]);

    expect(matrixService.options).toEqual([{ repoRoot: resolve(repo), human: false }]);
    expect(result).toEqual({
      exit: 0,
      stdout: 'matrix payload without a facade newline',
      stderr: '',
    });
  });

  it.each([
    {
      name: 'preserves a nonzero service exit and trims its diagnostic',
      service: { exitCode: 7, stderr: '  matrix configuration failed  \n' },
      expected: { exit: 7, stderr: 'devai evidence render: matrix configuration failed\n' },
    },
    {
      name: 'maps diagnostic output with a zero service exit to failure',
      service: { exitCode: 0, stderr: 'matrix emitted an invalid warning\n' },
      expected: { exit: 2, stderr: 'devai evidence render: matrix emitted an invalid warning\n' },
    },
    {
      name: 'renders the exit identity when the service has no diagnostic',
      service: { exitCode: 9, stderr: '' },
      expected: { exit: 9, stderr: 'devai evidence render: test-matrix exited 9\n' },
    },
  ])('$name', async ({ service, expected }) => {
    matrixService.exitCode = service.exitCode;
    matrixService.stderr = service.stderr;

    const result = await invoke(['evidence-render', '--kind', 'test-matrix']);

    expect(result).toEqual({ stdout: '', ...expected });
  });

  it('normalizes a decision projection newline and reports an exact JSON write identity', async () => {
    const repo = root();
    const streamed = await invoke(['evidence-render', '--kind', 'decisions', '--repo-root', repo]);
    expect(streamed).toEqual({
      exit: 0,
      stdout: '# Design Decisions\n\n<!-- generated from canonical records; do not edit -->\n',
      stderr: '',
    });

    const out = 'record/derived/decisions.md';
    const written = await invoke(
      ['evidence-render', '--kind', 'decisions', '--repo-root', repo, '--out', out],
      { writeConsent: true },
    );
    const body = readFileSync(join(repo, out), 'utf8');
    expect(written).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ kind: 'decisions', out, bytes: Buffer.byteLength(body) })}\n`,
      stderr: '',
    });
  });

  it('reports an exact rendering failure through the facade identity', async () => {
    const repo = root();
    put(repo, 'law/adr/broken.md', 'missing frontmatter\n');

    const result = await invoke(['evidence-render', '--kind', 'decisions', '--repo-root', repo]);

    expect(result).toEqual({
      exit: 2,
      stdout: '',
      stderr: 'devai evidence render: frontmatter is required\n',
    });
  });
});
