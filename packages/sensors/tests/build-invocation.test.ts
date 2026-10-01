// ADR-AUT-0002 inspector acceptance IA-001 and IA-005 at the sensor: a failing build reads
// FAIL with the exit code and the stderr head; the test-tasks.json build node wins over a
// declared build input; a declared build input is the command only without a descriptor
// node; and a declaration whose argv differs from the descriptor node reads error with
// BUILD_ARGV_CONFLICT instead of silently preferring either.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseBuild, type BuildOptions } from '../src/build.js';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-build-invocation-')));
const emptyPath = join(root, '.empty-path');
mkdirSync(emptyPath);
const originalPath = process.env.PATH;

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  // No pnpm on PATH: the selected argv reaches runCommand unresolved and comparable.
  process.env.PATH = emptyPath;
  mocks.runCommand.mockReset().mockReturnValue({
    stdout: 'built',
    stderr: '',
    exit_code: 0,
    duration_ms: 1,
    killed: false,
  });
});
afterEach(() => {
  process.env.PATH = originalPath;
});

/**
 * The declared build input as sense run passes it from .devai/config/sensor-inputs.json:
 * `argv` and the optional repository-relative `cwd` of law/schemas/sensor-inputs.schema.json.
 * The option names are the inspector's proposal for TASK-0413 (`argv` as type_check takes it,
 * `buildCwd` for the declared working directory beside the repository `cwd`).
 */
type DeclaredBuildOptions = BuildOptions & {
  readonly argv?: readonly string[];
  readonly buildCwd?: string;
};

function sense(options: DeclaredBuildOptions) {
  return senseBuild(options as BuildOptions);
}

let sequence = 0;
function project(): string {
  sequence += 1;
  const path = join(root, `project-${sequence}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function descriptorNode(path: string, argv: readonly string[], cwd = '.'): void {
  writeFileSync(
    join(path, 'test-tasks.json'),
    `${JSON.stringify({ tasks: [{ nodeId: 'build', argv, cwd }] })}\n`,
  );
}

function pnpmManifest(path: string): void {
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify({ scripts: { build: 'tsc -b' } })}\n`,
  );
  writeFileSync(join(path, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
}

describe('build reading for a failing build (IA-001)', () => {
  it('reads FAIL with the exit code and the stderr head, never error or PASS', () => {
    const path = project();
    descriptorNode(path, ['pnpm', '-r', 'build']);
    const stderr = [
      'packages/cli build$ tsc -b',
      'packages/cli/src/broken.ts(3,7): error TS2322: Type string is not assignable to number.',
      'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL',
    ].join('\n');
    mocks.runCommand.mockReturnValue({
      stdout: '',
      stderr,
      exit_code: 2,
      duration_ms: 10,
      killed: false,
    });

    const reading = sense({ cwd: path });

    expect(reading.status).toBe('fail');
    expect(reading.exit_code).toBe(2);
    expect(reading.err_head).toContain('error TS2322');
    expect(reading.err_head).toContain('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL');
    expect(reading.command).toBe('pnpm -r build');
    expect(JSON.stringify(reading.findings ?? [])).not.toContain('AUTHORITY_');
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: path }),
    );
  });

  it('reads FAIL for every non-zero exit, including a killed build', () => {
    const path = project();
    descriptorNode(path, ['pnpm', '-r', 'build']);
    mocks.runCommand.mockReturnValue({
      stdout: '',
      stderr: 'terminated',
      exit_code: 1,
      duration_ms: 300_000,
      killed: true,
    });

    const reading = sense({ cwd: path });

    expect(reading.status).toBe('fail');
    expect(reading.exit_code).toBe(1);
  });
});

describe('build command precedence (ADR-AUT-0002, template pnpm-recursive-build)', () => {
  it('runs the descriptor build node with its cwd when nothing is declared', () => {
    const path = project();
    mkdirSync(join(path, 'workspace'));
    descriptorNode(path, ['pnpm', '-r', 'build'], 'workspace');

    const reading = sense({ cwd: path });

    expect(reading.status).toBe('pass');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: join(path, 'workspace') }),
    );
  });

  it('keeps the descriptor node and its cwd when a declaration names the same argv', () => {
    const path = project();
    mkdirSync(join(path, 'workspace'));
    mkdirSync(join(path, 'declared'));
    descriptorNode(path, ['pnpm', '-r', 'build'], 'workspace');

    const reading = sense({ cwd: path, argv: ['pnpm', '-r', 'build'], buildCwd: 'declared' });

    expect(reading.status).toBe('pass');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: join(path, 'workspace') }),
    );
  });

  it('runs the declared argv and cwd when the repository has no descriptor build node', () => {
    const path = project();
    mkdirSync(join(path, 'app'));

    const reading = sense({ cwd: path, argv: ['pnpm', '-r', 'build'], buildCwd: 'app' });

    expect(reading.status).toBe('pass');
    expect(reading.command).toBe('pnpm -r build');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: join(path, 'app') }),
    );
  });

  it('runs the declared argv from the repository root when the declaration omits cwd', () => {
    const path = project();

    const reading = sense({ cwd: path, argv: ['pnpm', '-r', 'build'] });

    expect(reading.status).toBe('pass');
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: path }),
    );
  });

  it('prefers the declaration over the package manifest fallback', () => {
    const path = project();
    mkdirSync(join(path, 'app'));
    pnpmManifest(path);

    sense({ cwd: path, argv: ['pnpm', '-r', 'build'], buildCwd: 'app' });

    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: join(path, 'app') }),
    );
  });

  it('keeps the package manifest fallback when neither source supplies a command', () => {
    const path = project();
    pnpmManifest(path);

    const reading = sense({ cwd: path });

    expect(reading.status).toBe('pass');
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['pnpm', '-r', 'build'],
      expect.objectContaining({ cwd: path }),
    );
  });

  it('reads skipped BUILD_NOT_DECLARED with neither source nor manifest script', () => {
    const path = project();

    const reading = sense({ cwd: path });

    expect(reading.status).toBe('skipped');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'BUILD_NOT_DECLARED' }),
    );
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
});

describe('build argv conflict (ADR-AUT-0002 IA-005)', () => {
  it.each([
    ['another script', ['pnpm', '-r', 'compile']],
    ['an extra argument', ['pnpm', '-r', 'build', '--filter', 'cli']],
    ['another executable', ['npm', 'run', 'build']],
    ['a shorter argv', ['pnpm', 'build']],
  ] as const)(
    'reads error BUILD_ARGV_CONFLICT naming both argv for a declaration with %s',
    (_label, declared) => {
      const path = project();
      descriptorNode(path, ['pnpm', '-r', 'build']);

      const reading = sense({ cwd: path, argv: declared });

      expect(reading.status).toBe('error');
      const conflict = reading.findings?.find((finding) => finding.code === 'BUILD_ARGV_CONFLICT');
      expect(conflict).toBeDefined();
      expect(conflict?.message).toContain('pnpm -r build');
      expect(conflict?.message).toContain(declared.join(' '));
      expect(mocks.runCommand).not.toHaveBeenCalled();
    },
  );

  it('does not read a conflict when only the declared cwd differs from the descriptor node', () => {
    const path = project();
    mkdirSync(join(path, 'declared'));
    descriptorNode(path, ['pnpm', '-r', 'build']);

    const reading = sense({ cwd: path, argv: ['pnpm', '-r', 'build'], buildCwd: 'declared' });

    expect(reading.status).toBe('pass');
    expect(JSON.stringify(reading.findings ?? [])).not.toContain('BUILD_ARGV_CONFLICT');
  });
});
