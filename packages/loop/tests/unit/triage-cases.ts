import { describe, expect, it, vi } from 'vitest';
import type { SensorFinding, SensorReading } from '@devai-nyx/sensors';
import {
  classifyFailure,
  dispatchFor,
  findingsKey,
  tieBreak,
  tieBreakWithLadder,
  type BreakerClient,
  type TriageVerdict,
} from '../../src/loop/triage.js';

function reading(
  status: SensorReading['status'],
  findings: readonly SensorFinding[] = [],
  kind = 'lint',
  id = 'SR-abc123',
): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    timestamp: '2026-07-24T00:00:00.000Z',
    sensor: { name: `${kind}-sensor`, kind },
    status,
    deterministic: true,
    findings,
  } as SensorReading;
}

function finding(
  code: string,
  message: string,
  severity: SensorFinding['severity'] = 'error',
  invariantId?: string,
): SensorFinding {
  return {
    code,
    message,
    severity,
    ...(invariantId === undefined ? {} : { invariant_id: invariantId }),
  };
}

function verdict(
  classification: TriageVerdict['classification'],
  score: number,
  evidence: string,
): TriageVerdict {
  return {
    schemaVersion: '1.0.0',
    id: `TRG-${classification}`,
    generated_at: '2026-07-24T00:00:00.000Z',
    subject_evidence_ref: evidence,
    classification,
    confidence: { score, method: 'fixture' },
    summary: `${classification} summary`,
    rationale: `${classification} rationale`,
    recommended_route: dispatchFor({
      classification,
      recommended_route: { discipline: 'owner' },
    } as TriageVerdict),
  };
}

function breaker(
  result: unknown,
  options?: { asText?: boolean },
): BreakerClient & { complete: ReturnType<typeof vi.fn> } {
  return {
    family: 'independent',
    model: 'fixture',
    complete: vi.fn().mockResolvedValue({
      text: options?.asText ? JSON.stringify(result) : '',
      family: 'independent',
      model: 'fixture',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      latency_ms: 1,
      ...(options?.asText ? {} : { json: result }),
    }),
  };
}

describe('classifyFailure', () => {
  const timestamp = '2026-07-24T01:02:03.000Z';

  it('classifies sensor errors and normalizes evidence references', () => {
    const result = classifyFailure(reading('error', [], 'type_check', 'SR-deadbeef'), timestamp);

    expect(result).toMatchObject({
      generated_at: timestamp,
      subject_evidence_ref: 'EV-deadbeef',
      classification: 'sensor_error',
      confidence: { score: 0.9, method: 'rule-based-mvp' },
      recommended_route: { discipline: 'inspector', action: 'fix_sensor_adapter' },
    });
    expect(result.id).toMatch(/^TRG-[0-9a-f]{16}$/u);
  });

  it('routes an unknown LLM judgment to policy review', () => {
    expect(classifyFailure(reading('unknown', [], 'llm_judge'), timestamp)).toMatchObject({
      classification: 'policy_issue',
      confidence: { score: 0.4 },
      recommended_route: { discipline: 'harness_review', action: 'review_policy' },
    });
  });

  it('prioritizes specification gaps and carries impacted invariants', () => {
    const result = classifyFailure(
      reading('fail', [
        finding('untraced_invariant', 'Invariant is missing from the spec', 'error', 'INV-X-001'),
        finding('runtime.failure', 'ordinary failure', 'error'),
      ]),
      timestamp,
    );

    expect(result.classification).toBe('reference_gap');
    expect(result.confidence.score).toBe(0.6);
    expect(result.invariants_impacted).toEqual(['INV-X-001']);
  });

  it('distinguishes policy, plant, and inconclusive findings', () => {
    expect(
      classifyFailure(reading('fail', [finding('policy.limit', 'threshold is too low')]), timestamp)
        .classification,
    ).toBe('policy_issue');
    expect(
      classifyFailure(
        reading('fail', [
          finding('runtime.one', 'first crash', 'critical'),
          finding('runtime.two', 'second crash', 'error'),
        ]),
        timestamp,
      ),
    ).toMatchObject({ classification: 'plant_bug', confidence: { score: 0.5 } });
    expect(classifyFailure(reading('unknown'), timestamp)).toMatchObject({
      classification: 'inconclusive',
      recommended_route: { action: 'escalate_to_human' },
    });
  });

  it('preserves EV ids and deterministically repeats ids', () => {
    const first = classifyFailure(reading('unknown', [], 'lint', 'EV-source'), timestamp);
    const second = classifyFailure(reading('unknown', [], 'lint', 'EV-source'), timestamp);

    expect(first.subject_evidence_ref).toBe('EV-source');
    expect(second.id).toBe(first.id);
  });
});

describe('tie breaking and dispatch', () => {
  it('preserves confidence for agreement and defaults a missing dispatch action', () => {
    const first = verdict('plant_bug', 0.7, 'EV-one');
    const second = verdict('plant_bug', 0.9, 'EV-two');
    const result = tieBreak({ first, second });

    expect(result.confidence).toEqual(first.confidence);
    expect(result.tie_breaker_evidence_refs).toEqual(['EV-two']);
    expect(
      dispatchFor({
        ...result,
        recommended_route: { discipline: 'engineer' },
      }),
    ).toEqual({
      classification: 'plant_bug',
      discipline: 'engineer',
      action: 'feedback_iteration',
    });
  });

  it('chooses the higher-confidence disagreement and downgrades confidence', () => {
    const result = tieBreak({
      first: verdict('plant_bug', 0.4, 'EV-one'),
      second: verdict('policy_issue', 0.8, 'EV-two'),
    });

    expect(result.classification).toBe('policy_issue');
    expect(result.confidence).toEqual({
      score: 0.6000000000000001,
      method: 'mvp-fallback-not-article-23',
    });
    expect(result.tie_breaker_evidence_refs).toEqual(['EV-one']);
  });

  it('sorts compact finding keys independently of input order', () => {
    const input = [finding('z', 'last', 'warning'), finding('a', 'first', 'critical')];
    expect(findingsKey(input)).toBe('critical:a:first|warning:z:last');
  });
});

describe('Article-23 ladder', () => {
  it('does not call the breaker when classifications agree', async () => {
    const client = breaker({});
    const result = await tieBreakWithLadder({
      first: verdict('reference_gap', 0.7, 'EV-one'),
      second: verdict('reference_gap', 0.6, 'EV-two'),
      breakerClient: client,
    });

    expect(client.complete).not.toHaveBeenCalled();
    expect(result.confidence.method).toBe('article-23-no-disagreement');
  });

  it('accepts a structured breaker vote matching either candidate', async () => {
    const client = breaker({
      classification: 'policy_issue',
      confidence: 0.95,
      rationale: 'independent policy evidence',
    });
    const result = await tieBreakWithLadder({
      first: verdict('plant_bug', 0.8, 'EV-one'),
      second: verdict('policy_issue', 0.6, 'EV-two'),
      breakerClient: client,
      sensorContext: 'threshold mismatch',
      timestamp: '2026-07-24T02:00:00.000Z',
    });

    expect(client.complete).toHaveBeenCalledOnce();
    expect(client.complete.mock.calls[0]?.[0].user).toContain('[SENSOR CONTEXT]');
    expect(result).toMatchObject({
      classification: 'policy_issue',
      generated_at: '2026-07-24T02:00:00.000Z',
      confidence: { score: 0.95, method: 'article-23-cross-family-breaker' },
      tie_breaker_evidence_refs: ['EV-one'],
    });
    expect(result.rationale).toContain('independent/fixture');
  });

  it('parses text responses and escalates invalid or third classifications', async () => {
    const first = verdict('plant_bug', 0.8, 'EV-one');
    const second = verdict('policy_issue', 0.6, 'EV-two');
    const third = await tieBreakWithLadder({
      first,
      second,
      breakerClient: breaker(
        { classification: 'reference_gap', confidence: 0.7, rationale: 'third view' },
        { asText: true },
      ),
      timestamp: '2026-07-24T03:00:00.000Z',
    });
    const invalid = await tieBreakWithLadder({
      first,
      second,
      breakerClient: breaker({ classification: 'not-valid', confidence: 4 }),
      timestamp: '2026-07-24T03:00:00.000Z',
    });

    expect(third).toMatchObject({
      classification: 'inconclusive',
      confidence: { score: 0.7 },
      recommended_route: { discipline: 'harness_review', action: 'escalate_to_human' },
      tie_breaker_evidence_refs: ['EV-one', 'EV-two'],
    });
    expect(invalid).toMatchObject({
      classification: 'inconclusive',
      confidence: { score: 0.5 },
    });
  });

  it('handles malformed text without inventing a confident decision', async () => {
    const client = breaker({}, { asText: true });
    client.complete.mockResolvedValueOnce({
      text: '{bad json',
      family: 'independent',
      model: 'fixture',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      latency_ms: 1,
    });

    const result = await tieBreakWithLadder({
      first: verdict('plant_bug', 0.8, 'EV-one'),
      second: verdict('policy_issue', 0.6, 'EV-two'),
      breakerClient: client,
    });

    expect(result).toMatchObject({
      classification: 'inconclusive',
      confidence: { score: 0.5 },
    });
    expect(result.rationale).toContain('chose inconclusive');
  });
});
