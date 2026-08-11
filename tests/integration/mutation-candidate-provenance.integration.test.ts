import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import * as translationValidation from '../../packages/spec/src/translation-validation/index.js';
import { withAuthorityHostTestScope } from '../../packages/authority/tests/unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest, { allowMutationCandidateGit: true }));

// Invariants: INV-DEVAI-021

interface MutationCandidateResult {
  readonly candidate_sha: string;
  readonly candidate_ref: string;
  readonly witness: Readonly<Record<string, unknown>>;
  readonly touched: readonly string[];
}

type MutationCandidateRecorder = (input: {
  readonly repo_root: string;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly emitted_at: string;
  readonly run: () => Promise<unknown>;
}) => Promise<MutationCandidateResult>;

type MutationEvidenceRecorder = (input: {
  readonly repo_root: string;
  readonly intent_id: string;
  readonly candidate_sha: string;
  readonly timestamp: string;
  readonly recipe_name?: string;
  readonly recipe_variant?: string;
  readonly witness?: Readonly<Record<string, unknown>>;
  readonly state_paths?: readonly string[];
}) => unknown;

const recorder = (
  translationValidation as unknown as {
    readonly recordMutationCandidate?: MutationCandidateRecorder;
  }
).recordMutationCandidate;
const evidenceRecorder = (
  translationValidation as unknown as {
    readonly recordMutationEvidenceCommit?: MutationEvidenceRecorder;
  }
).recordMutationEvidenceCommit;

const roots: string[] = [];

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): { readonly repo: string; readonly baseSha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'devai-r28-candidate-'));
  roots.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'DEVAI R28 Recorder']);
  git(repo, ['config', 'user.email', 'recorder@example.invalid']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/value.ts'), "export const value = 'base';\n");
  writeJson(join(repo, '.devai/state/tasks/TASK-0028.json'), {
    schemaVersion: '2.0.0',
    id: 'TASK-0028',
    round_id: 'R-0028',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Produce one attributed candidate',
    target_modules: ['MOD-APP'],
    target_substrates: ['F2'],
    created_at: '2026-07-21T12:00:00.000Z',
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
    intent_diff: {
      summary: 'Change the fixture value.',
      planned_files: ['src/value.ts'],
      planned_steps: ['Write the requested value once.'],
    },
  });
  writeJson(join(repo, 'law/invariants/INV-APP-001.json'), {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    id: 'INV-APP-001',
    domain: 'APP',
    lifecycle: 'supported',
    severity: 'hard-fail',
    type: 'validation',
    title: 'Fixture candidate provenance',
    statement: 'The candidate MUST contain the bytes produced by its attributed run.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'llm_judge',
      strategy: {
        primary: 'semantic-review',
        deterministic_check_available: false,
        rationale: 'The fixture isolates recorder provenance.',
        semantic_review_justification: 'Candidate semantics remain report-only.',
      },
    },
    authority_docs: { docs: [{ doc: 'fixture.md', anchor: 'candidate-provenance' }] },
    scope: { components: ['fixture'], code_areas: ['src/value.ts'] },
    change_policy: {
      breaking_change_requires: ['test_update', 'human_approval'],
      test_weakening_allowed: false,
      human_approval_required: true,
    },
  });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'fixture base']);
  return { repo, baseSha: git(repo, ['rev-parse', 'HEAD']) };
}

function intent(baseSha: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'MI-0123456789abcdef',
    trust: 'untrusted-intent',
    task_id: 'TASK-0028',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: baseSha,
    submitted_at: '2026-07-21T12:01:00.000Z',
    authority_role: 'engineer',
    strategy: 'semantic-review',
    implements: [
      {
        invariant_id: 'INV-APP-001',
        criteria: [
          {
            claim: 'The attributed run produced the candidate bytes.',
            demonstrated_by: [{ kind: 'semantic-review', rubric_ref: 'docs/rubric.md' }],
          },
        ],
      },
    ],
    declared_touched: ['src/value.ts'],
    spec_edits: 'none',
    test_edits: 'none',
    inventory_delta_confined_to: ['MOD-APP'],
    effects_permitted: ['fs:plant'],
    ...overrides,
  };
}

function requireRecorder(): MutationCandidateRecorder {
  expect(recorder, 'D-173 recorder API must exist before these contracts can pass').toBeTypeOf(
    'function',
  );
  return recorder as MutationCandidateRecorder;
}

function requireEvidenceRecorder(): MutationEvidenceRecorder {
  expect(evidenceRecorder, 'D-173 evidence recorder API must exist').toBeTypeOf('function');
  return evidenceRecorder as MutationEvidenceRecorder;
}

function writeAttributionState(
  repo: string,
  candidate: MutationCandidateResult,
  options: { readonly duplicateWitnessId?: boolean; readonly callerName?: string } = {},
): readonly string[] {
  const witnessId = String(candidate.witness['id']);
  const witnessPath = `record/proofs/compliance/translation-validation/witnesses/${witnessId}.json`;
  const recipePath = 'record/proofs/work/recipe-runs/devai-fix/test/record.json';
  const agentRunPath = 'record/proofs/work/agent-runs/AR-01234567-89ab-7cde-8fab-0123456789ab.json';
  const taskPath = '.devai/state/tasks/TASK-0028.json';
  writeJson(join(repo, witnessPath), candidate.witness);
  writeJson(join(repo, recipePath), {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: candidate.witness },
  });
  const paths = [witnessPath, recipePath, agentRunPath, taskPath];
  if (options.duplicateWitnessId === true) {
    const duplicatePath = 'record/proofs/work/recipe-runs/devai-fix/test/stale.json';
    writeJson(join(repo, duplicatePath), {
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: {
        translation_witness: { ...candidate.witness, notes: ['stale duplicate identity'] },
      },
    });
    paths.push(duplicatePath);
  }
  writeJson(join(repo, agentRunPath), {
    schemaVersion: '1.0.0',
    run_id: 'AR-01234567-89ab-7cde-8fab-0123456789ab',
    started_at: '2026-07-21T12:01:00.000Z',
    ended_at: '2026-07-21T12:02:00.000Z',
    caller: {
      kind: 'recipe',
      name: options.callerName ?? 'devai-fix',
    },
    files_read: [],
    files_written: [join(repo, recipePath), join(repo, witnessPath)],
    commands_run: [],
    compliance: { invariant_ids: ['INV-DEVAI-021'] },
    outcome: { status: 'pass' },
    prev_hash: 'GENESIS',
    manifest_hash: 'a'.repeat(64),
  });
  return paths;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recorder-derived candidate provenance contracts', () => {
  it('rejects an invalid evidence intent id before resolving candidate state', () => {
    const { repo, baseSha } = fixture();
    expect(() =>
      requireEvidenceRecorder()({
        repo_root: repo,
        intent_id: '../caller-selected-ref',
        candidate_sha: baseSha,
        timestamp: '2026-07-21T12:02:00.000Z',
      }),
    ).toThrow(/MUTATION_INTENT_ID_INVALID/u);
  });

  it('uses the Linux resolver identity predicate before accepting a unique recipe record', async () => {
    const { repo, baseSha } = fixture();
    const candidate = await requireRecorder()({
      repo_root: repo,
      intent: intent(baseSha),
      emitted_at: '2026-07-21T12:02:00.000Z',
      run: async () =>
        writeFileSync(join(repo, 'src/value.ts'), "export const value = 'produced';\n"),
    });
    const statePaths = writeAttributionState(repo, candidate, { duplicateWitnessId: true });
    expect(() =>
      requireEvidenceRecorder()({
        repo_root: repo,
        intent_id: 'MI-0123456789abcdef',
        candidate_sha: candidate.candidate_sha,
        timestamp: '2026-07-21T12:02:00.000Z',
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        witness: candidate.witness,
        state_paths: statePaths,
      }),
    ).toThrow(/MUTATION_EVIDENCE_RECIPE_RECORD_NOT_UNIQUE/u);
  });

  it('rejects an agent-run record that is not bound to the invoking recipe', async () => {
    const { repo, baseSha } = fixture();
    const candidate = await requireRecorder()({
      repo_root: repo,
      intent: intent(baseSha),
      emitted_at: '2026-07-21T12:02:00.000Z',
      run: async () =>
        writeFileSync(join(repo, 'src/value.ts'), "export const value = 'produced';\n"),
    });
    const statePaths = writeAttributionState(repo, candidate, { callerName: 'devai-plan' });
    expect(() =>
      requireEvidenceRecorder()({
        repo_root: repo,
        intent_id: 'MI-0123456789abcdef',
        candidate_sha: candidate.candidate_sha,
        timestamp: '2026-07-21T12:02:00.000Z',
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        witness: candidate.witness,
        state_paths: statePaths,
      }),
    ).toThrow(/MUTATION_EVIDENCE_AGENT_RUN_MISMATCH/u);
  });

  it('rejects an evidence closure that omits the witness task record', async () => {
    const { repo, baseSha } = fixture();
    const candidate = await requireRecorder()({
      repo_root: repo,
      intent: intent(baseSha),
      emitted_at: '2026-07-21T12:02:00.000Z',
      run: async () =>
        writeFileSync(join(repo, 'src/value.ts'), "export const value = 'produced';\n"),
    });
    const statePaths = writeAttributionState(repo, candidate).filter(
      (path) => path !== '.devai/state/tasks/TASK-0028.json',
    );
    expect(() =>
      requireEvidenceRecorder()({
        repo_root: repo,
        intent_id: 'MI-0123456789abcdef',
        candidate_sha: candidate.candidate_sha,
        timestamp: '2026-07-21T12:02:00.000Z',
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        witness: candidate.witness,
        state_paths: statePaths,
      }),
    ).toThrow(/MUTATION_EVIDENCE_TASK_MISSING/u);
  });

  it('rejects caller-selected candidate provenance before actuation', async () => {
    const { repo, baseSha } = fixture();
    let runs = 0;
    await expect(
      requireRecorder()({
        repo_root: repo,
        intent: intent(baseSha, { candidate_sha: 'f'.repeat(40) }),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () => {
          runs += 1;
          writeFileSync(join(repo, 'src/value.ts'), "export const value = 'produced';\n");
        },
      }),
    ).rejects.toThrow(/MUTATION_INTENT_INVALID|CANDIDATE_PROVENANCE_CALLER_SUPPLIED/u);
    expect(runs).toBe(0);
  });

  it('runs once and derives a retained sole-parent exact-byte candidate after output exists', async () => {
    const { repo, baseSha } = fixture();
    const refsBefore = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/devai/r28/']);
    let runs = 0;
    const result = await requireRecorder()({
      repo_root: repo,
      intent: intent(baseSha),
      emitted_at: '2026-07-21T12:02:00.000Z',
      run: async () => {
        runs += 1;
        expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/devai/r28/'])).toBe(
          refsBefore,
        );
        writeFileSync(join(repo, 'src/value.ts'), "export const value = 'produced';\n");
      },
    });
    expect(runs).toBe(1);
    expect(result.witness).toMatchObject({
      base_sha: baseSha,
      candidate_sha: result.candidate_sha,
      touched: ['src/value.ts'],
    });
    expect(result.candidate_sha).not.toBe(baseSha);
    expect(git(repo, ['rev-list', '--parents', '-n', '1', result.candidate_sha])).toBe(
      `${result.candidate_sha} ${baseSha}`,
    );
    expect(git(repo, ['show', `${result.candidate_sha}:src/value.ts`])).toBe(
      "export const value = 'produced';",
    );
    expect(git(repo, ['show', `${baseSha}:src/value.ts`])).toBe("export const value = 'base';");
    expect(git(repo, ['rev-parse', result.candidate_ref])).toBe(result.candidate_sha);
    expect(result.candidate_ref).toMatch(/^refs\/devai\/r28\/candidates\//u);
  });

  it('excludes intent, evidence, and unrelated bytes from the candidate tree', async () => {
    const { repo, baseSha } = fixture();
    const outsideIntent = join(tmpdir(), `MI-${String(process.pid)}.json`);
    writeJson(outsideIntent, intent(baseSha));
    roots.push(outsideIntent);
    const result = await requireRecorder()({
      repo_root: repo,
      intent: intent(baseSha),
      emitted_at: '2026-07-21T12:02:00.000Z',
      run: async () => {
        writeFileSync(join(repo, 'src/value.ts'), "export const value = 'accepted';\n");
      },
    });
    const tree = git(repo, ['ls-tree', '-r', '--name-only', result.candidate_sha]);
    expect(tree).toContain('src/value.ts');
    expect(tree).not.toContain('mutation-intent');
    expect(tree).not.toContain('translation-validation/witnesses');
    expect(tree).not.toContain('agent-runs');
  });

  it('cannot reuse one pre-generated candidate for two different actual outputs', async () => {
    const first = fixture();
    const second = fixture();
    const run = async (repo: string, baseSha: string, value: string) =>
      requireRecorder()({
        repo_root: repo,
        intent: intent(baseSha),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () =>
          writeFileSync(join(repo, 'src/value.ts'), `export const value = '${value}';\n`),
      });
    const a = await run(first.repo, first.baseSha, 'A');
    const b = await run(second.repo, second.baseSha, 'B');
    expect(a.candidate_sha).not.toBe(b.candidate_sha);
    expect(a.witness['candidate_sha']).toBe(a.candidate_sha);
    expect(b.witness['candidate_sha']).toBe(b.candidate_sha);
  });

  it('rejects no-op and unexpected state without emitting countable evidence', async () => {
    const noOp = fixture();
    await expect(
      requireRecorder()({
        repo_root: noOp.repo,
        intent: intent(noOp.baseSha),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () => undefined,
      }),
    ).rejects.toThrow(/MUTATION_NO_OP/u);
    expect(git(noOp.repo, ['for-each-ref', '--format=%(refname)', 'refs/devai/r28/'])).toBe('');

    const unexpected = fixture();
    await expect(
      requireRecorder()({
        repo_root: unexpected.repo,
        intent: intent(unexpected.baseSha),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () => {
          writeFileSync(join(unexpected.repo, 'src/value.ts'), "export const value = 'ok';\n");
          writeFileSync(join(unexpected.repo, 'unrelated.txt'), 'preserve me\n');
        },
      }),
    ).rejects.toThrow(/MUTATION_UNDECLARED_PATH|MUTATION_UNEXPECTED_STATE/u);
    expect(readFileSync(join(unexpected.repo, 'unrelated.txt'), 'utf8')).toBe('preserve me\n');
    expect(git(unexpected.repo, ['rev-parse', 'HEAD'])).toBe(unexpected.baseSha);
    expect(git(unexpected.repo, ['for-each-ref', '--format=%(refname)', 'refs/devai/r28/'])).toBe(
      '',
    );
  });

  it('refuses a dirty or wrong-base worktree before the run and preserves user state', async () => {
    const dirty = fixture();
    writeFileSync(join(dirty.repo, 'user-note.txt'), 'do not touch\n');
    let dirtyRuns = 0;
    await expect(
      requireRecorder()({
        repo_root: dirty.repo,
        intent: intent(dirty.baseSha),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () => void (dirtyRuns += 1),
      }),
    ).rejects.toThrow(/MUTATION_WORKTREE_NOT_CLEAN/u);
    expect(dirtyRuns).toBe(0);
    expect(readFileSync(join(dirty.repo, 'user-note.txt'), 'utf8')).toBe('do not touch\n');

    const wrongBase = fixture();
    let wrongBaseRuns = 0;
    await expect(
      requireRecorder()({
        repo_root: wrongBase.repo,
        intent: intent('f'.repeat(40)),
        emitted_at: '2026-07-21T12:02:00.000Z',
        run: async () => void (wrongBaseRuns += 1),
      }),
    ).rejects.toThrow(/MUTATION_BASE_MISMATCH/u);
    expect(wrongBaseRuns).toBe(0);
    expect(
      spawnSync('git', ['status', '--porcelain'], { cwd: wrongBase.repo, encoding: 'utf8' }).stdout,
    ).toBe('');
  });
});
