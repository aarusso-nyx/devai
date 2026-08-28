import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseBuild } from '../../src/build.js';

const mocks = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../src/run-command.js', () => ({ runCommand: mocks.runCommand }));

const root = mkdtempSync(join(tmpdir(), 'devai-build-sensor-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() =>
  mocks.runCommand.mockReset().mockReturnValue({
    stdout: 'built',
    stderr: '',
    exit_code: 0,
    duration_ms: 1,
    killed: false,
  }),
);

function project(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('build sensor command selection', () => {
  it('uses the adopter-declared build task argv and cwd', async () => {
    const path = project('declared');
    mkdirSync(join(path, 'app'), { recursive: true });
    writeFileSync(
      join(path, 'test-tasks.json'),
      `${JSON.stringify({ tasks: [{ nodeId: 'build', argv: ['node', '-e', "process.stdout.write('declared')"], cwd: 'app' }] })}\n`,
    );
    const reading = senseBuild({ cwd: path });
    expect(reading).toMatchObject({ status: 'pass', out_head: 'built' });
    expect(reading.command).toMatch(/node .*process\.stdout/u);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      [expect.stringMatching(/node$/u), '-e', "process.stdout.write('declared')"],
      expect.objectContaining({ cwd: realpathSync(join(path, 'app')) }),
    );
  });

  it('uses npm for a package-lock project with a build script', async () => {
    const path = project('npm');
    writeFileSync(
      join(path, 'package.json'),
      `${JSON.stringify({ name: 'npm-build', private: true, scripts: { build: 'node build.mjs' } })}\n`,
    );
    writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const reading = senseBuild({ cwd: path });
    expect(reading).toMatchObject({ status: 'pass' });
    expect(reading.command).toMatch(/npm-cli\.js run build$/u);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      [expect.stringMatching(/npm-cli\.js$/u), 'run', 'build'],
      expect.objectContaining({ cwd: realpathSync(path) }),
    );
  });

  it('uses pnpm recursive build for a pnpm workspace with a build script', async () => {
    const path = project('pnpm');
    writeFileSync(
      join(path, 'package.json'),
      `${JSON.stringify({ name: 'pnpm-build', private: true, scripts: { build: 'node build.mjs' } })}\n`,
    );
    writeFileSync(join(path, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const reading = senseBuild({ cwd: path });
    expect(reading).toMatchObject({ status: 'pass' });
    expect(reading.command).toMatch(/[/\\]pnpm(?:\.js)? -r build$/u);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      [expect.stringMatching(/[/\\]pnpm(?:\.js)?$/u), '-r', 'build'],
      expect.objectContaining({ cwd: realpathSync(path) }),
    );
  });

  it('skips a repository that declares no build', async () => {
    const path = project('none');
    writeFileSync(join(path, 'package.json'), '{"name":"no-build","private":true}\n');
    const reading = senseBuild({ cwd: path });
    expect(reading.status).toBe('skipped');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'BUILD_NOT_DECLARED', severity: 'info' }),
    );
  });
});
