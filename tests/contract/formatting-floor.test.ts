import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('checks clean tracked files without a base and preserves bytes, including unusual filenames', () => {
  const descriptor = JSON.parse(readFileSync(resolve('test-tasks.json'), 'utf8')) as {
    tasks: { nodeId: string; argv: string[]; allowlistedEnv: string[] }[];
  };
  const task = descriptor.tasks.find((entry) => entry.nodeId === 'format');
  if (task === undefined) throw new Error('FORMAT_TASK_REQUIRED');
  const [executable, ...argv] = task.argv;
  if (executable === undefined) throw new Error('FORMAT_EXECUTABLE_REQUIRED');
  expect(task.allowlistedEnv).toEqual([]);
  const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const root = mkdtempSync(join(tmpdir(), 'devai-format-floor-'));
  directories.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(resolve('scripts/check-formatting.mjs'), join(root, 'scripts/check-formatting.mjs'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts }));
  const filename = 'espaço\ntracked.json';
  const original = '{"value":1}';
  writeFileSync(join(root, filename), original);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '--', filename);
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'fixture',
  );
  const index = readFileSync(join(root, '.git/index'));
  const check = () =>
    spawnSync(executable, argv, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DEVAI_FORMAT_BASE: 'unavailable-base' },
    });
  const failed = check();
  expect(failed.status, failed.stdout + failed.stderr).toBe(1);
  expect(readFileSync(join(root, filename), 'utf8')).toBe(original);
  expect(readFileSync(join(root, '.git/index'))).toEqual(index);
  writeFileSync(join(root, filename), '{ "value": 1 }\n');
  writeFileSync(join(root, 'unrelated.json'), 'invalid unrelated bytes');
  const passed = check();
  expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  expect(readFileSync(join(root, 'unrelated.json'), 'utf8')).toBe('invalid unrelated bytes');
  expect(readFileSync(join(root, '.git/index'))).toEqual(index);
});
