// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-GOV-0019 IA-003: a backlog item created in one
// session is committed with the repository, and a later session in a fresh
// clone of the same commit sees it through doctor without any host-specific
// state (no counters file, no authority session, no tracking activation, and
// no path of the originating checkout).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CAC } from 'cac';
import { afterAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor } from '../../src/commands/doctor.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

interface FacadeDefinition {
  readonly name: string;
  register(cli: CAC): void;
}

const FACADES_URL = pathToFileURL(
  resolve(import.meta.dirname, '../../src/commands/backlog/index.ts'),
);

async function backlogCommands(): Promise<readonly FacadeDefinition[]> {
  return ((await import(FACADES_URL.href)) as { backlogCommands: readonly FacadeDefinition[] })
    .backlogCommands;
}

/** The doctor check the Engineer must add; it reports open items and never fails the run. */
const CHECK = 'backlog-open-items';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=DEVAI Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function invoke(
  definitions: readonly FacadeDefinition[],
  argv: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cli = cac('devai-doctor-backlog-surface');
  for (const definition of definitions) definition.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
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
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() =>
        runWithAuthorityPolicyMaterialization(
          () => ({
            path: '.devai/config/authority-policy.json',
            operation: 'unchanged',
            digest_sha256: 'a'.repeat(64),
          }),
          () => cli.runMatchedCommand(),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly advisory?: boolean;
  readonly info?: { readonly items?: ReadonlyArray<Record<string, unknown>> };
}

async function doctorCheck(root: string): Promise<DoctorCheck> {
  const result = await invoke(
    [doctor],
    ['doctor', '--repo-root', root, '--skip', 'docs-governance'],
  );
  expect(result.stderr).toBe('');
  const report = JSON.parse(result.stdout) as { checks: DoctorCheck[] };
  const check = report.checks.find((candidate) => candidate.name === CHECK);
  expect(check, `doctor must report ${CHECK}`).toBeDefined();
  return check as DoctorCheck;
}

/**
 * The originating session: a committed repository whose .gitignore keeps
 * session state out of history but lets the backlog store in, one open and one
 * resolved item created through the real actions, and both committed.
 */
async function originWithItems(): Promise<{ readonly origin: string; readonly head: string }> {
  const commands = await backlogCommands();
  const origin = directory('devai-backlog-origin-');
  git(origin, ['init', '--quiet']);
  writeFileSync(
    join(origin, '.gitignore'),
    '.devai/state/*\n!.devai/state/.gitkeep\n!.devai/state/backlog/\n',
  );
  writeFileSync(join(origin, 'README.md'), '# backlog surface fixture\n');
  git(origin, ['add', '.gitignore', 'README.md']);
  git(origin, ['commit', '--quiet', '-m', 'test: seed backlog surface fixture']);

  const add = (title: string, kind: string) =>
    invoke(commands, [
      'backlog-add',
      '--repo-root',
      origin,
      '--kind',
      kind,
      '--title',
      title,
      '--body',
      `${title}.`,
      '--role',
      'engineer',
    ]);
  const open = await add('Round plan should surface open backlog items', 'note');
  expect(open.exit, open.stderr).toBe(0);
  const closed = await add('Already handled proposition', 'proposition');
  expect(closed.exit, closed.stderr).toBe(0);
  const resolved = await invoke(commands, [
    'backlog-resolve',
    'BL-0002',
    '--repo-root',
    origin,
    '--resolution',
    'TASK-0172',
  ]);
  expect(resolved.exit, resolved.stderr).toBe(0);

  git(origin, ['add', '.devai/state/backlog']);
  git(origin, ['commit', '--quiet', '-m', 'test: record backlog items']);
  return { origin, head: git(origin, ['rev-parse', 'HEAD']) };
}

function freshClone(origin: string, head: string): string {
  const clone = join(directory('devai-backlog-clone-'), 'clone');
  git(origin, ['clone', '--quiet', '--no-local', origin, clone]);
  expect(git(clone, ['rev-parse', 'HEAD'])).toBe(head);
  return clone;
}

describe('doctor backlog surface across sessions', () => {
  it('lists the open item in a fresh clone of the same commit without host-specific state', async () => {
    const { origin, head } = await originWithItems();
    const clone = freshClone(origin, head);

    // Nothing but committed bytes crossed into the new session.
    expect(existsSync(join(clone, '.devai/state/backlog/BL-0001.json'))).toBe(true);
    expect(existsSync(join(clone, '.devai/state/counters.json'))).toBe(false);
    expect(existsSync(join(clone, '.devai/state/authority-sessions'))).toBe(false);
    expect(existsSync(join(clone, '.devai/state/tracking'))).toBe(false);

    const check = await doctorCheck(clone);
    // Open items are surfaced, never a failure of the run.
    expect(check.ok).toBe(true);
    const items = check.info?.items ?? [];
    expect(items.map((item) => item.id)).toEqual(['BL-0001']);
    expect(items[0]).toMatchObject({
      id: 'BL-0001',
      kind: 'note',
      title: 'Round plan should surface open backlog items',
      status: 'open',
    });
    expect(JSON.stringify(check)).not.toContain(origin);
  }, 120_000);

  it('reports an empty surface for a repository with no backlog', async () => {
    const empty = directory('devai-backlog-empty-');
    git(empty, ['init', '--quiet']);
    const check = await doctorCheck(empty);
    expect(check.ok).toBe(true);
    expect(check.info?.items ?? []).toEqual([]);
  }, 120_000);

  it('does not reuse a committed id when the later session adds its own item', async () => {
    const { origin, head } = await originWithItems();
    const clone = freshClone(origin, head);
    const commands = await backlogCommands();

    const added = await invoke(commands, [
      'backlog-add',
      '--repo-root',
      clone,
      '--kind',
      'finding',
      '--title',
      'Found in the later session',
      '--body',
      'A later session must not overwrite a committed item.',
      '--role',
      'inspector',
    ]);
    expect(added.exit, added.stderr).toBe(0);
    expect((JSON.parse(added.stdout) as { id: string }).id).toBe('BL-0003');
  }, 120_000);

  it('keeps the backlog store committable under the repository ignore rules', () => {
    const probe = spawnSync(
      'git',
      ['check-ignore', '--quiet', '.devai/state/backlog/BL-0001.json'],
      {
        cwd: REPO_ROOT,
      },
    );
    // Exit 1 means "not ignored": items survive into a fresh clone.
    expect(probe.status).toBe(1);
  });
});
