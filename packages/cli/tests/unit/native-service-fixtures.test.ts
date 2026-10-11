// Injected transport tests prove client protocol behavior, not provisioned service standing.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNativeServiceFixturesKernel } from '../../src/native-service-fixtures-kernel.js';
import type {
  NativeServiceControlContext,
  NativeServiceControlRequest,
  NativeServiceFixtureKind,
} from '../../src/native-service-docker-broker.js';

const kinds: NativeServiceFixtureKind[] = [
  'postgres',
  'redis',
  'localstack-s3',
  'localstack-s3-kms',
];
const redisControl = {
  kind: 'pause-resume-v1',
  maxTransitionsPerInstance: 4,
  maxPausedMs: 1000,
} as const;
function fixture(
  admitted: NativeServiceFixtureKind[] = kinds,
  redisProcessControl: NativeServiceControlContext['redisProcessControl'] = null,
) {
  const context: NativeServiceControlContext = {
    schemaVersion: '1.0.0',
    nonce: 'a'.repeat(64),
    repository: '/candidate',
    candidate: 'b'.repeat(40),
    taskId: 'native',
    population: 'integration',
    backend: {
      kind: 'owned-linux-native-v1',
      recordId: 'owned-linux-native-v1-linux-arm64',
      recordSha256: 'c'.repeat(64),
      imageId: `sha256:${'d'.repeat(64)}`,
      namespace: 'net:[123]',
    },
    socket: { path: '/runtime/control/control.sock', dev: 1, ino: 2 },
    kinds: [...admitted],
    redisProcessControl,
    limits: {
      maxInstances: 8,
      maxConcurrent: 4,
      requestTimeoutMs: 1000,
      perKind: Object.fromEntries(admitted.map((kind) => [kind, { maxInstances: 2 }])),
    },
  };
  let counter = 0,
    changed = false;
  const requests: NativeServiceControlRequest[] = [],
    facts: Record<string, unknown>[] = [];
  const respond = (request: NativeServiceControlRequest): unknown => {
    const base = {
      schemaVersion: request.schemaVersion,
      nonce: request.nonce,
      scope: request.scope,
      requestId: request.requestId,
    };
    if (request.operation === 'stop')
      return { ...base, operation: 'stop', handle: request.handle, stopped: true };
    if (request.operation === 'redis-pause' || request.operation === 'redis-resume')
      return {
        ...base,
        operation: request.operation,
        handle: request.handle,
        paused: request.operation === 'redis-pause',
      };
    if (request.operation !== 'start') throw new Error('Unexpected fixture operation');
    return {
      ...base,
      operation: 'start',
      kind: request.kind,
      handle: request.requestId,
      host: '127.0.0.1',
      port: 11000 + counter,
      ...(request.kind === 'postgres'
        ? { credentials: { username: 'owned', password: 'secret', database: 'postgres' } }
        : request.kind === 'redis'
          ? {}
          : { credentials: { accessKeyId: 'test', secretAccessKey: 'test', region: 'us-east-1' } }),
    };
  };
  let reply = async (request: NativeServiceControlRequest): Promise<unknown> => respond(request);
  const kernel = createNativeServiceFixturesKernel({
    context,
    scope: 'main',
    requestId: () => (++counter).toString(16).padStart(32, '0'),
    verifyContext: () => {
      if (changed) throw new Error('changed');
    },
    request: async (request) => {
      requests.push(request);
      return reply(request);
    },
    sha256: (value) => createHash('sha256').update(value).digest('hex'),
    emit: (fact) => facts.push(fact),
  });
  return {
    context,
    kernel,
    requests,
    facts,
    respond,
    changeContext: () => {
      changed = true;
    },
    setReply: (next: typeof reply) => {
      reply = next;
    },
  };
}

describe('finite native service fixture client', () => {
  it('correlates finite Redis pause and resume to the exact frozen retained handle', async () => {
    const f = fixture(['redis'], redisControl);
    const first = await f.kernel.api.redis();
    const second = await f.kernel.api.redis();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(['host', 'pause', 'port', 'resume', 'stop']);
    const firstStart = f.requests[0];
    if (firstStart?.operation !== 'start') throw new Error('Missing first Redis start');
    const firstHandle = firstStart.requestId;
    await Reflect.apply(first.pause, second, []);
    await first.pause(); // Same-state requests still require fresh host verification.
    await first.resume();
    await first.resume();
    const controls = f.requests.filter(
      (request) => request.operation === 'redis-pause' || request.operation === 'redis-resume',
    );
    expect(controls.map((request) => request.operation)).toEqual([
      'redis-pause',
      'redis-pause',
      'redis-resume',
      'redis-resume',
    ]);
    for (const request of controls) {
      expect(Object.keys(request).sort()).toEqual([
        'handle',
        'nonce',
        'operation',
        'requestId',
        'schemaVersion',
        'scope',
      ]);
      expect(request).toMatchObject({
        schemaVersion: '1.0.0',
        nonce: f.context.nonce,
        scope: 'main',
        handle: firstHandle,
      });
    }
    expect(new Set(f.requests.map((request) => request.requestId)).size).toBe(f.requests.length);
    await first.stop();
    await second.stop();
    await f.kernel.api.verify();
    f.kernel.seal();
  });

  it('serializes Redis controls and stop instead of racing a retained instance', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    let release: (() => void) | undefined;
    f.setReply(async (request) => {
      if (request.operation === 'redis-pause')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return f.respond(request);
    });
    const paused = redis.pause();
    const resumed = redis.resume();
    const stopped = redis.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.requests.map((request) => request.operation)).toEqual(['start', 'redis-pause']);
    if (release === undefined) throw new Error('Pause RPC did not begin');
    release();
    await Promise.all([paused, resumed, stopped]);
    expect(f.requests.map((request) => request.operation)).toEqual([
      'start',
      'redis-pause',
      'redis-resume',
      'stop',
    ]);
    f.kernel.seal();
  });

  it.each(['pause', 'resume'] as const)(
    'refuses arguments to Redis %s before issuing control RPC',
    async (method) => {
      const f = fixture(['redis'], redisControl);
      const redis = await f.kernel.api.redis();
      await expect(Reflect.apply(redis[method], redis, ['outside-handle'])).rejects.toThrow(
        'ARGUMENTS_INVALID',
      );
      expect(f.requests.map((request) => request.operation)).toEqual(['start']);
      expect(() => f.kernel.seal()).toThrow('ARGUMENTS_INVALID');
    },
  );

  it.each(['nonce', 'scope', 'requestId', 'operation', 'handle', 'paused', 'extra'])(
    'refuses mismatched Redis control response %s and keeps the failure sticky',
    async (field) => {
      const f = fixture(['redis'], redisControl);
      const redis = await f.kernel.api.redis();
      f.setReply(async (request) => ({
        ...(f.respond(request) as object),
        [field]: field === 'paused' ? false : 'wrong',
      }));
      await expect(redis.pause()).rejects.toThrow('RESPONSE_INVALID');
      expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
      await expect(redis.resume()).rejects.toThrow('RESPONSE_INVALID');
      expect(f.requests).toHaveLength(2);
    },
  );

  it('refuses a Redis control response accessor without invoking candidate code', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    let getters = 0;
    f.setReply(async (request) => {
      const response = f.respond(request) as Record<string, unknown>;
      Object.defineProperty(response, 'paused', {
        enumerable: true,
        get: () => {
          getters++;
          return true;
        },
      });
      return response;
    });
    await expect(redis.pause()).rejects.toThrow('RESPONSE_INVALID');
    expect(getters).toBe(0);
    expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
  });
  it.each(['pause', 'resume'] as const)(
    'refuses unselected Redis %s before control transport',
    async (method) => {
      const f = fixture(['redis']);
      const redis = await f.kernel.api.redis();
      await expect(redis[method]()).rejects.toThrow('CONTROL_NOT_ADMITTED');
      expect(f.requests.map((request) => request.operation)).toEqual(['start']);
      expect(() => f.kernel.seal()).toThrow('CONTROL_NOT_ADMITTED');
    },
  );
  it('retains the finite actual-transition ceiling despite idempotent same-state requests', async () => {
    const f = fixture(['redis'], { ...redisControl, maxTransitionsPerInstance: 2 });
    const redis = await f.kernel.api.redis();
    await redis.pause();
    await redis.pause();
    await redis.resume();
    await redis.resume();
    await expect(redis.pause()).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.requests.map((request) => request.operation)).toEqual([
      'start',
      'redis-pause',
      'redis-pause',
      'redis-resume',
      'redis-resume',
    ]);
    expect(() => f.kernel.seal()).toThrow('LIMIT_EXCEEDED');
  });
  it('refuses Redis control after stop without sending a resurrected handle', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    await redis.stop();
    await expect(redis.pause()).rejects.toThrow('HANDLE_CLOSED');
    expect(f.requests.map((request) => request.operation)).toEqual(['start', 'stop']);
    expect(() => f.kernel.seal()).toThrow('HANDLE_CLOSED');
  });
  it('refuses Redis control after own seal before a fresh transport request', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    await redis.stop();
    f.kernel.seal();
    await expect(redis.resume()).rejects.toThrow('SEALED');
    expect(f.requests.map((request) => request.operation)).toEqual(['start', 'stop']);
  });
  it('resumes a paused Redis through an explicit correlated RPC before stop', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    await redis.pause();
    await redis.stop();
    expect(f.requests.map((request) => request.operation)).toEqual([
      'start',
      'redis-pause',
      'redis-resume',
      'stop',
    ]);
    expect(
      f.facts.filter((row) => row['kind'] === 'service-result').map((row) => row['operation']),
    ).toEqual(['start', 'redis-pause', 'redis-resume', 'stop']);
    f.kernel.seal();
  });
  it('does not use cleanup to cure exhausted Redis transition authority', async () => {
    const f = fixture(['redis'], { ...redisControl, maxTransitionsPerInstance: 1 });
    const redis = await f.kernel.api.redis();
    await redis.pause();
    await expect(redis.stop()).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.requests.map((request) => request.operation)).toEqual(['start', 'redis-pause']);
    expect(() => f.kernel.seal()).toThrow('LIMIT_EXCEEDED');
  });
  it('retains a broker process-control failure even if later cleanup could succeed', async () => {
    const f = fixture(['redis'], redisControl);
    const redis = await f.kernel.api.redis();
    f.setReply(async (request) => ({
      schemaVersion: request.schemaVersion,
      nonce: request.nonce,
      scope: request.scope,
      requestId: request.requestId,
      error: 'PROCESS_CONTROL_FAILED',
    }));
    await expect(redis.pause()).rejects.toThrow('BROKER_PROCESS_CONTROL_FAILED');
    f.setReply(async (request) => f.respond(request));
    await expect(redis.stop()).rejects.toThrow('BROKER_PROCESS_CONTROL_FAILED');
    expect(f.requests.map((request) => request.operation)).toEqual(['start', 'redis-pause']);
    expect(() => f.kernel.seal()).toThrow('BROKER_PROCESS_CONTROL_FAILED');
  });
  it('public packaged factory refuses ordinary context before exposing any fixture API', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const entry = createRequire(resolve(root, 'packages/cli/package.json')).resolve(
      '@aarusso-nyx/devai/native-service-fixtures',
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('DEVAI_NATIVE_') && key !== 'NODE_OPTIONS',
      ),
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createNativeServiceFixtures } from ${JSON.stringify(pathToFileURL(entry).href)};
      let result;
      try { createNativeServiceFixtures(); result={granted:true}; }
      catch(error) { result={granted:false,message:error.message}; }
      console.log(JSON.stringify(result));
    `,
      ],
      { env, cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      granted: false,
      message: 'NATIVE_SERVICE_FIXTURE_GOVERNED_CONTEXT_REQUIRED',
    });
  });

  it('creates fresh frozen handles with exactly the approved public fields and idempotent stop', async () => {
    const f = fixture();
    const pg1 = await f.kernel.api.postgres(),
      pg2 = await f.kernel.api.postgres();
    expect(pg1.port).not.toBe(pg2.port);
    expect(Object.keys(pg1).sort()).toEqual([
      'database',
      'host',
      'password',
      'port',
      'stop',
      'user',
    ]);
    expect(pg1.database).toBe('postgres');
    expect(Object.isFrozen(pg1)).toBe(true);
    const redis = await f.kernel.api.redis();
    expect(Object.keys(redis).sort()).toEqual(['host', 'pause', 'port', 'resume', 'stop']);
    const s3 = await f.kernel.api.localstackS3();
    expect(Object.keys(s3).sort()).toEqual(['credentials', 'endpoint', 'region', 'stop']);
    expect(Object.isFrozen(s3.credentials)).toBe(true);
    expect(s3.credentials).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
    await Promise.all([pg1.stop(), pg1.stop(), pg2.stop(), redis.stop(), s3.stop()]);
    const kms = await f.kernel.api.localstackS3Kms();
    expect(Object.keys(kms).sort()).toEqual(['credentials', 'endpoint', 'region', 'stop']);
    expect(kms.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(kms.region).toBe('us-east-1');
    expect(Object.isFrozen(kms)).toBe(true);
    expect(Object.isFrozen(kms.credentials)).toBe(true);
    expect(kms.credentials).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
    expect(f.requests.filter((r) => r.operation === 'start').map((r) => r.kind)).toEqual([
      'postgres',
      'postgres',
      'redis',
      'localstack-s3',
      'localstack-s3-kms',
    ]);
    await kms.stop();
    await kms.stop();
    expect(f.requests.filter((r) => r.operation === 'stop')).toHaveLength(5);
    await f.kernel.api.verify();
    f.kernel.seal();
    expect(JSON.stringify(f.facts)).not.toContain('secret');
  });

  it('retains per-kind budgets after successful cleanup', async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) await (await f.kernel.api.postgres()).stop();
    await expect(f.kernel.api.postgres()).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.requests.filter((r) => r.operation === 'start')).toHaveLength(2);
    await expect(f.kernel.api.redis()).rejects.toThrow('LIMIT_EXCEEDED');
    expect(() => f.kernel.seal()).toThrow('LIMIT_EXCEEDED');
  });

  it('reserves budgets before concurrent asynchronous starts', async () => {
    const f = fixture();
    const replies: (() => void)[] = [];
    f.setReply(
      (request) => new Promise((resolve) => replies.push(() => resolve(f.respond(request)))),
    );
    const first = f.kernel.api.postgres(),
      second = f.kernel.api.postgres();
    await expect(f.kernel.api.postgres()).rejects.toThrow('LIMIT_EXCEEDED');
    for (const reply of replies) reply();
    await expect(first).rejects.toThrow('LIMIT_EXCEEDED');
    await expect(second).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.requests).toHaveLength(2);
  });

  it('refuses arguments and unselected kinds before requesting any service', async () => {
    const f = fixture();
    await expect(Reflect.apply(f.kernel.api.postgres, undefined, [{}])).rejects.toThrow(
      'ARGUMENTS_INVALID',
    );
    expect(f.requests).toHaveLength(0);
    expect(() => f.kernel.seal()).toThrow('ARGUMENTS_INVALID');
    const g = fixture(['postgres']);
    await expect(g.kernel.api.redis()).rejects.toThrow('KIND_NOT_ADMITTED');
    expect(g.requests).toHaveLength(0);
  });

  it('refuses changed context before provisioning and at own seal', async () => {
    const f = fixture();
    f.changeContext();
    await expect(f.kernel.api.redis()).rejects.toThrow('CONTEXT_CHANGED');
    expect(f.requests).toHaveLength(0);
    expect(() => f.kernel.seal()).toThrow('CONTEXT_CHANGED');
  });

  it.each(['nonce', 'scope', 'requestId', 'host', 'operation', 'extra'])(
    'rejects a mismatched or expanded %s reply',
    async (field) => {
      const f = fixture();
      f.setReply(async (request) => ({ ...(f.respond(request) as object), [field]: 'wrong' }));
      await expect(f.kernel.api.postgres()).rejects.toThrow('RESPONSE_INVALID');
      await expect(f.kernel.api.verify()).rejects.toThrow('RESPONSE_INVALID');
      expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
    },
  );

  it.each(['database', 'accessKeyId'])('refuses non-contract %s credentials', async (field) => {
    const f = fixture();
    f.setReply(async (request) => {
      const result = f.respond(request) as { credentials: Record<string, unknown> };
      return { ...result, credentials: { ...result.credentials, [field]: 'outside' } };
    });
    await expect(
      field === 'database' ? f.kernel.api.postgres() : f.kernel.api.localstackS3(),
    ).rejects.toThrow('RESPONSE_INVALID');
  });

  it('refuses proxy replies without invoking traps', async () => {
    const f = fixture();
    let traps = 0;
    f.setReply(
      async () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              traps++;
              throw new Error('trap');
            },
          },
        ),
    );
    await expect(f.kernel.api.redis()).rejects.toThrow('RESPONSE_INVALID');
    expect(traps).toBe(0);
  });

  it.each(['response', 'credentials'])(
    'refuses %s accessors without invoking them',
    async (where) => {
      const f = fixture();
      let invoked = 0;
      f.setReply(async (request) => {
        const response = f.respond(request) as Record<string, unknown>;
        const target = where === 'response' ? response : (response.credentials as object);
        Object.defineProperty(target, where === 'response' ? 'port' : 'password', {
          enumerable: true,
          get() {
            invoked++;
            throw new Error('authored getter');
          },
        });
        return response;
      });
      await expect(f.kernel.api.postgres()).rejects.toThrow('RESPONSE_INVALID');
      expect(invoked).toBe(0);
      expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
    },
  );

  it('refuses a duplicate active handle without granting a second resource', async () => {
    const f = fixture();
    await f.kernel.api.postgres();
    const first = f.requests[0];
    expect(first).toBeDefined();
    f.setReply(async (request) => ({
      ...(f.respond(request) as object),
      handle: first?.requestId,
    }));
    await expect(f.kernel.api.redis()).rejects.toThrow('RESPONSE_INVALID');
    expect(
      f.facts.filter((row) => row.kind === 'service-result' && row.operation === 'start'),
    ).toHaveLength(1);
    expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
  });

  it('refuses concurrently returned distinct handles sharing an active endpoint', async () => {
    const f = fixture();
    const complete: (() => void)[] = [];
    f.setReply(
      (request) =>
        new Promise((resolve) => {
          complete.push(() => resolve({ ...(f.respond(request) as object), port: 15432 }));
        }),
    );
    const settled = Promise.allSettled([f.kernel.api.postgres(), f.kernel.api.redis()]);
    expect(complete).toHaveLength(2);
    for (const reply of complete) reply();
    const results = await settled;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : undefined).toMatchObject({
      message: 'NATIVE_SERVICE_FIXTURE_RESPONSE_INVALID',
    });
    expect(
      f.facts.filter((row) => row.kind === 'service-result' && row.operation === 'start'),
    ).toHaveLength(1);
    expect(() => f.kernel.seal()).toThrow('RESPONSE_INVALID');
  });

  it('permits endpoint reuse only after the original handle stop completes', async () => {
    const f = fixture();
    f.setReply(async (request) =>
      request.operation === 'start'
        ? { ...(f.respond(request) as object), port: 15432 }
        : f.respond(request),
    );
    const first = await f.kernel.api.postgres();
    await first.stop();
    const second = await f.kernel.api.redis();
    expect(second.port).toBe(first.port);
    const starts = f.requests.filter((request) => request.operation === 'start');
    expect(starts[0]?.requestId).not.toBe(starts[1]?.requestId);
    await second.stop();
    expect(f.requests.map((request) => request.operation)).toEqual([
      'start',
      'stop',
      'start',
      'stop',
    ]);
    expect(() => f.kernel.seal()).not.toThrow();
  });

  it.each(['start', 'stop'])(
    'refuses a seal with an unfinished %s and retains that failure',
    async (operation) => {
      const f = fixture();
      const handle = operation === 'stop' ? await f.kernel.api.redis() : undefined;
      let complete: (() => void) | undefined;
      f.setReply(
        (request) =>
          new Promise((resolve) => {
            complete = () => resolve(f.respond(request));
          }),
      );
      const pending = handle ? handle.stop() : f.kernel.api.redis();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(complete).toBeTypeOf('function');
      expect(() => f.kernel.seal()).toThrow('INCOMPLETE');
      complete?.();
      await expect(pending).rejects.toThrow('INCOMPLETE');
      await expect(f.kernel.api.verify()).rejects.toThrow('INCOMPLETE');
      expect(f.facts.filter((row) => row.kind === 'service-result')).toHaveLength(
        operation === 'start' ? 0 : 1,
      );
    },
  );

  it('requires completed stops before sealing and rejects activity after seal', async () => {
    const f = fixture();
    await f.kernel.api.redis();
    expect(() => f.kernel.seal()).toThrow('INCOMPLETE');
    const g = fixture();
    g.kernel.seal();
    await expect(g.kernel.api.redis()).rejects.toThrow('SEALED');
    expect(g.requests).toHaveLength(0);
  });
});
