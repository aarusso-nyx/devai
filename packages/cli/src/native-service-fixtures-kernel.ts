import { isProxy } from './native-coverage-data.js';
import type {
  NativeServiceControlContext,
  NativeServiceControlRequest,
  NativeServiceControlResponse,
  NativeServiceFixtureKind,
} from './native-service-docker-broker.js';

import type {
  NativeServiceFixtures,
  NativePostgresFixture,
  NativeRedisFixture,
  NativeLocalstackFixture,
} from './native-service-fixtures-types.js';
export type {
  NativeServiceFixtures,
  NativePostgresFixture,
  NativeRedisFixture,
  NativeLocalstackFixture,
} from './native-service-fixtures-types.js';

/** Private IO is injected only by the canonical early preload. Responses grant no origin. */
export interface NativeServiceFixtureHost {
  readonly context: NativeServiceControlContext;
  readonly scope: string;
  requestId(): string;
  verifyContext(): void;
  request(request: NativeServiceControlRequest): Promise<unknown>;
  sha256(value: string): string;
  emit(fact: Readonly<Record<string, unknown>>): void;
}

const freeze = Object.freeze;
const names = Object.getOwnPropertyNames;
const symbols = Object.getOwnPropertySymbols;
const descriptors = Object.getOwnPropertyDescriptors;
const prototype = Object.getPrototypeOf;
const json = JSON.stringify;
const integer = Number.isSafeInteger;
const record = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== 'object' ||
    isProxy(value) ||
    prototype(value) !== Object.prototype
  )
    return false;
  if (symbols(value).length !== 0) return false;
  const own = names(value);
  const data = descriptors(value);
  return (
    own.length === fields.length &&
    fields.every((key) => own.includes(key) && data[key] !== undefined && 'value' in data[key])
  );
};
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

/** A finite fixture client. No image, transport, command or endpoint can be supplied by its caller. */
export function createNativeServiceFixturesKernel(host: NativeServiceFixtureHost): {
  readonly api: NativeServiceFixtures;
  readonly seal: () => void;
} {
  const context = host.context;
  let failure: unknown;
  let sealed = false;
  let started = 0;
  const startedPerKind = new Map<NativeServiceFixtureKind, number>();
  let pending = 0;
  let sequence = 0;
  const active = new Set<string>();
  const activePorts = new Set<number>();
  const refuse = (reason: string): never => {
    const error = new Error(`NATIVE_SERVICE_FIXTURE_${reason}`);
    if (failure === undefined) failure = error;
    throw failure;
  };
  const verify = (): void => {
    if (failure !== undefined) throw failure;
    if (sealed) return refuse('SEALED');
    try {
      host.verifyContext();
    } catch {
      return refuse('CONTEXT_CHANGED');
    }
  };
  const exchange = async (
    request: NativeServiceControlRequest,
  ): Promise<NativeServiceControlResponse> => {
    verify();
    const index = ++sequence;
    const requestSha256 = host.sha256(json(request));
    host.emit({ kind: 'service-request', sequence: index, request, requestSha256 });
    pending++;
    try {
      const response = await host.request(request);
      if (
        response === null ||
        typeof response !== 'object' ||
        isProxy(response) ||
        !record(response, names(response)) ||
        response['schemaVersion'] !== '1.0.0' ||
        response['nonce'] !== context.nonce ||
        response['scope'] !== request.scope ||
        response['requestId'] !== request.requestId
      )
        return refuse('RESPONSE_INVALID');
      if (Object.hasOwn(response, 'error')) {
        if (
          !record(response, ['schemaVersion', 'nonce', 'scope', 'requestId', 'error']) ||
          typeof response['error'] !== 'string' ||
          ![
            'INVALID_REQUEST',
            'LIMIT_EXCEEDED',
            'START_FAILED',
            'STOP_FAILED',
            'PROCESS_CONTROL_FAILED',
            'UNKNOWN_HANDLE',
            'BACKEND_UNAVAILABLE',
            'SHUTTING_DOWN',
            'TIMEOUT',
          ].includes(String(response['error']))
        )
          return refuse('RESPONSE_INVALID');
        return refuse(`BROKER_${String(response['error'])}`);
      }
      if (request.operation === 'stop') {
        if (
          !record(response, [
            'schemaVersion',
            'nonce',
            'scope',
            'requestId',
            'operation',
            'handle',
            'stopped',
          ]) ||
          response['operation'] !== 'stop' ||
          response['handle'] !== request.handle ||
          response['stopped'] !== true
        )
          return refuse('RESPONSE_INVALID');
      } else if (request.operation === 'redis-pause' || request.operation === 'redis-resume') {
        if (
          !record(response, [
            'schemaVersion',
            'nonce',
            'scope',
            'requestId',
            'operation',
            'handle',
            'paused',
          ]) ||
          response['operation'] !== request.operation ||
          response['handle'] !== request.handle ||
          response['paused'] !== (request.operation === 'redis-pause')
        )
          return refuse('RESPONSE_INVALID');
      } else if (request.operation === 'start') {
        const fields = [
          'schemaVersion',
          'nonce',
          'scope',
          'requestId',
          'operation',
          'kind',
          'handle',
          'host',
          'port',
        ];
        if (request.kind !== 'redis') fields.push('credentials');
        if (
          !record(response, fields) ||
          response['operation'] !== 'start' ||
          response['kind'] !== request.kind ||
          !text(response['handle']) ||
          !/^[0-9a-f]{32,64}$/u.test(response['handle']) ||
          active.has(response['handle']) ||
          response['host'] !== '127.0.0.1' ||
          !integer(response['port']) ||
          Number(response['port']) < 1024 ||
          Number(response['port']) > 65535 ||
          activePorts.has(Number(response['port']))
        )
          return refuse('RESPONSE_INVALID');
        if (request.kind === 'postgres') {
          const credentials = response['credentials'];
          if (
            !record(credentials, ['username', 'password', 'database']) ||
            !text(credentials['username']) ||
            !text(credentials['password']) ||
            credentials['database'] !== 'postgres'
          )
            return refuse('RESPONSE_INVALID');
        } else if (request.kind !== 'redis') {
          const credentials = response['credentials'];
          if (
            !record(credentials, ['accessKeyId', 'secretAccessKey', 'region']) ||
            credentials['accessKeyId'] !== 'test' ||
            credentials['secretAccessKey'] !== 'test' ||
            credentials['region'] !== 'us-east-1'
          )
            return refuse('RESPONSE_INVALID');
        }
      } else return refuse('RESPONSE_INVALID');
      verify();
      if (request.operation === 'start') {
        active.add(String(response['handle']));
        activePorts.add(Number(response['port']));
      }
      // Credentials stay on the private transport. The authoritative parent binds their digest.
      host.emit({
        kind: 'service-result',
        sequence: index,
        operation: request.operation,
        handle: response['handle'],
        ...(request.operation === 'start'
          ? { fixtureKind: request.kind, host: response['host'], port: response['port'] }
          : request.operation === 'stop'
            ? { stopped: true }
            : { paused: response['paused'] }),
        requestSha256,
        responseSha256: host.sha256(json(response)),
      });
      return response as NativeServiceControlResponse;
    } catch (error) {
      if (failure === undefined) failure = error;
      throw failure;
    } finally {
      pending--;
    }
  };
  const start = async (
    kind: NativeServiceFixtureKind,
    args: readonly unknown[],
  ): Promise<NativePostgresFixture | NativeRedisFixture | NativeLocalstackFixture> => {
    if (args.length !== 0) return refuse('ARGUMENTS_INVALID');
    verify();
    if (!context.kinds.includes(kind)) return refuse('KIND_NOT_ADMITTED');
    if (
      started >= context.limits.maxInstances ||
      (startedPerKind.get(kind) ?? 0) >= (context.limits.perKind[kind]?.maxInstances ?? 0) ||
      active.size + pending >= context.limits.maxConcurrent
    )
      return refuse('LIMIT_EXCEEDED');
    started++;
    startedPerKind.set(kind, (startedPerKind.get(kind) ?? 0) + 1);
    const result = await exchange({
      schemaVersion: '1.0.0',
      nonce: context.nonce,
      scope: host.scope,
      requestId: host.requestId(),
      operation: 'start',
      kind,
    });
    if (!('operation' in result) || result.operation !== 'start') return refuse('RESPONSE_INVALID');
    let stopped: Promise<void> | undefined;
    let operationTail: Promise<void> = Promise.resolve();
    let closing = false;
    let paused = false;
    let transitions = 0;
    const control = (
      operation: 'redis-pause' | 'redis-resume',
      args: readonly unknown[],
    ): Promise<void> => {
      if (args.length !== 0) return refuse('ARGUMENTS_INVALID');
      verify();
      const policy = context.redisProcessControl;
      if (result.kind !== 'redis' || policy == null) return refuse('CONTROL_NOT_ADMITTED');
      if (closing || !active.has(result.handle)) return refuse('HANDLE_CLOSED');
      const next = operationTail.then(async () => {
        verify();
        const desired = operation === 'redis-pause';
        if (paused !== desired && ++transitions > policy.maxTransitionsPerInstance)
          return refuse('LIMIT_EXCEEDED');
        await exchange({
          schemaVersion: '1.0.0',
          nonce: context.nonce,
          scope: host.scope,
          requestId: host.requestId(),
          operation,
          handle: result.handle,
        });
        paused = desired;
      });
      operationTail = next;
      return next;
    };
    const stop = async (...args: readonly unknown[]): Promise<void> => {
      if (args.length !== 0) return refuse('ARGUMENTS_INVALID');
      closing = true;
      stopped ??= operationTail.then(async () => {
        if (paused) {
          const policy = context.redisProcessControl;
          if (policy == null || ++transitions > policy.maxTransitionsPerInstance)
            return refuse('LIMIT_EXCEEDED');
          await exchange({
            schemaVersion: '1.0.0',
            nonce: context.nonce,
            scope: host.scope,
            requestId: host.requestId(),
            operation: 'redis-resume',
            handle: result.handle,
          });
          paused = false;
        }
        await exchange({
          schemaVersion: '1.0.0',
          nonce: context.nonce,
          scope: host.scope,
          requestId: host.requestId(),
          operation: 'stop',
          handle: result.handle,
        });
        active.delete(result.handle);
        activePorts.delete(result.port);
      });
      return stopped;
    };
    if (result.kind === 'postgres') {
      const { username, password } = result.credentials;
      return freeze({
        host: result.host,
        port: result.port,
        user: username,
        password,
        database: 'postgres',
        stop,
      });
    }
    if (result.kind === 'redis')
      return freeze({
        host: result.host,
        port: result.port,
        pause: async (...args: readonly unknown[]) => control('redis-pause', args),
        resume: async (...args: readonly unknown[]) => control('redis-resume', args),
        stop,
      });
    return freeze({
      endpoint: `http://127.0.0.1:${result.port}`,
      region: result.credentials.region,
      credentials: freeze({
        accessKeyId: 'test',
        secretAccessKey: 'test',
      }),
      stop,
    });
  };
  return freeze({
    api: freeze({
      postgres: (...args: readonly unknown[]) =>
        start('postgres', args) as Promise<NativePostgresFixture>,
      redis: (...args: readonly unknown[]) => start('redis', args) as Promise<NativeRedisFixture>,
      localstackS3: (...args: readonly unknown[]) =>
        start('localstack-s3', args) as Promise<NativeLocalstackFixture>,
      localstackS3Kms: (...args: readonly unknown[]) =>
        start('localstack-s3-kms', args) as Promise<NativeLocalstackFixture>,
      verify: async (...args: readonly unknown[]) => {
        if (args.length !== 0) return refuse('ARGUMENTS_INVALID');
        verify();
      },
    }),
    seal: () => {
      verify();
      if (pending !== 0 || active.size !== 0) return refuse('INCOMPLETE');
      sealed = true;
    },
  });
}
