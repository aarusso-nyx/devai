import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROSTER, getValidator } from '@devai-nyx/schemas';

/**
 * ADR-MDL-0001 inspector acceptance for the one shared extractor of the model
 * bridge. The extractor lives at `packages/skills/src/model-bridge/extract.ts` and
 * exports `extractStructuredReply` and the excerpt bound `REPLY_EXCERPT_MAX_CHARS`
 * (the ADR names neither, so these names are the Inspector's contract).
 *
 * Contract pinned here:
 *
 *   extractStructuredReply(reply, schema) where
 *     reply  = { text: string; json?: unknown; finish_reason?: 'stop' | 'length' | 'tool_use' | 'error' }
 *     schema = 'review-verdict.schema.json' | 'triage-breaker.schema.json'
 *   returns
 *     { ok: true; document }                                   -- validated by getValidator(schema)
 *     { ok: false; error: { code, message, excerpt, reply_sha256 } }
 *
 *   error codes: reply_provider_error, reply_truncated, reply_invalid,
 *                reply_ambiguous, reply_no_document
 *
 * The bridge half (IA-004, IA-006) is pinned through `createModelBridge` with the
 * call option `response_schema` naming the consumer's schema.
 */

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawnSync: spawnSyncMock,
}));

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

const { extractStructuredReply, REPLY_EXCERPT_MAX_CHARS } =
  await import('../../src/model-bridge/extract.js');
const { createModelBridge } = await import('../../src/model-bridge/index.js');

const REVIEW = 'review-verdict.schema.json';
const TRIAGE = 'triage-breaker.schema.json';

type Extracted =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly excerpt: string;
        readonly reply_sha256: string;
      };
    };

function extract(
  reply: { text: string; json?: unknown; finish_reason?: string },
  schema: string = REVIEW,
): Extracted {
  return extractStructuredReply(reply as never, schema as never) as Extracted;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const PASS = {
  verdict: 'pass',
  confidence: 0.91,
  rationale: 'Every acceptance command reads as measured.',
  findings: [],
};
const PASS_TEXT = JSON.stringify(PASS);
const TRIAGE_VOTE = {
  classification: 'plant_bug',
  confidence: 0.8,
  rationale: 'Assertion failures in product code.',
};

function expectOk(result: Extracted, document: Record<string, unknown>): void {
  expect(result).toEqual({ ok: true, document });
}

function expectError(result: Extracted, reply: string, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result).not.toHaveProperty('document');
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
  expect(result.error.reply_sha256).toBe(sha256(reply));
  expect(result.error.reply_sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(typeof result.error.excerpt).toBe('string');
  expect(result.error.excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_CHARS);
}

describe('reply contract registration', () => {
  it('registers both reply schemas in the governed roster so getValidator reaches them', () => {
    expect(ROSTER).toContain(REVIEW);
    expect(ROSTER).toContain(TRIAGE);
    expect(getValidator(REVIEW as never)(PASS)).toBe(true);
    expect(getValidator(TRIAGE as never)(TRIAGE_VOTE)).toBe(true);
  });

  it('declares a positive integer excerpt bound small enough to be a bound', () => {
    expect(Number.isInteger(REPLY_EXCERPT_MAX_CHARS)).toBe(true);
    expect(REPLY_EXCERPT_MAX_CHARS).toBeGreaterThan(0);
    expect(REPLY_EXCERPT_MAX_CHARS).toBeLessThanOrEqual(4096);
  });
});

describe('IA-001 prose around exactly one valid document yields the document', () => {
  it('reads a bare document', () => {
    expectOk(extract({ text: PASS_TEXT, finish_reason: 'stop' }), PASS);
  });

  it('reads an unfenced document after conversational prose', () => {
    const text = `Here is my assessment: ${PASS_TEXT}`;
    expectOk(extract({ text, finish_reason: 'stop' }), PASS);
  });

  it('reads a fenced document between prose paragraphs', () => {
    const text = [
      'Here is my assessment',
      '',
      '```json',
      JSON.stringify(PASS, null, 2),
      '```',
      '',
      'Let me know if you need more detail.',
    ].join('\n');
    expectOk(extract({ text, finish_reason: 'stop' }), PASS);
  });

  it('reads a fence without a language tag', () => {
    const text = `Verdict follows.\n\`\`\`\n${PASS_TEXT}\n\`\`\``;
    expectOk(extract({ text, finish_reason: 'stop' }), PASS);
  });

  it('does not count nested finding objects or braces inside strings as extra candidates', () => {
    const document = {
      verdict: 'review',
      confidence: 0.5,
      rationale: 'The template literal `${x}` and the object {a: 1} in the diff need a look.',
      findings: [
        { severity: 'warning', code: 'brace_text', message: 'A "}" inside a string.', line: 3 },
        { severity: 'info', code: 'second', message: 'Nested object two.', file: 'src/a.ts' },
      ],
    };
    const text = `After reading the diff: ${JSON.stringify(document)} That is all.`;
    expectOk(extract({ text, finish_reason: 'stop' }), document);
  });

  it('keeps an explicit unknown verdict, the Article 39 uncertainty, as a document', () => {
    const document = { verdict: 'unknown', confidence: 0.2, rationale: 'Output not attached.' };
    expectOk(extract({ text: JSON.stringify(document), finish_reason: 'stop' }), document);
  });

  it('reads a triage vote wrapped in prose against the triage schema', () => {
    const text = `My independent vote:\n\`\`\`json\n${JSON.stringify(TRIAGE_VOTE)}\n\`\`\``;
    expectOk(extract({ text, finish_reason: 'stop' }, TRIAGE), TRIAGE_VOTE);
  });
});

describe('the provider json field is validated too', () => {
  it('takes a valid json field over a prose text body', () => {
    expectOk(
      extract({ text: 'Structured output returned.', json: PASS, finish_reason: 'stop' }),
      PASS,
    );
  });

  it('refuses an invalid json field and never falls back to a valid text body', () => {
    const json = { verdict: 'maybe', confidence: 0.5, rationale: 'r' };
    expectError(
      extract({ text: PASS_TEXT, json, finish_reason: 'stop' }),
      PASS_TEXT,
      'reply_invalid',
    );
  });

  it('refuses a json field shaped as the other consumer document', () => {
    expectError(
      extract({ text: PASS_TEXT, json: TRIAGE_VOTE, finish_reason: 'stop' }),
      PASS_TEXT,
      'reply_invalid',
    );
  });

  it('falls back to the text path when the json field is absent or null', () => {
    expectOk(extract({ text: `Result: ${PASS_TEXT}`, finish_reason: 'stop' }), PASS);
    expectOk(extract({ text: `Result: ${PASS_TEXT}`, json: null, finish_reason: 'stop' }), PASS);
  });
});

describe('IA-002 an invalid document is an error with an excerpt and the reply digest', () => {
  it('refuses a verdict outside the enum rather than reading it as unknown', () => {
    const text = 'Here is my assessment: {"verdict":"maybe","confidence":0.5,"rationale":"unsure"}';
    const result = extract({ text, finish_reason: 'stop' });
    expectError(result, text, 'reply_invalid');
    if (!result.ok) expect(result.error.excerpt).toContain('maybe');
  });

  it.each([
    ['a missing rationale', { verdict: 'pass', confidence: 0.9 }],
    ['an empty rationale', { verdict: 'pass', confidence: 0.9, rationale: '' }],
    ['a confidence above one', { verdict: 'pass', confidence: 1.5, rationale: 'r' }],
    ['a string confidence', { verdict: 'pass', confidence: '0.9', rationale: 'r' }],
    ['an extra member', { ...PASS, note: 'extra' }],
    [
      'a finding with a numeric message',
      { ...PASS, findings: [{ severity: 'info', code: 'c', message: 42 }] },
    ],
    [
      'a finding with an unknown severity',
      { ...PASS, findings: [{ severity: 'unexpected', code: 'c', message: 'm' }] },
    ],
  ])('refuses %s', (_label, document) => {
    const text = JSON.stringify(document);
    expectError(extract({ text, finish_reason: 'stop' }), text, 'reply_invalid');
  });

  it('refuses a reply with no JSON document at all', () => {
    const text = 'The change looks good to me and I would approve it.';
    expectError(extract({ text, finish_reason: 'stop' }), text, 'reply_no_document');
  });

  it('refuses malformed JSON rather than repairing it', () => {
    const text = 'Here: {"verdict":"pass","confidence":0.9,"rationale":"ok",}';
    const result = extract({ text, finish_reason: 'stop' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reply_sha256).toBe(sha256(text));
  });

  it('bounds the excerpt of a very long reply and digests the whole reply', () => {
    const text = `${'The reviewer rambles. '.repeat(5000)}{"verdict":"maybe"}`;
    const result = extract({ text, finish_reason: 'stop' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_CHARS);
    expect(result.error.excerpt.length).toBeLessThan(text.length);
    expect(result.error.reply_sha256).toBe(sha256(text));
  });

  it('redacts a credential in the excerpt while the digest covers the unredacted reply', () => {
    const credential = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const text = `Found aws_access_key_id=${credential} in the diff. {"verdict":"maybe"}`;
    const result = extract({ text, finish_reason: 'stop' });
    expectError(result, text, 'reply_invalid');
    if (!result.ok) expect(result.error.excerpt).not.toContain(credential);
  });
});

describe('IA-003 two candidates are an error, never the first object', () => {
  it('refuses two conflicting verdict objects', () => {
    const fail = { ...PASS, verdict: 'fail' };
    const text = `First thought: ${JSON.stringify(fail)}\nOn reflection: ${PASS_TEXT}`;
    expectError(extract({ text, finish_reason: 'stop' }), text, 'reply_ambiguous');
  });

  it('refuses an echoed example beside the real verdict', () => {
    const example = {
      verdict: 'review',
      confidence: 0.55,
      rationale: 'The schema restatement is looser than the reply contract it names.',
      findings: [],
    };
    const text = [
      'The expected format is:',
      '```json',
      JSON.stringify(example),
      '```',
      'My verdict:',
      '```json',
      PASS_TEXT,
      '```',
    ].join('\n');
    expectError(extract({ text, finish_reason: 'stop' }), text, 'reply_ambiguous');
  });

  it('refuses two conflicting triage votes', () => {
    const other = { ...TRIAGE_VOTE, classification: 'sensor_error' };
    const text = `${JSON.stringify(TRIAGE_VOTE)} or perhaps ${JSON.stringify(other)}`;
    expectError(extract({ text, finish_reason: 'stop' }, TRIAGE), text, 'reply_ambiguous');
  });
});

describe('IA-004 truncation and provider errors are errors', () => {
  it('refuses a length finish even when the text holds a valid document', () => {
    expectError(
      extract({ text: PASS_TEXT, finish_reason: 'length' }),
      PASS_TEXT,
      'reply_truncated',
    );
  });

  it('refuses a length finish when the provider json field is valid', () => {
    expectError(
      extract({ text: PASS_TEXT, json: PASS, finish_reason: 'length' }),
      PASS_TEXT,
      'reply_truncated',
    );
  });

  it('refuses a document cut off mid-object', () => {
    const text = 'Here is my assessment: {"verdict":"pass","confidence":0.9,"rational';
    const result = extract({ text, finish_reason: 'stop' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reply_sha256).toBe(sha256(text));
  });

  it('refuses a provider error finish', () => {
    expectError(
      extract({ text: PASS_TEXT, finish_reason: 'error' }),
      PASS_TEXT,
      'reply_provider_error',
    );
  });
});

describe('IA-005 neither consumer accepts the other document', () => {
  it('refuses a triage vote against the review verdict schema', () => {
    const text = JSON.stringify(TRIAGE_VOTE);
    expectError(extract({ text, finish_reason: 'stop' }, REVIEW), text, 'reply_invalid');
  });

  it('refuses a review verdict against the triage schema', () => {
    expectError(
      extract({ text: PASS_TEXT, finish_reason: 'stop' }, TRIAGE),
      PASS_TEXT,
      'reply_invalid',
    );
  });
});

describe('OE-05 CMP-0002 rejected PASS reply fixture', () => {
  const fixture = fileURLToPath(
    new URL(
      '../../../../tests/fixtures/review-replies/cmp-0002-rejected-pass.txt',
      import.meta.url,
    ),
  );

  it('parses the maintainer-supplied CMP-0002 reply as pass (OE-05; skipped while the file is absent)', (context) => {
    if (!existsSync(fixture)) {
      context.skip(
        'OE-05 not performed: tests/fixtures/review-replies/cmp-0002-rejected-pass.txt is absent; this is a diagnostic, not a pass',
      );
      return;
    }
    const text = readFileSync(fixture, 'utf8');
    const result = extract({ text, finish_reason: 'stop' }, REVIEW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document['verdict']).toBe('pass');
    expect(getValidator(REVIEW as never)(result.document)).toBe(true);
  });
});

describe('bridge transports (IA-004, IA-006)', () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenai = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
  });

  afterEach(() => {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
  });

  function spawnReturns(stdout: string): void {
    spawnSyncMock.mockReturnValue({ status: 0, stdout, stderr: '', error: undefined });
  }

  const messages = { system: 'rubric', user: 'evidence' };
  const call = { response_format_json: true, temperature: 0, response_schema: REVIEW };

  function argvOf(): readonly string[] {
    const args = spawnSyncMock.mock.calls[0]?.[1] as readonly string[] | undefined;
    return args ?? [];
  }

  it('passes the consumer schema to claude -p with --json-schema', async () => {
    spawnReturns(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        result: PASS_TEXT,
      }),
    );
    const bridge = createModelBridge({ provider: 'claude-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    const argv = argvOf();
    const at = argv.indexOf('--json-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    const schema = JSON.parse(String(argv[at + 1])) as {
      properties: { verdict: { enum: string[] } };
    };
    expect(schema.properties.verdict.enum).toEqual(['pass', 'review', 'fail', 'unknown']);
    expect(response.finish_reason).toBe('stop');
  });

  it('reports a length finish from claude -p when the host stopped on max tokens', async () => {
    spawnReturns(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'max_tokens',
        result: '{"verdict":"pa',
      }),
    );
    const bridge = createModelBridge({ provider: 'claude-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    expect(response.finish_reason).toBe('length');
    expect(extract(response).ok).toBe(false);
  });

  it('reports an error finish from claude -p when the host marks the result as an error', async () => {
    spawnReturns(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
      }),
    );
    const bridge = createModelBridge({ provider: 'claude-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    expect(response.finish_reason).not.toBe('stop');
  });

  it('passes the consumer schema to codex exec with --output-schema', async () => {
    spawnReturns(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: PASS_TEXT },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n'),
    );
    const bridge = createModelBridge({ provider: 'codex-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    const argv = argvOf();
    const at = argv.indexOf('--output-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(String(argv[at + 1])).toMatch(/\.json$/u);
    expect(response.finish_reason).toBe('stop');
  });

  it('never reports stop from codex exec when the turn did not complete', async () => {
    spawnReturns(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"verdict":"pa' },
        }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'max output tokens reached' } }),
      ].join('\n'),
    );
    const bridge = createModelBridge({ provider: 'codex-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    expect(response.finish_reason).not.toBe('stop');
    expect(extract(response).ok).toBe(false);
  });

  it('never reports stop from codex exec when the stream ends without turn.completed', async () => {
    spawnReturns(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: PASS_TEXT } }),
    );
    const bridge = createModelBridge({ provider: 'codex-cli', model: 'fixture-model' });
    const response = await bridge.complete(messages, {}, call as never);
    expect(response.finish_reason).not.toBe('stop');
  });

  it('sends output_config.format on the Claude API and no assistant prefill', async () => {
    process.env.ANTHROPIC_API_KEY = 'fixture-not-a-credential';
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: PASS_TEXT }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });
    const bridge = createModelBridge({ provider: 'claude', model: 'fixture-model' });
    await bridge.complete(messages, {}, call as never);
    const request = anthropicCreate.mock.calls[0]?.[0] as {
      messages: { role: string }[];
      output_config?: {
        format?: { type?: string; schema?: { properties: { verdict: { enum: string[] } } } };
      };
    };
    expect(request.messages.every((message) => message.role !== 'assistant')).toBe(true);
    expect(request.output_config?.format?.type).toBe('json_schema');
    expect(request.output_config?.format?.schema?.properties.verdict.enum).toEqual([
      'pass',
      'review',
      'fail',
      'unknown',
    ]);
  });

  it('sends a json_schema response_format on the OpenAI API and no assistant prefill', async () => {
    process.env.OPENAI_API_KEY = 'fixture-not-a-credential';
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: PASS_TEXT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const bridge = createModelBridge({ provider: 'codex', model: 'fixture-model' });
    await bridge.complete(messages, {}, { ...call, response_schema: TRIAGE } as never);
    const request = openaiCreate.mock.calls[0]?.[0] as {
      messages: { role: string }[];
      response_format?: {
        type?: string;
        json_schema?: { schema?: { properties: { classification: { enum: string[] } } } };
      };
    };
    expect(request.messages.every((message) => message.role !== 'assistant')).toBe(true);
    expect(request.response_format?.type).toBe('json_schema');
    expect(request.response_format?.json_schema?.schema?.properties.classification.enum).toEqual([
      'plant_bug',
      'sensor_error',
      'policy_issue',
      'reference_gap',
      'inconclusive',
    ]);
  });
});
