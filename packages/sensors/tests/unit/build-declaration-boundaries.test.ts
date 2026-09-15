import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseBuild } from '../../src/build.js';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

const root = mkdtempSync(join(tmpdir(), 'devai-build-declarations-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  mocks.runCommand.mockReset().mockReturnValue({
    stdout: 'built',
    stderr: '',
    exit_code: 0,
    duration_ms: 1,
    killed: false,
  });
});

function project(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function descriptor(path: string, task: Record<string, unknown>): void {
  writeFileSync(join(path, 'test-tasks.json'), `${JSON.stringify({ tasks: [task] })}\n`);
}

describe('build sensor declaration boundaries', () => {
  it('accepts build runner names only at both delimiters', () => {
    const exact = project('runner-exact');
    descriptor(exact, {
      runner: 'build',
      argv: ['fixture-build', '--exact'],
      cwd: '.',
    });
    const exactReading = senseBuild({ cwd: exact });
    expect(exactReading).toMatchObject({ status: 'pass', command: 'fixture-build --exact' });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['fixture-build', '--exact'],
      expect.objectContaining({ cwd: realpathSync(exact) }),
    );

    const leadingNearMiss = project('runner-leading-near-miss');
    descriptor(leadingNearMiss, {
      runner: 'xbuild',
      argv: ['fixture-leading-near-miss'],
      cwd: '.',
    });
    const leadingReading = senseBuild({ cwd: leadingNearMiss });
    expect(leadingReading.status).toBe('skipped');
    expect(leadingReading.command).toBe('<build-not-declared>');

    const trailingNearMiss = project('runner-trailing-near-miss');
    descriptor(trailingNearMiss, {
      runner: 'buildx',
      argv: ['fixture-trailing-near-miss'],
      cwd: '.',
    });
    const trailingReading = senseBuild({ cwd: trailingNearMiss });
    expect(trailingReading.status).toBe('skipped');
    expect(trailingReading.command).toBe('<build-not-declared>');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
  });

  it('uses a valid build nodeId even when runner is absent', () => {
    const path = project('node-id');
    const app = join(path, 'app');
    mkdirSync(app);
    descriptor(path, {
      nodeId: 'build',
      argv: ['fixture-build', '--declared'],
      cwd: 'app',
    });

    const reading = senseBuild({ cwd: path });

    expect(reading).toMatchObject({ status: 'pass', command: 'fixture-build --declared' });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ['fixture-build', '--declared'],
      expect.objectContaining({ cwd: realpathSync(app) }),
    );
  });

  it('rejects mixed-type argv and skips without a package fallback', () => {
    const path = project('invalid-argv');
    descriptor(path, {
      nodeId: 'build',
      argv: ['fixture-build', 7],
      cwd: '.',
    });

    const reading = senseBuild({ cwd: path });

    expect(reading.status).toBe('skipped');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'BUILD_NOT_DECLARED', severity: 'info' }),
    );
    expect(mocks.runCommand).not.toHaveBeenCalled();

    const empty = project('empty-argv');
    descriptor(empty, { nodeId: 'build', argv: [], cwd: '.' });
    expect(senseBuild({ cwd: empty }).status).toBe('skipped');
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('skips a declaration whose cwd is missing or escapes the repository', () => {
    const missing = project('missing-cwd');
    descriptor(missing, {
      nodeId: 'build',
      argv: ['fixture-build'],
      cwd: 'does-not-exist',
    });
    expect(senseBuild({ cwd: missing })).toMatchObject({
      status: 'skipped',
      command: '<build-not-declared>',
    });

    const outside = project('outside-cwd');
    const outsidePath = join(root, 'outside-target');
    mkdirSync(outsidePath);
    descriptor(outside, {
      nodeId: 'build',
      argv: ['fixture-build'],
      cwd: '../outside-target',
    });
    expect(senseBuild({ cwd: outside })).toMatchObject({
      status: 'skipped',
      command: '<build-not-declared>',
    });
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
});
