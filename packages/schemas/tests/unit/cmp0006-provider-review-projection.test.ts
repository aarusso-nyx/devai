import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getValidator,
  loadSchema,
  providerReplySchema,
  REPLY_PROJECTION_VERSION,
  replyProjectionIdentity,
} from '../../src/index.js';

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

const { spawnSyncMock, anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The Codex compatibility probe (`--version`, `features list`) answers as a binary that
  // honours every --disable; spawnSyncMock sees only the review itself.
  spawnSync: (cli: string, argv: string[], options: unknown) =>
    cli === 'codex' && (argv[0] === '--version' || argv[0] === 'features')
      ? {
          status: 0,
          stderr: '',
          stdout:
            argv[0] === '--version'
              ? 'codex-cli offline-stub\n'
              : argv
                  .flatMap((value, index) =>
                    value === '--disable' ? [`${String(argv[index + 1])}  stable  false`] : [],
                  )
                  .join('\n'),
        }
      : (spawnSyncMock as (...args: unknown[]) => unknown)(cli, argv, options),
}));
// The schemas package does not depend on @devai-nyx/authority: the local config aliases it to
// source, while under the RC coverage config the bridge resolves the package's source entry.
vi.mock('../../../authority/src/index.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The Codex compatibility probe (`--version`, `features list`) answers as a binary that
  // honours every --disable; spawnSyncMock sees only the review itself.
  spawnSync: (cli: string, argv: string[], options: unknown) =>
    cli === 'codex' && (argv[0] === '--version' || argv[0] === 'features')
      ? {
          status: 0,
          stderr: '',
          stdout:
            argv[0] === '--version'
              ? 'codex-cli offline-stub\n'
              : argv
                  .flatMap((value, index) =>
                    value === '--disable' ? [`${String(argv[index + 1])}  stable  false`] : [],
                  )
                  .join('\n'),
        }
      : (spawnSyncMock as (...args: unknown[]) => unknown)(cli, argv, options),
}));
vi.mock('../../../skills/node_modules/@anthropic-ai/sdk/index.mjs', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
vi.mock('../../../skills/node_modules/openai/index.mjs', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
const { createModelBridge, extractStructuredReply } =
  await import('../../../skills/src/model-bridge/index.js');
const REVIEW = 'review-verdict.schema.json';
const TRIAGE = 'triage-breaker.schema.json';
const messages = { system: 'Offline rubric.', user: 'Synthetic evidence.' };
const pass = {
  verdict: 'pass',
  confidence: 0.91,
  rationale: 'Synthetic provider projection.',
  findings: [],
};
const vote = { classification: 'plant_bug', confidence: 0.8, rationale: 'Synthetic triage vote.' };
type Provider = 'claude' | 'codex' | 'claude-cli' | 'codex-cli';
type Schema = Record<string, unknown>;
const originalKeys = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};
let captured: Schema | undefined;
beforeEach(() => {
  spawnSyncMock.mockReset();
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  captured = undefined;
  process.env.ANTHROPIC_API_KEY = 'synthetic-offline-key';
  process.env.OPENAI_API_KEY = 'synthetic-offline-key';
});
afterEach(() => {
  if (originalKeys.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKeys.anthropic;
  if (originalKeys.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKeys.openai;
});

function capturedSchema(): Schema {
  if (captured === undefined) throw new Error('OFFLINE_SCHEMA_REQUEST_NOT_CAPTURED');
  return captured;
}

async function request(
  provider: Provider,
  document: unknown,
  schema: typeof REVIEW | typeof TRIAGE = REVIEW,
) {
  // Per-request capture only; the native guard attempt history is never cleared.
  anthropicCreate.mockClear();
  openaiCreate.mockClear();
  spawnSyncMock.mockClear();
  captured = undefined;
  const text = JSON.stringify(document);
  anthropicCreate.mockImplementation(
    (outbound: { output_config: { format: { schema: Schema } } }) => {
      captured = outbound.output_config.format.schema;
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      };
    },
  );
  openaiCreate.mockImplementation(
    (outbound: { response_format: { json_schema: { schema: Schema } } }) => {
      captured = outbound.response_format.json_schema.schema;
      return {
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    },
  );
  spawnSyncMock.mockImplementation((_executable: string, argv: string[]) => {
    const at = argv.indexOf(provider === 'claude-cli' ? '--json-schema' : '--output-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    captured = JSON.parse(
      provider === 'claude-cli' ? String(argv[at + 1]) : readFileSync(String(argv[at + 1]), 'utf8'),
    ) as Schema;
    return {
      status: 0,
      stdout:
        provider === 'claude-cli'
          ? JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: false,
              stop_reason: 'end_turn',
              structured_output: document,
            })
          : `${JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`,
    };
  });
  const response = await createModelBridge({ provider, model: 'synthetic-offline-model' }).complete(
    messages,
    {},
    { response_schema: schema },
  );
  if (provider === 'claude') {
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const outbound = anthropicCreate.mock.calls[0]?.[0] as {
      model: string;
      messages: { role: string }[];
      output_config: { format: { type: string; schema: Schema } };
    };
    expect(outbound.model).toBe('synthetic-offline-model');
    expect(outbound.output_config.format.type).toBe('json_schema');
    expect(outbound.output_config.format.schema).toBe(captured);
    expect(outbound.messages.map((message) => message.role)).toEqual(['user']);
  } else if (provider === 'codex') {
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const outbound = openaiCreate.mock.calls[0]?.[0] as {
      model: string;
      messages: { role: string }[];
      response_format: { type: string; json_schema: { schema: Schema } };
    };
    expect(outbound.model).toBe('synthetic-offline-model');
    expect(outbound.response_format.type).toBe('json_schema');
    expect(outbound.response_format.json_schema.schema).toBe(captured);
    expect(outbound.messages.map((message) => message.role)).toEqual(['system', 'user']);
  } else {
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(provider === 'claude-cli' ? 'claude' : 'codex');
  }
  expect(captured).toBeDefined();
  return { response, schema: capturedSchema() };
}

const validate = (schema: Schema) => new Ajv2020({ strict: false }).compile(schema);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function assertStrictObjects(schema: Schema) {
  if (schema['type'] === 'object') {
    expect(schema['additionalProperties']).toBe(false);
    expect([...(schema['required'] as string[])].sort()).toEqual(
      Object.keys(schema['properties'] as Schema).sort(),
    );
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const entry of value)
        if (entry !== null && typeof entry === 'object') assertStrictObjects(entry as Schema);
    } else if (value !== null && typeof value === 'object') assertStrictObjects(value as Schema);
  }
}

describe('CMP-0006 provider schema projection is measured from actual requests', () => {
  it.each(['claude', 'codex', 'claude-cli', 'codex-cli'] as const)(
    '%s preserves canonical constraints and local finding references',
    async (provider) => {
      const before = JSON.stringify(loadSchema(REVIEW));
      const { schema } = await request(provider, pass);
      expect(schema['$schema']).toBeUndefined();
      expect(schema['$id']).toBeUndefined();
      expect(schema['schema_version']).toBeUndefined();
      expect(schema['examples']).toBeUndefined();
      const accepts = validate(schema);
      expect(accepts(pass)).toBe(true);
      for (const document of [
        { ...pass, verdict: 'maybe' },
        { ...pass, confidence: 1.1 },
        { ...pass, confidence: -0.1 },
        { ...pass, rationale: '' },
        { ...pass, extra: 'unknown' },
        { ...pass, findings: [null] },
        { ...pass, findings: [{ severity: 'info', code: '', message: 'm' }] },
        { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', line: 0 }] },
        { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', file: '' }] },
        { ...pass, findings: [{ severity: 'other', code: 'c', message: 'm' }] },
        { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', extra: true }] },
      ])
        expect(accepts(document), JSON.stringify(document)).toBe(false);
      expect(JSON.stringify(loadSchema(REVIEW))).toBe(before);
    },
  );

  it.each(['codex', 'codex-cli'] as const)(
    '%s requires every projected field and allows null only at the three optional positions',
    async (provider) => {
      const { schema } = await request(provider, pass);
      assertStrictObjects(schema);
      const accepts = validate(schema);
      expect(accepts({ ...pass, findings: null })).toBe(true);
      expect(
        accepts({
          ...pass,
          findings: [{ severity: 'warning', code: 'c', message: 'm', file: null, line: null }],
        }),
      ).toBe(true);
      expect(accepts({ verdict: 'pass', confidence: 0.9, rationale: 'r' })).toBe(false);
      expect(
        accepts({ ...pass, findings: [{ severity: 'warning', code: 'c', message: 'm' }] }),
      ).toBe(false);
      for (const key of ['verdict', 'confidence', 'rationale'])
        expect(accepts({ ...pass, [key]: null })).toBe(false);
      for (const key of ['severity', 'code', 'message']) {
        expect(
          accepts({
            ...pass,
            findings: [
              { severity: 'warning', code: 'c', message: 'm', file: null, line: null, [key]: null },
            ],
          }),
        ).toBe(false);
      }
    },
  );

  it('requests OpenAI strict schema mode without assistant prefill', async () => {
    await request('codex', pass);
    const outbound = openaiCreate.mock.calls[0]?.[0] as {
      messages: { role: string }[];
      response_format: { json_schema: { strict?: boolean } };
    };
    expect(outbound.response_format.json_schema.strict).toBe(true);
    expect(outbound.messages.some((message) => message.role === 'assistant')).toBe(false);
  });

  it.each(['codex', 'codex-cli'] as const)(
    '%s triage projection has no nullable fields or review normalization',
    async (provider) => {
      const { schema } = await request(provider, vote, TRIAGE);
      assertStrictObjects(schema);
      const accepts = validate(schema);
      expect(accepts(vote)).toBe(true);
      for (const key of Object.keys(vote)) expect(accepts({ ...vote, [key]: null })).toBe(false);
      expect(accepts({ ...vote, findings: null })).toBe(false);
    },
  );

  it('pins both canonical file digests independently of provider serialization', () => {
    const base = new URL('../../../../law/schemas/', import.meta.url);
    expect(hash(readFileSync(new URL(REVIEW, base)))).toBe(
      'c47b3b45218663d63f23162c73b2cfe010045ba841fcae1ff4d3bd85eb726f35',
    );
    expect(hash(readFileSync(new URL(TRIAGE, base)))).toBe(
      '6241a0dab9c590388cf46e177124833816ee96b75ba1e36536bf93db30105856',
    );
  });
});

describe('CMP-0006 strict response validation precedes optional-null normalization', () => {
  it.each(['codex', 'codex-cli'] as const)(
    '%s removes only explicit optional nulls and preserves all non-null values',
    async (provider) => {
      const raw = {
        ...pass,
        findings: [
          { severity: 'warning', code: 'nullable', message: 'm', file: null, line: null },
          { severity: 'error', code: 'preserved', message: 'n', file: 'src/a.ts', line: 7 },
        ],
      };
      const before = JSON.stringify(raw);
      const { response } = await request(provider, raw);
      expect(response.text).toBe(before);
      const expected = {
        ...pass,
        findings: [{ severity: 'warning', code: 'nullable', message: 'm' }, raw.findings[1]],
      };
      const extracted = extractStructuredReply(response, REVIEW);
      expect(extracted).toEqual({ ok: true, document: expected });
      if (extracted.ok) expect(getValidator(REVIEW)(extracted.document)).toBe(true);
      expect(JSON.stringify(raw)).toBe(before);
    },
  );

  it.each(['codex', 'codex-cli'] as const)(
    '%s removes a null findings array without inventing an empty array',
    async (provider) => {
      const { response } = await request(provider, { ...pass, findings: null });
      const expected = {
        verdict: pass.verdict,
        confidence: pass.confidence,
        rationale: pass.rationale,
      };
      expect(extractStructuredReply(response, REVIEW)).toEqual({ ok: true, document: expected });
    },
  );

  it.each(['codex', 'codex-cli'] as const)(
    '%s refuses absent strict fields even when the canonical document is valid',
    async (provider) => {
      const document = { verdict: 'pass', confidence: 0.9, rationale: 'r' };
      expect(getValidator(REVIEW)(document)).toBe(true);
      const { response } = await request(provider, document);
      expect(extractStructuredReply(response, REVIEW).ok).toBe(false);
    },
  );

  it.each(['codex', 'codex-cli'] as const)(
    '%s never deletes nulls outside optional schema positions',
    async (provider) => {
      for (const document of [
        { ...pass, verdict: null },
        { ...pass, confidence: null },
        { ...pass, rationale: null },
        { ...pass, findings: [null] },
        { ...pass, extra: null },
        {
          ...pass,
          findings: [{ severity: null, code: 'c', message: 'm', file: null, line: null }],
        },
        {
          ...pass,
          findings: [{ severity: 'info', code: 'c', message: null, file: null, line: null }],
        },
        {
          ...pass,
          findings: [
            { severity: 'info', code: 'c', message: 'm', file: { path: null }, line: null },
          ],
        },
      ]) {
        const { response } = await request(provider, document);
        const extracted = extractStructuredReply(response, REVIEW);
        expect(extracted.ok, JSON.stringify(document)).toBe(false);
        if (!extracted.ok)
          expect(extracted.error.reply_sha256).toBe(hash(JSON.stringify(document)));
      }
    },
  );
});

// Issue #249 item 4: Codex `--output-schema` and the OpenAI API send the projection in
// strict mode. The canonical review-verdict.schema.json is unchanged (ADR-MDL-0003); the
// projection is what must be strict-acceptable, and it must not change what is accepted.
describe('#249 strict projection is OpenAI strict-mode shaped and meaning-preserving', () => {
  // The JSON Schema subset OpenAI strict structured outputs document.
  const STRICT_KEYWORDS = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    '$ref',
    '$defs',
    'title',
    'description',
    'pattern',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
  ]);

  function keywordsOf(schema: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(schema)) for (const member of schema) keywordsOf(member, into);
    else if (schema !== null && typeof schema === 'object') {
      for (const [key, member] of Object.entries(schema as Schema)) {
        into.add(key);
        if (key === 'properties' || key === '$defs') {
          for (const child of Object.values(member as Schema)) keywordsOf(child, into);
        } else if (key !== 'enum' && key !== 'const') keywordsOf(member, into);
      }
    }
    return into;
  }

  function nodes(schema: unknown, into: Schema[] = []): Schema[] {
    if (Array.isArray(schema)) for (const member of schema) nodes(member, into);
    else if (schema !== null && typeof schema === 'object') {
      into.push(schema as Schema);
      for (const member of Object.values(schema as Schema)) nodes(member, into);
    }
    return into;
  }

  it.each([REVIEW, TRIAGE] as const)(
    '%s strict projection uses only strict-mode keywords and types every enum',
    (name) => {
      const schema = providerReplySchema(name, true);
      expect([...keywordsOf(schema)].filter((key) => !STRICT_KEYWORDS.has(key))).toEqual([]);
      assertStrictObjects(schema);
      for (const node of nodes(schema))
        if (Array.isArray(node['enum'])) expect(node['type'], JSON.stringify(node)).toBe('string');
    },
  );

  it.each(['codex', 'codex-cli'] as const)(
    '%s receives exactly the shared strict projection and its identity',
    async (provider) => {
      const { schema, response } = await request(provider, pass);
      expect(schema).toEqual(providerReplySchema(REVIEW, true));
      expect(response.projection).toEqual(replyProjectionIdentity(REVIEW));
      expect(response.projection?.version).toBe(REPLY_PROJECTION_VERSION);
    },
  );

  it('keeps the canonical schema and the non-strict projection free of strict rewrites', () => {
    const relaxed = providerReplySchema(REVIEW, false);
    expect(keywordsOf(relaxed).has('minLength')).toBe(true);
    expect((relaxed['required'] as string[]).includes('findings')).toBe(false);
    expect(JSON.stringify(loadSchema(REVIEW))).toContain('"minLength":1');
  });

  // A document absent an optional member is sent as null by a strict host; filling the
  // declared optional positions with null is the strict spelling of the same document.
  const strictSpelling = (document: Record<string, unknown>) => {
    const out = structuredClone(document);
    if (!('findings' in out)) out['findings'] = null;
    if (Array.isArray(out['findings']))
      for (const finding of out['findings'] as Record<string, unknown>[]) {
        if (finding === null || typeof finding !== 'object') continue;
        if (!('file' in finding)) finding['file'] = null;
        if (!('line' in finding)) finding['line'] = null;
      }
    return out;
  };

  it('accepts a document through projection and canonical validation exactly when the canonical schema does', () => {
    const projected = validate(providerReplySchema(REVIEW, true));
    const canonical = getValidator(REVIEW);
    const corpus: Record<string, unknown>[] = [
      ...(loadSchema(REVIEW)['examples'] as Record<string, unknown>[]),
      pass,
      { ...pass, rationale: '' },
      { ...pass, rationale: ' ' },
      { ...pass, rationale: '\n' },
      { ...pass, rationale: '\u{1F600}' },
      { ...pass, confidence: 1.1 },
      { ...pass, verdict: 'maybe' },
      { ...pass, extra: true },
      { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', file: 'a', line: 1 }] },
      { ...pass, findings: [{ severity: 'info', code: '', message: 'm' }] },
      { ...pass, findings: [{ severity: 'info', code: 'c', message: '' }] },
      { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', file: '' }] },
      { ...pass, findings: [{ severity: 'info', code: 'c', message: 'm', line: 0 }] },
      { ...pass, findings: [{ severity: 'note', code: 'c', message: 'm' }] },
    ];
    for (const document of corpus) {
      const strict = strictSpelling(document);
      const extracted = extractStructuredReply(
        {
          text: JSON.stringify(strict),
          json: strict,
          finish_reason: 'stop',
          projection: replyProjectionIdentity(REVIEW),
        },
        REVIEW,
      );
      expect(projected(strict) && extracted.ok, JSON.stringify(document)).toBe(canonical(document));
      if (extracted.ok) expect(extracted.document).toEqual(document);
    }
  });
});
