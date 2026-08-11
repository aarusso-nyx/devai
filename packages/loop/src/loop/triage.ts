import { createHash } from 'node:crypto';
import type { SensorReading, SensorFinding } from '@devai-nyx/sensors';

/** Classification enum (schema-conformant, underscored). */
export type TriageClass =
  'plant_bug' | 'sensor_error' | 'policy_issue' | 'reference_gap' | 'inconclusive';

/** Discipline enum from triage.schema.json#recommended_route. */
export type Discipline =
  'engineer' | 'inspector' | 'auditor' | 'architect' | 'owner' | 'harness_review';

/** Action enum from triage.schema.json#recommended_route. */
export type Action =
  | 'feedback_iteration'
  | 'fix_test'
  | 'fix_sensor_adapter'
  | 'review_policy'
  | 'review_thresholds'
  | 'emit_rgr'
  | 'escalate_to_human';

/**
 * Schema-conformant TriageVerdict. Mirrors triage.schema.json exactly
 * (additionalProperties: false). Use `dispatchFor(verdict)` to project
 * onto a DispatchTarget for CLI human output.
 */
export interface TriageVerdict {
  readonly schemaVersion: '1.0.0';
  readonly id: string; // TRG-[16hex]
  readonly generated_at: string; // ISO-8601
  readonly subject_evidence_ref: string; // EV-...
  readonly subject_task_id?: string | null;
  readonly classification: TriageClass;
  readonly confidence: { readonly score: number; readonly method?: string };
  readonly invariants_impacted?: readonly string[];
  readonly summary: string;
  readonly rationale?: string;
  readonly recommended_route: {
    readonly discipline: Discipline;
    readonly action?: Action;
    readonly priority?: number;
  };
  readonly tie_breaker_invoked?: boolean;
  readonly tie_breaker_evidence_refs?: readonly string[];
}

/**
 * Build the deterministic TRG- id from the canonical fields. Two
 * classifications of the same evidence with the same classification
 * collide intentionally (idempotent re-classification).
 */
function triageId(evidenceRef: string, classification: TriageClass): string {
  const digest = createHash('sha256').update(`${evidenceRef}|${classification}`).digest('hex');
  return `TRG-${digest.slice(0, 16)}`;
}

const DISPATCH_TABLE: Readonly<Record<TriageClass, { discipline: Discipline; action: Action }>> = {
  plant_bug: { discipline: 'engineer', action: 'feedback_iteration' },
  sensor_error: { discipline: 'inspector', action: 'fix_sensor_adapter' },
  policy_issue: { discipline: 'harness_review', action: 'review_policy' },
  reference_gap: { discipline: 'architect', action: 'emit_rgr' },
  inconclusive: { discipline: 'harness_review', action: 'escalate_to_human' },
};

/**
 * Rule-based triage classifier (Phase-6 MVP, Article 15). Returns a
 * schema-conformant TriageVerdict.
 *
 * Rules:
 *   - reading.status === 'error' → sensor_error
 *   - sensor.kind === 'llm_judge' && status === 'unknown' → policy_issue
 *   - finding messages reference invariants/specs → reference_gap
 *   - finding codes look policy-like → policy_issue
 *   - default, with strong error signals → plant_bug
 *   - default, no signal → inconclusive
 */
export function classifyFailure(reading: SensorReading, timestamp?: string): TriageVerdict {
  const generatedAt = timestamp ?? new Date().toISOString();
  const findings = reading.findings ?? [];
  const evidenceRef = reading.id.startsWith('SR-')
    ? `EV-${reading.id.slice(3)}`
    : reading.id.startsWith('EV-')
      ? reading.id
      : `EV-${reading.id}`;

  let classification: TriageClass;
  let score: number;
  let summary: string;
  let rationale: string;

  if (reading.status === 'error') {
    classification = 'sensor_error';
    score = 0.9;
    summary = 'Sensor itself failed';
    rationale = `Reading status is 'error' on sensor ${reading.sensor.kind} (${reading.sensor.name})`;
  } else if (reading.sensor.kind === 'llm_judge' && reading.status === 'unknown') {
    classification = 'policy_issue';
    score = 0.4;
    summary = 'llm_judge returned unknown';
    rationale = 'Possible rubric mismatch or insufficient evidence';
  } else {
    const referenceGapPatterns = /invariant|undefined|missing.*spec|no spec|spec.*missing/i;
    const policyPatterns = /config|threshold|policy/i;
    let refHits = 0;
    let plantHits = 0;
    let policyHits = 0;
    for (const f of findings) {
      if (
        referenceGapPatterns.test(f.message) ||
        f.code === 'untraced_invariant' ||
        f.code === 'unresolved_invariant'
      ) {
        refHits++;
      } else if (policyPatterns.test(f.message) || f.code.startsWith('policy.')) {
        policyHits++;
      } else if (f.severity === 'error' || f.severity === 'critical') {
        plantHits++;
      }
    }
    if (refHits > 0 && refHits >= plantHits) {
      classification = 'reference_gap';
      score = Math.min(0.95, 0.5 + refHits * 0.1);
      summary = `${String(refHits)} finding(s) reference specification gaps`;
      rationale = summary;
    } else if (policyHits > plantHits && policyHits > 0) {
      classification = 'policy_issue';
      score = 0.6;
      summary = `${String(policyHits)} policy/config-related finding(s)`;
      rationale = summary;
    } else if (plantHits > 0) {
      classification = 'plant_bug';
      score = Math.min(0.9, 0.4 + plantHits * 0.05);
      summary = `${String(plantHits)} code-level error finding(s)`;
      rationale = summary;
    } else {
      classification = 'inconclusive';
      score = 0.3;
      summary = 'No strong signal in findings';
      rationale = 'Default classification — fall back to tie-breaker ladder';
    }
  }

  const route = DISPATCH_TABLE[classification];
  const invariants_impacted = findings
    .map((f) => f.invariant_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  const verdict: TriageVerdict = {
    schemaVersion: '1.0.0',
    id: triageId(evidenceRef, classification),
    generated_at: generatedAt,
    subject_evidence_ref: evidenceRef,
    classification,
    confidence: { score, method: 'rule-based-mvp' },
    summary,
    rationale,
    recommended_route: { discipline: route.discipline, action: route.action },
    ...(invariants_impacted.length > 0 && { invariants_impacted }),
  };
  return verdict;
}

export interface TieBreakOptions {
  readonly first: TriageVerdict;
  readonly second: TriageVerdict;
}

/**
 * Synchronous fallback tie-break. Use this when no cross-family
 * breaker is available. The result is honest about the gap: on
 * disagreement, `confidence.method` becomes
 * `mvp-fallback-not-article-23` and the score is downgraded to the
 * mean per Article 39. Same-classification inputs preserve the
 * winner's confidence and just set tie_breaker_invoked.
 *
 * Phase-9 / Batch 9.F adds `tieBreakWithLadder` for the real
 * Article-23 cross-family flow. CLI defaults to that when a breaker
 * client is available; falls back to this when not.
 */
export function tieBreak(opts: TieBreakOptions): TriageVerdict {
  const sameClass = opts.first.classification === opts.second.classification;
  const winner = sameClass
    ? opts.first
    : opts.first.confidence.score >= opts.second.confidence.score
      ? opts.first
      : opts.second;
  const loser = winner === opts.first ? opts.second : opts.first;
  const downgraded = !sameClass
    ? {
        score: (opts.first.confidence.score + opts.second.confidence.score) / 2,
        method: 'mvp-fallback-not-article-23',
      }
    : winner.confidence;
  return {
    ...winner,
    confidence: downgraded,
    tie_breaker_invoked: true,
    tie_breaker_evidence_refs: [loser.subject_evidence_ref],
  };
}

// =====================================================================
// Article-23 cross-family ladder (Batch 9.F)
// =====================================================================

/**
 * Minimal structural type matching the production LlmClient from
 * the higher-layer skills/LLM package. Defined locally so loop has no upward edge
 * concern.
 */
export interface BreakerClient {
  readonly family: string;
  readonly model: string;
  complete(
    messages: { readonly system: string; readonly user: string },
    meta: {
      readonly caller?: string;
      readonly prompt_pc_id?: string;
      readonly stack_sha256?: string;
    },
    opts?: {
      readonly response_format_json?: boolean;
      readonly temperature?: number;
      readonly max_output_tokens?: number;
    },
  ): Promise<{
    readonly text: string;
    readonly family: string;
    readonly model: string;
    readonly usage: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cost_usd: number;
    };
    readonly latency_ms: number;
    readonly json?: unknown;
  }>;
}

export interface TieBreakLadderOptions extends TieBreakOptions {
  readonly breakerClient: BreakerClient;
  /**
   * Optional context the breaker should see. Typically the source
   * SensorReading's findings as a flat string. When omitted, the
   * breaker decides on the two summaries alone.
   */
  readonly sensorContext?: string;
  readonly timestamp?: string;
}

interface BreakerResponse {
  readonly classification?: string;
  readonly confidence?: number;
  readonly rationale?: string;
}

const VALID_CLASSIFICATIONS: ReadonlySet<TriageClass> = new Set([
  'plant_bug',
  'sensor_error',
  'policy_issue',
  'reference_gap',
  'inconclusive',
]);

/**
 * Article-23 cross-family tie-breaker.
 *
 *   - Same-classification inputs: the breaker is NOT called (no
 *     disagreement to resolve). Returns the winner with
 *     `confidence.method = 'article-23-no-disagreement'`.
 *   - Different classifications: invoke breakerClient with a prompt
 *     containing both verdicts + the original sensor context.
 *     Require structured JSON output { classification, confidence,
 *     rationale }.
 *     - Breaker agrees with one of the two → that side wins.
 *     - Breaker disagrees with both → returns 'inconclusive' with
 *       recommended_route.action = 'escalate_to_human' (Article 19).
 *
 * The caller is responsible for picking a breakerClient whose family
 * is DIFFERENT from the higher-confidence input. (Picking the right
 * family is a Phase-10 auto-inference concern; for MVP, the CLI's
 * `--breaker-family` flag lets the operator specify.)
 *
 * Returned verdict carries confidence.method `article-23-cross-family-
 * breaker` so downstream consumers can identify real-ladder runs.
 */
export async function tieBreakWithLadder(opts: TieBreakLadderOptions): Promise<TriageVerdict> {
  const sameClass = opts.first.classification === opts.second.classification;
  if (sameClass) {
    return {
      ...opts.first,
      confidence: { ...opts.first.confidence, method: 'article-23-no-disagreement' },
      tie_breaker_invoked: true,
      tie_breaker_evidence_refs: [opts.second.subject_evidence_ref],
    };
  }
  const system = [
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
  const user = [
    '[CANDIDATE 1]',
    `classification: ${opts.first.classification}`,
    `confidence: ${String(opts.first.confidence.score)}`,
    `summary: ${opts.first.summary}`,
    `rationale: ${opts.first.rationale ?? ''}`,
    '',
    '[CANDIDATE 2]',
    `classification: ${opts.second.classification}`,
    `confidence: ${String(opts.second.confidence.score)}`,
    `summary: ${opts.second.summary}`,
    `rationale: ${opts.second.rationale ?? ''}`,
    '',
    ...(opts.sensorContext !== undefined ? ['[SENSOR CONTEXT]', opts.sensorContext, ''] : []),
  ].join('\n');

  const response = await opts.breakerClient.complete(
    { system, user },
    { caller: 'tieBreakWithLadder' },
    { response_format_json: true, temperature: 0.0, max_output_tokens: 512 },
  );
  let parsed: BreakerResponse | null = null;
  if (response.json !== undefined && response.json !== null && typeof response.json === 'object') {
    parsed = response.json as BreakerResponse;
  } else {
    try {
      parsed = JSON.parse(response.text) as BreakerResponse;
    } catch {
      parsed = null;
    }
  }
  const breakerClass =
    parsed !== null &&
    typeof parsed.classification === 'string' &&
    VALID_CLASSIFICATIONS.has(parsed.classification as TriageClass)
      ? (parsed.classification as TriageClass)
      : 'inconclusive';
  const breakerScore =
    parsed !== null &&
    typeof parsed.confidence === 'number' &&
    parsed.confidence >= 0 &&
    parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;

  // The breaker's own classification is now the resolution.
  // - If it matches one of the inputs, that input "wins" (preserving its rationale).
  // - If it doesn't, we return an 'inconclusive' verdict that routes to escalate_to_human.
  const matchesFirst = breakerClass === opts.first.classification;
  const matchesSecond = breakerClass === opts.second.classification;
  const generatedAt = opts.timestamp ?? new Date().toISOString();

  if (matchesFirst || matchesSecond) {
    const winner = matchesFirst ? opts.first : opts.second;
    const loser = matchesFirst ? opts.second : opts.first;
    return {
      ...winner,
      generated_at: generatedAt,
      confidence: {
        score: Math.max(winner.confidence.score, breakerScore),
        method: 'article-23-cross-family-breaker',
      },
      summary: winner.summary,
      rationale:
        parsed?.rationale !== undefined
          ? `${winner.rationale ?? ''} | breaker(${opts.breakerClient.family}/${opts.breakerClient.model}): ${parsed.rationale}`
          : winner.rationale,
      tie_breaker_invoked: true,
      tie_breaker_evidence_refs: [loser.subject_evidence_ref],
    };
  }
  // Inconclusive — escalate.
  return {
    schemaVersion: '1.0.0',
    id: opts.first.id,
    generated_at: generatedAt,
    subject_evidence_ref: opts.first.subject_evidence_ref,
    classification: 'inconclusive',
    confidence: { score: breakerScore, method: 'article-23-cross-family-breaker' },
    summary: `Article-23 breaker disagreed with both candidates (chose ${breakerClass}); escalating per Article 19.`,
    rationale:
      parsed?.rationale ??
      `breaker(${opts.breakerClient.family}/${opts.breakerClient.model}) chose ${breakerClass}; candidates were ${opts.first.classification} and ${opts.second.classification}.`,
    recommended_route: { discipline: 'harness_review', action: 'escalate_to_human' },
    tie_breaker_invoked: true,
    tie_breaker_evidence_refs: [opts.first.subject_evidence_ref, opts.second.subject_evidence_ref],
  };
}

export interface DispatchTarget {
  readonly classification: TriageClass;
  readonly discipline: Discipline;
  readonly action: Action;
}

export function dispatchFor(verdict: TriageVerdict): DispatchTarget {
  return {
    classification: verdict.classification,
    discipline: verdict.recommended_route.discipline,
    action: verdict.recommended_route.action ?? DISPATCH_TABLE[verdict.classification].action,
  };
}

/** Extract findings without optional fields, useful for compact diffs. */
export function findingsKey(findings: readonly SensorFinding[]): string {
  return findings
    .map((f) => `${f.severity}:${f.code}:${f.message}`)
    .sort()
    .join('|');
}
