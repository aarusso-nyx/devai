// Invariants: INV-DEVAI-001
// #338: `backlog show <id>` and `backlog resolve <id>` pass through the real router. The in-process
// facade tests never cross the router, so this drives the BUILT CLI as a subprocess against a bound
// fixture repository, and checks that a backlog failure under --format json is a refusal envelope
// that carries the backlog code and its exit.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = resolve(import.meta.dirname, '../../dist/runtime/index/bin.js');
let repo = '';

function run(args: readonly string[]): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
  });
  return { exit: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(args: readonly string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=DEVAI Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

beforeAll(() => {
  expect(existsSync(BIN), 'run pnpm run build').toBe(true);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-backlog-routing-')));
  git(['init', '--quiet']);
  git(['config', 'maintenance.auto', 'false']);
  git(['config', 'gc.auto', '0']);
  writeFileSync(join(repo, 'README.md'), '# backlog routing fixture\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'test: seed backlog routing fixture']);
  for (const segment of [
    ['--tier', 'tier1', '--constitution'],
    ['--operational-law'],
    ['--subprocess-effects'],
    [],
  ]) {
    const bound = run([
      'init',
      'bind',
      '--target',
      repo,
      ...segment,
      '--as-role',
      'architect',
      '--write',
    ]);
    expect(bound.exit, `init bind ${segment.join(' ')}: ${bound.stderr}`).toBe(0);
  }
}, 180_000);

afterAll(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
});

describe('#338: backlog positional ids through the built CLI', () => {
  it('shows and resolves an item by its positional id', () => {
    const added = run([
      'backlog',
      'add',
      '--kind',
      'note',
      '--title',
      'Routing note',
      '--body',
      'body',
      '--as-role',
      'engineer',
      '--write',
      '--format',
      'json',
    ]);
    expect(added.exit, added.stderr).toBe(0);
    const id = (JSON.parse(added.stdout) as { result: { value: { id: string } } }).result.value.id;
    expect(id).toMatch(/^BL-[0-9]{4,}$/u);

    const shown = run(['backlog', 'show', id, '--format', 'json']);
    expect(shown.exit, shown.stdout + shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ ok: true, result: { value: { id } } });

    const resolved = run([
      'backlog',
      'resolve',
      id,
      '--resolution',
      'TASK-0338',
      '--as-role',
      'engineer',
      '--write',
      '--format',
      'json',
    ]);
    expect(resolved.exit, resolved.stdout + resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({ ok: true });
  }, 120_000);

  it('refuses a missing item with the backlog code and its exit under --format json', () => {
    const missing = run(['backlog', 'show', 'BL-9404', '--format', 'json']);
    expect(missing.exit).toBe(5);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      ok: false,
      error: { code: 'BACKLOG_ITEM_NOT_FOUND', class: 'precondition', exit: 5 },
    });

    const again = run([
      'backlog',
      'resolve',
      'BL-9404',
      '--resolution',
      'TASK-0338',
      '--as-role',
      'engineer',
      '--write',
      '--format',
      'json',
    ]);
    expect(again.exit).toBe(5);
    expect(JSON.parse(again.stderr)).toMatchObject({
      ok: false,
      error: { code: 'BACKLOG_ITEM_NOT_FOUND', class: 'precondition', exit: 5 },
    });

    const usage = run(['backlog', 'list', '--status', 'bogus', '--format', 'json']);
    expect(usage.exit).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({
      ok: false,
      error: { code: 'BACKLOG_STATUS_INVALID', class: 'routing-authority', exit: 2 },
    });
  }, 120_000);
});
