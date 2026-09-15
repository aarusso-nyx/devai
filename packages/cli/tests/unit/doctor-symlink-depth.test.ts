import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { doctor } from '../../src/commands/doctor.js';

type Options = { readonly repoRoot: string; readonly skip?: string };
type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly info?: Record<string, unknown>;
  readonly errors?: readonly string[];
};
type Capture = {
  option(): Capture;
  action(callback: (options: Options) => Promise<void>): Capture;
};
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

let invoke: (options: Options) => Promise<void>;
let root: string;
const originalExit = process.exit;
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;
const originalExitCode = process.exitCode;

beforeAll(() => {
  const command: Capture = {
    option: () => command,
    action: (callback) => {
      invoke = callback;
      return command;
    },
  };
  doctor.register({ command: () => command } as unknown as CAC);
  root = mkdtempSync(join(tmpdir(), 'devai-doctor-symlink-depth-'));
  mkdirSync(join(root, '.devai'), { recursive: true });
  mkdirSync(join(root, 'installed'), { recursive: true });
  writeFileSync(join(root, 'installed/constitution.md'), '# Installed constitution\n');
});

afterEach(() => {
  rmSync(join(root, '.devai/constitution.md'), { force: true });
});

afterAll(() => {
  process.exit = originalExit;
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
  rmSync(root, { recursive: true, force: true });
});

async function run(): Promise<{
  readonly exit: number;
  readonly report: { readonly checks: readonly Check[] };
}> {
  let stdout = '';
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    await withAuthorityHostTestScope(() => invoke({ repoRoot: root, skip: 'docs-governance' }));
    throw new Error('doctor returned without exit');
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    return { exit: error.code, report: JSON.parse(stdout) as { checks: readonly Check[] } };
  } finally {
    process.exitCode = originalExitCode;
    process.exit = originalExit;
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function constitutionCheck(report: { readonly checks: readonly Check[] }): Check {
  const check = report.checks.find((entry) => entry.name === 'constitution-symlink');
  if (check === undefined) throw new Error('constitution-symlink check missing');
  return check;
}

describe('doctor constitution pointer boundaries', () => {
  it('reports a valid symlink target and its resolved identity', async () => {
    const path = join(root, '.devai/constitution.md');
    symlinkSync('../installed/constitution.md', path);
    const result = await run();
    const check = constitutionCheck(result.report);
    expect(result.exit).toBe(1);
    expect(check.ok).toBe(true);
    expect(check.info).toMatchObject({ shape: 'symlink', target: '../installed/constitution.md' });
    expect(check.info?.resolved).toBe(join(root, 'installed/constitution.md'));
    expect(readlinkSync(path)).toBe('../installed/constitution.md');
    rmSync(path);
  });

  it('rejects existing non-constitution and missing symlink targets with distinct invalid findings', async () => {
    const path = join(root, '.devai/constitution.md');
    writeFileSync(join(root, 'other.txt'), 'other\n');
    for (const target of ['../other.txt', '../missing-constitution.md']) {
      symlinkSync(target, path);
      const check = constitutionCheck((await run()).report);
      expect(check.ok).toBe(false);
      if (target === '../other.txt') {
        expect(check.info).toMatchObject({
          shape: 'symlink-invalid',
          target,
          resolved: join(root, 'other.txt'),
        });
        expect(check.errors).toEqual([
          `symlink ${path} points to ${join(root, 'other.txt')}; expected an installed constitution.md`,
        ]);
      } else {
        expect(check.info).toBeUndefined();
        expect(check.errors).toEqual([`missing: ${path}`]);
      }
      rmSync(path);
    }
  });

  it('routes an ordinary file through the plain pointer contract', async () => {
    writeFileSync(join(root, '.devai/constitution.md'), '# malformed pointer\n');
    const check = constitutionCheck((await run()).report);
    expect(check.ok).toBe(false);
    expect(check.info).toMatchObject({ shape: 'plain-file-malformed' });
  });
});
