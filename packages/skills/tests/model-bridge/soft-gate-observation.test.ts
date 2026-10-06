// Invariants: INV-HARNESS-006
// ADR-MDL-0004 IA-004/005: offline adapter observations are never live isolation proof.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // The Codex compatibility probe (`--version`, `features list`) answers as a binary that
  // honours every --disable; spawnSyncMock sees only the review itself.
  spawnSync: (cli: string, argv: string[], options: unknown) =>
    /(^|\/)codex$/u.test(cli) && (argv[0] === '--version' || argv[0] === 'features')
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

const { createModelBridge } = await import('../../src/model-bridge/index.js');
const reply = JSON.stringify({
  verdict: 'pass',
  confidence: 1,
  rationale: 'Offline legacy-shaped completion.',
});
const events = () => [
  { type: 'thread.started', tools: [], mcp_servers: [] },
  { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: reply } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];
const complete = async (stream: unknown[]) => {
  spawnSyncMock.mockReturnValue({
    status: 0,
    stdout: stream.map((event) => JSON.stringify(event)).join('\n'),
    stderr: '',
  });
  return createModelBridge({
    provider: 'codex-cli',
    model: 'offline-fixture-model',
    timeout_ms: 1000,
  }).complete(
    { system: 'Offline fixture.', user: 'Return a fixture.' },
    {},
    { response_schema: 'review-verdict.schema.json' },
  );
};
beforeEach(() => spawnSyncMock.mockReset());
describe('actual model bridge completion and no-tool observations (offline)', () => {
  it('retains the final raw reply and explicitly observed empty inventories', async () => {
    expect(await complete(events())).toMatchObject({
      text: reply,
      finish_reason: 'stop',
      isolation: { tools: [], mcp_servers: [] },
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
  it('does not infer inventory observation from sandbox flags', async () => {
    const result = await complete(events().slice(1));
    expect(result.isolation).toBeUndefined();
  });
  it.each(['command_execution', 'mcp_tool_call'])(
    'rejects %s host events despite a final pass reply',
    async (type) => {
      const stream = events();
      stream.splice(1, 0, {
        type: 'item.completed',
        item: { id: 'unsafe', type, text: reply },
      } as never);
      const result = await complete(stream);
      expect(result.finish_reason).not.toBe('stop');
    },
  );
  it('requires positive turn completion rather than successful process status alone', async () => {
    expect((await complete(events().slice(0, -1))).finish_reason).not.toBe('stop');
  });
  it('rejects multiple final replies instead of selecting a convenient pass', async () => {
    const stream = events();
    stream.splice(2, 0, {
      type: 'item.completed',
      item: { id: 'second', type: 'agent_message', text: reply },
    } as never);
    expect((await complete(stream)).finish_reason).not.toBe('stop');
  });
});
// ADR does not name a typed verifier API. This Inspector contract requires the
// Engineer-owned module to bind the full observation to independently selected controls.
describe('bound completed host observation verifier (offline)', () => {
  async function verify(value: unknown) {
    const module = (await import(
      new URL('../../src/model-bridge/soft-gate-observation.js', import.meta.url).href
    )) as { verifySoftGateHostObservation: (input: unknown) => { status: string } };
    return module.verifySoftGateHostObservation(value);
  }
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const observation = () => {
    const executableBytes = Buffer.from('offline immutable executable fixture; never executed');
    const helpBytes = Buffer.from(
      'Usage: codex exec [OPTIONS]\n--json --ephemeral --sandbox --config\n',
    );
    const configuration = {
      tools: [] as string[],
      mcp_servers: [] as string[],
      hooks: [] as string[],
      plugins: [] as string[],
      agents: [] as string[],
      inheritedConversation: false,
      precedence: [{ source: 'isolated-settings', sha256: digest(Buffer.from('{}')) }],
    };
    const configurationBytes = Buffer.from(JSON.stringify(configuration));
    const argv = [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--config',
      'mcp_servers={}',
      '--config',
      'tools={}',
    ];
    return {
      workingAgent: {
        agent_id: 'worker',
        session_id: 'working-session',
        process_instance_id: 'working-process',
        host: 'codex',
        model: 'fixture',
      },
      evaluator: {
        agent_id: 'evaluator',
        session_id: 'evaluation-session',
        process_instance_id: 'evaluation-process',
        host: 'codex',
        model: 'fixture',
      },
      executable: { path: '/offline/codex', bytes: executableBytes },
      version: { status: 0, stdout: Buffer.from('codex offline-fixture-version\n') },
      hostHelp: { status: 0, stdout: helpBytes },
      configuration,
      configurationBytes,
      selectedControls: {
        executablePath: '/offline/codex',
        executableSha256: digest(executableBytes),
        version: 'codex offline-fixture-version',
        hostHelpSha256: digest(helpBytes),
        configurationSha256: digest(configurationBytes),
        argvSha256: digest(Buffer.from(JSON.stringify(argv))),
      },
      invocation: {
        process_instance_id: 'evaluation-process',
        argv,
        status: 0,
        stdout: Buffer.from(
          events()
            .map((event) => JSON.stringify(event))
            .join('\n'),
        ),
        stderr: Buffer.alloc(0),
      },
    };
  };
  const rebindConfiguration = (value: ReturnType<typeof observation>) => {
    value.configurationBytes = Buffer.from(JSON.stringify(value.configuration));
    value.selectedControls.configurationSha256 = digest(value.configurationBytes);
  };
  it('accepts a complete independent control-bound observation component only', async () =>
    expect((await verify(observation())).status).toBe('pass'));
  it.each(['agent_id', 'session_id', 'process_instance_id'] as const)(
    'refuses shared evaluator %s',
    async (key) => {
      const value = observation();
      value.evaluator[key] = value.workingAgent[key];
      expect((await verify(value)).status).not.toBe('pass');
    },
  );
  it.each(['tools', 'mcp_servers', 'hooks', 'plugins', 'agents'] as const)(
    'refuses a nonempty or absent %s configuration inventory',
    async (key) => {
      const value = observation();
      value.configuration[key] = ['unexpected'];
      rebindConfiguration(value);
      expect((await verify(value)).status).not.toBe('pass');
      Reflect.deleteProperty(value.configuration, key);
      rebindConfiguration(value);
      expect((await verify(value)).status).not.toBe('pass');
    },
  );
  it('refuses boolean declarations with no retained raw observations', async () => {
    expect(
      (
        await verify({
          workingAgent: observation().workingAgent,
          evaluator: observation().evaluator,
          completed: true,
          isolated: true,
          argvObserved: true,
          configurationObserved: true,
          tools: [],
          mcp_servers: [],
        })
      ).status,
    ).not.toBe('pass');
  });
  it.each(['command_execution', 'mcp_tool_call', 'error', 'refusal', 'ambiguous-final'])(
    'refuses hidden %s in authenticated raw host envelopes',
    async (fault) => {
      const value = observation();
      const stream = events();
      stream.splice(1, 0, {
        type: 'item.completed',
        item: {
          id: 'hidden',
          type: fault === 'ambiguous-final' ? 'agent_message' : fault,
          text: reply,
        },
      } as never);
      value.invocation.stdout = Buffer.from(
        stream.map((event) => JSON.stringify(event)).join('\n'),
      );
      expect((await verify(value)).status).not.toBe('pass');
    },
  );
  it('refuses inherited conversation, unobserved precedence, executable drift and absent completion', async () => {
    const cases = [
      () => {
        const x = observation();
        x.configuration.inheritedConversation = true;
        rebindConfiguration(x);
        return x;
      },
      () => {
        const x = observation();
        x.configuration.precedence = [];
        rebindConfiguration(x);
        return x;
      },
      () => {
        const x = observation();
        x.executable.bytes = Buffer.from('substituted executable');
        return x;
      },
      () => {
        const x = observation();
        x.invocation.stdout = Buffer.from(
          events()
            .slice(0, -1)
            .map((event) => JSON.stringify(event))
            .join('\n'),
        );
        return x;
      },
    ];
    for (const make of cases) expect((await verify(make())).status).not.toBe('pass');
  });
});
