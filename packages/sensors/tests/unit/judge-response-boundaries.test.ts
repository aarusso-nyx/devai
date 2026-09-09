import { describe, expect, it } from 'vitest';
import { senseJudge, type JudgeLlmClient } from '../../src/judge.js';

const responseBase = {
  family: 'fixture-family',
  model: 'fixture-model',
  usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.03 },
  finish_reason: 'stop' as const,
  latency_ms: 21,
};

function client(response: { text: string; json?: unknown }): JudgeLlmClient {
  return {
    family: 'fixture-family',
    model: 'fixture-model',
    complete: async (messages, meta, options) => {
      expect(messages).toEqual({
        system: expect.stringContaining('[OUTPUT FORMAT]'),
        user: 'evidence body',
      });
      expect(meta).toEqual({ caller: 'sense judge' });
      expect(options).toEqual({ response_format_json: true, temperature: 0 });
      return { ...responseBase, ...response };
    },
  };
}

const baseOptions = {
  aspect: 'coherence',
  rubric: 'apply rubric',
  evidence: 'evidence body',
};

describe('judge response boundaries', () => {
  it('prefers an object response over invalid text and records provider identity', async () => {
    const reading = await senseJudge(
      baseOptions,
      client({
        text: '{not-json',
        json: { verdict: 'pass', confidence: 0.8, rationale: 'structured result', findings: [] },
      }),
    );

    expect(reading).toMatchObject({
      status: 'pass',
      sensor: {
        name: 'judge.coherence',
        kind: 'llm_judge',
        version: 'fixture-family:fixture-model',
      },
      deterministic: false,
      metrics: {
        aspect_label: 'coherence',
        confidence: 0.8,
        input_tokens: 12,
        output_tokens: 8,
        cost_usd: 0.03,
        latency_ms: 21,
      },
      findings: [{ severity: 'info', code: 'rationale', message: 'structured result' }],
    });
  });

  it('falls back to valid text when the structured response is absent or null', async () => {
    const absent = await senseJudge(
      baseOptions,
      client({ text: '{"verdict":"review","confidence":0.4}', json: undefined }),
    );
    const nullJson = await senseJudge(
      baseOptions,
      client({ text: '{"verdict":"fail","confidence":0.2}', json: null }),
    );

    expect(absent).toMatchObject({ status: 'review', metrics: { confidence: 0.4 } });
    expect(nullJson).toMatchObject({ status: 'fail', metrics: { confidence: 0.2 } });
  });

  it('falls back to text when the structured payload is a primitive', async () => {
    const reading = await senseJudge(
      baseOptions,
      client({
        text: '{"verdict":"pass","confidence":0.6}',
        json: 'unstructured provider payload',
      }),
    );
    expect(reading).toMatchObject({ status: 'pass', metrics: { confidence: 0.6 } });
  });

  it('returns an error reading for text that is not JSON', async () => {
    const reading = await senseJudge(baseOptions, client({ text: 'plain model prose' }));

    expect(reading).toMatchObject({
      status: 'error',
      deterministic: false,
      sensor: {
        name: 'judge.coherence',
        kind: 'llm_judge',
        version: 'fixture-family:fixture-model',
      },
      findings: [
        {
          severity: 'critical',
          code: 'judge_invalid_response',
          message: 'LLM response did not parse as JSON',
        },
      ],
      metrics: { aspect_label: 'coherence', input_tokens: 12, output_tokens: 8, cost_usd: 0.03 },
    });
  });

  it('normalizes an unknown verdict and keeps only findings with string code and message', async () => {
    const reading = await senseJudge(
      { ...baseOptions, aspect: 'depth', evidencePath: 'record/proofs/judge/depth.json' },
      client({
        text: '',
        json: {
          verdict: 'not-a-verdict',
          confidence: 0.1,
          findings: [
            { severity: 'critical', code: 'VALID', message: 'kept' },
            { severity: 'warning', code: 'BAD_MESSAGE', message: 42 },
            { severity: 'error', code: 42, message: 'bad code' },
            { severity: 'unexpected', code: 'UNKNOWN_SEVERITY', message: 'defaults to info' },
          ],
        },
      }),
    );

    expect(reading).toMatchObject({
      status: 'unknown',
      evidence_path: 'record/proofs/judge/depth.json',
      metrics: { aspect_label: 'depth', confidence: 0.1 },
      findings: [
        { severity: 'critical', code: 'VALID', message: 'kept' },
        { severity: 'info', code: 'UNKNOWN_SEVERITY', message: 'defaults to info' },
      ],
    });
  });
});
