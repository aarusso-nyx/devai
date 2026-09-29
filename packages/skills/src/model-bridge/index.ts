import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { loadSchema } from '@devai-nyx/schemas';
import type { ReplySchemaName } from './extract.js';

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
function providerSchema(name: ReplySchemaName): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) => !['$schema', '$id', 'schema_version', 'examples', 'default'].includes(key),
        )
        .map(([key, member]) => [key, strip(member)]),
    );
  };
  return strip(structuredClone(loadSchema(name))) as Record<string, unknown>;
}

function providerSchemaName(name: ReplySchemaName): string {
  return name.replace(/\.schema\.json$/u, '').replace(/-/gu, '_');
}

interface BridgeResponse {
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
}

function parsedJson(text: string, requested: boolean): unknown | undefined {
  if (!requested) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** claude -p result envelope: a real finish from `is_error` and `stop_reason`. */
function claudeCliFinish(envelope: {
  readonly is_error?: unknown;
  readonly subtype?: unknown;
  readonly stop_reason?: unknown;
}): FinishReason {
  if (envelope.is_error === true) return 'error';
  if (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error')) return 'error';
  if (envelope.stop_reason === 'max_tokens') return 'length';
  if (envelope.stop_reason === 'tool_use') return 'tool_use';
  return 'stop';
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
    call?.response_schema === undefined ? undefined : providerSchema(call.response_schema);
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
  if (cli === 'claude') {
    const envelope = JSON.parse(stdout) as {
      readonly result?: string;
      readonly is_error?: unknown;
      readonly subtype?: unknown;
      readonly stop_reason?: unknown;
      readonly structured_output?: unknown;
      readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
      readonly total_cost_usd?: number;
      readonly model?: string;
    };
    const text =
      envelope.structured_output === undefined
        ? (envelope.result ?? '')
        : JSON.stringify(envelope.structured_output);
    return {
      text,
      family: options.provider,
      model: envelope.model ?? options.model,
      usage: {
        input_tokens: envelope.usage?.input_tokens ?? 0,
        output_tokens: envelope.usage?.output_tokens ?? 0,
        cost_usd: envelope.total_cost_usd ?? 0,
      },
      finish_reason: claudeCliFinish(envelope),
      latency_ms: Date.now() - started,
      ...(envelope.structured_output === undefined ? {} : { json: envelope.structured_output }),
    };
  }
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = false;
  let failed = false;
  for (const line of stdout.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event['type'] === 'item.completed') {
      const item = event['item'] as Record<string, unknown> | undefined;
      if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string')
        text = item['text'];
    }
    if (event['type'] === 'turn.failed' || event['type'] === 'error') failed = true;
    if (event['type'] === 'turn.completed') {
      completed = true;
      const usage = event['usage'] as Record<string, unknown> | undefined;
      inputTokens =
        Number(usage?.['input_tokens'] ?? 0) + Number(usage?.['cached_input_tokens'] ?? 0);
      outputTokens = Number(usage?.['output_tokens'] ?? 0);
    }
  }
  return {
    text,
    family: options.provider,
    model: options.model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: 0 },
    // codex exec reports a finished turn only through turn.completed; a failed turn or a
    // stream that ends without one is never a completed reply.
    finish_reason: completed && !failed ? 'stop' : 'error',
    latency_ms: Date.now() - started,
    ...(parsedJson(text, true) === undefined ? {} : { json: parsedJson(text, true) }),
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
        call?.response_schema === undefined ? undefined : providerSchema(call.response_schema);
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
          finish_reason:
            response.stop_reason === 'max_tokens'
              ? 'length'
              : response.stop_reason === 'tool_use'
                ? 'tool_use'
                : response.stop_reason === 'refusal'
                  ? 'error'
                  : 'stop',
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
                  json_schema: { name: providerSchemaName(call.response_schema), schema },
                },
              }
            : call?.response_format_json === true
              ? { response_format: { type: 'json_object' as const } }
              : {}),
        },
        { timeout: options.timeout_ms ?? 120_000 },
      );
      const text = response.choices[0]?.message.content ?? '';
      return {
        text,
        family: options.provider,
        model: options.model,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? 0,
          output_tokens: response.usage?.completion_tokens ?? 0,
          cost_usd: 0,
        },
        finish_reason:
          response.choices[0]?.finish_reason === 'length'
            ? 'length'
            : response.choices[0]?.finish_reason === 'tool_calls'
              ? 'tool_use'
              : response.choices[0]?.finish_reason === 'content_filter'
                ? 'error'
                : 'stop',
        latency_ms: Date.now() - started,
        ...(parsedJson(text, wantsJson) === undefined ? {} : { json: parsedJson(text, true) }),
      };
    },
  });
}
