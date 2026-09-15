import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseJudge, type JudgeLlmClient } from '../../src/judge.js';

const responseBase = {
  family: 'fixture-family',
  model: 'fixture-model',
  usage: { input_tokens: 11, output_tokens: 7, cost_usd: 0.25 },
  finish_reason: 'stop' as const,
  latency_ms: 19,
};

let responseJson: unknown;
let calls = 0;

function client(): JudgeLlmClient {
  return {
    family: 'fixture-family',
    model: 'fixture-model',
    complete: async (messages, meta, options) => {
      calls += 1;
      expect(messages.user).toBe('evidence body');
      expect(messages.system).toContain('[RUBRIC]\napply rubric');
      expect(meta).toMatchObject({ caller: 'sense judge' });
      expect(options).toMatchObject({ response_format_json: true, temperature: 0 });
      return { ...responseBase, text: '', json: responseJson };
    },
  };
}

beforeEach(() => {
  responseJson = undefined;
  calls = 0;
});

afterEach(() => {
  responseJson = undefined;
});

describe('judge finding population', () => {
  it('awaits the client and normalizes valid severities while dropping malformed findings', async () => {
    responseJson = {
      verdict: 'review',
      confidence: 0.75,
      rationale: 'needs attention',
      findings: [
        { severity: 'critical', code: 'CRITICAL_CASE', message: 'critical message' },
        { severity: 'error', code: 'ERROR_CASE', message: 'error message' },
        { severity: 'warning', code: 'WARNING_CASE', message: 'warning message' },
        { severity: 'info', code: 'INFO_CASE', message: 'info message' },
        { severity: 'unexpected', code: 'UNKNOWN_SEVERITY', message: 'defaults to info' },
        { severity: 'error', code: 42, message: 'invalid code' },
        { severity: 'error', code: 'INVALID_MESSAGE', message: 42 },
      ],
    };

    const reading = await senseJudge(
      {
        aspect: 'coherence',
        rubric: 'apply rubric',
        evidence: 'evidence body',
        evidencePath: 'record/proofs/judge/coherence.json',
      },
      client(),
    );

    expect(calls).toBe(1);
    expect(reading).toMatchObject({
      status: 'review',
      sensor: {
        name: 'judge.coherence',
        kind: 'llm_judge',
        version: 'fixture-family:fixture-model',
      },
      evidence_path: 'record/proofs/judge/coherence.json',
      metrics: {
        aspect_label: 'coherence',
        confidence: 0.75,
        input_tokens: 11,
        output_tokens: 7,
        cost_usd: 0.25,
        latency_ms: 19,
      },
    });
    expect(reading.findings).toEqual([
      { severity: 'info', code: 'rationale', message: 'needs attention' },
      { severity: 'critical', code: 'CRITICAL_CASE', message: 'critical message' },
      { severity: 'error', code: 'ERROR_CASE', message: 'error message' },
      { severity: 'warning', code: 'WARNING_CASE', message: 'warning message' },
      { severity: 'info', code: 'INFO_CASE', message: 'info message' },
      { severity: 'info', code: 'UNKNOWN_SEVERITY', message: 'defaults to info' },
    ]);
  });

  it('does not synthesize a rationale finding for an empty rationale', async () => {
    responseJson = { verdict: 'pass', confidence: 1, rationale: '', findings: [] };

    const reading = await senseJudge(
      {
        aspect: 'depth',
        rubric: 'apply rubric',
        evidence: 'evidence body',
        evidencePath: 'record/proofs/judge/depth.json',
      },
      client(),
    );

    expect(calls).toBe(1);
    expect(reading).toMatchObject({
      status: 'pass',
      sensor: { name: 'judge.depth', kind: 'llm_judge' },
      evidence_path: 'record/proofs/judge/depth.json',
      metrics: { aspect_label: 'depth', confidence: 1 },
    });
    expect(reading.findings).toEqual([]);
  });
});
