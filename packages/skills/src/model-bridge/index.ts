import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { spawnSync } from '@devai-nyx/authority';

export type ModelProvider = 'claude' | 'codex' | 'claude-cli' | 'codex-cli';

export interface ModelBridgeOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly timeout_ms?: number;
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
  readonly finish_reason: 'stop' | 'length' | 'tool_use' | 'error';
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

function cliResponse(options: ModelBridgeOptions, system: string, user: string): BridgeResponse {
  const started = Date.now();
  const cli = options.provider === 'claude-cli' ? 'claude' : 'codex';
  const prompt = `[SYSTEM]\n${system}\n\n[USER]\n${user}`;
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
          prompt,
        ];
  const result = spawnSync(cli, argv, {
    encoding: 'utf8',
    timeout: options.timeout_ms ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `MODEL_BRIDGE_CLI_FAILED:${cli}:${result.error?.message ?? String(result.status)}`,
    );
  }
  const stdout = String(result.stdout ?? '');
  if (cli === 'claude') {
    const envelope = JSON.parse(stdout) as {
      readonly result?: string;
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
      finish_reason: 'stop',
      latency_ms: Date.now() - started,
      ...(envelope.structured_output === undefined ? {} : { json: envelope.structured_output }),
    };
  }
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event['type'] === 'item.completed') {
      const item = event['item'] as Record<string, unknown> | undefined;
      if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string')
        text = item['text'];
    }
    if (event['type'] === 'turn.completed') {
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
    finish_reason: 'stop',
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
      call?: {
        readonly max_output_tokens?: number;
        readonly temperature?: number;
        readonly response_format_json?: boolean;
      },
    ): Promise<BridgeResponse> {
      if (options.provider.endsWith('-cli'))
        return cliResponse(options, messages.system, messages.user);
      const started = Date.now();
      if (options.provider === 'claude') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('MODEL_BRIDGE_ANTHROPIC_KEY_REQUIRED');
        const response = await new Anthropic({ apiKey }).messages.create(
          {
            model: options.model,
            max_tokens: call?.max_output_tokens ?? 4096,
            temperature: call?.temperature ?? 0,
            system: messages.system,
            messages: [{ role: 'user', content: messages.user }],
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
          finish_reason: response.stop_reason === 'max_tokens' ? 'length' : 'stop',
          latency_ms: Date.now() - started,
          ...(parsedJson(text, call?.response_format_json === true) === undefined
            ? {}
            : { json: parsedJson(text, true) }),
        };
      }
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('MODEL_BRIDGE_OPENAI_KEY_REQUIRED');
      const response = await new OpenAI({ apiKey }).chat.completions.create(
        {
          model: options.model,
          max_tokens: call?.max_output_tokens ?? 4096,
          temperature: call?.temperature ?? 0,
          messages: [
            { role: 'system', content: messages.system },
            { role: 'user', content: messages.user },
          ],
          ...(call?.response_format_json === true
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
        finish_reason: response.choices[0]?.finish_reason === 'length' ? 'length' : 'stop',
        latency_ms: Date.now() - started,
        ...(parsedJson(text, call?.response_format_json === true) === undefined
          ? {}
          : { json: parsedJson(text, true) }),
      };
    },
  });
}
