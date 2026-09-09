import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseBuild } from '../../src/build.js';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-build-package-managers-'));
  mocks.runCommand.mockReset().mockReturnValue({
    stdout: 'built',
    stderr: '',
    exit_code: 0,
    duration_ms: 3,
    killed: false,
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, lockfiles: readonly string[]): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({ scripts: { build: 'fixture-build' } }),
  );
  for (const lockfile of lockfiles) writeFileSync(join(path, lockfile), 'fixture lockfile\n');
  mkdirSync(join(path, 'node_modules', '.bin'), { recursive: true });
  for (const manager of ['pnpm', 'npm', 'yarn', 'bun']) {
    const executable = join(path, 'node_modules', '.bin', manager);
    writeFileSync(executable, '#!/bin/sh\nexit 99\n');
    chmodSync(executable, 0o755);
  }
  return path;
}

describe('build package-manager fallback population', () => {
  it.each([
    ['pnpm', ['pnpm-lock.yaml'], ['pnpm', '-r', 'build']],
    ['npm', ['package-lock.json'], ['npm', 'run', 'build']],
    ['yarn', ['yarn.lock'], ['yarn', 'build']],
    ['bun', ['bun.lockb'], ['bun', 'run', 'build']],
  ] as const)(
    'uses the %s build command when its lockfile is present',
    (manager, lockfiles, argv) => {
      const path = project(`${manager}-project`, lockfiles);

      const reading = senseBuild({ cwd: path });

      expect(reading.status).toBe('pass');
      expect(reading.exit_code).toBe(0);
      const [actualArgs, options] = mocks.runCommand.mock.calls[0] as [unknown[], { cwd: string }];
      expect(actualArgs[0]).toBe(realpathSync(join(path, 'node_modules', '.bin', manager)));
      expect(actualArgs.slice(1)).toEqual(argv.slice(1));
      expect(options.cwd).toBe(realpathSync(path));
    },
  );

  it('selects pnpm before lower-priority lockfiles when multiple managers are present', () => {
    const path = project('priority-project', [
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'bun.lockb',
    ]);

    const reading = senseBuild({ cwd: path });

    expect(reading.status).toBe('pass');
    const [actualArgs] = mocks.runCommand.mock.calls[0] as [unknown[]];
    expect(actualArgs[0]).toBe(realpathSync(join(path, 'node_modules', '.bin', 'pnpm')));
    expect(actualArgs.slice(1)).toEqual(['-r', 'build']);
  });

  it('skips a package build without a recognized lockfile', () => {
    const path = project('no-lockfile', []);
    const reading = senseBuild({ cwd: path });
    expect(reading.status).toBe('skipped');
    expect(reading.command).toBe('<build-not-declared>');
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('skips a malformed package manifest without invoking a package fallback', () => {
    const path = join(root, 'malformed-project');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), '{not-json');
    writeFileSync(join(path, 'package-lock.json'), 'fixture lockfile\n');

    const reading = senseBuild({ cwd: path });

    expect(reading.status).toBe('skipped');
    expect(reading.command).toBe('<build-not-declared>');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'BUILD_NOT_DECLARED', severity: 'info' }),
    );
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
});
