// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { verifyTranslation } from '../../src/commands/verify/translation.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const parent = mkdtempSync(join(tmpdir(), 'devai-translation-command-'));
const repository = join(parent, 'repository');
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

interface Options {
  readonly witness: string;
  readonly repoRoot?: string;
  readonly databaseUrl?: string;
  readonly human?: boolean;
}

interface CommandCapture {
  option(): CommandCapture;
  action(callback: (options: Options) => Promise<void>): CommandCapture;
}

let invoke: (options: Options) => Promise<void>;
let witness: Record<string, unknown>;

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(repository, path, '..'), { recursive: true });
  writeFileSync(resolve(repository, path), `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(() => {
  execFileSync('git', ['clone', '--no-local', '--quiet', ROOT, repository]);
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  witness = {
    schemaVersion: '1.0.0',
    id: 'TW-0123456789abcdef',
    trust: 'untrusted-claim',
    task_id: 'TASK-9001',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: candidate,
    candidate_sha: candidate,
    emitted_at: '2026-07-27T00:00:00.000Z',
    strategy: 'structural',
    implements: [
      {
        invariant_id: 'INV-DEVAI-020',
        criteria: [
          {
            claim: 'The action-effects structure remains deterministic.',
            demonstrated_by: [{ kind: 'structural', validator: 'check --only action-effects' }],
          },
        ],
      },
    ],
    touched: ['packages/cli/src/authority/broker.ts'],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
  writeJson('scratch/translation-depth-witness.json', witness);
  writeJson('.devai/state/tasks/TASK-9001.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9001',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation validation depth',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-07-27T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'model-primary',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'primary' },
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      prompt_composition_id: 'PC-0123456789abcdef',
      max_iterations: 1,
      capabilities: ['fs:workspace'],
    },
    intent_diff: { planned_files: ['packages/cli/src/**'] },
  });
  writeJson('record/proofs/work/recipe-runs/devai-fix/test/2026-07-27T00-00-00-000Z.json', {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: witness },
  });
  writeJson('record/proofs/chain.json', { head: null, records: [] });

  const command: CommandCapture = {
    option(): CommandCapture {
      return command;
    },
    action(callback: (options: Options) => Promise<void>): CommandCapture {
      invoke = callback;
      return command;
    },
  };
  verifyTranslation.register({ command: () => command } as unknown as CAC);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

afterAll(() => rmSync(parent, { recursive: true, force: true }));

async function run(options: Options): Promise<{ stdout: string; stderr: string; exit: number }> {
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  await withAuthorityHostTestScope(() => invoke(options), { allowMutationCandidateGit: true });
  return { stdout, stderr, exit: process.exitCode ?? 0 };
}

describe('translation command production depth', () => {
  it('records a report-only structural result when isolation infrastructure fails', async () => {
    const result = await run({
      witness: 'scratch/translation-depth-witness.json',
      repoRoot: repository,
      databaseUrl: 'postgres://127.0.0.1:1/postgres?connect_timeout=1',
    });
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(2);
    const report = JSON.parse(result.stdout) as {
      verdict: string;
      report_only: boolean;
      evidence_chain_refs: string[];
    };
    expect(report.verdict).toBe('FAIL');
    expect(report.report_only).toBe(true);
    expect(report.evidence_chain_refs).toEqual([expect.stringMatching(/^EV-[a-f0-9]{16}$/u)]);
  });

  it('fails closed at database, path, witness, and task authority preconditions', async () => {
    expect(
      (await run({ witness: 'scratch/translation-depth-witness.json', repoRoot: repository }))
        .stderr,
    ).toContain('DATABASE_URL_REQUIRED');
    expect(
      (
        await run({
          witness: '../outside.json',
          repoRoot: repository,
          databaseUrl: 'postgres://unused',
        })
      ).stderr,
    ).toContain('WITNESS_PATH_OUTSIDE_REPOSITORY');

    writeJson('scratch/invalid-witness.json', { id: 'not-a-witness' });
    expect(
      (
        await run({
          witness: 'scratch/invalid-witness.json',
          repoRoot: repository,
          databaseUrl: 'postgres://unused',
        })
      ).stderr,
    ).toContain('TRANSLATION_WITNESS_INVALID');

    writeJson('.devai/state/tasks/TASK-9001.json', {
      schemaVersion: '2.0.0',
      id: 'TASK-9001',
      round_id: 'R-0007',
      status: 'in_progress',
      discipline: 'inspector',
      title: 'Wrong authority',
      target_modules: ['MOD-CLI'],
      target_substrates: ['F3'],
      created_at: '2026-07-27T00:00:00.000Z',
      db_isolation: 'database',
      iteration_count: 0,
      executor: {
        kind: 'agent',
        runtime: 'codex-cli',
        model: 'model-primary',
        effort: 'high',
        selection: { mode: 'exact', registry_id: 'primary' },
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        prompt_composition_id: 'PC-0123456789abcdef',
        max_iterations: 1,
        capabilities: ['fs:workspace'],
      },
      intent_diff: { planned_files: ['packages/cli/src/**'] },
    });
    expect(
      (
        await run({
          witness: 'scratch/translation-depth-witness.json',
          repoRoot: repository,
          databaseUrl: 'postgres://unused',
        })
      ).stderr,
    ).toContain('TRANSLATION_TASK_AUTHORITY_MISMATCH');
  });
});
