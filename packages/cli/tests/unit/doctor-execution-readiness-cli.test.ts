// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017; ADR-SCR-0015.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { doctor } from '../../src/commands/doctor.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function put(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}

async function report(root: string) {
  let invoke: (() => Promise<void>) | undefined;
  const command = {
    option() {
      return command;
    },
    action(callback: (options: { repoRoot: string; skip: string }) => Promise<void>) {
      invoke = () => callback({ repoRoot: root, skip: 'docs-governance' });
      return command;
    },
  };
  doctor.register({ command: () => command } as unknown as CAC);
  const invokeDoctor = invoke;
  if (invokeDoctor === undefined) throw new Error('Doctor action was not registered');
  const original = { exit: process.exit, stdout: process.stdout.write };
  let stdout = '';
  try {
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.exit = (() => {
      throw new Error('INSPECTOR_DOCTOR_EXIT');
    }) as typeof process.exit;
    await expect(withAuthorityHostTestScope(invokeDoctor)).rejects.toThrow('INSPECTOR_DOCTOR_EXIT');
  } finally {
    process.exit = original.exit;
    process.stdout.write = original.stdout;
  }
  return JSON.parse(stdout) as {
    checks: Array<{
      name: string;
      ok: boolean;
      advisory?: boolean;
      info: { status: string; standing: string };
    }>;
  };
}

describe('default doctor exposes execution compatibility separately from installation health', () => {
  it('reports a broken declared task binding at tier1 without needing an optional probe flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-doctor-readiness-cli-'));
    roots.push(root);
    put(root, '.devai/config/project.json', { schemaVersion: '1.0.0', profile: 'tier1' });
    put(root, '.devai/config/sensor-inputs.json', {
      schemaVersion: '1.0.0',
      inputs: { unit_test: { taskId: 'test:unit', population: 'original-tests' } },
    });
    put(root, 'test-tasks.json', {
      schemaVersion: '1.0.0',
      descriptorVersion: 'fixture-1',
      repositoryId: 'fixture',
      fallbackNodeId: 'test:unit',
      dynamicFallbackSelectors: [],
      profiles: [],
      tasks: [
        {
          nodeId: 'test:unit',
          dependencies: [],
          cwd: '.',
          runner: 'exec-v1',
          argv: ['node'],
          inputSelectors: [{ kind: 'prefix', pattern: 'src/' }],
          toolchainKeys: [],
          allowlistedEnv: [],
          outputContract: { population: 'original-tests' },
        },
      ],
    });
    const result = await report(root);
    const readiness = result.checks.find((check) => check.name === 'adopter-execution-readiness');
    expect(readiness).toBeDefined();
    expect(readiness?.ok).toBe(false);
    expect(readiness?.advisory).not.toBe(true);
    expect(readiness?.info).toMatchObject({ status: 'fail', standing: 'diagnostic-only' });
  });

  it('keeps undeclared execution not-required instead of fabricating successful test execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-doctor-no-task-contracts-'));
    roots.push(root);
    put(root, '.devai/config/project.json', { schemaVersion: '1.0.0', profile: 'tier1' });
    const result = await report(root);
    expect(
      result.checks.find((check) => check.name === 'adopter-execution-readiness')?.info,
    ).toMatchObject({ status: 'not-required', standing: 'diagnostic-only' });
  });
});
