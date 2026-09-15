import { describe, expect, it } from 'vitest';
import {
  aggregateSensorRunResults,
  type SensorRunAggregate,
  type SensorRunChildResult,
} from '../../src/commands/sense/run-set.js';

const zeroCounts = {
  pass: 0,
  review: 0,
  fail: 0,
  unknown: 0,
  na: 0,
  error: 0,
} as const;

function child(
  stdout: string,
  overrides: Partial<SensorRunChildResult> = {},
): SensorRunChildResult {
  return {
    command: 'devai sense run unit_test',
    processStatus: 0,
    stdout,
    stderr: '',
    ...overrides,
  };
}

function structured(status: string, overrides: Partial<SensorRunChildResult> = {}) {
  return child(JSON.stringify({ status }), overrides);
}

function expectAggregate(
  children: readonly SensorRunChildResult[],
  expected: SensorRunAggregate,
): void {
  expect(aggregateSensorRunResults(children)).toEqual(expected);
}

describe('CLI shard 09 sense run set aggregation', () => {
  it('rejects every non-record status shape and terminal execution status', () => {
    for (const stdout of [
      'null',
      '[]',
      '"pass"',
      '0',
      'true',
      '{}',
      '{"status":null}',
      '{"status":0}',
      '{"status":"not-registered"}',
      '{broken',
    ]) {
      expectAggregate([child(stdout)], {
        execution_status: 'error',
        readiness_status: 'unknown',
        applicable_count: 0,
        na_count: 0,
        counts: { ...zeroCounts, error: 1 },
        exit_code: 3,
      });
    }

    expectAggregate([child('{"status":"pass"}', { processStatus: null })], {
      execution_status: 'error',
      readiness_status: 'unknown',
      applicable_count: 0,
      na_count: 0,
      counts: { ...zeroCounts, error: 1 },
      exit_code: 3,
    });

    expectAggregate([structured('error'), structured('killed'), structured('skipped')], {
      execution_status: 'error',
      readiness_status: 'na',
      applicable_count: 0,
      na_count: 1,
      counts: { ...zeroCounts, na: 1, error: 2 },
      exit_code: 3,
    });
  });

  it('preserves empty, N/A, and readiness precedence with exact counts', () => {
    expectAggregate([], {
      execution_status: 'pass',
      readiness_status: 'unknown',
      applicable_count: 0,
      na_count: 0,
      counts: zeroCounts,
      exit_code: 1,
    });

    expectAggregate([structured('skipped'), structured('pass', { na: true })], {
      execution_status: 'pass',
      readiness_status: 'na',
      applicable_count: 0,
      na_count: 2,
      counts: { ...zeroCounts, na: 2 },
      exit_code: 0,
    });

    expectAggregate(
      [structured('pass'), structured('unknown'), structured('review'), structured('fail')],
      {
        execution_status: 'pass',
        readiness_status: 'fail',
        applicable_count: 4,
        na_count: 0,
        counts: { ...zeroCounts, pass: 1, review: 1, fail: 1, unknown: 1 },
        exit_code: 3,
      },
    );

    expectAggregate([structured('pass'), structured('unknown'), structured('review')], {
      execution_status: 'pass',
      readiness_status: 'review',
      applicable_count: 3,
      na_count: 0,
      counts: { ...zeroCounts, pass: 1, review: 1, unknown: 1 },
      exit_code: 1,
    });

    expectAggregate([structured('pass'), structured('unknown')], {
      execution_status: 'pass',
      readiness_status: 'unknown',
      applicable_count: 2,
      na_count: 0,
      counts: { ...zeroCounts, pass: 1, unknown: 1 },
      exit_code: 1,
    });

    expectAggregate(
      [structured('pass'), child('', { processStatus: null, stderr: 'spawn failed' })],
      {
        execution_status: 'error',
        readiness_status: 'pass',
        applicable_count: 1,
        na_count: 0,
        counts: { ...zeroCounts, pass: 1, error: 1 },
        exit_code: 3,
      },
    );
  });
});
