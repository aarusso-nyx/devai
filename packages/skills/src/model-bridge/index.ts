import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { loadSchema } from '@devai-nyx/schemas';
import type { ReplySchemaName, StructuredReply } from './extract.js';

export * from './extract.js';

async function optionalModule<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`OPTIONAL_DEPENDENCY_MISSING:${name}`);
    }
    throw error;
  }
}

export type ModelProvider = 'claude' | 'codex' | 'claude-cli' | 'codex-cli';

export interface ModelBridgeOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly timeout_ms?: number;
}

/** Per-call request options. `response_schema` names the consumer's reply contract. */
export interface ModelBridgeCallOptions {
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly response_format_json?: boolean;
  readonly response_schema?: ReplySchemaName;
}

type FinishReason = 'stop' | 'length' | 'tool_use' | 'error';

/**
 * The consumer schema as a provider receives it: the governed document without its
 * identity and documentation-only members, which structured-output hosts do not read.
 */
function providerSchema(name: ReplySchemaName, strict: boolean): Record<string, unknown> {
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value))
      return value.map((member, index) => visit(member, `${path}/${index}`));
    if (value === null || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const out = Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key]) => !['$schema', '$id', 'schema_version', 'examples', 'default'].includes(key),
        )
        .map(([key, member]) => [key, visit(member, `${path}/${key}`)]),
    );
    if (strict && node['type'] === 'object') {
      if (
        node['additionalProperties'] !== false ||
        !node['properties'] ||
        !Array.isArray(node['required'])
      ) {
        throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
      }
      const properties = out['properties'] as Record<string, unknown>;
      for (const key of Object.keys(properties)) {
        if ((node['required'] as string[]).includes(key)) continue;
        const position = `${path}/properties/${key}`;
        if (
          name !== 'review-verdict.schema.json' ||
          ![
            '/properties/findings',
            '/$defs/finding/properties/file',
            '/$defs/finding/properties/line',
          ].includes(position)
        )
          throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
        properties[key] = { anyOf: [properties[key], { type: 'null' }] };
      }
      out['required'] = Object.keys(properties);
    }
    return out;
  };
  return visit(loadSchema(name), '') as Record<string, unknown>;
}

function projectionIdentity(
  name: ReplySchemaName | undefined,
  schema: Record<string, unknown> | undefined,
): StructuredReply['projection'] {
  return name === undefined || schema === undefined
    ? undefined
    : {
        version: 'strict-reply-v1',
        schema: name,
        schema_sha256: createHash('sha256').update(JSON.stringify(schema), 'utf8').digest('hex'),
      };
}

function providerSchemaName(name: ReplySchemaName): string {
  return name.replace(/\.schema\.json$/u, '').replace(/-/gu, '_');
}

interface BridgeResponse extends StructuredReply {
  readonly text: string;
  readonly family: string;
  readonly model: string;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cost_usd: number;
  };
  readonly finish_reason: FinishReason;
  readonly latency_ms: number;
  readonly json?: unknown;
  /** Only inventories actually present in the host transcript are reported. */
  readonly isolation?: {
    readonly tools: readonly unknown[];
    readonly mcp_servers: readonly unknown[];
  };
}

function parsedJson(text: string, requested: boolean): unknown | undefined {
  if (!requested) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Actual requests/refusals anywhere in a transcript remain failures. A formatter name is no exception. */
function unsafeEvent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsafeEvent);
  const node = record(value);
  if (node === undefined) return false;
  if (
    typeof node['type'] === 'string' &&
    /tool|mcp|command_execution|refusal|error|failed/iu.test(node['type'])
  )
    return true;
  if (
    node['is_error'] === true ||
    (node['status'] !== undefined &&
      !['in_progress', 'completed', 'success'].includes(String(node['status']))) ||
    (node['stop_reason'] !== undefined &&
      !['end_turn', 'stop_sequence'].includes(String(node['stop_reason']))) ||
    (node['finish_reason'] !== undefined && node['finish_reason'] !== 'stop') ||
    node['error'] != null ||
    node['function_call'] != null ||
    (node['refusal'] != null && node['refusal'] !== '') ||
    (node['tool_calls'] != null &&
      (!Array.isArray(node['tool_calls']) || node['tool_calls'].length > 0))
  )
    return true;
  for (const key of ['tools', 'mcp_servers']) {
    if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length > 0)) return true;
  }
  return Object.values(node).some(unsafeEvent);
}

function statusMatches(values: readonly unknown[], allowed: readonly string[]): boolean {
  return values.every((value) => {
    const status = record(value)?.['status'];
    return status === undefined || (typeof status === 'string' && allowed.includes(status));
  });
}

/** Reconcile metadata that the host actually observed; absent optional fields stay absent. */
function transcriptState() {
  let failed = false;
  const identities = new Map<string, string>();
  const items = new Map<string, { type: string; open: boolean }>();
  const anonymous = new Set<string>();
  const identity = (kind: string, values: unknown[]) => {
    for (const value of values) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length === 0) {
        failed = true;
        continue;
      }
      const prior = identities.get(kind);
      if (prior !== undefined && prior !== value) failed = true;
      identities.set(kind, value);
    }
  };
  return {
    identity,
    item(
      node: Record<string, unknown>,
      type: string,
      phase: 'started' | 'updated' | 'completed',
      eventId?: unknown,
    ) {
      const allowed = phase === 'completed' ? 'completed' : 'in_progress';
      if (node['status'] !== undefined && node['status'] !== allowed) failed = true;
      const ids = [node['id'], eventId].filter((id) => id !== undefined);
      if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size > 1) {
        failed = true;
        return;
      }
      const id = ids[0] as string | undefined;
      if (id === undefined) {
        if (phase === 'started' && anonymous.has(type)) failed = true;
        if (phase === 'completed') anonymous.delete(type);
        else anonymous.add(type);
        return;
      }
      const prior = items.get(id);
      if (prior !== undefined && (prior.type !== type || !prior.open || phase === 'started'))
        failed = true;
      items.set(id, { type, open: phase !== 'completed' });
    },
    complete() {
      return !failed && anonymous.size === 0 && ![...items.values()].some((item) => item.open);
    },
  };
}

function claudeContent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((part) => {
      const item = record(part);
      return (
        item !== undefined &&
        ['text', 'thinking', 'redacted_thinking'].includes(String(item['type']))
      );
    })
  );
}

/** Only recognized SDK control containers are inspected; selected JSON/text remains data. */
function apiFinish(provider: ModelProvider, value: unknown): FinishReason {
  const response = record(value);
  if (response === undefined) return 'error';
  const containers: Record<string, unknown>[] = [response];
  let reason: unknown;
  if (provider === 'claude') {
    if (
      (response['type'] !== undefined && response['type'] !== 'message') ||
      (response['role'] !== undefined && response['role'] !== 'assistant') ||
      !claudeContent(response['content'])
    )
      return 'error';
    reason = response['stop_reason'];
    containers.push(...(response['content'] as Record<string, unknown>[]));
  } else {
    const choices = response['choices'];
    if (
      (response['object'] !== undefined && response['object'] !== 'chat.completion') ||
      !Array.isArray(choices) ||
      choices.length !== 1
    )
      return 'error';
    for (const choice of choices) {
      const selected = record(choice);
      const message = record(selected?.['message']);
      if (
        selected === undefined ||
        message === undefined ||
        (message['role'] !== undefined && message['role'] !== 'assistant')
      )
        return 'error';
      reason = selected['finish_reason'];
      containers.push(selected, message);
    }
  }
  // A supplied SDK container is metadata, unlike parsed verdicts or content text.
  for (const node of containers) {
    if (node['container'] !== undefined && node['container'] !== null) {
      const container = record(node['container']);
      if (container === undefined) return 'error';
      if (!containers.includes(container)) containers.push(container);
    }
  }
  const completion = (marker: unknown): 'stop' | 'length' | undefined => {
    if (['stop', 'end_turn', 'stop_sequence', 'completed'].includes(String(marker))) return 'stop';
    if (['length', 'max_tokens'].includes(String(marker))) return 'length';
    return undefined;
  };
  const finish =
    provider === 'claude'
      ? reason === 'end_turn' || reason === 'stop_sequence'
        ? 'stop'
        : reason === 'max_tokens'
          ? 'length'
          : undefined
      : reason === 'stop'
        ? 'stop'
        : reason === 'length'
          ? 'length'
          : undefined;
  if (finish === undefined || !statusMatches(containers, ['completed'])) return 'error';
  for (const node of containers) {
    if (
      node['is_error'] === true ||
      node['error'] != null ||
      (node['refusal'] != null && node['refusal'] !== '') ||
      node['function_call'] != null ||
      (node['tool_calls'] != null &&
        (!Array.isArray(node['tool_calls']) || node['tool_calls'].length > 0)) ||
      (typeof node['type'] === 'string' &&
        /tool|mcp|command_execution|refusal|error|failed/iu.test(node['type']))
    )
      return 'error';
    for (const key of ['tools', 'mcp_servers']) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length > 0))
        return 'error';
    }
    for (const key of ['stop_reason', 'finish_reason', 'terminal_reason']) {
      if (node[key] !== undefined && completion(node[key]) !== finish) return 'error';
    }
  }
  return finish;
}

function inventories(events: readonly Record<string, unknown>[]): BridgeResponse['isolation'] {
  const event = events.find(
    (entry) => Array.isArray(entry['tools']) && Array.isArray(entry['mcp_servers']),
  );
  return event === undefined
    ? undefined
    : {
        tools: event['tools'] as unknown[],
        mcp_servers: event['mcp_servers'] as unknown[],
      };
}

function hostEvents(stdout: string): Record<string, unknown>[] {
  let values: unknown[];
  try {
    values = [JSON.parse(stdout) as unknown];
  } catch {
    values = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
  return values.map((value) => {
    const event = record(value);
    if (event === undefined) throw new Error('MODEL_BRIDGE_HOST_EVENT_INVALID');
    return event;
  });
}

function claudeCliFinish(envelope: Record<string, unknown>): FinishReason {
  if (
    envelope['type'] !== 'result' ||
    envelope['subtype'] !== 'success' ||
    envelope['is_error'] !== false ||
    !statusMatches([envelope, record(envelope['turn'])], ['completed', 'success']) ||
    unsafeEvent({ ...envelope, stop_reason: undefined })
  )
    return 'error';
  if (envelope['stop_reason'] === 'max_tokens') return 'length';
  if (envelope['terminal_reason'] !== undefined && envelope['terminal_reason'] !== 'completed')
    return 'error';
  if (envelope['stop_reason'] === 'tool_use') {
    return envelope['terminal_reason'] === 'completed' &&
      record(envelope['structured_output']) !== undefined
      ? 'stop'
      : 'tool_use';
  }
  return envelope['stop_reason'] === 'end_turn' || envelope['stop_reason'] === 'stop_sequence'
    ? 'stop'
    : 'error';
}

function cliResponse(
  options: ModelBridgeOptions,
  system: string,
  user: string,
  call: ModelBridgeCallOptions | undefined,
): BridgeResponse {
  const started = Date.now();
  const cli = options.provider === 'claude-cli' ? 'claude' : 'codex';
  const prompt = `[SYSTEM]\n${system}\n\n[USER]\n${user}`;
  const schema =
    call?.response_schema === undefined
      ? undefined
      : providerSchema(call.response_schema, options.provider.startsWith('codex'));
  let schemaDir: string | undefined;
  let schemaPath: string | undefined;
  if (cli === 'codex' && schema !== undefined && call?.response_schema !== undefined) {
    schemaDir = mkdtempSync(join(tmpdir(), 'devai-model-bridge-'));
    schemaPath = join(schemaDir, call.response_schema);
    writeFileSync(schemaPath, JSON.stringify(schema), 'utf8');
  }
  const argv =
    cli === 'claude'
      ? [
          '--print',
          '--no-session-persistence',
          '--safe-mode',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--tools',
          '',
          '--model',
          options.model,
          '--output-format',
          'json',
          ...(schema === undefined ? [] : ['--json-schema', JSON.stringify(schema)]),
          prompt,
        ]
      : [
          'exec',
          '--model',
          options.model,
          '--json',
          '--ephemeral',
          '--sandbox',
          'read-only',
          ...(schemaPath === undefined ? [] : ['--output-schema', schemaPath]),
          prompt,
        ];
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(cli, argv, {
      encoding: 'utf8',
      timeout: options.timeout_ms ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    if (schemaDir !== undefined) rmSync(schemaDir, { recursive: true, force: true });
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `MODEL_BRIDGE_CLI_FAILED:${cli}:${result.error?.message ?? String(result.status)}`,
    );
  }
  const stdout = String(result.stdout ?? '');
  const events = hostEvents(stdout);
  const isolation = inventories(events);
  if (cli === 'claude') {
    const terminals = events.filter((event) => event['type'] === 'result');
    const envelope = terminals[0] ?? {};
    const structured = envelope['structured_output'];
    const text =
      structured === undefined
        ? typeof envelope['result'] === 'string'
          ? envelope['result']
          : ''
        : JSON.stringify(structured);
    let finish = claudeCliFinish(envelope);
    const state = transcriptState();
    for (const event of events) {
      state.identity('session', [event['session_id']]);
      state.identity('thread', [event['thread_id'], record(event['thread'])?.['id']]);
      state.identity('turn', [event['turn_id'], record(event['turn'])?.['id']]);
      if (event['type'] === 'assistant') {
        const message = record(event['message']);
        const statuses = [event['status'], message?.['status']].filter(
          (status) => status !== undefined,
        );
        if (
          message === undefined ||
          !claudeContent(message['content']) ||
          new Set(statuses).size > 1
        )
          finish = 'error';
        if (message !== undefined) {
          const phase = statuses[0] === 'in_progress' ? 'updated' : 'completed';
          state.item(
            { ...message, ...(statuses.length === 0 ? {} : { status: statuses[0] }) },
            'assistant',
            phase,
            event['message_id'],
          );
          state.identity('turn', [message['turn_id']]);
          state.identity('thread', [message['thread_id']]);
        }
      }
      if (
        (event !== envelope && unsafeEvent(event)) ||
        !['result', 'system', 'assistant'].includes(String(event['type'])) ||
        (event['type'] === 'system' &&
          (event['subtype'] !== 'init' ||
            (event['status'] !== undefined &&
              !['completed', 'success'].includes(String(event['status'])))))
      )
        finish = 'error';
    }
    if (terminals.length !== 1 || events.at(-1) !== envelope || !state.complete()) finish = 'error';
    const usage = record(envelope['usage']);
    return {
      text,
      family: options.provider,
      model: typeof envelope['model'] === 'string' ? envelope['model'] : options.model,
      usage: {
        input_tokens: Number(usage?.['input_tokens'] ?? 0),
        output_tokens: Number(usage?.['output_tokens'] ?? 0),
        cost_usd: Number(envelope['total_cost_usd'] ?? 0),
      },
      finish_reason: finish,
      latency_ms: Date.now() - started,
      ...(structured === undefined ? {} : { json: structured }),
      ...(isolation === undefined ? {} : { isolation }),
    };
  }
  const finals: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = 0;
  let failed = false;
  let threadStarts = 0;
  let turnStarts = 0;
  let sawItem = false;
  const state = transcriptState();
  for (const event of events) {
    if (unsafeEvent(event)) failed = true;
    const type = event['type'];
    state.identity('session', [event['session_id'], record(event['session'])?.['id']]);
    state.identity('thread', [event['thread_id'], record(event['thread'])?.['id']]);
    state.identity('turn', [event['turn_id'], record(event['turn'])?.['id']]);
    if (type === 'thread.started') {
      threadStarts += 1;
      state.identity('thread', [event['id']]);
      if (
        threadStarts !== 1 ||
        sawItem ||
        turnStarts > 0 ||
        finals.length > 0 ||
        !statusMatches([event, record(event['thread'])], ['in_progress'])
      )
        failed = true;
    }
    if (type === 'turn.started') {
      turnStarts += 1;
      state.identity('turn', [event['id']]);
      if (
        turnStarts !== 1 ||
        sawItem ||
        finals.length > 0 ||
        !statusMatches([event, record(event['turn'])], ['in_progress'])
      )
        failed = true;
    }
    if (
      ![
        'thread.started',
        'turn.started',
        'turn.completed',
        'item.started',
        'item.updated',
        'item.completed',
      ].includes(String(type))
    )
      failed = true;
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      sawItem = true;
      const item = record(event['item']);
      if (item === undefined || !['agent_message', 'reasoning'].includes(String(item['type'])))
        failed = true;
      if (
        !statusMatches([event, item], type === 'item.completed' ? ['completed'] : ['in_progress'])
      )
        failed = true;
      if (item !== undefined) {
        state.item(
          item,
          String(item['type']),
          type === 'item.started' ? 'started' : type === 'item.updated' ? 'updated' : 'completed',
          event['item_id'],
        );
        state.identity('session', [item['session_id'], record(item['session'])?.['id']]);
        state.identity('turn', [item['turn_id']]);
        state.identity('thread', [item['thread_id']]);
      }
      if (type === 'item.completed' && item?.['type'] === 'agent_message') {
        if (typeof item['text'] === 'string') finals.push(item['text']);
        else failed = true;
      }
    }
    if (completed > 0) failed = true;
    if (type === 'turn.completed') {
      state.identity('turn', [event['id']]);
      if (finals.length !== 1 || !state.complete()) failed = true;
      if (
        !statusMatches([event, record(event['turn'])], ['completed']) ||
        (event['finish_reason'] !== undefined && event['finish_reason'] !== 'stop') ||
        (event['terminal_reason'] !== undefined && event['terminal_reason'] !== 'completed')
      )
        failed = true;
      completed += 1;
      const usage = record(event['usage']);
      inputTokens =
        Number(usage?.['input_tokens'] ?? 0) + Number(usage?.['cached_input_tokens'] ?? 0);
      outputTokens = Number(usage?.['output_tokens'] ?? 0);
    }
  }
  const text = finals[0] ?? '';
  const projection = projectionIdentity(call?.response_schema, schema);
  return {
    text,
    family: options.provider,
    model: options.model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: 0 },
    finish_reason:
      completed === 1 && finals.length === 1 && !failed && state.complete() ? 'stop' : 'error',
    latency_ms: Date.now() - started,
    ...(parsedJson(text, true) === undefined ? {} : { json: parsedJson(text, true) }),
    ...(projection === undefined ? {} : { projection }),
    ...(isolation === undefined ? {} : { isolation }),
  };
}

export function createModelBridge(options: ModelBridgeOptions) {
  if (options.model.trim().length === 0) throw new Error('MODEL_BRIDGE_MODEL_REQUIRED');
  return Object.freeze({
    family: options.provider,
    model: options.model,
    async complete(
      messages: { readonly system: string; readonly user: string },
      _meta: Readonly<Record<string, unknown>>,
      call?: ModelBridgeCallOptions,
    ): Promise<BridgeResponse> {
      if (options.provider.endsWith('-cli'))
        return cliResponse(options, messages.system, messages.user, call);
      const started = Date.now();
      const schema =
        call?.response_schema === undefined
          ? undefined
          : providerSchema(call.response_schema, options.provider.startsWith('codex'));
      const wantsJson = call?.response_format_json === true || schema !== undefined;
      if (options.provider === 'claude') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('MODEL_BRIDGE_ANTHROPIC_KEY_REQUIRED');
        const { default: Anthropic } = await optionalModule(
          '@anthropic-ai/sdk',
          () => import('@anthropic-ai/sdk'),
        );
        const response = await new Anthropic({ apiKey }).messages.create(
          {
            model: options.model,
            max_tokens: call?.max_output_tokens ?? 4096,
            temperature: call?.temperature ?? 0,
            system: messages.system,
            messages: [{ role: 'user', content: messages.user }],
            tools: [],
            ...(schema === undefined
              ? {}
              : { output_config: { format: { type: 'json_schema' as const, schema } } }),
          },
          { timeout: options.timeout_ms ?? 120_000 },
        );
        const text = response.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        return {
          text,
          family: options.provider,
          model: options.model,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cost_usd: 0,
          },
          finish_reason: apiFinish(options.provider, response),
          latency_ms: Date.now() - started,
          ...(parsedJson(text, wantsJson) === undefined ? {} : { json: parsedJson(text, true) }),
        };
      }
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('MODEL_BRIDGE_OPENAI_KEY_REQUIRED');
      const { default: OpenAI } = await optionalModule('openai', () => import('openai'));
      const response = await new OpenAI({ apiKey }).chat.completions.create(
        {
          model: options.model,
          tools: [],
          tool_choice: 'none',
          max_tokens: call?.max_output_tokens ?? 4096,
          temperature: call?.temperature ?? 0,
          messages: [
            { role: 'system', content: messages.system },
            { role: 'user', content: messages.user },
          ],
          ...(schema !== undefined && call?.response_schema !== undefined
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: providerSchemaName(call.response_schema),
                    strict: true,
                    schema,
                  },
                },
              }
            : call?.response_format_json === true
              ? { response_format: { type: 'json_object' as const } }
              : {}),
        },
        { timeout: options.timeout_ms ?? 120_000 },
      );
      const text = response.choices[0]?.message.content ?? '';
      const projection = projectionIdentity(call?.response_schema, schema);
      return {
        text,
        family: options.provider,
        model: options.model,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? 0,
          output_tokens: response.usage?.completion_tokens ?? 0,
          cost_usd: 0,
        },
        finish_reason: apiFinish(options.provider, response),
        ...(projection === undefined ? {} : { projection }),
        latency_ms: Date.now() - started,
        ...(parsedJson(text, wantsJson) === undefined ? {} : { json: parsedJson(text, true) }),
      };
    },
  });
}
