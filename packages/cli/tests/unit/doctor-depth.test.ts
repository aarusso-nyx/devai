// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  buildBootstrapPlan,
  executeBootstrapPlan,
  resolveCanonicalPolicyContent,
} from '../../../skills/src/bootstrap/index.js';
import { doctor } from '../../src/commands/doctor.js';

const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

interface DoctorInvocation {
  readonly repoRoot: string;
  readonly chain?: string;
  readonly human?: boolean;
  readonly skip?: string;
}

let invokeDoctor: (options: DoctorInvocation) => void;

interface CommandCapture {
  option(): CommandCapture;
  action(callback: (options: DoctorInvocation) => void): CommandCapture;
}

beforeAll(() => {
  const command: CommandCapture = {
    option(): CommandCapture {
      return command;
    },
    action(callback: (options: DoctorInvocation) => void): CommandCapture {
      invokeDoctor = callback;
      return command;
    },
  };
  doctor.register({ command: () => command } as unknown as CAC);
});

afterEach(() => {
  process.exit = originalExit;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

async function run(options: DoctorInvocation): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';
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
    await withAuthorityHostTestScope(() => invokeDoctor(options));
    throw new Error('doctor returned without an exit');
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    return { exit: error.code, stdout, stderr };
  }
}

describe('adopter doctor report depth', () => {
  const adopter = mkdtempSync(join(tmpdir(), 'devai-doctor-adopter-'));

  beforeAll(() => {
    for (const path of [
      'product',
      'law/invariants',
      'law/schemas',
      'law/adr',
      'law/glossary',
      'docs/dev/operations',
      'docs/dev/security',
      '.devai/config',
    ]) {
      mkdirSync(join(adopter, path), { recursive: true });
    }
    writeFileSync(
      join(adopter, '.devai/config/project.json'),
      `${JSON.stringify({ schemaVersion: '1.0.0', adoption_profile: 'tier1' }, null, 2)}\n`,
    );
  });

  afterAll(() => {
    rmSync(adopter, { recursive: true, force: true });
  });

  it('runs adopter checks and renders the declared profile for humans', async () => {
    const result = await run({ repoRoot: adopter, human: true });
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('devai doctor [profile=tier3]: FAIL');
    expect(result.stdout).toContain('f1-paths-present');
  });

  it('does not run DEVAI source-only checks', async () => {
    const result = await run({ repoRoot: adopter, skip: 'docs-governance' });
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string }> };
    const names = report.checks.map((check) => check.name);
    expect(names).not.toContain('workspace-layout');
    expect(names).not.toContain('schemas-loadable');
    expect(names).not.toContain('test-trace');
    expect(names).toContain('authority-enforcement');
  });
});

describe('tier1 adoption doctor regression', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reports green after materializing the documented tier1 bootstrap', async () => {
    const adopter = mkdtempSync(join(tmpdir(), 'devai-doctor-tier1-'));
    roots.push(adopter);
    await withAuthorityHostTestScope(() =>
      executeBootstrapPlan(
        buildBootstrapPlan({ targetRoot: adopter, version: '1.2.6', profile: 'tier1' }),
      ),
    );
    writeFileSync(
      join(adopter, '.devai/config/subprocess-effects.json'),
      resolveCanonicalPolicyContent('subprocess-effects.json'),
    );

    const result = await run({ repoRoot: adopter, human: true });
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('devai doctor [profile=tier1]: OK');
    expect(result.stdout).toContain('f1-paths-present (advisory: above declared profile)');
    expect(result.stdout).toContain('agents-claude-sync (advisory: above declared profile)');
  });

  it('reports materialized policy drift with exact rebind commands', async () => {
    const adopter = mkdtempSync(join(tmpdir(), 'devai-doctor-policy-drift-'));
    roots.push(adopter);
    await withAuthorityHostTestScope(() =>
      executeBootstrapPlan(
        buildBootstrapPlan({ targetRoot: adopter, version: '1.2.6', profile: 'tier1' }),
      ),
    );
    writeFileSync(join(adopter, '.devai/config/subprocess-effects.json'), '{}\n');

    const result = await run({ repoRoot: adopter, human: true });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain('policy-materialization-current');
    expect(result.stdout).toContain(
      'devai init bind --target . --operational-law --as-role architect --write',
    );
    expect(result.stdout).toContain(
      'devai init bind --target . --subprocess-effects --as-role architect --write',
    );
  });
});
