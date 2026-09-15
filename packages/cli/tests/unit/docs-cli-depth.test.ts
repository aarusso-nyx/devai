import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CAC } from 'cac';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { docsCli } from '../../src/commands/docs/cli.js';

type Options = {
  readonly repoRoot: string;
  readonly emitDir: string;
  readonly check?: boolean;
  readonly human?: boolean;
};
type Capture = { option(): Capture; action(callback: (options: Options) => void): Capture };
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}
let invoke: (options: Options) => void;
let root: string;
const oldExit = process.exit;
const oldCode = process.exitCode;
const oldOut = process.stdout.write;
const oldErr = process.stderr.write;

beforeAll(() => {
  const command: Capture = {
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  docsCli.register({ command: () => command } as unknown as CAC);
  root = mkdtempSync(join(tmpdir(), 'devai-docs-cli-depth-'));
});
afterEach(() => {
  process.exit = oldExit;
  process.exitCode = oldCode;
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(
  options: Options,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exit: number }> {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  let exit = 0;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    await withAuthorityHostTestScope(() => invoke(options));
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exit = error.code;
  } finally {
    exit = typeof process.exitCode === 'number' ? process.exitCode : exit;
    process.exit = oldExit;
    process.exitCode = oldCode;
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
  return { stdout, stderr, exit };
}

describe('docs cli public filesystem boundaries', () => {
  it('emits the registry pages and removes orphan markdown files', async () => {
    const emitDir = join(root, 'reference');
    mkdirSync(emitDir, { recursive: true });
    writeFileSync(join(emitDir, 'orphan.md'), 'stale\n');
    const result = await run({ repoRoot: root, emitDir: 'reference' });
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, out_dir: emitDir });
    expect(readdirSync(emitDir).some((name) => name === 'orphan.md')).toBe(false);
    expect(readFileSync(join(emitDir, 'README.md'), 'utf8')).toContain('DEVAI CLI reference');
  });

  it('reports missing and byte-drift files distinctly in check mode', async () => {
    const emitDir = join(root, 'check');
    const missing = await run({ repoRoot: root, emitDir: 'check', check: true });
    expect(missing.exit).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      ok: false,
      drift: expect.arrayContaining(['README.md: missing']),
    });
    await run({ repoRoot: root, emitDir: 'check' });
    writeFileSync(join(emitDir, 'README.md'), 'drift\n');
    const drift = await run({ repoRoot: root, emitDir: 'check', check: true });
    expect(drift.exit).toBe(2);
    expect(JSON.parse(drift.stdout).drift).toContain('README.md: byte mismatch');
  });

  it('reports a clean check and human summaries after emission', async () => {
    const emitDir = join(root, 'human');
    const emitted = await run({ repoRoot: root, emitDir: 'human', human: true });
    expect(emitted.exit).toBe(0);
    expect(emitted.stdout).toMatch(/^docs cli: wrote \d+ file\(s\) to /);

    const checked = await run({ repoRoot: root, emitDir: 'human', check: true, human: true });
    expect(checked.exit).toBe(0);
    expect(checked.stdout).toMatch(/^docs cli --check: OK \(\d+ file\(s\) match\)\n$/);
    expect(readdirSync(emitDir).every((name) => name.endsWith('.md'))).toBe(true);
  });
});
