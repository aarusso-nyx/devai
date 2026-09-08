import { describe, expect, it } from 'vitest';
import {
  validateRoutineExecutor,
  type RoutineExecutorRequest,
} from '../../src/loop/routine-executor.js';

function routine(overrides: Partial<RoutineExecutorRequest> = {}): RoutineExecutorRequest {
  return {
    kind: 'routine',
    argv: ['node', 'fixture.mjs'],
    cwd: 'workspace',
    inputs: ['input.json'],
    outputs: ['output.json'],
    effects: ['read'],
    timeout_ms: 1_000,
    authority_checks: ['discipline'],
    ...overrides,
  };
}

function failure(executor: RoutineExecutorRequest): {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
} {
  const result = validateRoutineExecutor({ executor });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected routine validation to fail');
  return result;
}

describe('routine literal validation boundaries', () => {
  it('rejects a mixed valid and invalid input path, preserving the input-specific error', () => {
    expect(failure(routine({ inputs: ['inside/input.json', '../outside.json'] }))).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_INPUTS_INVALID',
      message: 'routine input paths must be unique contained relative paths',
    });
  });

  it('rejects a mixed valid and invalid output path, preserving the output-specific error', () => {
    expect(failure(routine({ outputs: ['inside/output.json', '../outside.json'] }))).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_OUTPUTS_INVALID',
      message: 'routine output paths must be unique contained relative paths',
    });
  });

  it('rejects a mixed valid and invalid effect instead of accepting the valid member', () => {
    expect(failure(routine({ effects: ['read', 'not-an-effect'] as never }))).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_EFFECTS_INVALID',
      message: 'routine effects must be explicit and unique',
    });
  });

  it('accepts timeout one and rejects zero with the stable diagnostic', () => {
    const valid = routine({ timeout_ms: 1 });
    expect(validateRoutineExecutor({ executor: valid })).toEqual({
      ok: true,
      source: 'literal-argv',
      argv: valid.argv,
    });
    expect(failure(routine({ timeout_ms: 0 }))).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_TIMEOUT_INVALID',
      message: 'routine timeout must be a positive integer',
    });
  });

  it('rejects a valid executable followed by a NUL-containing argument', () => {
    expect(failure(routine({ argv: ['node', 'fixture\0.mjs'] }))).toEqual({
      ok: false,
      code: 'TASK_ROUTINE_ARGV_INVALID',
      message: 'literal argv requires a nonempty executable',
    });
  });
});
