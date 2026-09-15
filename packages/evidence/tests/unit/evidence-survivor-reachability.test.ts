// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Reachable evidence boundaries the existing suites never execute: a git
// working tree whose HEAD does not resolve while `git status` still answers,
// and immutable task requests whose list-valued fields are not lists.
// Evidence is built through real constructors; malformed task bindings are
// direct API refusal fixtures, not schema-valid installed task requests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { gatherGitContext } from '../../src/evidence/git-context.js';
import {
  buildTaskExecutionEvidence,
  type TaskExecutionEvidenceFacts,
  type TaskRecordBinding,
} from '../../src/task-execution/index.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'devai-survivor-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('gatherGitContext when HEAD does not resolve', () => {
  // A freshly initialised repository has an unborn HEAD: `git rev-parse HEAD`
  // fails while `git status` succeeds and happily lists untracked paths. The
  // documented contract is that an unresolvable HEAD yields no dirty-file
  // claim at all — dirt is only ever reported relative to a resolved commit.
  function unbornRepository(): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
    writeFileSync(join(tempDir, 'untracked.txt'), 'contents\n');
  }

  it('reports no dirty files even though git status still answers', () => {
    unbornRepository();
    // Guard the fixture: the second command genuinely succeeds, so the empty
    // result comes from the early return and not from a failing status call.
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    expect(status).toContain('untracked.txt');

    expect(gatherGitContext(tempDir)).toEqual({ head_sha: null, dirty_files: [] });
  });
});

describe('task-execution binding against a malformed immutable request', () => {
  const CANDIDATE = 'a'.repeat(40);
  const NOT_APPLICABLE = {
    not_applicable_reason: 'routine executor does not call a model provider',
  } as const;

  function routineFacts(
    resolved: TaskExecutionEvidenceFacts['resolved_executor'],
  ): TaskExecutionEvidenceFacts {
    return {
      id: 'TXE-0000000000009401',
      candidate_sha: CANDIDATE,
      resolved_executor: resolved,
      adapter_versions: [{ id: 'routine-argv-adapter', version: '1.0.0' }],
      tool_versions: [{ id: 'node', version: '22.0.0' }],
      input_digests: [{ id: 'input', digest_sha256: 'c'.repeat(64) }],
      output_digests: [{ id: 'output', digest_sha256: 'd'.repeat(64) }],
      selection: {
        mode: 'not-applicable',
        considered_registry_ids: [],
        selected_registry_id: null,
        rejection_codes: [],
        fallback: false,
        fallback_reason: null,
      },
      prompt: NOT_APPLICABLE,
      usage: NOT_APPLICABLE,
      cost: NOT_APPLICABLE,
      started_at: '2026-09-08T00:00:00.000Z',
      completed_at: '2026-09-08T00:00:02.000Z',
      verdict: 'pass',
      evidence_refs: ['EV-9401'],
    };
  }

  function refusalCode(callback: () => unknown): string {
    try {
      callback();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A closed refusal, not a crash.
      expect(error.name).toBe('TaskExecutionEvidenceError');
      return String((error as { readonly code?: unknown }).code);
    }
    throw new Error('expected a task-execution evidence refusal');
  }

  // `effects`, `argv` and `child_task_ids` are read off the task record as
  // `unknown`. When the record carries a scalar where the contract requires a
  // list, the binding must refuse rather than coerce the scalar into a match.
  it.each([
    ['a string where effects must be a list', 'read'],
    ['an object where effects must be a list', { 0: 'read', length: 1 }],
    ['null where effects must be a list', null],
  ])('refuses %s', (_label, effects) => {
    const task: TaskRecordBinding = {
      schemaVersion: '2.0.0',
      id: 'TASK-9401',
      round_id: 'R-0012',
      executor: { kind: 'routine', argv: ['node', 'fixture.mjs'], cwd: '.', effects },
    };
    const resolved = {
      kind: 'routine',
      action_id: null,
      argv: ['node', 'fixture.mjs'],
      cwd: '.',
      effects: ['read'],
    } as const;
    expect(refusalCode(() => buildTaskExecutionEvidence(task, routineFacts(resolved)))).toBe(
      'TASK_EXECUTION_EVIDENCE_ROUTINE_MISMATCH',
    );
  });
});
