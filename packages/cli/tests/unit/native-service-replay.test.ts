import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  replayNativeServiceFixtures,
  type NativeServiceParentExchange,
} from '../../src/commands/sense/native-service-replay.js';
import type { NativeServiceControlContext } from '../../src/native-service-docker-broker.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row = Record<string, unknown>;
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing transcript fixture entry');
  return value;
}

function transcript(handle = '1'.repeat(64), requestIds = ['1'.repeat(32), '2'.repeat(32)]) {
  const nonce = 'a'.repeat(64),
    scope = 'main';
  const context: NativeServiceControlContext = {
    schemaVersion: '1.0.0',
    nonce,
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
    kinds: ['postgres'],
    redisProcessControl: null,
    limits: {
      maxInstances: 2,
      maxConcurrent: 2,
      requestTimeoutMs: 1000,
      perKind: { postgres: { maxInstances: 2 } },
    },
  };
  const exchanges: NativeServiceParentExchange[] = [
    {
      request: {
        schemaVersion: '1.0.0',
        nonce,
        scope,
        requestId: at(requestIds, 0),
        operation: 'start',
        kind: 'postgres',
      },
      response: {
        schemaVersion: '1.0.0',
        nonce,
        scope,
        requestId: at(requestIds, 0),
        operation: 'start',
        kind: 'postgres',
        handle,
        host: '127.0.0.1',
        port: 5432,
        credentials: { username: 'owned', password: 'local', database: 'postgres' },
      },
    },
    {
      request: {
        schemaVersion: '1.0.0',
        nonce,
        scope,
        requestId: at(requestIds, 1),
        operation: 'stop',
        handle,
      },
      response: {
        schemaVersion: '1.0.0',
        nonce,
        scope,
        requestId: at(requestIds, 1),
        operation: 'stop',
        handle,
        stopped: true,
      },
    },
  ];
  const rows: Row[] = [];
  for (const [i, exchange] of exchanges.entries()) {
    const { request, response } = exchange;
    rows.push({
      nonce,
      scope,
      kind: 'service-request',
      sequence: i + 1,
      request,
      requestSha256: hash(request),
    });
    rows.push({
      nonce,
      scope,
      kind: 'service-result',
      sequence: i + 1,
      operation: request.operation,
      handle,
      ...(request.operation === 'start'
        ? { fixtureKind: 'postgres', host: '127.0.0.1', port: 5432 }
        : { stopped: true }),
      requestSha256: hash(request),
      responseSha256: hash(response),
    });
  }
  return { context, rows, exchanges };
}

function twoLifecycles(concurrent: boolean) {
  const first = transcript();
  const second = transcript('3'.repeat(64), ['3'.repeat(32), '4'.repeat(32)]);
  const order = concurrent
    ? [
        at(first.exchanges, 0),
        at(second.exchanges, 0),
        at(first.exchanges, 1),
        at(second.exchanges, 1),
      ]
    : [...first.exchanges, ...second.exchanges];
  const byRequest = new Map(
    [...first.exchanges, ...second.exchanges].map((exchange, index) => {
      const source = index < 2 ? first : second;
      const offset = (index % 2) * 2;
      return [exchange.request.requestId, [at(source.rows, offset), at(source.rows, offset + 1)]];
    }),
  );
  return {
    context: first.context,
    exchanges: order,
    rows: order.flatMap((exchange, index) => {
      const pair = byRequest.get(exchange.request.requestId);
      if (pair === undefined) throw new Error('Missing lifecycle request');
      return pair.map((row) => ({ ...row, sequence: index + 1 }));
    }),
  };
}

function redisTranscript(operations: readonly ('redis-pause' | 'redis-resume')[]) {
  const base = transcript();
  const context: NativeServiceControlContext = {
    ...base.context,
    kinds: ['redis'],
    redisProcessControl: {
      kind: 'pause-resume-v1',
      maxTransitionsPerInstance: 4,
      maxPausedMs: 1000,
    },
    limits: { ...base.context.limits, perKind: { redis: { maxInstances: 2 } } },
  };
  const handle = '5'.repeat(64);
  const exchanges: NativeServiceParentExchange[] = [];
  const rows: Row[] = [];
  const sequence: readonly ('start' | 'stop' | 'redis-pause' | 'redis-resume')[] = [
    'start',
    ...operations,
    'stop',
  ];
  for (const [index, operation] of sequence.entries()) {
    const common = {
      schemaVersion: '1.0.0' as const,
      nonce: context.nonce,
      scope: 'main',
      requestId: (index + 1).toString(16).padStart(32, '0'),
    };
    const exchange: NativeServiceParentExchange =
      operation === 'start'
        ? {
            request: { ...common, operation, kind: 'redis' },
            response: {
              ...common,
              operation,
              kind: 'redis',
              handle,
              host: '127.0.0.1',
              port: 6379,
            },
          }
        : operation === 'stop'
          ? {
              request: { ...common, operation, handle },
              response: { ...common, operation, handle, stopped: true },
            }
          : {
              request: { ...common, operation, handle },
              response: { ...common, operation, handle, paused: operation === 'redis-pause' },
            };
    exchanges.push(exchange);
    rows.push({
      nonce: context.nonce,
      scope: 'main',
      kind: 'service-request',
      sequence: index + 1,
      request: exchange.request,
      requestSha256: hash(exchange.request),
    });
    rows.push({
      nonce: context.nonce,
      scope: 'main',
      kind: 'service-result',
      sequence: index + 1,
      operation,
      handle,
      ...(operation === 'start'
        ? { fixtureKind: 'redis', host: '127.0.0.1', port: 6379 }
        : operation === 'stop'
          ? { stopped: true }
          : { paused: operation === 'redis-pause' }),
      requestSha256: hash(exchange.request),
      responseSha256: hash(exchange.response),
    });
  }
  return { context, rows, exchanges };
}

function rehash(f: ReturnType<typeof redisTranscript>, index: number) {
  const exchange = at(f.exchanges, index);
  at(f.rows, index * 2)['request'] = exchange.request;
  at(f.rows, index * 2)['requestSha256'] = hash(exchange.request);
  at(f.rows, index * 2 + 1)['requestSha256'] = hash(exchange.request);
  at(f.rows, index * 2 + 1)['responseSha256'] = hash(exchange.response);
}

describe('independent service RPC reconciliation', () => {
  it('reconciles selected Redis pause/resume and same-state acknowledgments before complete stop', () => {
    const f = redisTranscript(['redis-pause', 'redis-pause', 'redis-resume', 'redis-resume']);
    expect(f.exchanges).toHaveLength(6);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).not.toThrow();
  });
  it('refuses Redis process control when its independent context did not select the capability', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume']);
    const context = { ...f.context, redisProcessControl: null };
    expect(() => replayNativeServiceFixtures(context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('refuses a stop while paused when the explicit correlated resume is missing', () => {
    const f = redisTranscript(['redis-pause']);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('refuses overlapping control RPCs on one retained Redis instance', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume']);
    const rows = [0, 1, 2, 4, 3, 5, 6, 7].map((index) => at(f.rows, index));
    expect(() => replayNativeServiceFixtures(f.context, rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('independently rechecks the actual Redis transition ceiling', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume', 'redis-pause', 'redis-resume']);
    const context = {
      ...f.context,
      redisProcessControl: {
        kind: 'pause-resume-v1' as const,
        maxTransitionsPerInstance: 2,
        maxPausedMs: 1000,
      },
    };
    expect(() => replayNativeServiceFixtures(context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it.each(['handle', 'scope', 'nonce', 'requestId', 'extra'])(
    'refuses a substituted Redis control %s even when authored trace hashes are repaired',
    (field) => {
      const f = redisTranscript(['redis-pause', 'redis-resume']);
      const original = at(f.exchanges, 1);
      const value =
        field === 'requestId'
          ? at(f.exchanges, 0).request.requestId
          : 'f'.repeat(field === 'scope' ? 32 : 64);
      f.exchanges[1] = {
        request: { ...original.request, [field]: value },
        response: { ...original.response, [field]: value },
      };
      if (field === 'handle') at(f.rows, 3)[field] = value;
      if (field === 'scope' || field === 'nonce') {
        at(f.rows, 2)[field] = value;
        at(f.rows, 3)[field] = value;
      }
      rehash(f, 1);
      expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
        'TRANSCRIPT_INVALID',
      );
    },
  );
  it('refuses a contrary Redis paused state even with matching parent and task response hashes', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume']);
    const original = at(f.exchanges, 1);
    if (!('operation' in original.response) || original.response.operation !== 'redis-pause')
      throw new Error('Expected the authentic Redis pause response');
    f.exchanges[1] = { ...original, response: { ...original.response, paused: false } };
    at(f.rows, 3)['paused'] = false;
    rehash(f, 1);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('refuses Redis controls after a completed stop even when parent replies and trace hashes agree', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume']);
    const order = [0, 3, 1, 2];
    const rows = order.flatMap((index, position) => [
      { ...at(f.rows, index * 2), sequence: position + 1 },
      { ...at(f.rows, index * 2 + 1), sequence: position + 1 },
    ]);
    expect(() =>
      replayNativeServiceFixtures(
        f.context,
        rows,
        order.map((index) => at(f.exchanges, index)),
      ),
    ).toThrow('TRANSCRIPT_INVALID');
  });
  it('refuses Redis controls on a genuinely started different service kind', () => {
    const f = redisTranscript(['redis-pause', 'redis-resume']);
    const first = at(f.exchanges, 0);
    if (
      first.request.operation !== 'start' ||
      !('operation' in first.response) ||
      first.response.operation !== 'start'
    )
      throw new Error('Missing initial start exchange');
    f.exchanges[0] = {
      request: { ...first.request, kind: 'postgres' },
      response: {
        ...first.response,
        kind: 'postgres',
        credentials: { username: 'owned', password: 'local', database: 'postgres' },
      },
    };
    at(f.rows, 1)['fixtureKind'] = 'postgres';
    rehash(f, 0);
    const context: NativeServiceControlContext = {
      ...f.context,
      kinds: ['postgres'],
      limits: { ...f.context.limits, perKind: { postgres: { maxInstances: 2 } } },
    };
    expect(() => replayNativeServiceFixtures(context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('accepts exactly matched parent observations and completed fresh lifecycle', () => {
    const f = transcript();
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).not.toThrow();
  });
  it('rejects distinct active handles sharing one endpoint despite matching parent hashes', () => {
    const f = twoLifecycles(true);
    expect(f.exchanges).toHaveLength(4);
    expect(f.rows).toHaveLength(8);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('permits endpoint reuse only after the prior fresh handle has stopped', () => {
    const f = twoLifecycles(false);
    expect(f.exchanges).toHaveLength(4);
    expect(f.rows).toHaveLength(8);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).not.toThrow();
  });
  it('cannot reconstruct parent authority from authored trace hashes', () => {
    const f = transcript();
    expect(() => replayNativeServiceFixtures(f.context, f.rows, [])).toThrow('TRANSCRIPT_INVALID');
  });
  it('rejects an untraced or duplicated parent exchange', () => {
    const f = transcript();
    expect(() => replayNativeServiceFixtures(f.context, [], f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
    expect(() =>
      replayNativeServiceFixtures(f.context, f.rows, [...f.exchanges, at(f.exchanges, 0)]),
    ).toThrow('TRANSCRIPT_INVALID');
  });
  it.each(['responseSha256', 'requestSha256', 'port', 'handle', 'extra'])(
    'rejects altered task result %s',
    (field) => {
      const f = transcript();
      at(f.rows, 1)[field] = 'forged';
      expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
        'TRANSCRIPT_INVALID',
      );
    },
  );
  it('rejects incomplete stops even when the task claims success', () => {
    const f = transcript();
    expect(() =>
      replayNativeServiceFixtures(f.context, f.rows.slice(0, 2), f.exchanges.slice(0, 1)),
    ).toThrow('TRANSCRIPT_INVALID');
  });
  it('rejects repeated and reordered task exchanges', () => {
    const f = transcript();
    expect(() =>
      replayNativeServiceFixtures(f.context, [...f.rows, ...f.rows], f.exchanges),
    ).toThrow('TRANSCRIPT_INVALID');
    expect(() =>
      replayNativeServiceFixtures(
        f.context,
        [at(f.rows, 1), at(f.rows, 0), ...f.rows.slice(2)],
        f.exchanges,
      ),
    ).toThrow('TRANSCRIPT_INVALID');
  });
  it('independently refuses non-contract credentials even when both hashes match', () => {
    const f = transcript();
    const response = at(f.exchanges, 0).response;
    if (
      !('operation' in response) ||
      response.operation !== 'start' ||
      response.kind !== 'postgres'
    )
      throw new Error('fixture');
    const bad = { ...response, credentials: { ...response.credentials, database: 'outside' } };
    f.exchanges[0] = { request: at(f.exchanges, 0).request, response: bad };
    at(f.rows, 1)['responseSha256'] = hash(bad);
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('rejects cross-scope and cross-nonce parent observations', () => {
    const f = transcript(),
      original = at(f.exchanges, 0);
    f.exchanges[0] = { ...original, response: { ...original.response, scope: 'f'.repeat(32) } };
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
    f.exchanges[0] = { ...original, response: { ...original.response, nonce: 'f'.repeat(64) } };
    expect(() => replayNativeServiceFixtures(f.context, f.rows, f.exchanges)).toThrow(
      'TRANSCRIPT_INVALID',
    );
  });
  it('rechecks the per-kind ceiling instead of trusting client or parent acceptance', () => {
    const f = transcript();
    const second = transcript();
    const original = JSON.stringify(second)
      .replaceAll('1'.repeat(64), '3'.repeat(64))
      .replaceAll('1'.repeat(32), '3'.repeat(32))
      .replaceAll('2'.repeat(32), '4'.repeat(32));
    const next = JSON.parse(original) as ReturnType<typeof transcript>;
    for (let i = 0; i < 2; i++) {
      at(next.rows, i * 2)['sequence'] = i + 3;
      at(next.rows, i * 2 + 1)['sequence'] = i + 3;
      at(next.rows, i * 2)['requestSha256'] = hash(at(next.exchanges, i).request);
      at(next.rows, i * 2 + 1)['requestSha256'] = hash(at(next.exchanges, i).request);
      at(next.rows, i * 2 + 1)['responseSha256'] = hash(at(next.exchanges, i).response);
    }
    const context = {
      ...f.context,
      limits: { ...f.context.limits, perKind: { postgres: { maxInstances: 1 } } },
    };
    expect(() =>
      replayNativeServiceFixtures(
        context,
        [...f.rows, ...next.rows],
        [...f.exchanges, ...next.exchanges],
      ),
    ).toThrow('TRANSCRIPT_INVALID');
  });
});
