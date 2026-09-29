import { extractStructuredReply } from '@devai-nyx/schemas';
import {
  buildSensorReading,
  type FindingSeverity,
  type SensorFinding,
  type SensorReading,
} from './sensor-reading.js';

/**
 * Phase-9: structural type matching the production LlmClient from
 * the downstream LLM package. Sensors can't depend on core (core depends on
 * sensors), so we declare the minimal interface we need here and rely
 * on structural typing to accept the real client.
 */
export interface JudgeLlmClient {
  readonly family: string;
  readonly model: string;
  complete(
    messages: { readonly system: string; readonly user: string },
    meta: {
      readonly prompt_pc_id?: string;
      readonly stack_sha256?: string;
      readonly caller?: string;
    },
    opts?: {
      readonly max_output_tokens?: number;
      readonly temperature?: number;
      readonly response_format_json?: boolean;
      readonly response_schema?: 'review-verdict.schema.json';
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
    readonly finish_reason: 'stop' | 'length' | 'tool_use' | 'error';
    readonly latency_ms: number;
    readonly json?: unknown;
  }>;
}

export interface JudgeOptions {
  /** Aspect identifier, e.g. `coherence`, `idiomaticity`, `test_depth`. */
  readonly aspect: string;
  /** Rubric body. Required: tells the model what to evaluate against. */
  readonly rubric: string;
  /** Evidence text — the content being judged. Required. */
  readonly evidence: string;
  /** Path the evidence came from (recorded on the reading). */
  readonly evidencePath?: string;
  /** PromptComposition metadata for audit telemetry. */
  readonly prompt_pc_id?: string;
  readonly stack_sha256?: string;
}

/** The review-verdict.schema.json document, as the extractor returns it validated. */
interface ReviewVerdict {
  readonly verdict: 'pass' | 'review' | 'fail' | 'unknown';
  readonly confidence: number;
  readonly rationale: string;
  readonly findings?: ReadonlyArray<{
    readonly severity: FindingSeverity;
    readonly code: string;
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
  }>;
}

/**
 * Soft-gate LLM evaluator with an LLM-backed
 * implementation. The caller supplies an `LlmClient` instance (mock
 * in tests, Anthropic/Codex in production) and the rubric body; the
 * judge instructs the model to emit a structured verdict, parses it,
 * and returns a SensorReading.
 *
 * Determinism: false (LLM is stochastic). Cost telemetry: recorded
 * via the LlmClient telemetry wrapper. The sensor's `version` field
 * records the exact host-reported runtime identity so consumers can
 * identify which provider execution produced the verdict.
 */
export async function senseJudge(
  opts: JudgeOptions,
  client: JudgeLlmClient,
): Promise<SensorReading> {
  const command = ['devai', 'sense', 'judge', opts.aspect];
  const system = [
    'You are a DEVAI soft-gate evaluator. Your job is to apply the rubric below to the evidence and emit a single JSON verdict.',
    '',
    '[RUBRIC]',
    opts.rubric,
    '',
    '[OUTPUT FORMAT]',
    '{',
    '  "verdict": "pass" | "review" | "fail" | "unknown",',
    '  "confidence": number in [0,1],',
    '  "rationale": "short prose justification",',
    '  "findings": [ { "severity": "info|warning|error|critical", "code": "...", "message": "..." } ]',
    '}',
    '',
    'Return ONLY the JSON object. No markdown fences, no prose.',
  ].join('\n');
  const meta: Parameters<JudgeLlmClient['complete']>[1] = { caller: 'sense judge' };
  if (opts.prompt_pc_id !== undefined) {
    (meta as Record<string, unknown>).prompt_pc_id = opts.prompt_pc_id;
  }
  if (opts.stack_sha256 !== undefined) {
    (meta as Record<string, unknown>).stack_sha256 = opts.stack_sha256;
  }
  const response = await client.complete({ system, user: opts.evidence }, meta, {
    temperature: 0.0,
    response_schema: 'review-verdict.schema.json',
  });
  // ADR-MDL-0001: one shared extractor, validated against review-verdict.schema.json.
  // A failure is an error reading with a bounded redacted excerpt and the reply digest;
  // `unknown` is only the model's explicit uncertainty, never a parse fallback.
  const extracted = extractStructuredReply(response, 'review-verdict.schema.json');
  if (!extracted.ok) {
    return buildSensorReading({
      sensorName: `judge.${opts.aspect}`,
      sensorKind: 'llm_judge',
      sensorVersion: `${response.family}:${response.model}`,
      command,
      status: 'error',
      deterministic: false,
      ...(opts.evidencePath !== undefined && { evidence_path: opts.evidencePath }),
      findings: [
        {
          severity: 'critical',
          code: 'judge_invalid_response',
          message: `LLM reply rejected (${extracted.error.code}): ${extracted.error.message}`,
        },
      ],
      metrics: {
        aspect_label: opts.aspect,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: response.usage.cost_usd,
        latency_ms: response.latency_ms,
        reply_sha256: extracted.error.reply_sha256,
        reply_excerpt: extracted.error.excerpt,
      },
    });
  }
  const parsed = extracted.document as unknown as ReviewVerdict;
  const verdict = parsed.verdict;
  const findings: SensorFinding[] = [
    { severity: 'info', code: 'rationale', message: parsed.rationale },
    ...(parsed.findings ?? []).map((f) => ({
      severity: f.severity,
      code: f.code,
      message: f.message,
      ...(f.file !== undefined && { file: f.file }),
      ...(f.line !== undefined && { line: f.line }),
    })),
  ];
  return buildSensorReading({
    sensorName: `judge.${opts.aspect}`,
    sensorKind: 'llm_judge',
    sensorVersion: `${response.family}:${response.model}`,
    command,
    status: verdict,
    deterministic: false,
    ...(opts.evidencePath !== undefined && { evidence_path: opts.evidencePath }),
    findings,
    metrics: {
      aspect_label: opts.aspect,
      confidence: parsed.confidence,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: response.usage.cost_usd,
      latency_ms: response.latency_ms,
    },
  });
}
