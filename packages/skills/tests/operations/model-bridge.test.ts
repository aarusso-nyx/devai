import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawnSync: spawnSyncMock,
}));

const { createModelBridge, extractStructuredReply } =
  await import('../../src/model-bridge/index.js');
const REVIEW = 'review-verdict.schema.json';
const PASS = {
  verdict: 'pass',
  confidence: 0.91,
  rationale: 'Offline counterexample.',
  findings: [],
};
const PASS_TEXT = JSON.stringify(PASS);
const messages = { system: 'Offline rubric.', user: 'Synthetic evidence.' };
const call = { response_schema: REVIEW } as const;
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../../tests/fixtures/review-replies/${name}`, import.meta.url),
    'utf8',
  );
const claudeFixture = fixture('cmp0006-claude-envelope.json');
const codexFixture = fixture('cmp0006-codex-events.jsonl');
const claudeSuccess = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  result: PASS_TEXT,
};
const final = {
  type: 'item.completed',
  item: { id: 'final', type: 'agent_message', text: PASS_TEXT },
};
const completed = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
const stream = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => spawnSyncMock.mockReset());

async function observe(provider: 'claude-cli' | 'codex-cli', stdout: string) {
  spawnSyncMock.mockReturnValue({ status: 0, stdout, stderr: '', error: undefined });
  const bridge = createModelBridge({
    provider,
    model: 'synthetic-offline-model',
    timeout_ms: 1000,
  });
  return bridge.complete(messages, {}, call);
}

function expectFixtureConsumed(provider: 'claude-cli' | 'codex-cli') {
  expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(provider === 'claude-cli' ? 'claude' : 'codex');
}

/** A transport can refuse before extraction or return an incomplete diagnostic. */
async function expectRefused(provider: 'claude-cli' | 'codex-cli', stdout: string) {
  const observation = await observe(provider, stdout).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  // Assert outside the caught transport outcome: a lost fixture/mock cannot pass.
  expectFixtureConsumed(provider);
  if ('error' in observation) {
    expect(observation.error).toBeInstanceOf(Error);
    return;
  }
  expect(extractStructuredReply(observation.response, REVIEW).ok).toBe(false);
}

describe('internal model bridge', () => {
  it('requires an explicit provider and non-empty model without a default family', () => {
    const bridge = createModelBridge({ provider: 'codex-cli', model: 'gpt-explicit' });
    expect({ family: bridge.family, model: bridge.model }).toEqual({
      family: 'codex-cli',
      model: 'gpt-explicit',
    });
    expect(() => createModelBridge({ provider: 'claude', model: '' })).toThrow(
      'MODEL_BRIDGE_MODEL_REQUIRED',
    );
  });
});

describe('CMP-0006 completed structured host replies (offline, not live isolation)', () => {
  it('admits only the completed Claude structured marker and selects exact structured bytes', async () => {
    const envelope = JSON.parse(claudeFixture) as {
      structured_output: Record<string, unknown>;
      result: string;
    };
    const response = await observe('claude-cli', claudeFixture);
    expectFixtureConsumed('claude-cli');
    expect(response.finish_reason).toBe('stop');
    expect(response.text).toBe(JSON.stringify(envelope.structured_output));
    expect(response.text).not.toBe(envelope.result);
    expect(response.text.endsWith('\n')).toBe(false);
    expect(extractStructuredReply(response, REVIEW)).toEqual({
      ok: true,
      document: envelope.structured_output,
    });
  });

  it('preserves Codex selected message whitespace and excludes JSONL separators from reply bytes', async () => {
    const events = codexFixture
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const item = events.find((event) => event['type'] === 'item.completed')?.['item'] as {
      text: string;
    };
    const response = await observe('codex-cli', codexFixture);
    expectFixtureConsumed('codex-cli');
    expect(response.finish_reason).toBe('stop');
    expect(response.text).toBe(item.text);
    expect(response.text.startsWith('\t')).toBe(true);
    expect(response.text.endsWith('\n')).toBe(true);
    expect(response.usage).toEqual({ input_tokens: 3, output_tokens: 3, cost_usd: 0 });
    expect(digest(response.text)).not.toBe(digest(codexFixture));
    const document = JSON.parse(item.text) as Record<string, unknown>;
    delete document['findings'];
    expect(extractStructuredReply(response, REVIEW)).toEqual({ ok: true, document });
  });
});

describe('CMP-0006 complete Claude stream admission', () => {
  it('accepts a fully observed empty-inventory stream with a completed structured terminal', async () => {
    const terminal = JSON.parse(claudeFixture) as Record<string, unknown>;
    const response = await observe(
      'claude-cli',
      stream(
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Offline assessment.' }] },
        },
        terminal,
      ),
    );
    expect(response.finish_reason).toBe('stop');
    expect(response.text).toBe(JSON.stringify(terminal['structured_output']));
    expect(extractStructuredReply(response, REVIEW)).toEqual({
      ok: true,
      document: terminal['structured_output'],
    });
  });
});

describe('CMP-0006 Claude failure dominates valid-looking output', () => {
  it.each([
    ['missing terminal identity', { result: PASS_TEXT }],
    ['missing stop reason', { ...claudeSuccess, stop_reason: undefined }],
    ['missing affirmative error flag', { ...claudeSuccess, is_error: undefined }],
    ['unknown terminal subtype', { ...claudeSuccess, subtype: 'unknown' }],
    ['unknown stop reason', { ...claudeSuccess, stop_reason: 'surprise' }],
    ['refusal', { ...claudeSuccess, stop_reason: 'refusal' }],
    [
      'structured marker without structured output',
      { ...claudeSuccess, stop_reason: 'tool_use', terminal_reason: 'completed' },
    ],
    [
      'structured output without successful terminal',
      { ...claudeSuccess, subtype: 'error_during_execution', structured_output: PASS },
    ],
    [
      'structured output with truncation',
      { ...claudeSuccess, stop_reason: 'max_tokens', structured_output: PASS },
    ],
    ['structured output with error', { ...claudeSuccess, is_error: true, structured_output: PASS }],
    [
      'malformed structured verdict',
      { ...claudeSuccess, structured_output: { ...PASS, verdict: 'maybe' } },
    ],
    [
      'real built-in tool request in envelope',
      {
        ...claudeSuccess,
        content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'true' } }],
      },
    ],
    [
      'real MCP request in envelope',
      {
        ...claudeSuccess,
        content: [{ type: 'tool_use', id: 'mcp', name: 'mcp__inherited__read', input: {} }],
      },
    ],
    [
      'formatter-named tool request',
      {
        ...claudeSuccess,
        structured_output: PASS,
        content: [{ type: 'tool_use', id: 'formatter', name: 'structured_output', input: PASS }],
      },
    ],
  ])('refuses %s', async (_name, envelope) => {
    await expectRefused('claude-cli', JSON.stringify(envelope));
  });

  it.each([
    [
      'inherited built-in inventory',
      { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] },
    ],
    [
      'inherited MCP inventory',
      {
        type: 'system',
        subtype: 'init',
        tools: [],
        mcp_servers: [{ name: 'inherited', status: 'connected' }],
      },
    ],
    [
      'tool request before success',
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'true' } }],
        },
      },
    ],
    [
      'MCP request before success',
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'mcp', name: 'mcp__inherited__read', input: {} }],
        },
      },
    ],
    [
      'earlier error',
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: PASS_TEXT },
    ],
  ])('refuses complete transcript with %s', async (_name, event) => {
    await expectRefused('claude-cli', stream(event, claudeSuccess));
  });

  it('retains the exact pre-normalization reply digest on malformed structured output', async () => {
    const document = { ...PASS, rationale: '', findings: null };
    const response = await observe(
      'claude-cli',
      JSON.stringify({ ...claudeSuccess, structured_output: document }),
    );
    const extracted = extractStructuredReply(response, REVIEW);
    expect(extracted.ok).toBe(false);
    if (!extracted.ok) expect(extracted.error.reply_sha256).toBe(digest(JSON.stringify(document)));
  });
});

describe('CMP-0006 Codex complete event stream counterexamples', () => {
  it.each([
    ['uncompleted final', stream(final)],
    ['completed turn without final', stream(completed)],
    [
      'failed turn before success',
      stream({ type: 'turn.failed', error: { message: 'failed' } }, final, completed),
    ],
    [
      'error after success',
      stream(final, completed, { type: 'error', message: 'transport failed' }),
    ],
    [
      'truncated turn before success',
      stream(
        { type: 'turn.failed', error: { message: 'max output tokens reached' } },
        final,
        completed,
      ),
    ],
    [
      'aborted tool item',
      stream(
        { type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'true' } },
        final,
        completed,
      ),
    ],
    [
      'completed tool item',
      stream(
        {
          type: 'item.completed',
          item: { id: 'tool', type: 'command_execution', command: 'true', exit_code: 0 },
        },
        final,
        completed,
      ),
    ],
    [
      'aborted MCP item',
      stream(
        {
          type: 'item.started',
          item: { id: 'mcp', type: 'mcp_tool_call', server: 'inherited', tool: 'read' },
        },
        final,
        completed,
      ),
    ],
    [
      'completed MCP item',
      stream(
        {
          type: 'item.completed',
          item: { id: 'mcp', type: 'mcp_tool_call', server: 'inherited', tool: 'read', result: {} },
        },
        final,
        completed,
      ),
    ],
    [
      'inherited tool inventory',
      stream({ type: 'thread.started', tools: ['shell'], mcp_servers: [] }, final, completed),
    ],
    [
      'inherited MCP inventory',
      stream(
        { type: 'thread.started', tools: [], mcp_servers: [{ name: 'inherited' }] },
        final,
        completed,
      ),
    ],
    [
      'conflicting finals',
      stream(
        {
          ...final,
          item: { ...final.item, id: 'first', text: JSON.stringify({ ...PASS, verdict: 'fail' }) },
        },
        final,
        completed,
      ),
    ],
    [
      'contradictory completion after failure',
      stream(final, completed, { type: 'turn.failed', error: { message: 'contradiction' } }),
    ],
    [
      'unknown event variant',
      stream({ type: 'future.tool_activity', payload: {} }, final, completed),
    ],
    [
      'refusal item before success',
      stream(
        { type: 'item.completed', item: { id: 'refusal', type: 'refusal', text: 'Refused.' } },
        final,
        completed,
      ),
    ],
    ['malformed JSONL suffix', stream(final, completed) + '{'],
  ])('refuses %s', async (_name, stdout) => {
    await expectRefused('codex-cli', stdout);
  });
});

describe('CMP-0006 transport exit and timeout failures', () => {
  it.each(['claude-cli', 'codex-cli'] as const)(
    'rejects %s nonzero exit without salvaging its verdict',
    async (provider) => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: provider === 'claude-cli' ? claudeFixture : codexFixture,
        stderr: 'failed',
      });
      await expect(
        createModelBridge({ provider, model: 'offline' }).complete(messages, {}, call),
      ).rejects.toThrow('MODEL_BRIDGE_CLI_FAILED');
    },
  );
  it.each(['claude-cli', 'codex-cli'] as const)(
    'rejects %s timeout without salvaging its verdict',
    async (provider) => {
      spawnSyncMock.mockReturnValue({
        status: null,
        stdout: provider === 'claude-cli' ? claudeFixture : codexFixture,
        error: new Error('ETIMEDOUT'),
      });
      await expect(
        createModelBridge({ provider, model: 'offline' }).complete(messages, {}, call),
      ).rejects.toThrow('MODEL_BRIDGE_CLI_FAILED');
    },
  );
});

// The README is the metadata store; hashes are independently recomputed from
// both files and from the host-selected reply, never copied from a bridge field.
describe('CMP-0006 fixture provenance', () => {
  const readme = fixture('README.md');
  const metadataText = readme
    .split('<!-- cmp0006-provenance:start -->')[1]
    ?.split('<!-- cmp0006-provenance:end -->')[0]
    ?.match(/```json\s*([\s\S]*?)\s*```/u)?.[1];
  const metadata = JSON.parse(metadataText ?? 'null') as {
    origin: string;
    sanitization: string;
    host: { file: string; encoding: string; bytes: number; sha256: string };
    reply: {
      file: string;
      encoding: string;
      bytes: number;
      sha256: string;
      transformation: string;
    };
  }[];

  it('identifies two synthetic host/reply pairs with independently measured exact bytes', () => {
    expect(metadata).toHaveLength(2);
    expect(metadata.map((row) => [row.host.file, row.reply.file])).toEqual([
      ['cmp0006-claude-envelope.json', 'cmp0006-claude-reply.txt'],
      ['cmp0006-codex-events.jsonl', 'cmp0006-codex-reply.txt'],
    ]);
    for (const row of metadata) {
      expect(row.origin).toBe('synthetic-offline');
      expect(row.sanitization).toContain('no captured original exists');
      for (const identity of [row.host, row.reply]) {
        const bytes = fixture(identity.file);
        expect(identity.encoding).toBe('UTF-8');
        expect(identity.bytes).toBe(Buffer.byteLength(bytes, 'utf8'));
        expect(identity.sha256).toBe(digest(bytes));
      }
      expect(row.host.sha256).not.toBe(row.reply.sha256);
    }
  });

  it('stores Claude reply bytes as exact JSON.stringify(structured_output), not result or envelope', () => {
    const envelope = JSON.parse(claudeFixture) as { result: string; structured_output: unknown };
    const bytes = fixture('cmp0006-claude-reply.txt');
    expect(bytes).toBe(JSON.stringify(envelope.structured_output));
    expect(bytes).not.toBe(envelope.result);
    expect(bytes.endsWith('\n')).toBe(false);
  });

  it('stores Codex text bytes without trimming, framing or optional-null normalization', () => {
    const events = codexFixture
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; item?: { text: string } });
    const bytes = fixture('cmp0006-codex-reply.txt');
    expect(bytes).toBe(events.find((event) => event.type === 'item.completed')?.item?.text);
    expect(bytes).not.toBe(bytes.trim());
    expect(JSON.parse(bytes)).toHaveProperty('findings', null);
  });
});
