import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { senseJudge, type JudgeLlmClient } from '../../src/judge.js';

/**
 * Judge reply boundaries under ADR-MDL-0001. The judge reads its reply through the
 * one shared extractor against `review-verdict.schema.json`: prose around exactly
 * one valid document yields the verdict; an invalid document, two candidates, a
 * triage-shaped document, a provider error, or a `length` finish is an `error`
 * reading that keeps a bounded redacted excerpt (`metrics.reply_excerpt`) and the
 * SHA-256 of the full reply text (`metrics.reply_sha256`). `unknown` is only the
 * model's explicit uncertainty, never a parse fallback.
 */

type FinishReason = 'stop' | 'length' | 'tool_use' | 'error';

const responseBase = {
  family: 'fixture-family',
  model: 'fixture-model',
  usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.03 },
  latency_ms: 21,
};

/** A bound no excerpt may exceed, whatever REPLY_EXCERPT_MAX_CHARS the bridge declares. */
const EXCERPT_CEILING = 4096;

const requestOptions: unknown[] = [];

function client(response: {
  text: string;
  json?: unknown;
  finish_reason?: FinishReason;
}): JudgeLlmClient {
  return {
    family: 'fixture-family',
    model: 'fixture-model',
    complete: async (messages, meta, options) => {
      expect(messages).toEqual({
        system: expect.stringContaining('[OUTPUT FORMAT]'),
        user: 'evidence body',
      });
      expect(meta).toEqual({ caller: 'sense judge' });
      requestOptions.push(options);
      return { ...responseBase, finish_reason: 'stop' as const, ...response };
    },
  };
}

const baseOptions = {
  aspect: 'coherence',
  rubric: 'apply rubric',
  evidence: 'evidence body',
};

const PASS = {
  verdict: 'pass',
  confidence: 0.8,
  rationale: 'structured result',
  findings: [],
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function expectErrorReading(response: {
  text: string;
  json?: unknown;
  finish_reason?: FinishReason;
}): Promise<void> {
  const reading = await senseJudge(baseOptions, client(response));
  expect(reading).toMatchObject({
    status: 'error',
    deterministic: false,
    sensor: {
      name: 'judge.coherence',
      kind: 'llm_judge',
      version: 'fixture-family:fixture-model',
    },
    findings: [{ severity: 'critical', code: 'judge_invalid_response' }],
    metrics: {
      aspect_label: 'coherence',
      input_tokens: 12,
      output_tokens: 8,
      cost_usd: 0.03,
      reply_sha256: sha256(response.text),
    },
  });
  const excerpt = reading.metrics?.['reply_excerpt'];
  expect(typeof excerpt).toBe('string');
  expect(String(excerpt).length).toBeLessThanOrEqual(EXCERPT_CEILING);
  expect(reading.status).not.toBe('unknown');
}

describe('judge response boundaries', () => {
  it('asks the bridge for the review verdict schema at temperature zero (IA-006)', async () => {
    requestOptions.length = 0;
    await senseJudge(baseOptions, client({ text: JSON.stringify(PASS) }));
    expect(requestOptions).toHaveLength(1);
    expect(requestOptions[0]).toMatchObject({
      temperature: 0,
      response_schema: 'review-verdict.schema.json',
    });
  });

  it('prefers a valid object response over invalid text and records provider identity', async () => {
    const reading = await senseJudge(baseOptions, client({ text: '{not-json', json: PASS }));

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

  it('yields the verdict from prose around one unfenced document (IA-001)', async () => {
    const reading = await senseJudge(
      baseOptions,
      client({ text: `Here is my assessment: ${JSON.stringify(PASS)}` }),
    );
    expect(reading).toMatchObject({ status: 'pass', metrics: { confidence: 0.8 } });
  });

  it('yields the verdict from prose around one fenced document (IA-001)', async () => {
    const document = { verdict: 'review', confidence: 0.4, rationale: 'needs a look' };
    const text = [
      'Here is my assessment',
      '```json',
      JSON.stringify(document, null, 2),
      '```',
      'Happy to elaborate.',
    ].join('\n');
    const reading = await senseJudge(baseOptions, client({ text }));
    expect(reading).toMatchObject({
      status: 'review',
      metrics: { confidence: 0.4 },
      findings: [{ severity: 'info', code: 'rationale', message: 'needs a look' }],
    });
  });

  it('falls back to the text path when the structured response is absent or null', async () => {
    const fail = { verdict: 'fail', confidence: 0.2, rationale: 'broken' };
    const absent = await senseJudge(baseOptions, client({ text: JSON.stringify(fail) }));
    const nullJson = await senseJudge(
      baseOptions,
      client({ text: JSON.stringify(fail), json: null }),
    );
    expect(absent).toMatchObject({ status: 'fail', metrics: { confidence: 0.2 } });
    expect(nullJson).toMatchObject({ status: 'fail', metrics: { confidence: 0.2 } });
  });

  it('copies valid findings after the rationale finding', async () => {
    const reading = await senseJudge(
      { ...baseOptions, evidencePath: 'record/proofs/judge/coherence.json' },
      client({
        text: '',
        json: {
          verdict: 'fail',
          confidence: 0.7,
          rationale: 'two defects',
          findings: [
            { severity: 'critical', code: 'VALID', message: 'kept' },
            { severity: 'warning', code: 'SECOND', message: 'also kept' },
          ],
        },
      }),
    );
    expect(reading).toMatchObject({
      status: 'fail',
      evidence_path: 'record/proofs/judge/coherence.json',
      findings: [
        { severity: 'info', code: 'rationale', message: 'two defects' },
        { severity: 'critical', code: 'VALID', message: 'kept' },
        { severity: 'warning', code: 'SECOND', message: 'also kept' },
      ],
    });
  });

  it('keeps an explicit unknown verdict as the model uncertainty', async () => {
    const reading = await senseJudge(
      baseOptions,
      client({
        text: JSON.stringify({ verdict: 'unknown', confidence: 0.1, rationale: 'no output' }),
      }),
    );
    expect(reading).toMatchObject({ status: 'unknown', metrics: { confidence: 0.1 } });
  });

  it('returns an error reading with excerpt and digest for prose with no document', async () => {
    await expectErrorReading({ text: 'plain model prose' });
  });

  it('returns an error, never unknown, for a verdict outside the enum (IA-002)', async () => {
    await expectErrorReading({
      text: 'Here is my assessment: {"verdict":"maybe","confidence":0.5,"rationale":"unsure"}',
    });
  });

  it('returns an error for an invalid structured response instead of reading the text', async () => {
    await expectErrorReading({
      text: JSON.stringify(PASS),
      json: { verdict: 'not-a-verdict', confidence: 0.1, rationale: 'r' },
    });
  });

  it('returns an error for a malformed finding instead of filtering it out', async () => {
    await expectErrorReading({
      text: JSON.stringify({
        ...PASS,
        findings: [
          { severity: 'critical', code: 'VALID', message: 'kept' },
          { severity: 'warning', code: 'BAD_MESSAGE', message: 42 },
        ],
      }),
    });
  });

  it('returns an error for two conflicting verdict objects (IA-003)', async () => {
    await expectErrorReading({
      text: `Draft: ${JSON.stringify({ ...PASS, verdict: 'fail' })}\nFinal: ${JSON.stringify(PASS)}`,
    });
  });

  it('returns an error for a length finish even around a valid document (IA-004)', async () => {
    await expectErrorReading({ text: JSON.stringify(PASS), finish_reason: 'length' });
  });

  it('returns an error for a provider error finish', async () => {
    await expectErrorReading({ text: JSON.stringify(PASS), finish_reason: 'error' });
  });

  it('refuses a triage classification document (IA-005)', async () => {
    await expectErrorReading({
      text: JSON.stringify({ classification: 'plant_bug', confidence: 0.9, rationale: 'r' }),
    });
  });

  it('bounds the excerpt of a very long reply and digests all of it', async () => {
    const text = `${'The reviewer rambles on. '.repeat(4000)}{"verdict":"maybe"}`;
    const reading = await senseJudge(baseOptions, client({ text }));
    expect(reading.status).toBe('error');
    expect(reading.metrics?.['reply_sha256']).toBe(sha256(text));
    const excerpt = String(reading.metrics?.['reply_excerpt']);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CEILING);
    expect(excerpt.length).toBeLessThan(text.length);
  });
});
