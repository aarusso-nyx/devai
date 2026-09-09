import { describe, expect, it } from 'vitest';
import { senseJudge, type JudgeLlmClient } from '../../src/judge.js';

interface Capture {
  calls: number;
  meta: Record<string, unknown> | undefined;
  options: Record<string, unknown> | undefined;
  system: string | undefined;
  user: string | undefined;
}

function client(capture: Capture): JudgeLlmClient {
  return {
    family: 'fixture-family',
    model: 'fixture-model',
    complete: async (messages, meta, options) => {
      capture.calls += 1;
      capture.meta = { ...meta };
      capture.options = { ...options };
      capture.system = messages.system;
      capture.user = messages.user;
      return {
        text: '',
        json: { verdict: 'pass', confidence: 0.9, findings: [] },
        family: 'fixture-family',
        model: 'fixture-model',
        usage: { input_tokens: 3, output_tokens: 2, cost_usd: 0.01 },
        finish_reason: 'stop',
        latency_ms: 5,
      };
    },
  };
}

describe('judge request metadata', () => {
  it('forwards prompt composition and stack metadata with the fixed JSON request options', async () => {
    const capture: Capture = {
      calls: 0,
      meta: undefined,
      options: undefined,
      system: undefined,
      user: undefined,
    };

    const reading = await senseJudge(
      {
        aspect: 'coherence',
        rubric: 'apply rubric',
        evidence: 'evidence body',
        evidencePath: 'record/proofs/judge/coherence.json',
        prompt_pc_id: 'PC-wave29',
        stack_sha256: 'a'.repeat(64),
      },
      client(capture),
    );

    expect(capture.calls).toBe(1);
    expect(capture.meta).toEqual({
      caller: 'sense judge',
      prompt_pc_id: 'PC-wave29',
      stack_sha256: 'a'.repeat(64),
    });
    expect(capture.options).toEqual({ response_format_json: true, temperature: 0 });
    expect(capture.system).toContain('[RUBRIC]\napply rubric');
    expect(capture.user).toBe('evidence body');
    expect(reading).toMatchObject({
      status: 'pass',
      sensor: {
        name: 'judge.coherence',
        kind: 'llm_judge',
        version: 'fixture-family:fixture-model',
      },
      command: 'devai sense judge coherence',
      evidence_path: 'record/proofs/judge/coherence.json',
      metrics: { aspect_label: 'coherence', confidence: 0.9 },
    });
  });

  it('keeps optional metadata absent while retaining the caller and request options', async () => {
    const capture: Capture = {
      calls: 0,
      meta: undefined,
      options: undefined,
      system: undefined,
      user: undefined,
    };

    const reading = await senseJudge(
      { aspect: 'depth', rubric: 'depth rubric', evidence: 'depth evidence' },
      client(capture),
    );

    expect(capture.calls).toBe(1);
    expect(capture.meta).toEqual({ caller: 'sense judge' });
    expect(capture.options).toEqual({ response_format_json: true, temperature: 0 });
    expect(reading).toMatchObject({
      status: 'pass',
      sensor: { name: 'judge.depth', kind: 'llm_judge' },
      command: 'devai sense judge depth',
      metrics: { aspect_label: 'depth', confidence: 0.9 },
    });
  });
});
