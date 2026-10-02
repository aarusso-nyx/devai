import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getValidator, validators } from '@devai-nyx/schemas';
import { buildSensorReading } from '@devai-nyx/sensors';
import {
  classifyFailure,
  tieBreakWithLadder,
  type BreakerClient,
  type TriageVerdict,
} from '../src/loop/triage.js';

/**
 * ADR-MDL-0001 for the Article 23 tie-breaker. The breaker reply is read through
 * the one shared extractor against `triage-breaker.schema.json`:
 *
 *   - prose around exactly one valid vote resolves the disagreement, so a
 *     formatting accident no longer escalates;
 *   - an invalid vote, a review-verdict-shaped document, two conflicting votes, a
 *     `length` finish, or a provider error is an extractor error: the ladder
 *     escalates to a human (Article 19) and the escalation rationale keeps the
 *     SHA-256 of the full reply and only a bounded excerpt of it;
 *   - the breaker request names the consumer schema (`response_schema`).
 */

// Activated before any bridge/SDK import and retained through suite teardown.
// This is native denial, independent of vi mocks and per-test restoration.
const offlineGuard = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const attempts: string[] = [];
  const retained: { object: object; key: string; descriptor: PropertyDescriptor | undefined }[] =
    [];
  const deny = (surface: string): never => {
    attempts.push(surface);
    throw new Error(`OFFLINE_TEST_EFFECT_FORBIDDEN:${surface}`);
  };
  const block = (object: object, key: string, surface: string) => {
    retained.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key) });
    Object.defineProperty(object, key, {
      configurable: true,
      writable: true,
      value: () => deny(surface),
    });
  };
  block(globalThis, 'fetch', 'fetch');
  for (const [object, name] of [
    [http, 'http'],
    [https, 'https'],
  ] as const) {
    block(object, 'request', `${name}.request`);
    block(object, 'get', `${name}.get`);
  }
  block(net.Socket.prototype, 'connect', 'socket.connect');
  block(tls, 'connect', 'tls.connect');
  for (const key of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ]) {
    block(childProcess, key, `child_process.${key}`);
  }
  block(childProcess.ChildProcess.prototype, 'spawn', 'ChildProcess.spawn');
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const { object, key, descriptor } of retained.reverse()) {
        if (descriptor === undefined) Reflect.deleteProperty(object, key);
        else Object.defineProperty(object, key, descriptor);
      }
      syncBuiltinESMExports();
    },
  };
});

afterEach(() => {
  // Surface names only: never print SDK headers, credentials or request bodies.
  expect(offlineGuard.attempts).toEqual([]);
});
afterAll(() => {
  offlineGuard.restore();
  expect(offlineGuard.attempts).toEqual([]);
});

const TIMESTAMP = '2026-09-29T00:00:00.000Z';
const SCHEMA = 'triage-breaker.schema.json';
const EXCERPT_CEILING = 4096;

type FinishReason = 'stop' | 'length' | 'tool_use' | 'error';

interface Reply {
  readonly text: string;
  readonly json?: unknown;
  readonly finish_reason?: FinishReason;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function breaker(reply: Reply): BreakerClient & { readonly options: unknown[] } {
  const options: unknown[] = [];
  const client = {
    options,
    family: 'independent',
    model: 'breaker-fixture',
    complete(_messages: unknown, _meta: unknown, opts?: unknown) {
      options.push(opts);
      return Promise.resolve({
        family: 'independent',
        model: 'breaker-fixture',
        usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.0001 },
        latency_ms: 42,
        finish_reason: 'stop' as FinishReason,
        ...reply,
      });
    },
  };
  return client as unknown as BreakerClient & { readonly options: unknown[] };
}

/** first: sensor_error at 0.9; second: policy_issue at 0.6. */
function disagreeingPair(): { first: TriageVerdict; second: TriageVerdict } {
  const first = classifyFailure(
    buildSensorReading({
      sensorName: 'tsc',
      sensorKind: 'type_check',
      command: ['pnpm', 'run', 'typecheck'],
      status: 'error',
      deterministic: true,
      timestamp: TIMESTAMP,
    }),
    TIMESTAMP,
  );
  const second = classifyFailure(
    buildSensorReading({
      sensorName: 'limits',
      sensorKind: 'unit_test',
      command: ['pnpm', 'run', 'test'],
      status: 'fail',
      deterministic: true,
      timestamp: TIMESTAMP,
      findings: [
        { severity: 'warning', code: 'limits.window', message: 'threshold window too narrow' },
      ],
    }),
    TIMESTAMP,
  );
  expect(first.classification).toBe('sensor_error');
  expect(second.classification).toBe('policy_issue');
  return { first, second };
}

const VOTE_SECOND = {
  classification: 'policy_issue',
  confidence: 0.85,
  rationale: 'The finding names a threshold window.',
};

async function ladder(reply: Reply): Promise<TriageVerdict> {
  const { first, second } = disagreeingPair();
  return tieBreakWithLadder({
    first,
    second,
    breakerClient: breaker(reply),
    timestamp: TIMESTAMP,
  });
}

async function expectEscalationWithDigest(reply: Reply): Promise<TriageVerdict> {
  const verdict = await ladder(reply);
  expect(verdict).toMatchObject({
    classification: 'inconclusive',
    recommended_route: { discipline: 'harness_review', action: 'escalate_to_human' },
    tie_breaker_invoked: true,
  });
  expect(verdict.rationale ?? '').toContain(sha256(reply.text));
  expect(validators.triage(verdict)).toBe(true);
  return verdict;
}

describe('triage-breaker.schema.json through getValidator', () => {
  const validate = getValidator(SCHEMA as never);

  it('accepts a complete vote, including an inconclusive one', () => {
    expect(validate(VOTE_SECOND)).toBe(true);
    expect(validate({ classification: 'inconclusive', confidence: 0, rationale: 'r' })).toBe(true);
  });

  it.each([
    ['a review verdict document', { verdict: 'pass', confidence: 0.9, rationale: 'r' }],
    ['a missing rationale', { classification: 'plant_bug', confidence: 0.9 }],
    ['an empty rationale', { classification: 'plant_bug', confidence: 0.9, rationale: '' }],
    ['a classification outside the enum', { ...VOTE_SECOND, classification: 'maybe' }],
    ['a confidence above one', { ...VOTE_SECOND, confidence: 1.2 }],
    ['a negative confidence', { ...VOTE_SECOND, confidence: -0.1 }],
    ['a score object instead of a number', { ...VOTE_SECOND, confidence: { score: 0.8 } }],
    ['an extra member', { ...VOTE_SECOND, verdict: 'pass' }],
  ])('refuses %s', (_label, document) => {
    expect(validate(document)).toBe(false);
  });
});

describe('the ladder reads its vote through the shared extractor', () => {
  it('asks the breaker for the triage-breaker schema (IA-006)', async () => {
    const { first, second } = disagreeingPair();
    const client = breaker({ text: JSON.stringify(VOTE_SECOND) });
    await tieBreakWithLadder({ first, second, breakerClient: client, timestamp: TIMESTAMP });
    expect(client.options).toHaveLength(1);
    expect(client.options[0]).toMatchObject({ temperature: 0, response_schema: SCHEMA });
  });

  it('resolves to the matching candidate from a bare vote', async () => {
    const { second } = disagreeingPair();
    const verdict = await ladder({ text: JSON.stringify(VOTE_SECOND) });
    expect(verdict).toMatchObject({
      classification: 'policy_issue',
      id: second.id,
      confidence: { score: 0.85, method: 'article-23-cross-family-breaker' },
    });
  });

  it('resolves from an unfenced vote after prose instead of escalating', async () => {
    const verdict = await ladder({
      text: `Having weighed both candidates, my vote is ${JSON.stringify(VOTE_SECOND)}.`,
    });
    expect(verdict).toMatchObject({
      classification: 'policy_issue',
      confidence: { method: 'article-23-cross-family-breaker' },
    });
    expect(verdict.rationale).toContain('The finding names a threshold window.');
  });

  it('resolves from a fenced vote between prose paragraphs', async () => {
    const verdict = await ladder({
      text: [
        'Here is my independent vote.',
        '```json',
        JSON.stringify(VOTE_SECOND, null, 2),
        '```',
        'Escalate if you disagree.',
      ].join('\n'),
    });
    expect(verdict.classification).toBe('policy_issue');
  });

  it('keeps an explicit inconclusive vote as an escalation', async () => {
    const vote = { classification: 'inconclusive', confidence: 0.3, rationale: 'even split' };
    const verdict = await ladder({ text: JSON.stringify(vote) });
    expect(verdict).toMatchObject({
      classification: 'inconclusive',
      recommended_route: { action: 'escalate_to_human' },
      rationale: 'even split',
    });
  });
});

describe('an extractor error escalates and keeps the reply digest', () => {
  it('refuses a review verdict document as a vote (IA-005)', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify({ verdict: 'pass', confidence: 0.95, rationale: 'looks fine' }),
    });
  });

  it('refuses a vote outside the classification enum', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify({ ...VOTE_SECOND, classification: 'maybe' }),
    });
  });

  it('refuses a vote without a rationale instead of defaulting it', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify({ classification: 'policy_issue', confidence: 0.8 }),
    });
  });

  it('refuses an out-of-range confidence instead of substituting the midpoint', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify({ ...VOTE_SECOND, confidence: -0.5 }),
    });
  });

  it('refuses an invalid structured json field even beside a valid text vote', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify(VOTE_SECOND),
      json: { classification: 'policy_issue', confidence: 2, rationale: 'r' },
    });
  });

  it('refuses two conflicting votes rather than taking the first (IA-003)', async () => {
    const other = { ...VOTE_SECOND, classification: 'sensor_error' };
    await expectEscalationWithDigest({
      text: `${JSON.stringify(other)}\nActually: ${JSON.stringify(VOTE_SECOND)}`,
    });
  });

  it('refuses a length finish even around a valid vote (IA-004)', async () => {
    await expectEscalationWithDigest({
      text: JSON.stringify(VOTE_SECOND),
      finish_reason: 'length',
    });
  });

  it('refuses a provider error finish', async () => {
    await expectEscalationWithDigest({ text: JSON.stringify(VOTE_SECOND), finish_reason: 'error' });
  });

  it('refuses prose with no vote', async () => {
    await expectEscalationWithDigest({ text: 'I think the first candidate is probably right.' });
  });

  it('keeps only a bounded excerpt of a very long reply', async () => {
    const text = `${'The breaker deliberates. '.repeat(4000)}{"classification":"maybe"}`;
    const verdict = await expectEscalationWithDigest({ text });
    const rationale = verdict.rationale ?? '';
    expect(rationale.length).toBeLessThan(text.length);
    expect(rationale.length).toBeLessThanOrEqual(EXCERPT_CEILING + 1024);
  });
});
