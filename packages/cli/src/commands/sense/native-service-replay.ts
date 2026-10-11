import { createHash } from 'node:crypto';
import type {
  NativeServiceControlContext,
  NativeServiceControlRequest,
  NativeServiceControlResponse,
  NativeServiceFixtureKind,
} from '../../native-service-docker-broker.js';

/** Collected by the private parent channel, never accepted from a task report. */
export interface NativeServiceParentExchange {
  readonly request: NativeServiceControlRequest;
  readonly response: NativeServiceControlResponse;
}

type Row = Readonly<Record<string, unknown>>;
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(): never {
  throw new Error('NATIVE_SERVICE_TRANSCRIPT_INVALID');
}
const exactKeys = (value: Row, fields: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());

/** Reconcile every successful fixture RPC with independent parent observations; grants no origin. */
export function replayNativeServiceFixtures(
  context: NativeServiceControlContext,
  rows: readonly Row[],
  exchanges: readonly NativeServiceParentExchange[],
): void {
  const pending = new Map<string, { request: NativeServiceControlRequest; sequence: number }>();
  const parents = new Map<string, NativeServiceParentExchange>();
  const seen = new Set<string>();
  const sequences = new Map<string, number>();
  const active = new Map<
    string,
    {
      scope: string;
      kind: NativeServiceFixtureKind;
      paused: boolean;
      transitions: number;
    }
  >();
  const handles = new Set<string>();
  const activePorts = new Map<number, string>();
  const starts = new Map<NativeServiceFixtureKind, number>();
  let totalStarts = 0;
  const key = (scope: string, requestId: string): string => `${scope}:${requestId}`;
  for (const exchange of exchanges) {
    const { request, response } = exchange;
    if (
      request.nonce !== context.nonce ||
      response.nonce !== context.nonce ||
      request.schemaVersion !== '1.0.0' ||
      response.schemaVersion !== '1.0.0' ||
      response.scope !== request.scope ||
      response.requestId !== request.requestId ||
      (request.scope !== 'main' && !/^[0-9a-f]{32}$/u.test(request.scope)) ||
      !/^[0-9a-f]{32}$/u.test(request.requestId) ||
      'error' in response
    )
      invalid();
    if (request.operation === 'start') {
      if (
        !('operation' in response) ||
        response.operation !== 'start' ||
        response.kind !== request.kind ||
        !exactKeys(response, [
          'schemaVersion',
          'nonce',
          'scope',
          'requestId',
          'operation',
          'kind',
          'handle',
          'host',
          'port',
          ...(request.kind === 'redis' ? [] : ['credentials']),
        ])
      )
        invalid();
      if (response.kind === 'postgres') {
        const credentials = response.credentials;
        if (
          credentials === null ||
          typeof credentials !== 'object' ||
          !exactKeys(credentials, ['username', 'password', 'database']) ||
          typeof credentials.username !== 'string' ||
          credentials.username.length === 0 ||
          typeof credentials.password !== 'string' ||
          credentials.password.length === 0 ||
          credentials.database !== 'postgres'
        )
          invalid();
      } else if (response.kind !== 'redis') {
        const credentials = response.credentials;
        if (
          credentials === null ||
          typeof credentials !== 'object' ||
          !exactKeys(credentials, ['accessKeyId', 'secretAccessKey', 'region']) ||
          credentials.accessKeyId !== 'test' ||
          credentials.secretAccessKey !== 'test' ||
          credentials.region !== 'us-east-1'
        )
          invalid();
      }
    } else if (request.operation === 'redis-pause' || request.operation === 'redis-resume') {
      if (
        !('operation' in response) ||
        response.operation !== request.operation ||
        !exactKeys(response, [
          'schemaVersion',
          'nonce',
          'scope',
          'requestId',
          'operation',
          'handle',
          'paused',
        ]) ||
        response.handle !== request.handle ||
        response.paused !== (request.operation === 'redis-pause')
      )
        invalid();
    } else if (
      !('operation' in response) ||
      response.operation !== 'stop' ||
      !exactKeys(response, [
        'schemaVersion',
        'nonce',
        'scope',
        'requestId',
        'operation',
        'handle',
        'stopped',
      ]) ||
      response.handle !== request.handle ||
      response.stopped !== true
    )
      invalid();
    const identity = key(request.scope, request.requestId);
    if (parents.has(identity)) invalid();
    parents.set(identity, exchange);
  }
  for (const row of rows) {
    if (row['kind'] !== 'service-request' && row['kind'] !== 'service-result') continue;
    const scope = row['scope'];
    if (
      row['nonce'] !== context.nonce ||
      typeof scope !== 'string' ||
      typeof row['sequence'] !== 'number' ||
      !Number.isSafeInteger(row['sequence']) ||
      row['sequence'] < 1
    )
      invalid();
    const sequence = row['sequence'] as number;
    if (row['kind'] === 'service-request') {
      if (
        !exactKeys(row, ['nonce', 'scope', 'kind', 'sequence', 'request', 'requestSha256']) ||
        sequence !== (sequences.get(scope) ?? 0) + 1
      )
        invalid();
      sequences.set(scope, sequence);
      const request = row['request'] as NativeServiceControlRequest | undefined;
      if (
        request === undefined ||
        request === null ||
        typeof request !== 'object' ||
        request.scope !== scope ||
        request.nonce !== context.nonce ||
        request.schemaVersion !== '1.0.0' ||
        !/^[0-9a-f]{32}$/u.test(request.requestId)
      )
        invalid();
      const identity = key(scope, request.requestId);
      const parent = parents.get(identity);
      if (
        seen.has(identity) ||
        parent === undefined ||
        hash(request) !== row['requestSha256'] ||
        hash(parent.request) !== row['requestSha256']
      )
        invalid();
      seen.add(identity);
      if (request.operation === 'start') {
        if (
          !exactKeys(request, [
            'schemaVersion',
            'nonce',
            'scope',
            'requestId',
            'operation',
            'kind',
          ]) ||
          !context.kinds.includes(request.kind)
        )
          invalid();
        const count = (starts.get(request.kind) ?? 0) + 1;
        if (
          ++totalStarts > context.limits.maxInstances ||
          count > (context.limits.perKind[request.kind]?.maxInstances ?? 0) ||
          active.size +
            [...pending.values()].filter((p) => p.request.operation === 'start').length >=
            context.limits.maxConcurrent
        )
          invalid();
        starts.set(request.kind, count);
      } else if (
        request.operation === 'stop' ||
        request.operation === 'redis-pause' ||
        request.operation === 'redis-resume'
      ) {
        if (
          !exactKeys(request, [
            'schemaVersion',
            'nonce',
            'scope',
            'requestId',
            'operation',
            'handle',
          ]) ||
          active.get(request.handle)?.scope !== scope ||
          (request.operation === 'stop' && active.get(request.handle)?.paused === true) ||
          [...pending.values()].some(
            (p) => p.request.operation !== 'start' && p.request.handle === request.handle,
          )
        )
          invalid();
        if (request.operation !== 'stop') {
          const handle = active.get(request.handle);
          const policy = context.redisProcessControl;
          if (handle?.kind !== 'redis' || policy == null) invalid();
          if (
            handle.paused !== (request.operation === 'redis-pause') &&
            ++handle.transitions > policy.maxTransitionsPerInstance
          )
            invalid();
        }
      } else invalid();
      pending.set(identity, { request, sequence });
    } else {
      const matches = [...pending.entries()].filter(
        ([, p]) => p.request.scope === scope && p.sequence === sequence,
      );
      if (matches.length !== 1) invalid();
      const [identity, entry] = matches[0] as [
        string,
        { request: NativeServiceControlRequest; sequence: number },
      ];
      const { request } = entry;
      const response = parents.get(identity)?.response;
      if (
        response === undefined ||
        'error' in response ||
        row['operation'] !== request.operation ||
        row['requestSha256'] !== hash(request) ||
        row['responseSha256'] !== hash(response)
      )
        invalid();
      if (request.operation === 'start') {
        if (
          response.operation !== 'start' ||
          response.kind !== request.kind ||
          !exactKeys(row, [
            'nonce',
            'scope',
            'kind',
            'sequence',
            'operation',
            'handle',
            'fixtureKind',
            'host',
            'port',
            'requestSha256',
            'responseSha256',
          ]) ||
          row['fixtureKind'] !== request.kind ||
          row['handle'] !== response.handle ||
          row['host'] !== response.host ||
          row['port'] !== response.port ||
          response.host !== '127.0.0.1' ||
          !Number.isSafeInteger(response.port) ||
          response.port < 1024 ||
          response.port > 65535 ||
          !/^[0-9a-f]{32,64}$/u.test(response.handle) ||
          handles.has(response.handle) ||
          activePorts.has(response.port)
        )
          invalid();
        handles.add(response.handle);
        activePorts.set(response.port, response.handle);
        active.set(response.handle, { scope, kind: request.kind, paused: false, transitions: 0 });
      } else if (request.operation === 'redis-pause' || request.operation === 'redis-resume') {
        const handle = active.get(request.handle);
        if (
          handle?.kind !== 'redis' ||
          response.operation !== request.operation ||
          response.handle !== request.handle ||
          response.paused !== (request.operation === 'redis-pause') ||
          !exactKeys(row, [
            'nonce',
            'scope',
            'kind',
            'sequence',
            'operation',
            'handle',
            'paused',
            'requestSha256',
            'responseSha256',
          ]) ||
          row['handle'] !== request.handle ||
          row['paused'] !== response.paused
        )
          invalid();
        handle.paused = response.paused;
      } else {
        if (
          response.operation !== 'stop' ||
          response.handle !== request.handle ||
          response.stopped !== true ||
          !exactKeys(row, [
            'nonce',
            'scope',
            'kind',
            'sequence',
            'operation',
            'handle',
            'stopped',
            'requestSha256',
            'responseSha256',
          ]) ||
          row['handle'] !== request.handle ||
          row['stopped'] !== true
        )
          invalid();
        for (const [port, handle] of activePorts) {
          if (handle === request.handle) activePorts.delete(port);
        }
        active.delete(request.handle);
      }
      pending.delete(identity);
    }
  }
  if (pending.size !== 0 || active.size !== 0 || seen.size !== parents.size) invalid();
}
