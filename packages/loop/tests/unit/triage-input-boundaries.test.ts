import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorFinding, type SensorReading } from '@devai-nyx/sensors';
import {
  classifyFailure,
  tieBreak,
  tieBreakWithLadder,
  type BreakerClient,
  type TriageVerdict,
} from '../../src/loop/triage.js';

/**
 * Input-boundary coverage for triage. `triage-cases.ts` already covers the
 * happy path of each rule; this file pins the edges those cases leave open:
 * which input actually populates each classification counter, how the
 * verdict identity is derived, the exact text handed to the Article-23
 * breaker, and what happens when the breaker resource misbehaves.
 *
 * Fixtures come from `buildSensorReading`, which hard-gates on
 * sensor-reading.schema.json — so the readings here are real readings, not
 * cast-shaped stand-ins. The few deliberately non-conformant inputs are
 * confined to `defensiveReading` and each proves, in the same test, that
 * the schema rejects the shape being exercised.
 */

const TIMESTAMP = '2026-09-08T00:00:00.000Z';

function realReading(opts: {
  readonly status: SensorReading['status'];
  readonly kind?: string;
  readonly name?: string;
  readonly findings?: readonly SensorFinding[];
  readonly command?: readonly string[];
}): SensorReading {
  return buildSensorReading({
    sensorName: opts.name ?? 'triage-fixture',
    sensorKind: opts.kind ?? 'unit_test',
    command: opts.command ?? ['pnpm', 'run', 'test'],
    status: opts.status,
    deterministic: true,
    timestamp: TIMESTAMP,
    ...(opts.findings === undefined ? {} : { findings: opts.findings }),
  });
}

/**
 * A reading the sensor-reading schema forbids. `classifyFailure` accepts a
 * structural `SensorReading`, and its evidence-reference fallbacks only
 * fire for ids no schema-conformant reading can carry — so exercising them
 * requires stepping outside the builder on purpose. Callers assert the
 * schema rejection alongside the behaviour.
 */
function defensiveReading(id: string, findings: readonly SensorFinding[] = []): SensorReading {
  return {
    schemaVersion: '1.0.0',
    id,
    timestamp: TIMESTAMP,
    sensor: { name: 'triage-fixture', kind: 'unit_test' },
    status: 'fail',
    deterministic: true,
    command: 'pnpm run test',
    findings: [...findings],
  } as unknown as SensorReading;
}

function finding(
  severity: SensorFinding['severity'],
  code: string,
  message: string,
  invariantId?: string,
): SensorFinding {
  return {
    severity,
    code,
    message,
    ...(invariantId === undefined ? {} : { invariant_id: invariantId }),
  };
}

/** Assert a verdict satisfies triage.schema.json rather than only our types. */
function expectSchemaConformant(verdict: TriageVerdict): void {
  const valid = validators.triage(verdict);
  expect(validators.triage.errors ?? [], JSON.stringify(validators.triage.errors)).toEqual([]);
  expect(valid).toBe(true);
}

interface BreakerCall {
  readonly messages: { readonly system: string; readonly user: string };
  readonly meta: Record<string, unknown>;
  readonly opts: Record<string, unknown> | undefined;
}

/**
 * A hand-written implementation of the public `BreakerClient` seam. It is
 * the injected control the production signature already exposes — no
 * internal of `tieBreakWithLadder` is stubbed, and the recorded calls are
 * exactly what a real client would receive.
 */
function recordingBreaker(reply: {
  readonly json?: unknown;
  readonly text?: string;
  readonly family?: string;
  readonly model?: string;
  readonly reject?: Error;
}): BreakerClient & { readonly calls: BreakerCall[] } {
  const calls: BreakerCall[] = [];
  return {
    calls,
    family: reply.family ?? 'independent',
    model: reply.model ?? 'breaker-fixture',
    complete(messages, meta, opts) {
      calls.push({
        messages,
        meta: { ...meta },
        opts: opts === undefined ? undefined : { ...opts },
      });
      if (reply.reject !== undefined) return Promise.reject(reply.reject);
      return Promise.resolve({
        text: reply.text ?? '',
        family: reply.family ?? 'independent',
        model: reply.model ?? 'breaker-fixture',
        usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.0001 },
        latency_ms: 42,
        ...('json' in reply ? { json: reply.json } : {}),
      });
    },
  };
}

/**
 * Rebuild a verdict without its optional `rationale`. `rationale` is
 * optional in triage.schema.json, so a real classifier variant may omit it
 * and the ladder still has to render a prompt line for it.
 */
function withoutRationale(verdict: TriageVerdict): TriageVerdict {
  return {
    schemaVersion: verdict.schemaVersion,
    id: verdict.id,
    generated_at: verdict.generated_at,
    subject_evidence_ref: verdict.subject_evidence_ref,
    classification: verdict.classification,
    confidence: verdict.confidence,
    summary: verdict.summary,
    recommended_route: verdict.recommended_route,
  };
}

/** Two real, disagreeing verdicts used across the ladder cases. */
function disagreeingPair(): { first: TriageVerdict; second: TriageVerdict } {
  const first = classifyFailure(
    realReading({ status: 'error', kind: 'type_check', name: 'tsc' }),
    TIMESTAMP,
  );
  const second = classifyFailure(
    realReading({
      status: 'fail',
      findings: [finding('warning', 'limits.window', 'threshold window too narrow')],
    }),
    TIMESTAMP,
  );
  return { first, second };
}

describe('classifyFailure evidence reference derivation', () => {
  it('derives the evidence reference from a schema-real SR id', () => {
    const reading = realReading({ status: 'fail' });

    expect(reading.id).toMatch(/^SR-[0-9a-f]{16}$/u);
    const result = classifyFailure(reading, TIMESTAMP);

    expect(result.subject_evidence_ref).toBe(`EV-${reading.id.slice(3)}`);
    expect(result.subject_evidence_ref).toMatch(/^EV-[0-9a-f]{16}$/u);
    expectSchemaConformant(result);
  });

  it('passes an EV id through untouched instead of re-prefixing it', () => {
    // Only reachable defensively: the schema pins reading ids to ^SR-.
    expect(validators.sensorReading(defensiveReading('EV-source-record'))).toBe(false);

    expect(classifyFailure(defensiveReading('EV-source-record'), TIMESTAMP)).toMatchObject({
      subject_evidence_ref: 'EV-source-record',
    });
  });

  it('prefixes an id that carries neither known prefix without truncating it', () => {
    // The SR- branch slices three characters; a bare id must not be sliced.
    expect(validators.sensorReading(defensiveReading('TASK-42-run'))).toBe(false);

    expect(classifyFailure(defensiveReading('TASK-42-run'), TIMESTAMP)).toMatchObject({
      subject_evidence_ref: 'EV-TASK-42-run',
    });
  });

  it('does not confuse a short id with a prefixed one', () => {
    expect(validators.sensorReading(defensiveReading('ab'))).toBe(false);
    expect(classifyFailure(defensiveReading('ab'), TIMESTAMP)).toMatchObject({
      subject_evidence_ref: 'EV-ab',
    });
  });
});

describe('classifyFailure verdict identity', () => {
  it('repeats one id for the same evidence and classification', () => {
    const reading = realReading({ status: 'unknown' });
    const first = classifyFailure(reading, TIMESTAMP);
    const second = classifyFailure(reading, '2027-01-01T00:00:00.000Z');

    expect(first.id).toMatch(/^TRG-[0-9a-f]{16}$/u);
    expect(second.id).toBe(first.id);
    expect(second.generated_at).toBe('2027-01-01T00:00:00.000Z');
  });

  it('separates ids when the classification differs for one evidence record', () => {
    // Same evidence reference, two classifications: the id must move, or
    // re-classification would silently overwrite the earlier verdict.
    const evidenceId = 'SR-00112233445566aa';
    const asSensorError = classifyFailure(
      { ...defensiveReading(evidenceId), status: 'error' } as SensorReading,
      TIMESTAMP,
    );
    const asInconclusive = classifyFailure(
      { ...defensiveReading(evidenceId), status: 'unknown' } as SensorReading,
      TIMESTAMP,
    );

    expect(asSensorError.subject_evidence_ref).toBe(asInconclusive.subject_evidence_ref);
    expect(asSensorError.classification).not.toBe(asInconclusive.classification);
    expect(asSensorError.id).not.toBe(asInconclusive.id);
  });

  it('separates ids when two evidence records share a classification', () => {
    const one = classifyFailure(realReading({ status: 'error', name: 'sensor-one' }), TIMESTAMP);
    const two = classifyFailure(realReading({ status: 'error', name: 'sensor-two' }), TIMESTAMP);

    expect(one.classification).toBe(two.classification);
    expect(one.subject_evidence_ref).not.toBe(two.subject_evidence_ref);
    expect(one.id).not.toBe(two.id);
  });

  it('defaults generated_at to now when no timestamp is supplied', () => {
    const before = Date.now();
    const result = classifyFailure(realReading({ status: 'fail' }));
    const after = Date.now();

    const stamped = Date.parse(result.generated_at);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
  });
});

describe('classifyFailure status precedence', () => {
  it('reports the failing sensor identity when the sensor itself errored', () => {
    const result = classifyFailure(
      realReading({ status: 'error', kind: 'security_scan', name: 'audit-sensor' }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'sensor_error',
      confidence: { score: 0.9, method: 'rule-based-mvp' },
      summary: 'Sensor itself failed',
      rationale: "Reading status is 'error' on sensor security_scan (audit-sensor)",
      recommended_route: { discipline: 'inspector', action: 'fix_sensor_adapter' },
    });
    expectSchemaConformant(result);
  });

  it('lets an errored sensor outrank findings that would otherwise classify', () => {
    const result = classifyFailure(
      realReading({
        status: 'error',
        findings: [finding('critical', 'untraced_invariant', 'invariant has no spec')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('sensor_error');
  });

  it('names the rubric gap when an llm_judge returns unknown', () => {
    const result = classifyFailure(
      realReading({ status: 'unknown', kind: 'llm_judge', name: 'rubric-judge' }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'policy_issue',
      confidence: { score: 0.4, method: 'rule-based-mvp' },
      summary: 'llm_judge returned unknown',
      rationale: 'Possible rubric mismatch or insufficient evidence',
    });
    expectSchemaConformant(result);
  });

  it('does not route a failing llm_judge to policy review on kind alone', () => {
    // Only `unknown` signals a rubric gap; a plain `fail` is ordinary evidence.
    const result = classifyFailure(
      realReading({
        status: 'fail',
        kind: 'llm_judge',
        findings: [finding('error', 'judge.verdict', 'assistant response contradicted the plant')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('plant_bug');
  });

  it('does not route a non-judge unknown reading to policy review', () => {
    expect(
      classifyFailure(realReading({ status: 'unknown', kind: 'lint' }), TIMESTAMP).classification,
    ).toBe('inconclusive');
  });
});

describe('classifyFailure finding tallies', () => {
  it('counts a reference gap from the message alone', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'trace.gap', 'invariant is not traced anywhere')],
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'reference_gap',
      confidence: { score: 0.6 },
      summary: '1 finding(s) reference specification gaps',
      rationale: '1 finding(s) reference specification gaps',
      recommended_route: { discipline: 'architect', action: 'emit_rgr' },
    });
  });

  it('counts a reference gap from an untraced_invariant code alone', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'untraced_invariant', 'no matching trace row')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('reference_gap');
  });

  it('counts a reference gap from an unresolved_invariant code alone', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('critical', 'unresolved_invariant', 'left dangling after the merge')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('reference_gap');
  });

  it('matches spec-gap wording with words between the anchors', () => {
    const spaced = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'docs.gap', 'missing the behavioural spec')],
      }),
      TIMESTAMP,
    );
    const reversed = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'docs.gap', 'spec for this route is missing')],
      }),
      TIMESTAMP,
    );

    expect(spaced.classification).toBe('reference_gap');
    expect(reversed.classification).toBe('reference_gap');
  });

  it('yields to plant findings when they outnumber reference gaps', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('error', 'trace.gap', 'invariant is untraced'),
          finding('error', 'runtime.one', 'first crash'),
          finding('critical', 'runtime.two', 'second crash'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'plant_bug',
      confidence: { score: 0.5 },
      summary: '2 code-level error finding(s)',
      recommended_route: { discipline: 'engineer', action: 'feedback_iteration' },
    });
  });

  it('keeps the reference gap when the counts are level', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('error', 'trace.gap', 'invariant is untraced'),
          finding('error', 'runtime.one', 'first crash'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('reference_gap');
  });

  it('caps reference-gap confidence below certainty', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: Array.from({ length: 6 }, (_unused, index) =>
          finding('error', `trace.gap.${String(index)}`, `invariant ${String(index)} is untraced`),
        ),
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'reference_gap',
      confidence: { score: 0.95 },
      summary: '6 finding(s) reference specification gaps',
    });
  });

  it('caps plant-bug confidence below certainty', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: Array.from({ length: 12 }, (_unused, index) =>
          finding('error', `runtime.${String(index)}`, `crash ${String(index)}`),
        ),
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'plant_bug',
      confidence: { score: 0.9 },
      summary: '12 code-level error finding(s)',
    });
  });

  it('counts a policy issue from the message alone', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('warning', 'limits.window', 'threshold window too narrow')],
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'policy_issue',
      confidence: { score: 0.6 },
      summary: '1 policy/config-related finding(s)',
      rationale: '1 policy/config-related finding(s)',
      recommended_route: { discipline: 'harness_review', action: 'review_policy' },
    });
  });

  it('counts a policy issue from a policy-prefixed code alone', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'policy.denied', 'the request was refused')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('policy_issue');
  });

  it('does not treat a code merely ending in policy as a policy finding', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'denied.by.policy.', 'the request was refused')],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('plant_bug');
  });

  it('prefers plant findings when policy findings only tie them', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('error', 'policy.denied', 'the request was refused'),
          finding('error', 'runtime.one', 'first crash'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('plant_bug');
  });

  it('prefers plant findings when they outnumber policy findings', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('error', 'policy.denied', 'the request was refused'),
          finding('error', 'runtime.one', 'first crash'),
          finding('critical', 'runtime.two', 'second crash'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result.classification).toBe('plant_bug');
  });

  it('does not count sub-error findings as plant evidence', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('warning', 'style.spacing', 'inconsistent indentation'),
          finding('info', 'style.naming', 'shorthand identifier'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result).toMatchObject({
      classification: 'inconclusive',
      confidence: { score: 0.3 },
      summary: 'No strong signal in findings',
      rationale: 'Default classification — fall back to tie-breaker ladder',
      recommended_route: { discipline: 'harness_review', action: 'escalate_to_human' },
    });
    expectSchemaConformant(result);
  });
});

describe('classifyFailure impacted invariants', () => {
  it('collects invariant ids in finding order', () => {
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [
          finding('error', 'trace.gap', 'invariant is untraced', 'INV-B-002'),
          finding('error', 'runtime.one', 'first crash'),
          finding('error', 'trace.gap.2', 'invariant is untraced again', 'INV-A-001'),
        ],
      }),
      TIMESTAMP,
    );

    expect(result.invariants_impacted).toEqual(['INV-B-002', 'INV-A-001']);
    expectSchemaConformant(result);
  });

  it('omits the property entirely when no finding names an invariant', () => {
    // triage.schema.json sets additionalProperties:false and constrains the
    // array's items; an always-spread empty array is a different record.
    const result = classifyFailure(
      realReading({
        status: 'fail',
        findings: [finding('error', 'runtime.one', 'first crash')],
      }),
      TIMESTAMP,
    );

    expect(result.invariants_impacted).toBeUndefined();
    expect(Object.keys(result)).not.toContain('invariants_impacted');
  });

  it('omits the property when the reading carries no findings at all', () => {
    const result = classifyFailure(realReading({ status: 'unknown' }), TIMESTAMP);

    expect(Object.keys(result)).not.toContain('invariants_impacted');
  });

  it('drops an empty invariant id rather than emitting an unusable reference', () => {
    // The schema pins invariant_id to ^INV-, so an empty one cannot reach
    // triage through the builder — this guards the defensive filter.
    expect(() =>
      buildSensorReading({
        sensorName: 'triage-fixture',
        sensorKind: 'unit_test',
        command: ['pnpm', 'run', 'test'],
        status: 'fail',
        deterministic: true,
        timestamp: TIMESTAMP,
        findings: [finding('error', 'runtime.one', 'first crash', '')],
      }),
    ).toThrow(/sensor-reading\.schema\.json/u);

    const result = classifyFailure(
      defensiveReading('SR-00112233445566aa', [
        finding('error', 'runtime.one', 'first crash', ''),
        finding('error', 'runtime.two', 'second crash', 'INV-C-003'),
      ]),
      TIMESTAMP,
    );

    expect(result.invariants_impacted).toEqual(['INV-C-003']);
  });
});

describe('tieBreak fallback', () => {
  it('marks the invocation and names the loser when both agree', () => {
    const first = classifyFailure(realReading({ status: 'error', name: 'one' }), TIMESTAMP);
    const second = classifyFailure(realReading({ status: 'error', name: 'two' }), TIMESTAMP);
    const result = tieBreak({ first, second });

    expect(result.tie_breaker_invoked).toBe(true);
    expect(result.confidence).toEqual(first.confidence);
    expect(result.tie_breaker_evidence_refs).toEqual([second.subject_evidence_ref]);
    expect(result.id).toBe(first.id);
    expectSchemaConformant(result);
  });

  it('keeps the first verdict when it holds the higher confidence', () => {
    const { first, second } = disagreeingPair();
    expect(first.confidence.score).toBeGreaterThan(second.confidence.score);

    const result = tieBreak({ first, second });

    expect(result.classification).toBe(first.classification);
    expect(result.confidence).toEqual({ score: 0.75, method: 'mvp-fallback-not-article-23' });
    expect(result.tie_breaker_invoked).toBe(true);
    expect(result.tie_breaker_evidence_refs).toEqual([second.subject_evidence_ref]);
  });

  it('resolves an exact confidence tie in favour of the first verdict', () => {
    const first = classifyFailure(realReading({ status: 'error' }), TIMESTAMP);
    const second = classifyFailure(
      realReading({
        status: 'fail',
        findings: Array.from({ length: 12 }, (_unused, index) =>
          finding('error', `runtime.${String(index)}`, `crash ${String(index)}`),
        ),
      }),
      TIMESTAMP,
    );
    expect(first.confidence.score).toBe(second.confidence.score);
    expect(first.classification).not.toBe(second.classification);

    const result = tieBreak({ first, second });

    expect(result.classification).toBe(first.classification);
    expect(result.tie_breaker_evidence_refs).toEqual([second.subject_evidence_ref]);
  });
});

describe('Article-23 ladder prompt construction', () => {
  const EXPECTED_SYSTEM = [
    'You are an Article-23 cross-family tie-breaker for the DEVAI triage subsystem. Two classifiers from one family disagreed; your job is to vote independently.',
    '',
    '[CLASSIFICATION ENUM]',
    '"plant_bug" | "sensor_error" | "policy_issue" | "reference_gap" | "inconclusive"',
    '',
    'You may choose "inconclusive" if neither candidate is clearly right; this escalates to a human per Article 19.',
    '',
    '[OUTPUT FORMAT]',
    '{ "classification": "...", "confidence": number in [0,1], "rationale": "short prose" }',
    '',
    'Return ONLY the JSON object.',
  ].join('\n');

  it('sends the full rubric, both candidates and the sensor context', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'policy_issue', confidence: 0.7 } });

    await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      sensorContext: 'threshold window narrowed in the last release',
      timestamp: TIMESTAMP,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.messages.system).toBe(EXPECTED_SYSTEM);
    expect(client.calls[0]?.messages.user).toBe(
      [
        '[CANDIDATE 1]',
        'classification: sensor_error',
        'confidence: 0.9',
        'summary: Sensor itself failed',
        "rationale: Reading status is 'error' on sensor type_check (tsc)",
        '',
        '[CANDIDATE 2]',
        'classification: policy_issue',
        'confidence: 0.6',
        'summary: 1 policy/config-related finding(s)',
        'rationale: 1 policy/config-related finding(s)',
        '',
        '[SENSOR CONTEXT]',
        'threshold window narrowed in the last release',
        '',
      ].join('\n'),
    );
  });

  it('omits the sensor-context block instead of sending an undefined one', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'policy_issue', confidence: 0.7 } });

    await tieBreakWithLadder({ first, second, breakerClient: client, timestamp: TIMESTAMP });

    const user = client.calls[0]?.messages.user ?? '';
    expect(user).not.toContain('[SENSOR CONTEXT]');
    expect(user).not.toContain('undefined');
    expect(user).toBe(
      [
        '[CANDIDATE 1]',
        'classification: sensor_error',
        'confidence: 0.9',
        'summary: Sensor itself failed',
        "rationale: Reading status is 'error' on sensor type_check (tsc)",
        '',
        '[CANDIDATE 2]',
        'classification: policy_issue',
        'confidence: 0.6',
        'summary: 1 policy/config-related finding(s)',
        'rationale: 1 policy/config-related finding(s)',
        '',
      ].join('\n'),
    );
  });

  it('sends an empty rationale line when a candidate carries none', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'policy_issue', confidence: 0.7 } });
    await tieBreakWithLadder({
      first: withoutRationale(first),
      second: withoutRationale(second),
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    const lines = (client.calls[0]?.messages.user ?? '').split('\n');
    expect(lines[4]).toBe('rationale: ');
    expect(lines[10]).toBe('rationale: ');
  });

  it('identifies itself and demands deterministic JSON from the breaker', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'policy_issue', confidence: 0.7 } });

    await tieBreakWithLadder({ first, second, breakerClient: client, timestamp: TIMESTAMP });

    expect(client.calls[0]?.meta).toEqual({ caller: 'tieBreakWithLadder' });
    expect(client.calls[0]?.opts).toEqual({
      response_format_json: true,
      temperature: 0,
      max_output_tokens: 512,
    });
  });

  it('spends nothing on the breaker when both candidates already agree', async () => {
    const first = classifyFailure(realReading({ status: 'error', name: 'one' }), TIMESTAMP);
    const second = classifyFailure(realReading({ status: 'error', name: 'two' }), TIMESTAMP);
    const client = recordingBreaker({ json: { classification: 'plant_bug', confidence: 0.99 } });

    const result = await tieBreakWithLadder({ first, second, breakerClient: client });

    expect(client.calls).toEqual([]);
    expect(result.confidence).toEqual({ score: 0.9, method: 'article-23-no-disagreement' });
    expect(result.tie_breaker_invoked).toBe(true);
    expect(result.tie_breaker_evidence_refs).toEqual([second.subject_evidence_ref]);
    expectSchemaConformant(result);
  });
});

describe('Article-23 ladder response handling', () => {
  it('falls back to the text body when json is null', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: null,
      text: JSON.stringify({ classification: 'policy_issue', confidence: 0.8, rationale: 'r' }),
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('policy_issue');
    expect(result.confidence.method).toBe('article-23-cross-family-breaker');
  });

  it('falls back to the text body when json is not an object', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: 'policy_issue',
      text: JSON.stringify({ classification: 'policy_issue', confidence: 0.8 }),
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('policy_issue');
  });

  it('prefers the structured json body over a conflicting text body', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'sensor_error', confidence: 0.99 },
      text: JSON.stringify({ classification: 'policy_issue', confidence: 0.1 }),
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('sensor_error');
  });

  it('escalates when a json array carries no classification', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: [{ classification: 'policy_issue' }] });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('inconclusive');
    expect(result.confidence).toEqual({
      score: 0.5,
      method: 'article-23-cross-family-breaker',
    });
  });

  it('accepts a breaker confidence of exactly zero', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'reference_gap', confidence: 0 } });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('inconclusive');
    expect(result.confidence.score).toBe(0);
    expectSchemaConformant(result);
  });

  it('accepts a breaker confidence of exactly one', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'reference_gap', confidence: 1 } });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.confidence.score).toBe(1);
    expectSchemaConformant(result);
  });

  it('refuses a negative breaker confidence and falls back to the midpoint', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'reference_gap', confidence: -0.5 },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.confidence.score).toBe(0.5);
    expectSchemaConformant(result);
  });

  it('falls back to the midpoint when the breaker omits its confidence', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'reference_gap' } });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.confidence.score).toBe(0.5);
  });
});

describe('Article-23 ladder resolution', () => {
  it('lets the breaker restore the first candidate', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'sensor_error', confidence: 0.95, rationale: 'adapter crashed' },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result).toMatchObject({
      classification: 'sensor_error',
      generated_at: TIMESTAMP,
      confidence: { score: 0.95, method: 'article-23-cross-family-breaker' },
      summary: 'Sensor itself failed',
      tie_breaker_invoked: true,
      tie_breaker_evidence_refs: [second.subject_evidence_ref],
    });
    expect(result.rationale).toBe(
      "Reading status is 'error' on sensor type_check (tsc)" +
        ' | breaker(independent/breaker-fixture): adapter crashed',
    );
    expectSchemaConformant(result);
  });

  it('keeps the winner confidence when the breaker is less certain', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'sensor_error', confidence: 0.2 },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.confidence.score).toBe(0.9);
  });

  it('leaves the winner rationale untouched when the breaker supplies none', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ json: { classification: 'policy_issue', confidence: 0.7 } });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.rationale).toBe(second.rationale);
    expect(result.rationale).not.toContain('breaker(');
  });

  it('still attributes the breaker when the winner has no rationale', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'policy_issue', confidence: 0.7, rationale: 'config drift' },
    });

    const result = await tieBreakWithLadder({
      first,
      second: withoutRationale(second),
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.rationale).toBe(' | breaker(independent/breaker-fixture): config drift');
  });

  it('escalates with a full account when the breaker names a third class', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'reference_gap', confidence: 0.66 },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result).toMatchObject({
      schemaVersion: '1.0.0',
      classification: 'inconclusive',
      generated_at: TIMESTAMP,
      subject_evidence_ref: first.subject_evidence_ref,
      confidence: { score: 0.66, method: 'article-23-cross-family-breaker' },
      summary:
        'Article-23 breaker disagreed with both candidates (chose reference_gap); escalating per Article 19.',
      rationale:
        'breaker(independent/breaker-fixture) chose reference_gap; candidates were sensor_error and policy_issue.',
      recommended_route: { discipline: 'harness_review', action: 'escalate_to_human' },
      tie_breaker_invoked: true,
      tie_breaker_evidence_refs: [first.subject_evidence_ref, second.subject_evidence_ref],
    });
    expectSchemaConformant(result);
  });

  it('carries the breaker rationale into the escalation when one is given', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'reference_gap', confidence: 0.66, rationale: 'no spec exists yet' },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.rationale).toBe('no spec exists yet');
  });
});

describe('Article-23 ladder resource failures', () => {
  it('surfaces a breaker transport failure instead of inventing a verdict', async () => {
    const { first, second } = disagreeingPair();
    const failure = new Error('breaker endpoint unreachable');
    const client = recordingBreaker({ reject: failure });

    await expect(
      tieBreakWithLadder({ first, second, breakerClient: client, timestamp: TIMESTAMP }),
    ).rejects.toBe(failure);
    expect(client.calls).toHaveLength(1);
  });

  it('escalates rather than throwing when the breaker returns no body at all', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ text: '' });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('inconclusive');
    expect(result.confidence.score).toBe(0.5);
    expectSchemaConformant(result);
  });

  it('escalates rather than throwing when the breaker returns truncated JSON', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({ text: '{"classification":"policy_iss' });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('inconclusive');
    expect(result.summary).toContain('chose inconclusive');
  });

  it('escalates when the breaker returns a classification outside the enum', async () => {
    const { first, second } = disagreeingPair();
    const client = recordingBreaker({
      json: { classification: 'PLANT_BUG', confidence: 0.9 },
    });

    const result = await tieBreakWithLadder({
      first,
      second,
      breakerClient: client,
      timestamp: TIMESTAMP,
    });

    expect(result.classification).toBe('inconclusive');
    expect(result.confidence.score).toBe(0.9);
  });
});

describe('Article-23 escalation identity', () => {
  it.each(['error', 'unknown'] as const)(
    'binds the emitted classification when the first reading is %s',
    async (status) => {
      const first = classifyFailure(realReading({ status }), TIMESTAMP);
      const { second } = disagreeingPair();
      const client = recordingBreaker({
        json: { classification: 'reference_gap', confidence: 0.66 },
      });
      const invoke = (timestamp: string) =>
        tieBreakWithLadder({ first, second, breakerClient: client, timestamp });
      const before = structuredClone(first);
      const result = await invoke(TIMESTAMP);
      const expectedId =
        'TRG-' +
        createHash('sha256')
          .update(`${first.subject_evidence_ref}|inconclusive`)
          .digest('hex')
          .slice(0, 16);
      expect(result.classification).toBe('inconclusive');
      expect(result.subject_evidence_ref).toBe(first.subject_evidence_ref);
      expect(result.id).toBe(expectedId);
      if (status === 'error') expect(result.id).not.toBe(first.id);
      else expect(result.id).toBe(first.id);
      expect(first).toEqual(before);
      expect((await invoke('2027-01-01T00:00:00.000Z')).id).toBe(result.id);
      expectSchemaConformant(result);
    },
  );
});
