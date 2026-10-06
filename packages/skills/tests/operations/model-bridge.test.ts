import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

const { spawnSyncMock, codexProbe } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  // The Codex compatibility probe (#321): by default a binary that honours every
  // --disable. Tests replace `version` or `listing` to model an incompatible binary.
  codexProbe: {
    version: 'codex-cli offline-stub' as string | null,
    listing: undefined as
      undefined | ((argv: string[]) => { status: number; stdout: string; stderr: string }),
    calls: [] as string[][],
    executables: [] as string[],
  },
}));
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawnSync: (cli: string, argv: string[], options: unknown) => {
    if (/(^|\/)codex$/u.test(cli) && (argv[0] === '--version' || argv[0] === 'features')) {
      codexProbe.calls.push(argv);
      codexProbe.executables.push(cli);
      if (argv[0] === '--version')
        return codexProbe.version === null
          ? { status: 127, stdout: '', stderr: 'not found' }
          : { status: 0, stdout: `${codexProbe.version}\n`, stderr: '' };
      return (
        codexProbe.listing?.(argv) ?? {
          status: 0,
          stderr: '',
          stdout: argv
            .flatMap((value, index) =>
              value === '--disable' ? [`${String(argv[index + 1])}  stable  false`] : [],
            )
            .join('\n'),
        }
      );
    }
    return (spawnSyncMock as (...args: unknown[]) => unknown)(cli, argv, options);
  },
}));
// #321: the bridge resolves `codex` on PATH to an executable regular file before it
// spawns; this placeholder is that file. The spawn is mocked and never runs it.
{
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const bin = mkdtempSync(join(tmpdir(), 'devai-codex-placeholder-'));
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(bin, 'codex'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

const {
  assertCodexReviewCompatibility,
  CODEX_REVIEW_DISABLED_FEATURES,
  createModelBridge,
  extractStructuredReply,
  replyProjectionIdentity,
  replySha256,
  resolveCodexExecutable,
} = await import('../../src/model-bridge/index.js');
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

// A block body: a returned mock would run again as the hook's cleanup.
beforeEach(() => {
  spawnSyncMock.mockReset();
});

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
  expect(String(spawnSyncMock.mock.calls[0]?.[0])).toMatch(
    provider === 'claude-cli' ? /^claude$/u : /\/codex$/u,
  );
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

// Issue #249, offline part. Every host reply below is scripted; none is a live transcript,
// and none proves that a live review on either host returns a valid verdict.
describe('#249 Claude structured reply finish mapping', () => {
  // The field set Claude Code 2.1.277 prints for `--print --output-format json
  // --json-schema` (OE-05, 2026-09-29), with synthetic values.
  const liveShaped = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1100,
    num_turns: 2,
    result: 'Prose that is not the selected reply.',
    stop_reason: 'tool_use',
    session_id: '00000000-0000-4000-8000-000000000000',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 20,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    },
    modelUsage: {
      'synthetic-offline-model': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow: 200000,
      },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '00000000-0000-4000-8000-000000000001',
    structured_output: PASS,
  };

  it('maps tool_use + terminal_reason completed + structured_output to a valid reply', async () => {
    const response = await observe('claude-cli', JSON.stringify(liveShaped));
    expect(response.finish_reason).toBe('stop');
    expect(response.text).toBe(JSON.stringify(PASS));
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 20, cost_usd: 0.01 });
    expect(extractStructuredReply(response, REVIEW)).toEqual({ ok: true, document: PASS });
  });

  it.each([
    ['without structured_output', { structured_output: undefined }],
    ['with a non-object structured_output', { structured_output: PASS_TEXT }],
    ['with a non-completed terminal reason', { terminal_reason: 'max_turns' }],
    ['without a terminal reason', { terminal_reason: undefined }],
    [
      'with a denied tool request',
      { permission_denials: [{ tool_name: 'Bash', tool_use_id: 't', tool_input: {} }] },
    ],
    ['with an error subtype', { subtype: 'error_max_turns' }],
    [
      'with a server-side web search',
      { usage: { ...liveShaped.usage, server_tool_use: { web_search_requests: 1 } } },
    ],
    [
      'with a server-side web fetch',
      {
        usage: {
          ...liveShaped.usage,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 2 },
        },
      },
    ],
    [
      'with a malformed server tool counter',
      { usage: { ...liveShaped.usage, server_tool_use: { web_search_requests: '0' } } },
    ],
    [
      'with a per-model web search count',
      {
        modelUsage: {
          'synthetic-offline-model': {
            ...liveShaped.modelUsage['synthetic-offline-model'],
            webSearchRequests: 1,
          },
        },
      },
    ],
  ])('keeps the marker a provider error %s', async (_name, change) => {
    const response = await observe('claude-cli', JSON.stringify({ ...liveShaped, ...change }));
    expect(response.finish_reason).not.toBe('stop');
    const extracted = extractStructuredReply(response, REVIEW);
    expect(extracted.ok).toBe(false);
    if (!extracted.ok) expect(extracted.error.code).toBe('reply_provider_error');
  });
});

describe('#249 review process isolation (no MCP server, no tools, allowlisted env)', () => {
  // Flags as advertised by `claude --help` (Claude Code 2.1.277) and `codex exec --help`
  // (codex-cli 0.157.1), inspected on 2026-10-06; the bridge may use no other flag.
  const CLAUDE_HELP_FLAGS = [
    '--print',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
    '--setting-sources',
    '--strict-mcp-config',
    '--mcp-config',
    '--tools',
    '--model',
    '--output-format',
    '--json-schema',
  ];
  const CODEX_HELP_FLAGS = [
    '--model',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--cd',
    '--sandbox',
    '--config',
    '--output-schema',
    '--disable',
  ];
  // Effective state confirmed with `codex features list --disable <feature>` (0.157.1).
  const CODEX_DISABLED_FEATURES = [
    'shell_tool',
    'apps',
    'browser_use',
    'computer_use',
    'in_app_browser',
    'multi_agent',
    'plugins',
    'image_generation',
    'view_image',
    'sleep_tool',
    'tool_suggest',
    'skill_search',
  ];
  const secrets = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'NODE_OPTIONS'] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of secrets) {
      saved.set(name, process.env[name]);
      process.env[name] = 'synthetic-offline-value';
    }
  });
  afterEach(() => {
    for (const name of secrets) {
      const value = saved.get(name);
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  });

  interface Spawned {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    workspaceEntries: string[];
    schemaPath?: string;
  }

  async function spawnOf(provider: 'claude-cli' | 'codex-cli'): Promise<Spawned> {
    let seen: Spawned | undefined;
    spawnSyncMock.mockImplementation(
      (_cli: string, argv: string[], options: { cwd: string; env: Record<string, string> }) => {
        const at = argv.indexOf('--output-schema');
        seen = {
          argv,
          cwd: options.cwd,
          env: options.env,
          workspaceEntries: readdirSync(options.cwd),
          ...(at < 0 ? {} : { schemaPath: String(argv[at + 1]) }),
        };
        return {
          status: 0,
          stdout: provider === 'claude-cli' ? claudeFixture : codexFixture,
          stderr: '',
        };
      },
    );
    const response = await createModelBridge({ provider, model: 'offline' }).complete(
      messages,
      {},
      call,
    );
    expect(response.finish_reason).toBe('stop');
    if (seen === undefined) throw new Error('OFFLINE_SPAWN_NOT_CAPTURED');
    return seen;
  }

  const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  it('runs Claude with no tools, only the empty MCP set and no settings or customizations', async () => {
    const { argv } = await spawnOf('claude-cli');
    expect(flagValue(argv, '--tools')).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(flagValue(argv, '--mcp-config')).toBe('{"mcpServers":{}}');
    expect(flagValue(argv, '--setting-sources')).toBe('');
    expect(argv).toEqual(expect.arrayContaining(['--safe-mode', '--disable-slash-commands']));
    const flags = argv.filter((value) => value.startsWith('--'));
    expect(flags.filter((flag) => !CLAUDE_HELP_FLAGS.includes(flag))).toEqual([]);
  });

  it('runs every Codex review without user config, rules or MCP servers in the workspace', async () => {
    const { argv, cwd } = await spawnOf('codex-cli');
    expect(argv[0]).toBe('exec');
    expect(argv).toEqual(
      expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']),
    );
    expect(flagValue(argv, '--sandbox')).toBe('read-only');
    expect(flagValue(argv, '--cd')).toBe(cwd);
    const configs = argv.flatMap((value, index) => (value === '--config' ? [argv[index + 1]] : []));
    expect(configs).toEqual([
      'mcp_servers={}',
      'tools={}',
      'web_search="disabled"',
      'skills.include_instructions=false',
      'agents.enabled=false',
    ]);
    const disabled = argv.flatMap((value, index) =>
      value === '--disable' ? [argv[index + 1]] : [],
    );
    expect(disabled).toEqual(CODEX_DISABLED_FEATURES);
    expect(disabled).not.toContain('unified_exec');
    const flags = argv.filter((value) => value.startsWith('--'));
    expect(flags.filter((flag) => !CODEX_HELP_FLAGS.includes(flag))).toEqual([]);
  });

  it.each(['claude-cli', 'codex-cli'] as const)(
    '%s starts in a fresh empty workspace that is removed afterwards',
    async (provider) => {
      const { cwd, workspaceEntries, schemaPath } = await spawnOf(provider);
      expect(workspaceEntries).toEqual([]);
      expect(cwd.startsWith(process.cwd())).toBe(false);
      if (schemaPath !== undefined) expect(schemaPath.startsWith(`${cwd}/`)).toBe(false);
      expect(existsSync(cwd)).toBe(false);
    },
  );

  it.each(['claude-cli', 'codex-cli'] as const)(
    '%s receives only the agent-cli environment allowlist',
    async (provider) => {
      const { env } = await spawnOf(provider);
      for (const name of secrets) expect(env).not.toHaveProperty(name);
      if (process.env.PATH !== undefined) expect(env['PATH']).toBe(process.env.PATH);
      const allowed = new Set([
        ...['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM'],
        ...['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'],
        ...['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'],
        ...['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'],
        provider === 'claude-cli' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      ]);
      for (const name of Object.keys(env))
        expect(allowed.has(name) || name.startsWith('LC_'), name).toBe(true);
    },
  );
});

describe('#249 declared reply bytes: recording and replay agree', () => {
  const readme = fixture('README.md');
  const declared = <T>(marker: string): T[] =>
    JSON.parse(
      readme
        .split(`<!-- ${marker}:start -->`)[1]
        ?.split(`<!-- ${marker}:end -->`)[0]
        ?.match(/```json\s*([\s\S]*?)\s*```/u)?.[1] ?? 'null',
    ) as T[];

  it.each([
    ['claude-cli', 0],
    ['codex-cli', 1],
  ] as const)(
    '%s: the recorded digest is the stored reply file digest and its replay extracts the same document',
    async (provider, row) => {
      const stored = declared<{ reply: { file: string; sha256: string } }>('cmp0006-provenance')[
        row
      ];
      if (stored === undefined) throw new Error('fixture provenance row missing');
      const response = await observe(
        provider,
        provider === 'claude-cli' ? claudeFixture : codexFixture,
      );
      const recorded = extractStructuredReply(response, REVIEW);
      const bytes = fixture(stored.reply.file);
      expect(response.text).toBe(bytes);
      expect(replySha256(response)).toBe(stored.reply.sha256);
      const replayed = extractStructuredReply(
        {
          text: bytes,
          json: JSON.parse(bytes) as unknown,
          finish_reason: 'stop',
          ...(provider === 'codex-cli' ? { projection: replyProjectionIdentity(REVIEW) } : {}),
        },
        REVIEW,
      );
      expect(replayed.ok).toBe(true);
      expect(replayed).toEqual(recorded);
    },
  );

  it('declares the ADR-MDL-0001 fixture as envelope result bytes, replayed on the text path', () => {
    const [row] = declared<{
      origin: string;
      reply: { file: string; bytes: number; sha256: string; transformation: string };
    }>('adr-mdl-0001-provenance');
    if (row === undefined) throw new Error('ADR-MDL-0001 fixture provenance missing');
    expect(row.origin).toBe('captured-live');
    expect(row.reply.transformation).toContain('envelope result string');
    const bytes = fixture(row.reply.file);
    expect(Buffer.byteLength(bytes, 'utf8')).toBe(row.reply.bytes);
    expect(replySha256({ text: bytes })).toBe(row.reply.sha256);
    const replayed = extractStructuredReply({ text: bytes, finish_reason: 'stop' }, REVIEW);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.document['verdict']).toBe('pass');
  });
});

describe('#321 Codex host compatibility check before a review', () => {
  // `codex features list --disable <each review feature>` as codex-cli 0.157.1 printed it
  // on 2026-10-06 (no provider call): every review feature off, unified_exec still on.
  const installedListing = fixture('codex-0.157.1-features-review-disabled.txt');
  let versions = 0;
  beforeEach(() => {
    // A fresh version per case, so the per-binary cache never hides a probe.
    versions += 1;
    codexProbe.version = `codex-cli 0.157.1-case-${String(versions)}`;
    codexProbe.listing = undefined;
    codexProbe.calls.length = 0;
  });
  afterEach(() => {
    codexProbe.version = 'codex-cli offline-stub';
    codexProbe.listing = undefined;
  });
  const env = { PATH: process.env.PATH ?? '' };

  it('accepts the installed 0.157.1 listing, where unified_exec stays on', () => {
    codexProbe.listing = () => ({ status: 0, stdout: installedListing, stderr: '' });
    expect(() => assertCodexReviewCompatibility(env, '/')).not.toThrow();
    expect(installedListing).toMatch(/^unified_exec\s+stable\s+true$/mu);
    const listed = codexProbe.calls.find((argv) => argv[0] === 'features');
    expect(
      listed?.flatMap((value, index) => (value === '--disable' ? [listed[index + 1]] : [])),
    ).toEqual([...CODEX_REVIEW_DISABLED_FEATURES]);
  });

  it('refuses a binary that does not know a review feature, before the provider runs', async () => {
    codexProbe.listing = () => ({
      status: 1,
      stdout: '',
      stderr: 'Error: Unknown feature flag: tool_suggest\n',
    });
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      'MODEL_BRIDGE_CODEX_INCOMPATIBLE:unknown-feature:tool_suggest',
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('refuses a feature the binary still reports on after --disable', async () => {
    codexProbe.listing = () => ({
      status: 0,
      stdout: installedListing.replace(/^shell_tool(\s+stable\s+)false$/mu, 'shell_tool$1true'),
      stderr: '',
    });
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      'MODEL_BRIDGE_CODEX_INCOMPATIBLE:feature-enabled:shell_tool',
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('refuses a listing that omits a review feature', async () => {
    codexProbe.listing = () => ({
      status: 0,
      stdout: installedListing.replace(/^skill_search\s.*$/mu, ''),
      stderr: '',
    });
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      'MODEL_BRIDGE_CODEX_INCOMPATIBLE:unknown-feature:skill_search',
    );
  });

  it('refuses when the version probe fails', async () => {
    codexProbe.version = null;
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      'MODEL_BRIDGE_CODEX_INCOMPATIBLE:version:127',
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('checks each binary version once per process', async () => {
    codexProbe.listing = () => ({ status: 0, stdout: installedListing, stderr: '' });
    await observe('codex-cli', codexFixture);
    await observe('codex-cli', codexFixture);
    expect(codexProbe.calls.filter((argv) => argv[0] === 'features')).toHaveLength(1);
    expect(codexProbe.calls.filter((argv) => argv[0] === '--version')).toHaveLength(2);
    codexProbe.version = `${codexProbe.version}-upgraded`;
    await observe('codex-cli', codexFixture);
    expect(codexProbe.calls.filter((argv) => argv[0] === 'features')).toHaveLength(2);
  });

  it('never probes for a Claude review', async () => {
    await observe('claude-cli', claudeFixture);
    expect(codexProbe.calls).toEqual([]);
  });
});

describe('#321 Codex executable resolution and listing integrity', () => {
  let versions = 0;
  const savedPath = process.env.PATH;
  const dirs: string[] = [];
  beforeEach(() => {
    versions += 1;
    codexProbe.version = `codex-cli resolution-case-${String(versions)}`;
    codexProbe.listing = undefined;
    codexProbe.calls.length = 0;
    codexProbe.executables.length = 0;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    codexProbe.version = 'codex-cli offline-stub';
    codexProbe.listing = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dir = () => {
    const created = realpathSync(mkdtempSync(join(tmpdir(), 'devai-codex-resolve-')));
    dirs.push(created);
    return created;
  };

  it('skips a non-executable or non-file codex and runs one executable for probes and review', async () => {
    const shadow = dir();
    writeFileSync(join(shadow, 'codex'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(shadow, 'codex'), 0o644);
    const directoryShadow = dir();
    mkdirSync(join(directoryShadow, 'codex'));
    const real = dir();
    writeFileSync(join(real, 'codex'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(real, 'codex'), 0o755);
    process.env.PATH = [shadow, directoryShadow, real, savedPath ?? ''].join(delimiter);
    expect(resolveCodexExecutable(process.env.PATH, '/')).toBe(join(real, 'codex'));
    const response = await observe('codex-cli', codexFixture);
    expect(response.finish_reason).toBe('stop');
    expect(new Set(codexProbe.executables)).toEqual(new Set([join(real, 'codex')]));
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(join(real, 'codex'));
  });

  it('refuses before any spawn when no executable codex is on PATH', async () => {
    const shadow = dir();
    writeFileSync(join(shadow, 'codex'), 'not executable');
    process.env.PATH = shadow;
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      'MODEL_BRIDGE_CODEX_INCOMPATIBLE:executable:not-found',
    );
    expect(codexProbe.calls).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  const rows = (overrides: Record<string, string> = {}) =>
    CODEX_REVIEW_DISABLED_FEATURES.map(
      (feature) => overrides[feature] ?? `${feature}  stable  false`,
    ).join('\n');

  it.each([
    [
      'a duplicate row that would flip the state',
      `${rows()}\nshell_tool  stable  true`,
      'shell_tool',
    ],
    ['a duplicate row with the same state', `shell_tool  stable  false\n${rows()}`, 'shell_tool'],
    ['a row without a state', rows({ apps: 'apps  stable' }), 'line-2'],
    ['a row with an unknown state', rows({ plugins: 'plugins  stable  maybe' }), 'line-7'],
    ['a stray error line', `Error: something else\n${rows()}`, 'line-1'],
    ['an extra boolean token', `shell_tool  stable  true false\n${rows()}`, 'line-1'],
    ['a stage outside the 0.157.1 set', rows({ apps: 'apps  beta  false' }), 'line-2'],
  ])('refuses a listing with %s', async (_name, stdout, detail) => {
    codexProbe.listing = () => ({ status: 0, stdout, stderr: '' });
    await expect(observe('codex-cli', codexFixture)).rejects.toThrow(
      `MODEL_BRIDGE_CODEX_INCOMPATIBLE:listing-malformed:${detail}`,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('accepts multi-word stages such as under development', async () => {
    codexProbe.listing = () => ({
      status: 0,
      stdout: `${rows()}\nagent_message_board                      under development  false\n`,
      stderr: '',
    });
    await expect(observe('codex-cli', codexFixture)).resolves.toMatchObject({
      finish_reason: 'stop',
    });
  });
});

describe('#321 Codex resolution against the child working directory and cache freshness', () => {
  const dirs: string[] = [];
  let versions = 0;
  beforeEach(() => {
    versions += 1;
    codexProbe.version = `codex-cli freshness-case-${String(versions)}`;
    codexProbe.listing = undefined;
    codexProbe.calls.length = 0;
  });
  afterEach(() => {
    codexProbe.version = 'codex-cli offline-stub';
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves relative and empty PATH entries against the child working directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-codex-relative-')));
    dirs.push(root);
    mkdirSync(join(root, 'work'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'codex'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(root, 'bin', 'codex'), 0o755);
    expect(resolveCodexExecutable('../bin', join(root, 'work'))).toBe(join(root, 'bin', 'codex'));
    expect(resolveCodexExecutable('bin', root)).toBe(join(root, 'bin', 'codex'));
    // An empty entry is the working directory itself, never the parent process cwd.
    expect(resolveCodexExecutable(`${delimiter}/nonexistent`, join(root, 'bin'))).toBe(
      join(root, 'bin', 'codex'),
    );
    expect(resolveCodexExecutable('bin', join(root, 'work'))).toBeUndefined();
  });

  it('checks a binary again after its file changes under the same path and version', async () => {
    const executable = resolveCodexExecutable(process.env.PATH, '/');
    if (executable === undefined) throw new Error('placeholder codex missing');
    await observe('codex-cli', codexFixture);
    await observe('codex-cli', codexFixture);
    expect(codexProbe.calls.filter((argv) => argv[0] === 'features')).toHaveLength(1);
    writeFileSync(executable, '#!/bin/sh\n# rebuilt placeholder\nexit 99\n');
    utimesSync(executable, new Date(), new Date(Date.now() + 5000));
    await observe('codex-cli', codexFixture);
    expect(codexProbe.calls.filter((argv) => argv[0] === 'features')).toHaveLength(2);
  });
});
