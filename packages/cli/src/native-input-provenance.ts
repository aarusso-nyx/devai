import fs from 'node:fs';
import promises from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import moduleApi, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import net from 'node:net';
import {
  createNativeServiceFixturesKernel,
  type NativeServiceFixtures,
} from './native-service-fixtures-kernel.js';
import type {
  NativeServiceControlContext,
  NativeServiceControlRequest,
  NativeServiceFixtureKind,
} from './native-service-docker-broker.js';
import workerThreads from 'node:worker_threads';
import { Session } from 'node:inspector';
import { getCallSites } from 'node:util';
import { release } from 'node:os';
import {
  frameworkPlatformProbeCallers,
  frameworkPlatformPackageRoot,
  inspectFrameworkPlatformCaller,
  nativePlatformProbeObservation,
} from './native-platform-probes.js';
import type { FrameworkPlatformProbeCaller } from './native-platform-probes.js';

import { createNativeCoverageAdapterKernel } from './native-coverage-kernel.js';
import './native-coverage-data.js';
import type {
  NativeCoverageAdapterOptions,
  NativeCoverageKernelHost,
} from './native-coverage-kernel.js';

const FixtureSocket = net.Socket;
const fixtureSocketConnect = net.Socket.prototype.connect;
const fixtureGetPrototype = Object.getPrototypeOf;
const fixtureNames = Object.getOwnPropertyNames;
const fixtureSymbols = Object.getOwnPropertySymbols;
const fixtureDescriptor = Object.getOwnPropertyDescriptor;
const fixtureSame = Object.is;
const fixtureTimer = setTimeout;
const fixtureClearTimer = clearTimeout;
const fixtureSocketPrototypes: {
  target: object;
  parent: object | null;
  keys: (string | symbol)[];
  descriptors: PropertyDescriptor[];
}[] = [];
for (
  let target: object | null = FixtureSocket.prototype;
  target !== null;
  target = fixtureGetPrototype(target)
) {
  const keys = [...fixtureNames(target), ...fixtureSymbols(target)];
  fixtureSocketPrototypes.push({
    target,
    parent: fixtureGetPrototype(target),
    keys,
    descriptors: keys.map((key) => fixtureDescriptor(target as object, key) as PropertyDescriptor),
  });
}
const fixtureConstructorKeys = [...fixtureNames(FixtureSocket), ...fixtureSymbols(FixtureSocket)];
fixtureSocketPrototypes.push({
  target: FixtureSocket,
  parent: fixtureGetPrototype(FixtureSocket),
  keys: fixtureConstructorKeys,
  descriptors: fixtureConstructorKeys.map(
    (key) => fixtureDescriptor(FixtureSocket, key) as PropertyDescriptor,
  ),
});
const fixtureSocketPrototypesCurrent = (): boolean => {
  for (const row of fixtureSocketPrototypes) {
    if (fixtureGetPrototype(row.target) !== row.parent) return false;
    const keys = [...fixtureNames(row.target), ...fixtureSymbols(row.target)];
    if (keys.length !== row.keys.length) return false;
    for (let index = 0; index < keys.length; index++) {
      if (keys[index] !== row.keys[index]) return false;
      const actual = fixtureDescriptor(row.target, keys[index] as string | symbol);
      const expected = row.descriptors[index];
      if (
        actual === undefined ||
        expected === undefined ||
        actual.configurable !== expected.configurable ||
        actual.enumerable !== expected.enumerable ||
        actual.writable !== expected.writable ||
        !fixtureSame(actual.value, expected.value) ||
        !fixtureSame(actual.get, expected.get) ||
        !fixtureSame(actual.set, expected.set)
      )
        return false;
    }
  }
  return true;
};
const fixtureSocketWrite = net.Socket.prototype.write;
const fixtureSocketDestroy = net.Socket.prototype.destroy;
const fixtureSocketOnce = net.Socket.prototype.once;
const fixtureSocketOn = net.Socket.prototype.on;
const applyFixtureSocket = Reflect.apply;

// Captured only in the canonical early preload, never exported or accepted from authored code.
const coverageAdapterIO: NativeCoverageKernelHost['io'] = Object.freeze({
  createHash,
  execFileSync: childProcess.execFileSync,
  accessSync: fs.accessSync,
  constants: fs.constants,
  lstatSync: fs.lstatSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  readlinkSync: fs.readlinkSync,
  realpathSync: fs.realpathSync,
  createRequire: moduleApi.createRequire,
});
type CoverageAdapterAPI = ReturnType<typeof createNativeCoverageAdapterKernel>['api'];
let governedCoverageFactory:
  ((options: NativeCoverageAdapterOptions) => CoverageAdapterAPI) | undefined;

export function createNativeCoverageAdapter(
  options: NativeCoverageAdapterOptions,
): CoverageAdapterAPI {
  if (trace !== undefined || nonce !== undefined) {
    if (governedCoverageFactory === undefined)
      throw new Error('NATIVE_COVERAGE_ADAPTER_GOVERNED_CONTEXT_REQUIRED');
    return governedCoverageFactory(options);
  }
  if (
    process.env['DEVAI_NATIVE_INPUT_TRACE'] !== undefined ||
    process.env['DEVAI_NATIVE_COLLECTION_NONCE'] !== undefined
  )
    throw new Error('NATIVE_COVERAGE_ADAPTER_GOVERNED_CONTEXT_REQUIRED');
  return createNativeCoverageAdapterKernel(options, {
    io: coverageAdapterIO,
    path: process.env.PATH ?? '',
    mode: 'diagnostic',
  }).api;
}

let governedServiceFactory: (() => NativeServiceFixtures) | undefined;
let serviceFactoryFailure: string | undefined;
let refuseGovernedServiceFactory: ((reason: string) => never) | undefined;
const refuseServiceFactory = (reason: string): never => {
  serviceFactoryFailure ??= reason;
  if (refuseGovernedServiceFactory !== undefined)
    return refuseGovernedServiceFactory(serviceFactoryFailure);
  throw new Error(`NATIVE_SERVICE_FIXTURE_${serviceFactoryFailure}`);
};

/** Services have no ordinary diagnostic or ambient-endpoint fallback. */
export function createNativeServiceFixtures(): NativeServiceFixtures {
  if (arguments.length !== 0) return refuseServiceFactory('ARGUMENTS_INVALID');
  if (trace === undefined || nonce === undefined || governedServiceFactory === undefined)
    return refuseServiceFactory('GOVERNED_CONTEXT_REQUIRED');
  if (serviceFactoryFailure !== undefined) return refuseServiceFactory(serviceFactoryFailure);
  try {
    return governedServiceFactory();
  } catch (error) {
    serviceFactoryFailure ??= 'FACTORY_REFUSED';
    throw error;
  }
}

let closeScope: (() => void) | undefined;
export function sealNativeInputScope(): void {
  if (closeScope === undefined) throw new Error('NATIVE_LOADER_SCOPE_MISSING');
  closeScope();
}

/** Trusted preload: observe native configuration/collection inputs before its first import. */
const trace = process.env['DEVAI_NATIVE_INPUT_TRACE'];
const nonce = process.env['DEVAI_NATIVE_COLLECTION_NONCE'];
if (trace !== undefined && nonce !== undefined) {
  interface WorkerControl {
    nonce: string;
    childScope: string;
    port: workerThreads.MessagePort;
    acknowledgement: SharedArrayBuffer;
  }
  const workerEnvelope = workerThreads.workerData as
    | {
        __devaiNativeWorkerControl?: WorkerControl;
        originalData?: unknown;
      }
    | null
    | undefined;
  const workerControl =
    workerEnvelope !== null && typeof workerEnvelope === 'object'
      ? workerEnvelope.__devaiNativeWorkerControl
      : undefined;
  if (workerControl !== undefined) {
    if (
      workerThreads.isMainThread ||
      workerControl.nonce !== nonce ||
      workerControl.childScope !== process.env['DEVAI_NATIVE_INPUT_SCOPE'] ||
      !(workerControl.port instanceof workerThreads.MessagePort) ||
      !(workerControl.acknowledgement instanceof SharedArrayBuffer) ||
      workerControl.acknowledgement.byteLength !== 4
    )
      throw new Error('NATIVE_WORKER_CONTROL_INVALID');
    // The runner sees precisely its original structured-cloned workerData.
    (workerThreads as unknown as { workerData: unknown }).workerData = workerEnvelope?.originalData;
  }
  const initialEnvironment = Object.freeze({ ...process.env });
  const viteRuntimeKeys = [
    'BASE_URL',
    'DEV',
    'MODE',
    'PROD',
    'FORCE_TTY',
    'PLAYWRIGHT_TEST',
    'FORCE_COLOR',
    'DEBUG_COLORS',
  ];
  const runtimeEnvironment = (
    env: Record<string, string | undefined>,
  ): Record<string, string | null> =>
    Object.fromEntries(viteRuntimeKeys.map((key) => [key, env[key] ?? null]));
  let trustedReadDepth = 0;
  const original = { ...fs };
  const runtimeRoot = process.env['DEVAI_NATIVE_RUNTIME_ROOT'];
  const resultRoot = process.env['DEVAI_NATIVE_RESULT_ROOT'];
  const runtimePath = (path: string): boolean =>
    runtimeRoot !== undefined && (path === runtimeRoot || path.startsWith(`${runtimeRoot}/`));
  const scope = process.env['DEVAI_NATIVE_INPUT_SCOPE'] ?? 'main';
  const seen = new Set<string>();
  let sealed = false;
  let pendingIO = 0;
  const loaderSealers: (() => void)[] = [];
  const originalCreateHash = createHash;
  const hash = (bytes: Uint8Array | string): string =>
    originalCreateHash('sha256').update(bytes).digest('hex');
  const emit = (row: Record<string, unknown>): void => {
    if (sealed && row['kind'] !== 'unsupported') {
      original.appendFileSync(
        trace,
        `${JSON.stringify({ nonce, scope, kind: 'unsupported', operation: 'sealed-loader-activity' })}\n`,
      );
      throw new Error('DEVAI_NATIVE_LOADER_SEALED');
    }
    const line = JSON.stringify({ nonce, scope, ...row });
    if (
      !String(row['kind']).startsWith('output-') &&
      !(typeof row['path'] === 'string' && runtimePath(row['path']))
    ) {
      if (seen.has(line)) return;
      seen.add(line);
    }
    original.appendFileSync(trace, `${line}\n`, { encoding: 'utf8', flag: 'a' });
  };
  const unsupported = (operation: string): never => {
    emit({ kind: 'unsupported', operation });
    throw new Error(`DEVAI_NATIVE_INPUT_UNSUPPORTED:${operation}`);
  };
  // The native runtime is fixed; a different patch must never gain implicit loader standing.
  if (process.version !== 'v24.20.0') unsupported('node-runtime-unsupported');
  refuseGovernedServiceFactory = (reason) => unsupported(`native-service-factory-${reason}`);
  const coverageAdapters: { verify: () => void; seal: () => void }[] = [];
  const coverageContextPath = resolve(dirname(trace), 'adapter-context.json');
  let contextIdentity: { dev: number; ino: number } | undefined;
  const readCoverageContext = (): Buffer => {
    let directory = dirname(coverageContextPath);
    for (;;) {
      if (original.lstatSync(directory).isSymbolicLink())
        return unsupported('native-coverage-context-link');
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const expected = original.lstatSync(coverageContextPath);
    if (
      !expected.isFile() ||
      expected.isSymbolicLink() ||
      expected.nlink !== 1 ||
      (expected.mode & 0o777) !== 0o400 ||
      original.realpathSync(coverageContextPath) !== coverageContextPath
    )
      return unsupported('native-coverage-context-file');
    if (
      contextIdentity !== undefined &&
      (contextIdentity.dev !== expected.dev || contextIdentity.ino !== expected.ino)
    )
      return unsupported('native-coverage-context-replaced');
    const descriptor = original.openSync(
      coverageContextPath,
      original.constants.O_RDONLY | original.constants.O_NOFOLLOW,
    );
    try {
      const stat = original.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        (stat.mode & 0o777) !== 0o400 ||
        stat.size > 4 * 1024 * 1024
      )
        return unsupported('native-coverage-context-file');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = original.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) return unsupported('native-coverage-context-truncated');
        offset += count;
      }
      const after = original.lstatSync(coverageContextPath);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.nlink !== 1 ||
        after.isSymbolicLink()
      )
        return unsupported('native-coverage-context-replaced');
      contextIdentity = { dev: stat.dev, ino: stat.ino };
      return bytes;
    } finally {
      original.closeSync(descriptor);
    }
  };
  const coverageContextBytes =
    initialEnvironment['DEVAI_NATIVE_ADAPTER_CONTEXT_SHA256'] === undefined
      ? undefined
      : readCoverageContext();
  const coverageContextHash =
    coverageContextBytes === undefined ? undefined : hash(coverageContextBytes);
  if (coverageContextHash !== initialEnvironment['DEVAI_NATIVE_ADAPTER_CONTEXT_SHA256'])
    unsupported('native-coverage-context-integrity');
  const coverageContext =
    coverageContextBytes === undefined
      ? undefined
      : Object.freeze(
          JSON.parse(coverageContextBytes.toString('utf8')) as {
            nonce: string;
            repository: string;
            candidate: string;
            packageDir: string;
            git: { path: string; sha256: string };
            tracked: readonly string[];
            excludedPrefixes: readonly string[];
          },
        );
  if (
    coverageContext !== undefined &&
    (coverageContext.nonce !== nonce ||
      JSON.stringify(Object.keys(coverageContext).sort()) !==
        JSON.stringify(
          [
            'nonce',
            'repository',
            'candidate',
            'packageDir',
            'git',
            'tracked',
            'excludedPrefixes',
          ].sort(),
        ) ||
      !Array.isArray(coverageContext.tracked) ||
      !coverageContext.tracked.every((path) => typeof path === 'string') ||
      !Array.isArray(coverageContext.excludedPrefixes))
  )
    unsupported('native-coverage-context-integrity');
  const serviceContextHash = initialEnvironment['DEVAI_NATIVE_SERVICE_CONTEXT_SHA256'];
  const serviceContextPath =
    runtimeRoot === undefined
      ? undefined
      : process.platform === 'linux'
        ? '/runtime/fixtures/service-context.json'
        : resolve(runtimeRoot, 'fixtures/service-context.json');
  let serviceContextIdentity: { dev: number; ino: number } | undefined;
  const readServiceContext = (): Buffer => {
    if (serviceContextPath === undefined) return unsupported('native-service-context-path');
    for (let directory = dirname(serviceContextPath); ;) {
      if (original.lstatSync(directory).isSymbolicLink())
        return unsupported('native-service-context-link');
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const expected = original.lstatSync(serviceContextPath);
    if (
      !expected.isFile() ||
      expected.nlink !== 1 ||
      (expected.mode & 0o777) !== 0o400 ||
      original.realpathSync(serviceContextPath) !== serviceContextPath ||
      (serviceContextIdentity !== undefined &&
        (serviceContextIdentity.dev !== expected.dev ||
          serviceContextIdentity.ino !== expected.ino))
    )
      return unsupported('native-service-context-file');
    const descriptor = original.openSync(
      serviceContextPath,
      original.constants.O_RDONLY | original.constants.O_NOFOLLOW,
    );
    try {
      const stat = original.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        (stat.mode & 0o777) !== 0o400 ||
        stat.size > 64 * 1024
      )
        return unsupported('native-service-context-file');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = original.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) return unsupported('native-service-context-file');
        offset += count;
      }
      const after = original.lstatSync(serviceContextPath);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.nlink !== 1 ||
        after.isSymbolicLink()
      )
        return unsupported('native-service-context-replaced');
      serviceContextIdentity = { dev: stat.dev, ino: stat.ino };
      return bytes;
    } finally {
      original.closeSync(descriptor);
    }
  };
  const serviceContext =
    serviceContextHash === undefined
      ? undefined
      : (() => {
          const bytes = readServiceContext();
          if (!/^[0-9a-f]{64}$/u.test(serviceContextHash) || hash(bytes) !== serviceContextHash)
            return unsupported('native-service-context-integrity');
          const context = JSON.parse(bytes.toString('utf8')) as NativeServiceControlContext;
          const closed = (value: unknown, keys: readonly string[]): boolean =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
          if (
            !closed(context, [
              'schemaVersion',
              'nonce',
              'repository',
              'candidate',
              'taskId',
              'population',
              'backend',
              'socket',
              'kinds',
              'redisProcessControl',
              'limits',
            ]) ||
            !closed(context.backend, [
              'kind',
              'recordId',
              'recordSha256',
              'imageId',
              'namespace',
            ]) ||
            !closed(context.socket, ['path', 'dev', 'ino']) ||
            !closed(context.limits, [
              'maxInstances',
              'maxConcurrent',
              'requestTimeoutMs',
              'perKind',
            ]) ||
            typeof context.taskId !== 'string' ||
            context.taskId.length === 0 ||
            typeof context.population !== 'string' ||
            context.population.length === 0 ||
            coverageContext === undefined ||
            process.platform !== 'linux' ||
            context.schemaVersion !== '1.0.0' ||
            context.nonce !== nonce ||
            context.repository !== coverageContext?.repository ||
            context.candidate !== coverageContext.candidate ||
            context.backend?.kind !== 'owned-linux-native-v1' ||
            !['owned-linux-native-v1-linux-amd64', 'owned-linux-native-v1-linux-arm64'].includes(
              context.backend.recordId,
            ) ||
            !/^[0-9a-f]{64}$/u.test(context.backend.recordSha256) ||
            !/^sha256:[0-9a-f]{64}$/u.test(context.backend.imageId) ||
            !/^net:\[[0-9]+\]$/u.test(context.backend.namespace) ||
            original.readlinkSync('/proc/self/ns/net') !== context.backend.namespace ||
            context.socket?.path !==
              (process.platform === 'linux'
                ? '/runtime/control/control.sock'
                : resolve(runtimeRoot as string, 'control/control.sock')) ||
            !Number.isSafeInteger(context.socket.dev) ||
            !Number.isSafeInteger(context.socket.ino) ||
            !Array.isArray(context.kinds) ||
            context.kinds.length === 0 ||
            new Set(context.kinds).size !== context.kinds.length ||
            context.kinds.some(
              (kind) => !['postgres', 'redis', 'localstack-s3', 'localstack-s3-kms'].includes(kind),
            ) ||
            (context.redisProcessControl !== null &&
              (!context.kinds.includes('redis') ||
                !closed(context.redisProcessControl, [
                  'kind',
                  'maxTransitionsPerInstance',
                  'maxPausedMs',
                ]) ||
                context.redisProcessControl?.kind !== 'pause-resume-v1' ||
                !Number.isSafeInteger(context.redisProcessControl.maxTransitionsPerInstance) ||
                context.redisProcessControl.maxTransitionsPerInstance < 1 ||
                context.redisProcessControl.maxTransitionsPerInstance > 64 ||
                !Number.isSafeInteger(context.redisProcessControl.maxPausedMs) ||
                context.redisProcessControl.maxPausedMs < 1 ||
                context.redisProcessControl.maxPausedMs > 60_000)) ||
            !closed(context.limits.perKind, context.kinds) ||
            context.kinds.some((kind: NativeServiceFixtureKind) => {
              const bound = context.limits.perKind[kind];
              return (
                !closed(bound, ['maxInstances']) ||
                !Number.isSafeInteger(bound?.maxInstances) ||
                (bound?.maxInstances ?? 0) < 1 ||
                (bound?.maxInstances ?? 0) > context.limits.maxInstances
              );
            }) ||
            !Number.isSafeInteger(context.limits?.maxInstances) ||
            context.limits.maxInstances < 1 ||
            context.limits.maxInstances > 128 ||
            !Number.isSafeInteger(context.limits.maxConcurrent) ||
            context.limits.maxConcurrent < 1 ||
            context.limits.maxConcurrent > context.limits.maxInstances ||
            !Number.isSafeInteger(context.limits.requestTimeoutMs) ||
            context.limits.requestTimeoutMs < 100 ||
            context.limits.requestTimeoutMs > 120_000
          )
            return unsupported('native-service-context-integrity');
          return context;
        })();
  let serviceFixtures: ReturnType<typeof createNativeServiceFixturesKernel> | undefined;
  if (serviceContext !== undefined) {
    const verifyServiceContext = (): void => {
      if (!fixtureSocketPrototypesCurrent()) return unsupported('native-service-transport-mutated');
      if (
        sealed ||
        hash(readServiceContext()) !== serviceContextHash ||
        original.readlinkSync('/proc/self/ns/net') !== serviceContext.backend.namespace
      )
        return unsupported('native-service-context-changed');
      const socket = original.lstatSync(serviceContext.socket.path);
      if (
        !socket.isSocket() ||
        socket.dev !== serviceContext.socket.dev ||
        socket.ino !== serviceContext.socket.ino ||
        original.realpathSync(serviceContext.socket.path) !== serviceContext.socket.path
      )
        return unsupported('native-service-socket-changed');
    };
    const requestService = (request: NativeServiceControlRequest): Promise<unknown> =>
      new Promise((resolveReply, rejectReply) => {
        verifyServiceContext();
        const socket = new FixtureSocket({ allowHalfOpen: false });
        let reply = Buffer.alloc(0),
          done = false;
        const finish = (error?: Error, value?: unknown): void => {
          if (done) return;
          done = true;
          fixtureClearTimer(deadline);
          if (!fixtureSocketPrototypesCurrent()) {
            // Avoid invoking a mutated lifecycle. Parent cleanup owns terminal resources.
            try {
              unsupported('native-service-transport-mutated');
            } catch (cause) {
              rejectReply(cause);
            }
            return;
          }
          applyFixtureSocket(fixtureSocketDestroy, socket, []);
          if (error !== undefined) rejectReply(error);
          else resolveReply(value);
        };
        const deadline = fixtureTimer(
          () => finish(new Error('NATIVE_SERVICE_FIXTURE_TIMEOUT')),
          serviceContext.limits.requestTimeoutMs,
        );
        applyFixtureSocket(fixtureSocketOnce, socket, ['error', (error: Error) => finish(error)]);
        applyFixtureSocket(fixtureSocketOnce, socket, [
          'connect',
          () => {
            if (!fixtureSocketPrototypesCurrent()) {
              finish(new Error('NATIVE_SERVICE_FIXTURE_TRANSPORT_MUTATED'));
              return;
            }
            applyFixtureSocket(fixtureSocketWrite, socket, [`${JSON.stringify(request)}\n`]);
          },
        ]);
        applyFixtureSocket(fixtureSocketOn, socket, [
          'data',
          (chunk: Buffer) => {
            if (done) return;
            if (!fixtureSocketPrototypesCurrent()) {
              finish(new Error('NATIVE_SERVICE_FIXTURE_TRANSPORT_MUTATED'));
              return;
            }
            reply = Buffer.concat([reply, chunk]);
            if (reply.length > 64 * 1024)
              finish(new Error('NATIVE_SERVICE_FIXTURE_RESPONSE_INVALID'));
          },
        ]);
        applyFixtureSocket(fixtureSocketOnce, socket, [
          'end',
          () => {
            try {
              verifyServiceContext();
              const text = reply.toString('utf8');
              if (
                !Buffer.from(text).equals(reply) ||
                !text.endsWith('\n') ||
                text.indexOf('\n') !== text.length - 1
              )
                throw new Error('NATIVE_SERVICE_FIXTURE_RESPONSE_INVALID');
              finish(undefined, JSON.parse(text));
            } catch {
              finish(new Error('NATIVE_SERVICE_FIXTURE_RESPONSE_INVALID'));
            }
          },
        ]);
        applyFixtureSocket(fixtureSocketOnce, socket, [
          'close',
          () => {
            if (!done) finish(new Error('NATIVE_SERVICE_FIXTURE_RESPONSE_INCOMPLETE'));
          },
        ]);
        verifyServiceContext();
        applyFixtureSocket(fixtureSocketConnect, socket, [{ path: serviceContext.socket.path }]);
      });
    governedServiceFactory = () => {
      verifyServiceContext();
      serviceFixtures ??= createNativeServiceFixturesKernel({
        context: serviceContext,
        scope,
        requestId: () => randomBytes(16).toString('hex'),
        verifyContext: verifyServiceContext,
        request: requestService,
        sha256: hash,
        emit,
      });
      return serviceFixtures.api;
    };
  }
  governedCoverageFactory = (options) => {
    if (
      sealed ||
      coverageContext === undefined ||
      coverageContext.repository === undefined ||
      coverageContext.packageDir === undefined ||
      coverageContext.candidate === undefined ||
      !/^[0-9a-f]{40}$/u.test(coverageContext.candidate) ||
      coverageContext.git.path === undefined ||
      coverageContext.git.sha256 === undefined ||
      !/^[0-9a-f]{64}$/u.test(coverageContext.git.sha256)
    )
      return unsupported('native-coverage-context');
    const adapterId = coverageAdapters.length + 1;
    try {
      const { request, api, lastCompilation } = createNativeCoverageAdapterKernel(options, {
        io: {
          ...coverageAdapterIO,
          readFileSync: ((path: fs.PathLike) => trustedReadFile(path)) as typeof fs.readFileSync,
        },
        path: '',
        mode: 'governed',
        bound: {
          repository: coverageContext.repository,
          candidate: coverageContext.candidate,
          packageDir: coverageContext.packageDir,
          git: { path: coverageContext.git.path, sha256: coverageContext.git.sha256 },
          tracked: coverageContext.tracked,
          excludedPrefixes: coverageContext.excludedPrefixes,
        },
      });
      emit({
        kind: 'adapter-begin',
        adapterId,
        request,
        requestSha256: hash(JSON.stringify(request)),
      });
      const derived = new Map<string, string>();
      const guardAdapter = <T>(operation: () => T): T => {
        if (sealed) return unsupported('native-coverage-sealed');
        try {
          return operation();
        } catch {
          return unsupported('native-coverage-operation');
        }
      };
      const safe = Object.freeze({
        sha256: (value: string | Uint8Array) => guardAdapter(() => api.sha256(value)),
        candidate: () => guardAdapter(() => api.candidate()),
        sourceCensus: () => guardAdapter(() => api.sourceCensus()),
        compile: (parameters: Parameters<CoverageAdapterAPI['compile']>[0]) =>
          guardAdapter(() => {
            const result = api.compile(parameters);
            const summary = {
              outputs: result.outputs.map(({ path, sha256 }) => ({ path, sha256 })),
              diagnostics: result.diagnostics,
            };
            const derivationSha256 = hash(JSON.stringify(summary));
            const accepted = lastCompilation();
            if (accepted === undefined) return unsupported('native-coverage-derivation');
            const { mode, source } = accepted;
            emit({
              kind: 'adapter-derived',
              adapterId,
              mode,
              source,
              ...summary,
              derivationSha256,
            });
            if (mode === 'production')
              for (const output of result.outputs) derived.set(output.path, derivationSha256);
            return result;
          }),
        readVerifiedOutput: (path: string) =>
          guardAdapter(() => {
            const text = api.readVerifiedOutput(path);
            const derivationSha256 = derived.get(path);
            if (derivationSha256 === undefined)
              return unsupported('native-coverage-output-not-derived');
            emit({
              kind: 'adapter-verified-output',
              adapterId,
              path,
              sha256: hash(text),
              derivationSha256,
            });
            return text;
          }),
        verify: () => guardAdapter(() => api.verify()),
        evidence: () => guardAdapter(() => api.evidence()),
      });
      coverageAdapters.push({
        verify: () => api.verify(),
        seal: () => {
          const evidence = api.evidence();
          const evidenceSha256 = hash(JSON.stringify(evidence));
          emit({ kind: 'adapter-evidence', adapterId, evidence, evidenceSha256 });
          emit({ kind: 'adapter-end', adapterId, evidenceSha256 });
        },
      });
      return safe;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.split('\n')[0]?.slice(0, 512) : 'unknown';
      return unsupported(`native-coverage-initialization:${reason}`);
    }
  };

  const actualCallSites = getCallSites;
  const OriginalError = Error;
  const OriginalSession = Session;
  const connectSession = Session.prototype.connect;
  const postSession = Session.prototype.post;
  const disconnectSession = Session.prototype.disconnect;
  const invokeSession = Reflect.apply;
  const originalRelease = release;
  const nativeHostPlatform = () => ({
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    osRelease: originalRelease(),
  });
  const inspectPlatformCaller = (file: string, caller: FrameworkPlatformProbeCaller): string => {
    const packageRoot = frameworkPlatformPackageRoot(file, caller);
    return inspectFrameworkPlatformCaller(
      file,
      caller,
      original.realpathSync(file),
      trustedReadFile(file),
      trustedReadFile(resolve(packageRoot, 'package.json')),
    );
  };
  const platformObservation = (caller: FrameworkPlatformProbeCaller, returnedValue?: unknown) =>
    nativePlatformProbeObservation(
      caller,
      nativeHostPlatform(),
      original.realpathSync(caller.path),
      trustedReadFile(caller.path),
      returnedValue,
    );
  const platformFacts = new Map<number, Record<string, unknown>>();
  const platformSourceRoots = new Map<number, Error>();
  let nextPlatformProbe = 0;
  const actualSourceHash = (scriptId: string): string | undefined => {
    if (process.platform !== 'linux') return undefined;
    let session: Session | undefined;
    let identity: string | undefined;
    try {
      // Debugger agents cache script text, even across edits by another session.
      // Every lookup needs a fresh in-process agent, closed before returning.
      session = new OriginalSession();
      invokeSession(connectSession, session, []);
      let ready = false;
      invokeSession(postSession, session, [
        'Debugger.enable',
        (error: Error | null): void => {
          ready = error === null;
        },
      ]);
      if (ready) {
        let source: string | undefined;
        let completed = false;
        invokeSession(postSession, session, [
          'Debugger.getScriptSource',
          { scriptId },
          (error: Error | null, result?: { scriptSource?: unknown }): void => {
            completed = true;
            if (error === null && typeof result?.scriptSource === 'string')
              source = result.scriptSource;
          },
        ]);
        if (completed && source !== undefined) identity = hash(source);
      }
    } catch {
      // Missing or asynchronous identity cannot gain platform-fact standing.
      identity = undefined;
    } finally {
      if (session !== undefined) {
        try {
          invokeSession(disconnectSession, session, []);
        } catch {
          identity = undefined;
        }
      }
    }
    return identity;
  };
  const platformProbe = (
    name: string,
    args: unknown[],
    value: unknown,
    callSite?: ReturnType<typeof getCallSites>[number],
  ): boolean => {
    if (name !== 'readFile' || args.length !== 2 || callSite === undefined) return false;
    try {
      const reviewed = frameworkPlatformProbeCallers.find(
        (caller) =>
          args[0] === caller.path &&
          args[1] === caller.encoding &&
          callSite.lineNumber === caller.line &&
          callSite.columnNumber === caller.column,
      );
      if (reviewed === undefined || typeof value !== 'string') return false;
      const file = callSite.scriptName.startsWith('file:')
        ? fileURLToPath(callSite.scriptName)
        : callSite.scriptName;
      // Retain the genuine caller frame, without formatting or reading its stack.
      // Transient CJS initialization scripts otherwise disappear before sealing.
      // This object supplies lifetime only; fresh V8 queries supply all identity.
      const sourceRoot = new OriginalError();
      const sourceSha256 = actualSourceHash(callSite.scriptId);
      if (sourceSha256 !== reviewed.sha256) return false;
      const packageRoot = inspectPlatformCaller(file, reviewed);
      const observation = platformObservation(reviewed, value);
      observe(file, 'file');
      observe(resolve(packageRoot, 'package.json'), 'file');
      const fact = {
        probeId: ++nextPlatformProbe,
        probe: reviewed.probe,
        ...nativeHostPlatform(),
        caller: {
          packageName: reviewed.packageName,
          packageVersion: reviewed.packageVersion,
          file,
          sha256: reviewed.sha256,
          scriptId: callSite.scriptId,
          sourceSha256,
          line: reviewed.line,
          column: reviewed.column,
        },
        api: 'readFileSync',
        path: reviewed.path,
        encoding: reviewed.encoding,
        observation,
      };
      platformFacts.set(nextPlatformProbe, fact);
      platformSourceRoots.set(nextPlatformProbe, sourceRoot);
      emit({ kind: 'framework-platform-probe', ...fact });
      return true;
    } catch {
      // Preserve the native value/error; unproved platform reads remain generic observations.
      return false;
    }
  };
  const dlopen = process.dlopen;
  process.dlopen = (...loadArguments: Parameters<typeof dlopen>): void => {
    const [module, filename] = loadArguments;
    observe(filename, 'file');
    const swc = /[/\\]@swc[/\\]core-[^/\\]+[/\\][^/\\]+\.node$/u.test(filename);
    const rollup = /[/\\]@rollup[/\\]rollup-[^/\\]+[/\\][^/\\]+\.node$/u.test(filename);
    const fsevents = /[/\\]fsevents[/\\]fsevents\.node$/u.test(filename);
    if (!swc && !rollup && !fsevents) unsupported('native-addon');
    if (swc || rollup || fsevents) {
      const manifest = JSON.parse(
        trustedReadFile(resolve(dirname(filename), 'package.json')).toString(),
      ) as Record<string, unknown>;
      if (
        (fsevents &&
          (manifest['name'] !== 'fsevents' ||
            !['2.3.2', '2.3.3'].includes(String(manifest['version'])))) ||
        (swc && manifest['version'] !== '1.16.2') ||
        (rollup && manifest['version'] !== '4.64.5')
      )
        unsupported('native-addon-version');
    }
    // Omitted flags and explicit undefined select different dlopen modes on Linux.
    dlopen(...loadArguments);
    const nativeExports = (module as { exports: Record<PropertyKey, unknown> }).exports;
    const exports: Record<PropertyKey, unknown> = Object.create(null) as Record<
      PropertyKey,
      unknown
    >;
    for (const key of Reflect.ownKeys(nativeExports)) {
      const descriptor =
        Object.getOwnPropertyDescriptor(nativeExports, key) ??
        unsupported('native-addon-descriptor');
      if (!Object.hasOwn(descriptor, 'value')) unsupported('native-addon-accessor');
      const value: unknown = descriptor.value;
      const name = String(key);
      if (typeof value !== 'function') {
        if (fsevents && name === 'global') {
          exports[key] = null;
          continue;
        }
        if (
          fsevents &&
          ['constants', 'flags'].includes(name) &&
          value !== null &&
          typeof value === 'object'
        ) {
          const constants: Record<PropertyKey, unknown> = Object.create(null) as Record<
            PropertyKey,
            unknown
          >;
          for (const constantKey of Reflect.ownKeys(value)) {
            const constant = Object.getOwnPropertyDescriptor(value, constantKey);
            if (
              constant === undefined ||
              !Object.hasOwn(constant, 'value') ||
              !['number', 'string', 'boolean'].includes(typeof constant.value)
            )
              unsupported('fsevents-constant');
            constants[constantKey] = constant?.value;
          }
          exports[key] = Object.freeze(constants);
          continue;
        }
        if (value !== null && (typeof value === 'object' || typeof value === 'symbol'))
          unsupported('native-addon-object');
        exports[key] = value;
        continue;
      }
      if (fsevents) {
        exports[key] = (): never => unsupported(`fsevents.${name}`);
        continue;
      }
      if (swc && name === 'getTargetTriple') {
        exports[key] = (...args: unknown[]): unknown =>
          args.length === 0 ? value() : unsupported('swc.getTargetTriple');
        continue;
      }
      if (rollup) {
        exports[key] = (...args: unknown[]): unknown => {
          if (
            (name === 'parse' || name === 'parseAsync') &&
            typeof args[0] === 'string' &&
            typeof args[1] === 'boolean' &&
            typeof args[2] === 'boolean' &&
            (args.length === 3 ||
              (name === 'parseAsync' &&
                args.length === 4 &&
                (args[3] === undefined || args[3] instanceof AbortSignal)))
          )
            return value(...args);
          if (
            ['xxhashBase64Url', 'xxhashBase36', 'xxhashBase16'].includes(name) &&
            args.length === 1 &&
            (typeof args[0] === 'string' || args[0] instanceof Uint8Array)
          )
            return value(...args);
          return unsupported(`rollup.${name}`);
        };
        continue;
      }
      if (name !== 'transform' && name !== 'transformSync') {
        exports[key] = (): never => unsupported(`swc.${name}`);
        continue;
      }
      exports[key] = (...args: unknown[]): unknown => {
        if (
          args.length !== 3 ||
          typeof args[0] !== 'string' ||
          args[1] !== false ||
          !Buffer.isBuffer(args[2])
        )
          unsupported('swc-transform-signature');
        const options = JSON.parse((args[2] as Buffer).toString()) as Record<string, unknown>;
        const jsc = options['jsc'] as Record<string, unknown> | undefined;
        if (
          options['swcrc'] !== false ||
          options['configFile'] !== false ||
          options['inputSourceMap'] !== false ||
          Object.keys(options).some(
            (key) =>
              ![
                'swcrc',
                'configFile',
                'inputSourceMap',
                'filename',
                'sourceMaps',
                'jsc',
                'module',
                'minify',
                'isModule',
                'sourceFileName',
              ].includes(key),
          ) ||
          (jsc !== undefined &&
            ['experimental', 'plugins', 'cacheRoot', 'baseUrl', 'paths'].some((key) =>
              Object.hasOwn(jsc, key),
            ))
        )
          unsupported('swc-filesystem-options');
        return value(args[0], false, Buffer.from(JSON.stringify(options)));
      };
    }
    (module as { exports: unknown }).exports = Object.freeze(exports);
  };
  const pathOf = (value: unknown): string => {
    if (value instanceof URL) return fileURLToPath(value);
    if (Buffer.isBuffer(value)) return resolve(value.toString());
    if (typeof value !== 'string') return unsupported('unbound-file-descriptor');
    return resolve(value);
  };
  const capture = (
    name: string,
    args: unknown[],
    value: unknown,
    error?: unknown,
    callSite?: ReturnType<typeof getCallSites>[number],
  ): void => {
    const path = pathOf(args[0]);
    if (path === trace || (path.startsWith(`${dirname(trace)}/`) && !runtimePath(path)))
      unsupported('provenance-transport-read');
    if (error === undefined && platformProbe(name, args, value, callSite)) return;
    const options = args[1];
    const encoding =
      name === 'readFile'
        ? ((typeof options === 'string'
            ? options
            : (options as { encoding?: string } | undefined)?.encoding) ?? null)
        : null;
    let observation: Record<string, unknown>;
    if (error !== undefined)
      observation = { error: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
    else if (name === 'readFile')
      observation = {
        sha256: hash(typeof value === 'string' ? value : (value as Uint8Array)),
        realpath: original.realpathSync(path),
      };
    else if (name === 'readdir') {
      if ((options as { recursive?: boolean } | undefined)?.recursive)
        unsupported('recursive-directory');
      observation = {
        entries: (value as (string | Buffer | fs.Dirent)[]).map((entry) =>
          typeof entry === 'string' || Buffer.isBuffer(entry)
            ? [String(entry)]
            : [
                entry.name,
                entry.isDirectory()
                  ? 'directory'
                  : entry.isFile()
                    ? 'file'
                    : entry.isSymbolicLink()
                      ? 'symlink'
                      : 'other',
              ],
        ),
      };
    } else if (name === 'stat' || name === 'lstat') {
      observation = {
        present: true,
        ...(name === 'stat' ? { realpath: original.realpathSync(path) } : {}),
      };
    } else observation = { value: Buffer.isBuffer(value) ? value.toString() : (value ?? null) };
    emit({
      kind: 'observation',
      operation: name,
      path,
      encoding,
      accessMode: name === 'access' ? (typeof args[1] === 'number' ? args[1] : 0) : null,
      dirents:
        name === 'readdir' &&
        typeof options === 'object' &&
        options !== null &&
        (options as { withFileTypes?: boolean }).withFileTypes === true,
      observation,
    });
  };
  const observedValue = (name: string, args: unknown[], value: unknown): unknown => {
    if (name !== 'stat' && name !== 'lstat') return value;
    const path = pathOf(args[0]);
    const bigint = (args[1] as { bigint?: boolean } | undefined)?.bigint === true;
    const field = (key: string, result: unknown): void => {
      if (typeof result === 'function' || typeof result === 'symbol') return;
      emit({
        kind: 'observation',
        operation: 'stat-field',
        path,
        statOperation: name,
        field: key,
        bigint,
        observation: {
          value:
            typeof result === 'bigint'
              ? result.toString()
              : result instanceof Date
                ? result.toISOString()
                : (result ?? null),
        },
      });
    };
    return new Proxy(value as object, {
      get(target, key, receiver) {
        const result: unknown = Reflect.get(target, key, receiver);
        if (typeof key === 'string') field(key, result);
        return result;
      },
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (
          typeof key === 'string' &&
          descriptor !== undefined &&
          Object.hasOwn(descriptor, 'value')
        )
          field(key, descriptor.value);
        return descriptor;
      },
    });
  };
  const trustedReadFile = (path: fs.PathLike): Buffer => {
    trustedReadDepth += 1;
    try {
      return original.readFileSync(path);
    } finally {
      trustedReadDepth -= 1;
    }
  };
  const observe = (value: unknown, _kind: 'file' | 'directory' | 'metadata'): void => {
    const args = [value];
    try {
      capture('readFile', args, trustedReadFile(pathOf(value)));
    } catch (error) {
      capture('readFile', args, undefined, error);
    }
  };
  const fsMethods = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const promiseMethods = promises as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'readlink']) {
    const sync = fsMethods[`${name}Sync`];
    if (sync !== undefined) {
      const replacement = (...args: unknown[]): unknown => {
        let callSite: ReturnType<typeof getCallSites>[number] | undefined;
        if (
          name === 'readFile' &&
          args.length === 2 &&
          frameworkPlatformProbeCallers.some(
            (caller) => args[0] === caller.path && args[1] === caller.encoding,
          )
        ) {
          try {
            callSite = actualCallSites(2, { sourceMap: false })[1];
          } catch {
            // Preserve the original operation; missing source proof cannot gain standing.
          }
        }
        try {
          let value: unknown;
          if (name === 'readFile') {
            trustedReadDepth += 1;
            try {
              value = sync(...args);
            } finally {
              trustedReadDepth -= 1;
            }
          } else value = sync(...args);
          capture(name, args, value, undefined, callSite);
          return observedValue(name, args, value);
        } catch (error) {
          capture(name, args, undefined, error);
          throw error;
        }
      };
      if (name === 'realpath') Object.assign(replacement, { native: replacement });
      fsMethods[`${name}Sync`] = replacement;
    }
    const callback = fsMethods[name];
    if (callback !== undefined) {
      const replacement = (...args: unknown[]): unknown => {
        const cb = args.at(-1);
        if (typeof cb !== 'function') return callback(...args);
        pendingIO += 1;
        let completed = false;
        const complete = (): void => {
          if (!completed) {
            completed = true;
            pendingIO -= 1;
          }
        };
        try {
          return callback(...args.slice(0, -1), (error: unknown, value: unknown): void => {
            let observed: unknown;
            try {
              capture(name, args, value, error ?? undefined);
              observed = error == null ? observedValue(name, args, value) : value;
            } finally {
              complete();
            }
            cb(error, observed);
          });
        } catch (error) {
          complete();
          throw error;
        }
      };
      if (name === 'realpath') Object.assign(replacement, { native: replacement });
      fsMethods[name] = replacement;
    }
    const promise = promiseMethods[name];
    if (promise !== undefined)
      promiseMethods[name] = async (...args: unknown[]): Promise<unknown> => {
        pendingIO += 1;
        try {
          const value = await promise(...args);
          capture(name, args, value);
          return observedValue(name, args, value);
        } catch (error) {
          capture(name, args, undefined, error);
          throw error;
        } finally {
          pendingIO -= 1;
        }
      };
  }
  const removalContext = new AsyncLocalStorage<{ root: string; active: boolean }>();
  const createdParents = (path: string): string[] => {
    const paths: string[] = [];
    for (
      let current = path;
      runtimePath(current) && !original.existsSync(current);
      current = dirname(current)
    )
      paths.unshift(current);
    return paths;
  };
  const outputEvent = (name: string, args: unknown[], created: string[]): void => {
    const path = pathOf(args[0]);
    if (!runtimePath(path)) return;
    if (name === 'mkdir') {
      emit({
        kind: 'output-mkdir',
        path,
        created: created.map((entry) => ({
          path: entry,
          realpath: original.realpathSync(entry),
          mode: original.statSync(entry).mode,
        })),
      });
    } else if (name === 'writeFile') {
      const bytes = trustedReadFile(path);
      emit({
        kind: 'output-write',
        path,
        realpath: original.realpathSync(path),
        sha256: hash(bytes),
        utf8Sha256: hash(bytes.toString('utf8')),
        size: bytes.length,
        mode: original.statSync(path).mode,
      });
    } else if (name === 'rename') {
      const target = pathOf(args[1]);
      if (!runtimePath(target)) unsupported('runtime-output-rename-escape');
      emit({ kind: 'output-rename', path, target, realpath: original.realpathSync(target) });
    } else emit({ kind: 'output-remove', path });
  };
  for (const name of ['mkdir', 'writeFile', 'rename', 'rm', 'rmdir', 'unlink']) {
    const prepare = (args: unknown[]): string[] => {
      const path = pathOf(args[0]);
      if (!runtimePath(path)) return [];
      if (name === 'rename' && !runtimePath(pathOf(args[1])))
        unsupported('runtime-output-rename-escape');
      if (name === 'writeFile') {
        const option = args[2];
        const flag =
          typeof option === 'object' && option !== null
            ? (option as { flag?: unknown }).flag
            : undefined;
        if (flag !== undefined && flag !== 'w' && flag !== 'wx')
          unsupported('runtime-output-partial-write');
        if (
          typeof args[1] !== 'string' &&
          !Buffer.isBuffer(args[1]) &&
          !(args[1] instanceof Uint8Array)
        )
          unsupported('runtime-output-write-value');
        if (args[1] instanceof Uint8Array) args[1] = Buffer.from(args[1]);
        const present = original.existsSync(path);
        emit({
          kind: 'output-write-intent',
          path,
          present,
          sha256: present ? hash(trustedReadFile(path)) : null,
        });
      }
      if (name === 'rename')
        emit({
          kind: 'output-rename-intent',
          path,
          target: pathOf(args[1]),
          targetPresent: original.existsSync(pathOf(args[1])),
        });
      if (['rm', 'rmdir', 'unlink'].includes(name)) {
        const entries: Record<string, unknown>[] = [];
        const walk = (entry: string): void => {
          if (!original.existsSync(entry)) return;
          const stat = original.lstatSync(entry);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
            unsupported('runtime-output-cleanup-entry');
          entries.push({
            path: entry,
            realpath: original.realpathSync(entry),
            mode: stat.mode,
            sha256: stat.isFile() ? hash(trustedReadFile(entry)) : null,
          });
          if (stat.isDirectory())
            for (const child of original.readdirSync(entry)) walk(resolve(entry, child));
        };
        walk(path);
        emit({ kind: 'output-cleanup', path, entries });
      }
      return name === 'mkdir' ? createdParents(path) : [];
    };
    const removal = ['rm', 'rmdir', 'unlink'].includes(name);
    const nested = (args: unknown[]): boolean => {
      const context = removalContext.getStore();
      const path = pathOf(args[0]);
      return (
        removal &&
        context?.active === true &&
        (path === context.root || path.startsWith(`${context.root}/`))
      );
    };
    const contextFor = (args: unknown[]): { root: string; active: boolean } | undefined =>
      removal && runtimePath(pathOf(args[0])) ? { root: pathOf(args[0]), active: true } : undefined;
    const sync = fsMethods[`${name}Sync`];
    if (sync !== undefined)
      fsMethods[`${name}Sync`] = (...args): unknown => {
        if (nested(args)) return sync(...args);
        const context = contextFor(args);
        const operation = (): unknown => {
          const created = prepare(args);
          try {
            const value = sync(...args);
            outputEvent(name, args, created);
            return value;
          } finally {
            if (context !== undefined) context.active = false;
          }
        };
        return context === undefined ? operation() : removalContext.run(context, operation);
      };
    const callback = fsMethods[name];
    if (callback !== undefined)
      fsMethods[name] = (...args): unknown => {
        if (nested(args)) return callback(...args);
        const cb = args.at(-1);
        if (typeof cb !== 'function') return callback(...args);
        const context = contextFor(args);
        const operation = (): unknown => {
          const created = prepare(args);
          pendingIO += 1;
          let completed = false;
          const complete = (): void => {
            if (!completed) {
              completed = true;
              pendingIO -= 1;
            }
            if (context !== undefined) context.active = false;
          };
          try {
            return callback(...args.slice(0, -1), (...result: unknown[]): void => {
              try {
                if (result[0] == null) outputEvent(name, args, created);
              } finally {
                complete();
              }
              cb(...result);
            });
          } catch (error) {
            complete();
            throw error;
          }
        };
        return context === undefined ? operation() : removalContext.run(context, operation);
      };
    const promise = promiseMethods[name];
    if (promise !== undefined)
      promiseMethods[name] = async (...args): Promise<unknown> => {
        if (nested(args)) return promise(...args);
        const context = contextFor(args);
        const operation = async (): Promise<unknown> => {
          const created = prepare(args);
          pendingIO += 1;
          try {
            const value = await promise(...args);
            outputEvent(name, args, created);
            return value;
          } finally {
            pendingIO -= 1;
            if (context !== undefined) context.active = false;
          }
        };
        return context === undefined ? operation() : removalContext.run(context, operation);
      };
  }

  fsMethods['existsSync'] = (...args): boolean => {
    const value = original.existsSync(args[0] as fs.PathLike);
    capture('exists', args, value);
    return value;
  };
  const readable = (flags: unknown): boolean =>
    typeof flags === 'number'
      ? (flags & 3) !== 1
      : typeof flags !== 'string' || flags.includes('+') || !/[wa]/u.test(flags);
  for (const name of ['open', 'openSync']) {
    const method = fsMethods[name];
    if (method !== undefined)
      fsMethods[name] = (...args): unknown => {
        if (trustedReadDepth === 0 && readable(args[1])) unsupported(`fs.${name}.readable`);
        return method(...args);
      };
  }
  const open = promiseMethods['open'];
  if (open !== undefined)
    promiseMethods['open'] = (...args): unknown => {
      if (readable(args[1])) unsupported('fs.promises.open.readable');
      return open(...args);
    };
  for (const name of [
    'read',
    'readSync',
    'readv',
    'readvSync',
    'createReadStream',
    'opendir',
    'opendirSync',
    'glob',
    'globSync',
    'watch',
    'watchFile',
  ]) {
    const method = fsMethods[name];
    fsMethods[name] = (...args): unknown => {
      if (trustedReadDepth > 0 && method !== undefined) return method(...args);
      return unsupported(`fs.${name}`);
    };
    if (name in promiseMethods)
      promiseMethods[name] = (): never => unsupported(`fs.promises.${name}`);
  }
  const envForChild = (
    environment: unknown,
    childScope: string,
    runtime: 'node' | 'esbuild' = 'node',
  ): Record<string, string | undefined> => {
    const env =
      environment === undefined ? process.env : (environment as Record<string, string | undefined>);
    if (Object.values(env).some((value) => value !== undefined && typeof value !== 'string'))
      unsupported('child-environment-value');
    if (
      env['DEVAI_NATIVE_INPUT_TRACE'] !== trace ||
      env['DEVAI_NATIVE_COLLECTION_NONCE'] !== nonce ||
      env['NODE_OPTIONS'] !== process.env['NODE_OPTIONS']
    )
      unsupported('child-preload-not-inherited');
    const normalize = (input: Record<string, string | undefined>): string =>
      JSON.stringify(
        Object.entries(input)
          .filter(
            ([key]) =>
              key !== 'DEVAI_NATIVE_INPUT_SCOPE' &&
              ![
                'VITEST',
                'VITEST_MODE',
                'VITEST_WORKER_ID',
                'VITEST_POOL_ID',
                'TEST',
                'NODE_ENV',
                ...viteRuntimeKeys,
              ].includes(key),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    if (normalize(env) !== normalize(initialEnvironment))
      unsupported(
        `child-environment-changed:${[
          ...new Set([...Object.keys(env), ...Object.keys(initialEnvironment)]),
        ]
          .filter(
            (key) =>
              key !== 'DEVAI_NATIVE_INPUT_SCOPE' &&
              ![
                'VITEST',
                'VITEST_MODE',
                'VITEST_WORKER_ID',
                'VITEST_POOL_ID',
                'TEST',
                'NODE_ENV',
                ...viteRuntimeKeys,
              ].includes(key) &&
              env[key] !== initialEnvironment[key],
          )
          .sort()
          .join(',')}`,
      );
    for (const [key, value] of Object.entries(env)) {
      if (
        (['VITEST', 'TEST'].includes(key) && value !== undefined && value !== 'true') ||
        (key === 'VITEST_MODE' && value !== undefined && value !== 'RUN') ||
        (key === 'NODE_ENV' && value !== undefined && value !== 'test') ||
        (['VITEST_WORKER_ID', 'VITEST_POOL_ID'].includes(key) &&
          value !== undefined &&
          !/^[0-9]+$/u.test(value))
      )
        unsupported('child-runtime-environment');
    }
    emit({ kind: 'runtime-environment', runtime, environment: runtimeEnvironment(env) });
    return { ...env, DEVAI_NATIVE_INPUT_SCOPE: childScope };
  };
  const validateNodeFlags = (input: unknown): number => {
    if (!Array.isArray(input) || !input.every((argument) => typeof argument === 'string'))
      unsupported('child-node-arguments');
    const argv = input as string[];
    let index = 0;
    while (index < argv.length && argv[index]?.startsWith('-')) {
      const flag = argv[index++];
      if (flag === '--experimental-import-meta-resolve') continue;
      if (flag === '--conditions') {
        if (!/^[a-zA-Z0-9_.-]{1,128}$/u.test(argv[index++] ?? ''))
          unsupported('child-node-condition');
        continue;
      }
      if (flag === '--require') {
        const path = argv[index++];
        if (path === undefined || !/[/\\]vitest[/\\]suppress-warnings\.cjs$/u.test(path))
          unsupported('child-node-preload');
        const bytes = trustedReadFile(path as string);
        if (hash(bytes) !== 'a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1')
          unsupported('child-node-preload');
        capture('readFile', [path], bytes);
        continue;
      }
      unsupported('child-node-flag');
    }
    return index;
  };
  const validateExecArgv = (input: unknown): void => {
    const argv = input ?? process.execArgv;
    if (validateNodeFlags(argv) !== (argv as unknown[]).length) unsupported('child-node-arguments');
  };
  const childMethods = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync'])
    childMethods[name] = (): never => unsupported(`child_process.${name}`);
  const spawn = childMethods['spawn'];
  const guardEsbuild = (child: childProcess.ChildProcess, version: string): void => {
    if (child.stdin === null || child.stdout === null) unsupported('esbuild-stdio');
    const pending = new Set<number>();
    const pings = new Set<number>();
    let handshake = false;
    let output = Buffer.alloc(0);
    const decode = (bytes: Buffer): { id: number; request: boolean; value: unknown } => {
      let cursor = 0;
      const uint = (): number => {
        if (cursor + 4 > bytes.length) unsupported('esbuild-packet');
        const number = bytes.readUInt32LE(cursor);
        cursor += 4;
        return number;
      };
      const data = (): Buffer => {
        const size = uint();
        if (size > bytes.length - cursor) unsupported('esbuild-packet');
        const value = bytes.subarray(cursor, cursor + size);
        cursor += size;
        return value;
      };
      const visit = (depth: number): unknown => {
        if (depth > 32 || cursor >= bytes.length) unsupported('esbuild-packet');
        const tag = bytes[cursor++];
        if (tag === 0) return null;
        if (tag === 1) {
          if (cursor >= bytes.length || (bytes[cursor] !== 0 && bytes[cursor] !== 1))
            unsupported('esbuild-packet');
          return bytes[cursor++] === 1;
        }
        if (tag === 2) return uint();
        if (tag === 3) return data().toString('utf8');
        if (tag === 4) return data();
        if (tag === 5 || tag === 6) {
          const size = uint();
          if (size > 100000) unsupported('esbuild-packet');
          if (tag === 5) return Array.from({ length: size }, () => visit(depth + 1));
          const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (let index = 0; index < size; index += 1) {
            const key = data().toString('utf8');
            if (Object.hasOwn(object, key)) unsupported('esbuild-packet');
            object[key] = visit(depth + 1);
          }
          return object;
        }
        return unsupported('esbuild-packet');
      };
      const encoded = uint();
      const value = visit(0);
      if (cursor !== bytes.length) unsupported('esbuild-packet');
      return { id: encoded >>> 1, request: (encoded & 1) === 0, value };
    };
    const frame = (chunk: unknown): Buffer => {
      if (!(chunk instanceof Uint8Array)) unsupported('esbuild-nonbinary-write');
      const bytes = Buffer.from(chunk as Uint8Array);
      if (
        bytes.length < 8 ||
        bytes.length > 16 * 1024 * 1024 ||
        bytes.readUInt32LE(0) !== bytes.length - 4
      )
        unsupported('esbuild-fragmented-write');
      const packet = decode(bytes.subarray(4));
      const value = packet.value as Record<string, unknown>;
      if (!packet.request) {
        if (
          !pings.delete(packet.id) ||
          value === null ||
          typeof value !== 'object' ||
          Object.keys(value).length !== 0
        )
          unsupported('esbuild-response');
      } else {
        if (
          pending.has(packet.id) ||
          value === null ||
          typeof value !== 'object' ||
          value['command'] !== 'transform' ||
          value['inputFS'] !== false ||
          !(value['input'] instanceof Uint8Array) ||
          !Array.isArray(value['flags']) ||
          !value['flags'].every((flag) => typeof flag === 'string') ||
          Object.keys(value).some(
            (key) => !['command', 'inputFS', 'input', 'flags', 'mangleCache'].includes(key),
          )
        )
          unsupported('esbuild-filesystem-command');
        if (
          (value['flags'] as string[]).some(
            (flag) =>
              !/^--(?:loader=|target=|format=|sourcemap(?:=|$)|sourcefile=|sources-content=|jsx(?:-|=)|tsconfig-raw=|define:|supported:|charset=|legal-comments=|log-level=|log-limit=|color=|tree-shaking=|minify(?:-|$)|keep-names$|ignore-annotations$|banner=|footer=|drop:|pure:|mangle-|reserve-props=|mangle-props=|platform=)/u.test(
                flag,
              ),
          )
        )
          unsupported('esbuild-transform-flag');
        pending.add(packet.id);
      }
      return bytes;
    };
    const stdin = child.stdin as NonNullable<childProcess.ChildProcess['stdin']>;
    const write = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, ...args: unknown[]): boolean =>
      Reflect.apply(write, stdin, [frame(chunk), ...args])) as typeof stdin.write;
    const end = stdin.end.bind(stdin);
    stdin.end = ((chunk?: unknown, ...args: unknown[]): typeof stdin =>
      Reflect.apply(
        end,
        stdin,
        chunk === undefined || typeof chunk === 'function'
          ? [chunk, ...args]
          : [frame(chunk), ...args],
      )) as typeof stdin.end;
    child.stdout?.prependListener('data', (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk]);
      while (output.length >= 4) {
        const size = output.readUInt32LE(0);
        if (size > 16 * 1024 * 1024) unsupported('esbuild-response-size');
        if (output.length < size + 4) break;
        const bytes = output.subarray(4, size + 4);
        output = output.subarray(size + 4);
        if (!handshake) {
          if (bytes.toString('utf8') !== version) unsupported('esbuild-version');
          handshake = true;
          continue;
        }
        const packet = decode(bytes);
        const value = packet.value as Record<string, unknown>;
        if (packet.request) {
          if (value?.['command'] !== 'ping' || Object.keys(value).length !== 1)
            unsupported('esbuild-service-request');
          pings.add(packet.id);
        } else {
          if (!pending.delete(packet.id) || value?.['codeFS'] === true || value?.['mapFS'] === true)
            unsupported('esbuild-filesystem-response');
        }
      }
    });
    process.once('exit', () => {
      if (!handshake || pending.size > 0 || output.length > 0)
        emit({ kind: 'unsupported', operation: 'esbuild-incomplete' });
    });
  };
  childMethods['spawn'] = (...args): unknown => {
    if (typeof args[0] !== 'string' || !Array.isArray(args[1]))
      unsupported('untraced-native-child');
    const options = (args[2] ?? {}) as Record<string, unknown>;
    if (options['shell']) unsupported('child-shell');
    const executable = original.realpathSync(args[0] as string);
    if (executable !== original.realpathSync(process.execPath)) {
      const argv = args[1] as unknown[];
      if (
        !/[/\\]@esbuild[/\\][^/\\]+[/\\]bin[/\\]esbuild(?:\.exe)?$/u.test(executable) ||
        argv.length !== 2 ||
        !['--service=0.28.1', '--service=0.28.2'].includes(String(argv[0])) ||
        argv[1] !== '--ping' ||
        options['detached']
      )
        unsupported('untraced-native-child');
      envForChild(options['env'], scope, 'esbuild');
      observe(executable, 'file');
      const child = spawn?.(...args) as childProcess.ChildProcess;
      guardEsbuild(child, String(argv[0]).slice('--service='.length));
      return child;
    }
    const scriptIndex = validateNodeFlags(args[1]);
    if (scriptIndex >= (args[1] as string[]).length) unsupported('child-node-script-missing');
    const childScope = randomBytes(16).toString('hex');
    emit({ kind: 'child', childScope });
    if (options['detached']) unsupported('detached-child');
    const child = spawn?.(args[0], args[1], {
      ...options,
      env: envForChild(options['env'], childScope),
    }) as childProcess.ChildProcess;
    child.once('exit', () => emit({ kind: 'child-end', childScope }));
    return child;
  };
  const fork = childMethods['fork'];
  childMethods['fork'] = (...args): unknown => {
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
    const options = (args[optionsIndex] ?? {}) as Record<string, unknown>;
    if (options['execPath'] !== undefined && options['execPath'] !== process.execPath)
      unsupported('fork-interpreter');
    const childScope = randomBytes(16).toString('hex');
    emit({ kind: 'child', childScope });
    validateExecArgv(options['execArgv']);
    const selected = [...args];
    selected[optionsIndex] = { ...options, env: envForChild(options['env'], childScope) };
    if (options['detached']) unsupported('detached-child');
    const child = fork?.(...selected) as childProcess.ChildProcess;
    child.once('exit', () => emit({ kind: 'child-end', childScope }));
    return child;
  };
  const NativeWorker = workerThreads.Worker;
  workerThreads.Worker = class extends NativeWorker {
    #sealNative: () => void;
    constructor(filename: string | URL, options?: workerThreads.WorkerOptions) {
      if (options?.eval === true) unsupported('worker-eval');
      validateExecArgv(options?.execArgv);
      const childScope = randomBytes(16).toString('hex');
      emit({ kind: 'child', childScope });
      if (options?.env === workerThreads.SHARE_ENV) unsupported('worker-shared-environment');
      const control = new workerThreads.MessageChannel();
      const acknowledgement = new SharedArrayBuffer(4);
      const state = new Int32Array(acknowledgement);
      super(filename, {
        ...options,
        env: envForChild(options?.env, childScope),
        workerData: {
          originalData: options?.workerData,
          __devaiNativeWorkerControl: { nonce, childScope, port: control.port2, acknowledgement },
        },
        transferList: [...(options?.transferList ?? []), control.port2],
      });
      let exited = false;
      control.port1.unref();
      this.#sealNative = (): void => {
        if (exited || Atomics.load(state, 0) === 1) return;
        control.port1.postMessage({ kind: 'seal', nonce, childScope });
        const outcome = Atomics.wait(state, 0, 0, 5000);
        control.port1.close();
        if (outcome === 'timed-out' || Atomics.load(state, 0) !== 1)
          unsupported('worker-seal-not-acknowledged');
      };
      this.once('exit', () => {
        exited = true;
        control.port1.close();
        emit({ kind: 'child-end', childScope });
      });
    }
    override terminate(): Promise<number> {
      this.#sealNative();
      return super.terminate();
    }
  };
  const nativeRegister = moduleApi.register;
  const nativeRegisterHooks = registerHooks;
  moduleApi.register = ((specifier: unknown, options: unknown): void => {
    if (
      initialEnvironment['DEVAI_NATIVE_RUNNER'] !== 'playwright-v1' ||
      !(specifier instanceof URL) ||
      specifier.protocol !== 'file:' ||
      options === null ||
      typeof options !== 'object'
    )
      unsupported('unreviewed-module-register');
    const selected = options as { data?: { port?: unknown }; transferList?: unknown[] };
    if (
      Object.keys(selected).some((key) => !['data', 'transferList'].includes(key)) ||
      selected.data === undefined ||
      Object.keys(selected.data).join(',') !== 'port' ||
      !(selected.data.port instanceof workerThreads.MessagePort) ||
      selected.transferList?.length !== 1 ||
      selected.transferList[0] !== selected.data.port
    )
      unsupported('unreviewed-module-register-shape');
    const loader = fileURLToPath(specifier as URL);
    const manifestPath = resolve(dirname(loader), '../../package.json');
    const manifest = JSON.parse(trustedReadFile(manifestPath).toString()) as {
      name?: string;
      version?: string;
    };
    if (
      manifest.name !== 'playwright' ||
      manifest.version !== '1.60.0' ||
      resolve(dirname(manifestPath), 'lib/transform/esmLoader.js') !== loader
    )
      unsupported('unreviewed-module-register-target');
    observe(manifestPath, 'file');
    observe(loader, 'file');
    const childScope = randomBytes(16).toString('hex');
    const control = new workerThreads.MessageChannel();
    const acknowledgement = new SharedArrayBuffer(4);
    const state = new Int32Array(acknowledgement);
    const wrapper = new URL('./native-playwright-loader.js', import.meta.url);
    observe(wrapper, 'file');
    emit({ kind: 'loader-registration', childScope, loader, wrapper: fileURLToPath(wrapper) });
    nativeRegister(wrapper, {
      data: {
        originalUrl: (specifier as URL).href,
        originalData: selected.data,
        preloadUrl: import.meta.url,
        ownerScope: scope,
        childScope,
        nonce,
        trace,
        control: control.port2,
        acknowledgement,
      },
      transferList: [...(selected.transferList as workerThreads.MessagePort[]), control.port2],
    });
    control.port1.unref();
    loaderSealers.push(() => {
      control.port1.postMessage({ kind: 'seal', nonce, childScope });
      const outcome = Atomics.wait(state, 0, 0, 5000);
      if (outcome === 'timed-out' || Atomics.load(state, 0) !== 1)
        emit({ kind: 'unsupported', operation: 'loader-seal-not-acknowledged' });
      else emit({ kind: 'loader-acknowledged', childScope });
      control.port1.close();
    });
  }) as typeof moduleApi.register;
  moduleApi.registerHooks = (() =>
    unsupported('unreviewed-module-register-hooks')) as typeof moduleApi.registerHooks;
  syncBuiltinESMExports();
  nativeRegisterHooks({
    resolve(specifier, context, next) {
      try {
        const resolved = next(specifier, context);
        if (context.parentURL !== undefined && resolved.url.startsWith('file:'))
          emit({
            kind: 'resolve',
            specifier,
            parent: context.parentURL,
            conditions: context.conditions,
            url: resolved.url,
          });
        return resolved;
      } catch (error) {
        if (context.parentURL !== undefined)
          emit({
            kind: 'resolve',
            specifier,
            parent: context.parentURL,
            conditions: context.conditions,
            error: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
          });
        throw error;
      }
    },
    load(url, context, next) {
      if (!url.startsWith('file:')) {
        if (!url.startsWith('node:')) unsupported('non-file-module');
        return next(url, context);
      }
      const modulePath = fileURLToPath(url);
      if (
        resultRoot !== undefined &&
        (modulePath === resultRoot || modulePath.startsWith(`${resultRoot}/`))
      )
        unsupported('result-artifact-module');
      let directory = dirname(fileURLToPath(url));
      for (;;) {
        const manifestPath = resolve(directory, 'package.json');
        const present = original.existsSync(manifestPath);
        capture('exists', [manifestPath], present);
        if (present) {
          const bytes = trustedReadFile(manifestPath);
          capture('readFile', [manifestPath], bytes);
          const manifest = JSON.parse(bytes.toString()) as Record<string, unknown>;
          if (typeof manifest['name'] === 'string' && typeof manifest['version'] === 'string')
            break;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      const loaded = next(url, context);
      if (loaded.format === 'addon') {
        observe(new URL(url), 'file');
        return loaded;
      }
      const preflight =
        initialEnvironment['DEVAI_NATIVE_RUNNER'] === 'playwright-v1' &&
        url.endsWith('.esm.preflight');
      const rawUrl = preflight ? url.slice(0, -'.esm.preflight'.length) : url;
      const raw = trustedReadFile(new URL(rawUrl));
      capture('readFile', [new URL(rawUrl)], raw);
      const source = loaded.source ?? raw;
      emit({
        kind: 'module-load',
        path: fileURLToPath(rawUrl),
        moduleUrl: url,
        format: loaded.format,
        rawSha256: hash(raw),
        sourceSha256: hash(typeof source === 'string' ? source : Buffer.from(source as Uint8Array)),
      });
      return { ...loaded, source };
    },
  });
  emit({
    kind: 'begin',
    node: process.execPath,
    version: process.version,
    cwd: process.cwd(),
    initialRuntimeEnvironment: runtimeEnvironment(initialEnvironment),
    runtimeRoot: runtimeRoot ?? null,
    runtimePhysicalRoot: runtimeRoot === undefined ? null : original.realpathSync(runtimeRoot),
    runtimeRootMode: runtimeRoot === undefined ? null : original.statSync(runtimeRoot).mode,
    initialRuntimeEntries: runtimeRoot === undefined ? null : original.readdirSync(runtimeRoot),
    hostPlatform: nativeHostPlatform(),
  });
  closeScope = (): void => {
    if (serviceFactoryFailure !== undefined)
      unsupported(`native-service-factory-${serviceFactoryFailure}`);
    if (sealed) throw new Error('NATIVE_LOADER_ALREADY_SEALED');
    if (pendingIO !== 0) unsupported('pending-filesystem-io');
    if (coverageContextHash !== undefined && hash(readCoverageContext()) !== coverageContextHash)
      unsupported('native-coverage-context-changed');
    if (serviceContextHash !== undefined && hash(readServiceContext()) !== serviceContextHash)
      unsupported('native-service-context-changed');
    if (serviceFixtures !== undefined) {
      try {
        serviceFixtures.seal();
      } catch {
        unsupported('native-service-seal');
      }
    }
    for (const adapter of coverageAdapters) {
      try {
        adapter.verify();
        adapter.seal();
      } catch {
        unsupported('native-coverage-seal');
      }
    }
    for (const fact of platformFacts.values()) {
      const caller = fact['caller'] as Record<string, unknown>;
      const reviewed = frameworkPlatformProbeCallers.find(
        (entry) => entry.sha256 === caller['sha256'] && entry.probe === fact['probe'],
      );
      try {
        if (reviewed === undefined) throw new Error('NATIVE_PLATFORM_PROBE_INVALID');
        if (actualSourceHash(caller['scriptId'] as string) !== reviewed.sha256)
          unsupported('framework-platform-source-changed');
        inspectPlatformCaller(caller['file'] as string, reviewed);
        const observation = platformObservation(reviewed);
        if (
          JSON.stringify(observation) !== JSON.stringify(fact['observation']) ||
          nativeHostPlatform().osRelease !== fact['osRelease']
        )
          unsupported('framework-platform-probe-changed');
        emit({ kind: 'framework-platform-probe-recheck', ...fact, observation });
      } catch {
        unsupported('framework-platform-probe-recheck-failed');
      }
    }
    emit({ kind: 'end' });
    sealed = true;
    platformSourceRoots.clear();
  };
  const finishScope = (): void => {
    if (sealed) return;
    for (const seal of loaderSealers) seal();
    closeScope?.();
  };
  if (workerControl !== undefined) {
    workerControl.port.on('message', (message: unknown): void => {
      const request = message as Record<string, unknown>;
      const state = new Int32Array(workerControl.acknowledgement);
      try {
        if (
          request['kind'] !== 'seal' ||
          request['nonce'] !== nonce ||
          request['childScope'] !== scope
        )
          unsupported('worker-control-invalid');
        finishScope();
        Atomics.store(state, 0, 1);
      } catch (error) {
        Atomics.store(state, 0, -1);
        throw error;
      } finally {
        Atomics.notify(state, 0);
        workerControl.port.close();
      }
    });
    workerControl.port.unref();
  }
  if (scope !== 'main' && workerThreads.isMainThread) {
    process.once('SIGTERM', () => {
      finishScope();
      process.exit(143);
    });
  }
  process.once('exit', finishScope);
}
