import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { attachActionOutputBoundaries } from '../../src/action-output.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { hostedPartitionDiagnostics } from '../../src/hosted-partition-diagnostics.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const argv = [
  'node',
  'devai',
  'check',
  '--affected',
  '--run',
  '--partition-include',
  'test:cli',
  '--format',
  'json',
];
const originalArgv = process.argv;
const originalExit = process.exitCode;
const roots: string[] = [];
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-hosted-diag-')));
  roots.push(root);
  const dir = join(root, '.devai/state/check-cache/v1/diagnostics');
  mkdirSync(dir, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_REPOSITORY', 'aarusso-nyx/devai');
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
  vi.stubEnv('GITHUB_WORKFLOW', 'Pull request preflight');
  vi.stubEnv(
    'GITHUB_WORKFLOW_REF',
    'aarusso-nyx/devai/.github/workflows/pull-request-checks.yml@refs/pull/1/merge',
  );
  vi.stubEnv('GITHUB_JOB', 'gate-cli');
  const path = join(dir, 'failure.json');
  const task = { nodeId: 'test:cli', taskKey: 'key', outcome: 'FAIL', diagnosticPath: path };
  const report = JSON.stringify({ partition: { include: ['test:cli'] }, execution: [task] });
  const put = (obj: unknown) => writeFileSync(path, JSON.stringify(obj));
  return { root, path, task, report, put };
}

describe('hosted partition failure detail', () => {
  it('requires every workflow identity and the corresponding partition', () => {
    const f = fixture();
    f.put({ ...f.task, stdoutTail: 'failure' });
    expect(hostedPartitionDiagnostics(argv, f.report)).toContain('failure');
    for (const [key, wrong] of Object.entries({
      GITHUB_ACTIONS: 'false',
      GITHUB_REPOSITORY: 'other/repo',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_WORKFLOW: 'other',
      GITHUB_WORKFLOW_REF: 'other/workflow@ref',
      GITHUB_JOB: 'other',
    })) {
      const previous = process.env[key];
      vi.stubEnv(key, wrong);
      expect(hostedPartitionDiagnostics(argv, f.report), key).toBeUndefined();
      vi.stubEnv(key, previous);
    }
    const excluded = argv.map((arg) =>
      arg === '--partition-include' ? '--partition-exclude' : arg,
    );
    expect(hostedPartitionDiagnostics(excluded, f.report)).toBeUndefined();
    vi.stubEnv('GITHUB_JOB', 'gate-rest');
    expect(hostedPartitionDiagnostics(argv, f.report)).toBeUndefined();
    expect(hostedPartitionDiagnostics(excluded, f.report)).toContain('failure');
    expect(
      hostedPartitionDiagnostics(
        argv.filter((arg) => arg !== '--run'),
        f.report,
      ),
    ).toBeUndefined();
  });

  it('returns promptly for a FIFO in both diagnostic readers', () => {
    const f = fixture();
    const created = spawnSync('mkfifo', [f.path], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    // Compile the actual helper in isolation; its redactor is irrelevant to this
    // file-type rejection and is replaced to avoid loading the full CLI graph.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/hosted-partition-diagnostics.ts', import.meta.url)),
      'utf8',
    ).replace(
      "import { redactDiagnosticText } from './services/credential-probe.js';",
      'const redactDiagnosticText = (value: string) => value;',
    );
    const modulePath = join(f.root, 'hosted.mjs');
    writeFileSync(
      modulePath,
      ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText,
    );
    const scriptUrl = new URL('../../../../scripts/pr-failure-diagnostics.mjs', import.meta.url)
      .href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const hosted = await import(process.argv[1]);
      const pr = await import(process.argv[2]);
      const report = JSON.parse(process.argv[3]);
      const detail = hosted.hostedPartitionDiagnostics(JSON.parse(process.argv[4]), JSON.stringify(report));
      const other = pr.prFailureDiagnostics(process.cwd(), report.execution);
      process.stdout.write(JSON.stringify({ detail: JSON.parse(detail), other }));
    `,
        pathToFileURL(modulePath).href,
        scriptUrl,
        f.report,
        JSON.stringify(argv),
      ],
      {
        cwd: f.root,
        env: process.env,
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.detail.failures[0].diagnostic).toBe('unavailable');
    expect(result.other[0].diagnostic).toBe('unavailable');
  });

  it('preserves the action report and exit while adding only hosted failure detail', () => {
    const f = fixture();
    f.put({ ...f.task, stdoutTail: 'useful failure', stderrTail: 'TOKEN=secretvalue' });
    const run = (hosted: boolean, exit: number) => {
      vi.stubEnv('GITHUB_ACTIONS', hosted ? 'true' : 'false');
      let stdout = '';
      let stderr = '';
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(((v: unknown) => {
        stdout += String(v);
        return true;
      }) as typeof process.stdout.write);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(((v: unknown) => {
        stderr += String(v);
        return true;
      }) as typeof process.stderr.write);
      const cli = cac('fixture');
      const entry = canonicalRegistry().find((row) => row.name === 'check');
      if (!entry) throw new Error('missing check action');
      cli.command(entry.internal_name).action(() => {
        process.stdout.write(f.report);
        process.exitCode = exit;
      });
      process.argv = argv;
      attachActionOutputBoundaries(cli.commands, canonicalRegistry());
      cli.commands[0]?.commandAction?.();
      const result = { stdout, stderr, exit: process.exitCode };
      out.mockRestore();
      err.mockRestore();
      return result;
    };
    const plain = run(false, 1);
    const hosted = run(true, 1);
    expect(hosted.stdout).toBe(plain.stdout);
    expect(hosted.exit).toBe(1);
    expect(plain.stderr).toBe('');
    expect(hosted.stderr).toContain('useful failure');
    expect(hosted.stderr).not.toContain('secretvalue');
    expect(run(true, 0).stderr).toBe('');
  });

  it('limits output, redacts before truncation, and omits passing and partitioned tasks', () => {
    const f = fixture();
    const secret = 'TOKEN=' + 'x'.repeat(5000);
    f.put({ ...f.task, stdoutTail: secret + ' end', stderrTail: 'Bearer abcdefghijklmnop' });
    const report = JSON.stringify({
      partition: {},
      execution: [
        f.task,
        { ...f.task, outcome: 'PASS' },
        { ...f.task, partition: 'partitioned-out' },
        ...Array(9).fill(f.task),
      ],
    });
    const text = hostedPartitionDiagnostics(argv, report) ?? '';
    const result = JSON.parse(text);
    expect(result.failures).toHaveLength(8);
    expect(result.omitted).toBe(2);
    expect(result.failures[0].stdoutTail).toBe('[REDACTED] end');
    expect(text).not.toContain('xxxx');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(
      hostedPartitionDiagnostics(
        argv.filter((v) => v !== '--affected'),
        report,
      ),
    ).toBeUndefined();
    vi.stubEnv('GITHUB_ACTIONS', 'false');
    expect(hostedPartitionDiagnostics(argv, report)).toBeUndefined();
  });

  it('does not expose missing, mismatched, oversized, malformed, or symlinked files', () => {
    const f = fixture();
    const unavailable = () => {
      const text = hostedPartitionDiagnostics(argv, f.report) ?? '';
      expect(JSON.parse(text).failures[0].diagnostic).toBe('unavailable');
      expect(text).not.toContain('private-marker');
    };
    unavailable();
    f.put({ ...f.task, taskKey: 'wrong', stdoutTail: 'private-marker' });
    unavailable();
    f.put({ ...f.task, nodeId: 'wrong', stdoutTail: 'private-marker' });
    unavailable();
    writeFileSync(f.path, 'private-marker' + 'x'.repeat(65536));
    unavailable();
    writeFileSync(f.path, '{private-marker');
    unavailable();
    rmSync(f.path);
    const target = join(f.root, 'target');
    writeFileSync(target, JSON.stringify({ ...f.task, stdoutTail: 'private-marker' }));
    symlinkSync(target, f.path);
    unavailable();
  });
});
