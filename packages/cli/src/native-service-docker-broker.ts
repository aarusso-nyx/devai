import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createServer as createSocketServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { request, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';

export type NativeServiceFixtureKind = 'postgres' | 'redis' | 'localstack-s3' | 'localstack-s3-kms';

export interface NativeRedisProcessControl {
  readonly kind: 'pause-resume-v1';
  readonly maxTransitionsPerInstance: number;
  readonly maxPausedMs: number;
}

export function validNativeRedisProcessControl(
  value: unknown,
): value is NativeRedisProcessControl | null {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const control = value as Record<string, unknown>;
  return (
    Object.keys(control).sort().join(',') === 'kind,maxPausedMs,maxTransitionsPerInstance' &&
    control['kind'] === 'pause-resume-v1' &&
    Number.isSafeInteger(control['maxTransitionsPerInstance']) &&
    Number(control['maxTransitionsPerInstance']) >= 1 &&
    Number(control['maxTransitionsPerInstance']) <= 64 &&
    Number.isSafeInteger(control['maxPausedMs']) &&
    Number(control['maxPausedMs']) >= 1 &&
    Number(control['maxPausedMs']) <= 60000
  );
}

/** Private finite client context. No engine endpoint or caller-selected provisioning option. */
export interface NativeServiceControlContext {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly repository: string;
  readonly candidate: string;
  readonly taskId: string;
  readonly population: string;
  readonly backend: {
    readonly kind: 'owned-linux-native-v1';
    readonly recordId: string;
    readonly recordSha256: string;
    readonly imageId: string;
    readonly namespace: string;
  };
  readonly socket: { readonly path: string; readonly dev: number; readonly ino: number };
  readonly kinds: readonly NativeServiceFixtureKind[];
  readonly redisProcessControl: NativeRedisProcessControl | null;
  readonly limits: {
    readonly maxInstances: number;
    readonly maxConcurrent: number;
    readonly requestTimeoutMs: number;
    readonly perKind: Readonly<
      Partial<Record<NativeServiceFixtureKind, { readonly maxInstances: number }>>
    >;
  };
}

export type NativeServiceControlRequest = {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly scope: string;
  readonly requestId: string;
} & (
  | { readonly operation: 'start'; readonly kind: NativeServiceFixtureKind }
  | { readonly operation: 'stop'; readonly handle: string }
  | { readonly operation: 'redis-pause' | 'redis-resume'; readonly handle: string }
);

export type NativeServiceControlError =
  | 'INVALID_REQUEST'
  | 'LIMIT_EXCEEDED'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'PROCESS_CONTROL_FAILED'
  | 'UNKNOWN_HANDLE'
  | 'BACKEND_UNAVAILABLE'
  | 'SHUTTING_DOWN'
  | 'TIMEOUT';

export type NativeServiceStartResult = {
  readonly operation: 'start';
  readonly handle: string;
  readonly host: '127.0.0.1';
  readonly port: number;
} & (
  | {
      readonly kind: 'postgres';
      readonly credentials: {
        readonly username: string;
        readonly password: string;
        readonly database: string;
      };
    }
  | { readonly kind: 'redis'; readonly credentials?: never }
  | {
      readonly kind: 'localstack-s3' | 'localstack-s3-kms';
      readonly credentials: {
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
        readonly region: 'us-east-1';
      };
    }
);

export type NativeServiceControlResponse = {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly scope: string;
  readonly requestId: string;
} & (
  | NativeServiceStartResult
  | { readonly operation: 'stop'; readonly handle: string; readonly stopped: true }
  | {
      readonly operation: 'redis-pause' | 'redis-resume';
      readonly handle: string;
      readonly paused: boolean;
    }
  | { readonly error: NativeServiceControlError }
);

/** Identities independently selected by the parent, never candidate Docker environment. */
export interface NativeDockerBinding {
  readonly executable: string;
  readonly sha256: string;
  readonly socket: {
    readonly path: string;
    readonly realpath: string;
    readonly dev: number;
    readonly ino: number;
  };
  readonly engine: {
    readonly id: string;
    readonly serverVersion: string;
    readonly apiVersion: string;
  };
}

export interface NativeDockerImage {
  readonly reference: string;
  readonly id: string;
  readonly architecture: 'arm64' | 'amd64';
  readonly os: 'linux';
}

export interface NativeServiceLifecycle {
  readonly sequence: number;
  readonly timestamp: string;
  readonly operation: string;
  readonly resource: string;
  readonly status: number;
  readonly requestSha256: string;
  readonly responseSha256: string;
}

const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => {
  throw new Error(`NATIVE_SERVICE_${code}`);
};
type Document = Record<string, unknown>;

function object(value: unknown): Document {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail('ENGINE_RESPONSE_INVALID');
  return value as Document;
}

/** Host-only engine client: no candidate receives this object or its original socket. */
export function createOwnedDockerEngine(
  binding: NativeDockerBinding,
  owner: { readonly nonce: string; readonly planSha256: string },
  ledger: NativeServiceLifecycle[],
  cancellation?: AbortSignal,
) {
  if (!/^[a-f0-9]{64}$/u.test(owner.nonce) || !/^[a-f0-9]{64}$/u.test(owner.planSha256))
    return fail('OWNER_INVALID');
  const name = `devai-native-${owner.nonce.slice(0, 32)}`;
  const labels = { 'devai.native.nonce': owner.nonce, 'devai.native.plan': owner.planSha256 };
  let networkId: string | undefined;
  let postgresId: string | undefined;
  let networkAttempted = false;
  let postgresAttempted = false;
  let cleanupDeadline: number | undefined;
  let postgresIdentity: { image: NativeDockerImage; port: number } | undefined;
  const assertIdentity = (): void => {
    if (
      !isAbsolute(binding.executable) ||
      realpathSync(binding.executable) !== binding.executable ||
      !lstatSync(binding.executable).isFile() ||
      hash(readFileSync(binding.executable)) !== binding.sha256
    )
      return fail('DOCKER_EXECUTABLE_CHANGED');
    if (
      !isAbsolute(binding.socket.path) ||
      realpathSync(binding.socket.path) !== binding.socket.realpath
    )
      return fail('ENGINE_SOCKET_CHANGED');
    const stat = statSync(binding.socket.realpath);
    if (!stat.isSocket() || stat.dev !== binding.socket.dev || stat.ino !== binding.socket.ino)
      return fail('ENGINE_SOCKET_CHANGED');
  };
  const api = async (method: string, path: string, body: unknown, statuses: readonly number[]) => {
    assertIdentity();
    if (cleanupDeadline === undefined && cancellation?.aborted)
      return fail('SUPERVISOR_INTERRUPTED');
    if (method !== 'GET') await verify();
    const remaining =
      cleanupDeadline === undefined ? 10_000 : Math.min(10_000, cleanupDeadline - Date.now());
    if (remaining <= 0) return fail('CLEANUP_TIMEOUT');
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const response = await new Promise<{ status: number; bytes: Buffer }>((accept, reject) => {
      const query = request(
        {
          socketPath: binding.socket.realpath,
          method,
          path,
          headers: {
            'content-type': 'application/json',
            'content-length': bytes.length,
            connection: 'close',
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              query.destroy(new Error('NATIVE_SERVICE_ENGINE_RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () =>
            accept({ status: incoming.statusCode ?? 0, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      query.setTimeout(remaining, () => query.destroy(new Error('NATIVE_SERVICE_ENGINE_TIMEOUT')));
      const abort = (): void => {
        query.destroy(new Error('NATIVE_SERVICE_SUPERVISOR_INTERRUPTED'));
      };
      if (cleanupDeadline === undefined)
        cancellation?.addEventListener('abort', abort, { once: true });
      query.once('close', () => cancellation?.removeEventListener('abort', abort));
      query.on('error', reject);
      query.end(bytes);
    });
    assertIdentity();
    ledger.push({
      sequence: ledger.length + 1,
      timestamp: new Date().toISOString(),
      operation: `${method} ${path}`,
      resource: path,
      status: response.status,
      requestSha256: hash(bytes),
      responseSha256: hash(response.bytes),
    });
    if (!statuses.includes(response.status)) return fail(`ENGINE_HTTP_${String(response.status)}`);
    return response;
  };
  const json = async (
    method: string,
    path: string,
    body?: unknown,
    statuses: readonly number[] = [200],
  ) => {
    const response = await api(method, path, body, statuses);
    return {
      status: response.status,
      value: response.bytes.length === 0 ? {} : object(JSON.parse(response.bytes.toString('utf8'))),
    };
  };
  const verify = async (): Promise<void> => {
    const info = (await json('GET', '/info')).value;
    const version = (await json('GET', '/version')).value;
    if (
      info['ID'] !== binding.engine.id ||
      info['ServerVersion'] !== binding.engine.serverVersion ||
      version['Version'] !== binding.engine.serverVersion ||
      version['ApiVersion'] !== binding.engine.apiVersion
    )
      return fail('ENGINE_IDENTITY_CHANGED');
  };
  const inspect = async (references: {
    readonly postgres: string;
    readonly localstack?: string;
  }) => {
    const info = (await json('GET', '/info')).value;
    const version = (await json('GET', '/version')).value;
    if (
      typeof info['ID'] !== 'string' ||
      typeof info['ServerVersion'] !== 'string' ||
      version['Version'] !== info['ServerVersion'] ||
      typeof version['ApiVersion'] !== 'string'
    )
      return fail('ENGINE_RESPONSE_INVALID');
    const image = async (
      reference: string,
      kind: 'postgres' | 'localstack',
    ): Promise<NativeDockerImage> => {
      const prefix = kind === 'postgres' ? 'postgres:16-alpine' : 'localstack/localstack:3.8.1';
      if (
        !new RegExp(`^${prefix}@sha256:[a-f0-9]{64}$`, 'u').test(reference) ||
        reference.endsWith('0'.repeat(64))
      )
        return fail('IMAGE_DECLARATION_INVALID');
      const document = (await json('GET', `/images/${encodeURIComponent(reference)}/json`)).value;
      const digest = `${kind === 'postgres' ? 'postgres' : 'localstack/localstack'}@${reference.split('@')[1] ?? ''}`;
      if (
        typeof document['Id'] !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(document['Id']) ||
        !['arm64', 'amd64'].includes(String(document['Architecture'])) ||
        document['Os'] !== 'linux' ||
        !Array.isArray(document['RepoDigests']) ||
        !document['RepoDigests'].includes(digest)
      )
        return fail('IMAGE_IDENTITY_CHANGED');
      return {
        reference,
        id: document['Id'],
        architecture: document['Architecture'] as 'arm64' | 'amd64',
        os: 'linux',
      };
    };
    return {
      docker: {
        ...binding,
        engine: {
          id: info['ID'],
          serverVersion: info['ServerVersion'],
          apiVersion: version['ApiVersion'],
        },
      },
      postgres: await image(references.postgres, 'postgres'),
      ...(references.localstack === undefined
        ? {}
        : { localstack: await image(references.localstack, 'localstack') }),
    };
  };
  const verifyImage = async (
    image: NativeDockerImage,
    kind: 'postgres' | 'localstack',
  ): Promise<void> => {
    const prefix = kind === 'postgres' ? 'postgres:16-alpine' : 'localstack/localstack:3.8.1';
    if (
      !new RegExp(`^${prefix}@sha256:[a-f0-9]{64}$`, 'u').test(image.reference) ||
      image.reference.endsWith('0'.repeat(64)) ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.id) ||
      image.os !== 'linux' ||
      !['arm64', 'amd64'].includes(image.architecture)
    )
      return fail('IMAGE_DECLARATION_INVALID');
    await verify();
    const document = (await json('GET', `/images/${encodeURIComponent(image.reference)}/json`))
      .value;
    const repo = kind === 'postgres' ? 'postgres' : 'localstack/localstack';
    const digest = `${repo}@${image.reference.split('@')[1] ?? ''}`;
    if (
      document['Id'] !== image.id ||
      document['Architecture'] !== image.architecture ||
      document['Os'] !== image.os ||
      !Array.isArray(document['RepoDigests']) ||
      !document['RepoDigests'].includes(digest)
    )
      return fail('IMAGE_IDENTITY_CHANGED');
  };
  const ownedContainer = async (id: string): Promise<Document> => {
    if (!/^[a-f0-9]{64}$/u.test(id)) return fail('RESOURCE_ID_INVALID');
    const document = (await json('GET', `/containers/${id}/json`)).value;
    const config = object(document['Config']);
    const actualLabels = object(config['Labels']);
    if (
      actualLabels['devai.native.nonce'] !== owner.nonce ||
      actualLabels['devai.native.plan'] !== owner.planSha256
    )
      return fail('RESOURCE_OWNERSHIP_CHANGED');
    return document;
  };
  const provisionPostgres = async (
    image: NativeDockerImage,
    password: string,
    timeoutMs: number,
  ): Promise<{ host: '127.0.0.1'; port: number }> => {
    if (networkId !== undefined || postgresId !== undefined || !/^[a-f0-9]{64}$/u.test(password))
      return fail('PROVISIONING_REPEATED');
    await verifyImage(image, 'postgres');
    if (
      (await api('GET', `/networks/${name}`, undefined, [200, 404])).status !== 404 ||
      (await api('GET', `/containers/${name}-pg/json`, undefined, [200, 404])).status !== 404
    )
      return fail('RESOURCE_ALREADY_EXISTS');
    networkAttempted = true;
    const network = (
      await json(
        'POST',
        '/networks/create',
        {
          Name: name,
          CheckDuplicate: true,
          Driver: 'bridge',
          Internal: true,
          Attachable: false,
          Ingress: false,
          EnableIPv6: false,
          Labels: labels,
        },
        [201],
      )
    ).value;
    if (typeof network['Id'] !== 'string' || !/^[a-f0-9]{64}$/u.test(network['Id']))
      return fail('NETWORK_CREATE_INVALID');
    networkId = network['Id'];
    postgresAttempted = true;
    const created = (
      await json(
        'POST',
        `/containers/create?name=${name}-pg`,
        {
          Image: image.reference,
          Env: [
            `POSTGRES_USER=devai_fixture`,
            `POSTGRES_PASSWORD=${password}`,
            'POSTGRES_DB=postgres',
          ],
          Labels: labels,
          ExposedPorts: { '5432/tcp': {} },
          HostConfig: {
            NetworkMode: networkId,
            PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
            ReadonlyRootfs: true,
            SecurityOpt: ['no-new-privileges:true'],
            Tmpfs: {
              '/var/lib/postgresql/data': 'rw,nosuid,noexec,size=536870912',
              '/var/run/postgresql': 'rw,nosuid,noexec',
              '/tmp': 'rw,nosuid,noexec',
            },
          },
        },
        [201],
      )
    ).value;
    if (typeof created['Id'] !== 'string' || !/^[a-f0-9]{64}$/u.test(created['Id']))
      return fail('CONTAINER_CREATE_INVALID');
    postgresId = created['Id'];
    await api('POST', `/containers/${postgresId}/start`, undefined, [204]);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const inspected = await ownedContainer(postgresId);
      if (inspected['Image'] !== image.id || !object(inspected['State'])['Running'])
        return fail('POSTGRES_NOT_RUNNING');
      const ports = object(object(inspected['NetworkSettings'])['Ports'])['5432/tcp'];
      if (!Array.isArray(ports) || ports.length !== 1) return fail('POSTGRES_PORT_INVALID');
      const portBinding = object(ports[0]);
      const port = Number(portBinding['HostPort']);
      if (
        portBinding['HostIp'] !== '127.0.0.1' ||
        !Number.isSafeInteger(port) ||
        port < 1 ||
        port > 65535
      )
        return fail('POSTGRES_PORT_INVALID');
      const logs = await api(
        'GET',
        `/containers/${postgresId}/logs?stdout=1&stderr=1&tail=100`,
        undefined,
        [200],
      );
      if (logs.bytes.includes(Buffer.from('database system is ready to accept connections'))) {
        const executable = (
          await json(
            'POST',
            `/containers/${postgresId}/exec`,
            {
              AttachStdout: true,
              AttachStderr: true,
              Cmd: ['pg_isready', '-h', '127.0.0.1', '-U', 'devai_fixture', '-d', 'postgres'],
            },
            [201],
          )
        ).value['Id'];
        if (typeof executable !== 'string' || !/^[a-f0-9]{64}$/u.test(executable))
          return fail('POSTGRES_READINESS_INVALID');
        await api('POST', `/exec/${executable}/start`, { Detach: false, Tty: false }, [200]);
        const state = (await json('GET', `/exec/${executable}/json`)).value;
        if (state['Running'] === false && state['ExitCode'] === 0) {
          postgresIdentity = { image, port };
          await verifyPostgres();
          return { host: '127.0.0.1', port };
        }
      }
      if (Date.now() >= deadline) return fail('POSTGRES_READINESS_TIMEOUT');
      await new Promise((accept) => setTimeout(accept, 200));
    }
  };
  const verifyPostgres = async (): Promise<void> => {
    if (postgresId === undefined || networkId === undefined || postgresIdentity === undefined)
      return fail('POSTGRES_IDENTITY_MISSING');
    const actual = await ownedContainer(postgresId);
    const host = object(actual['HostConfig']);
    const network = object(actual['NetworkSettings']);
    const ports = object(network['Ports'])['5432/tcp'];
    const networks = object(network['Networks']);
    if (
      actual['Image'] !== postgresIdentity.image.id ||
      object(actual['State'])['Running'] !== true ||
      host['NetworkMode'] !== networkId ||
      host['ReadonlyRootfs'] !== true ||
      !Array.isArray(actual['Mounts']) ||
      actual['Mounts'].some((mount) => object(mount)['Type'] !== 'tmpfs') ||
      !Array.isArray(ports) ||
      ports.length !== 1 ||
      object(ports[0])['HostIp'] !== '127.0.0.1' ||
      Number(object(ports[0])['HostPort']) !== postgresIdentity.port ||
      Object.keys(networks).length !== 1 ||
      object(Object.values(networks)[0])['NetworkID'] !== networkId
    )
      return fail('POSTGRES_IDENTITY_CHANGED');
  };
  const cleanup = async (timeoutMs = 30_000): Promise<readonly string[]> => {
    cleanupDeadline = Date.now() + timeoutMs;
    const errors: string[] = [];
    // A lost create response never implies that no resource exists.
    if (postgresAttempted && postgresId === undefined) {
      try {
        const response = await api('GET', `/containers/${name}-pg/json`, undefined, [200, 404]);
        if (response.status === 200) {
          const document = object(JSON.parse(response.bytes.toString('utf8')));
          const actualLabels = object(object(document['Config'])['Labels']);
          if (
            actualLabels['devai.native.nonce'] !== owner.nonce ||
            actualLabels['devai.native.plan'] !== owner.planSha256 ||
            typeof document['Id'] !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(document['Id'])
          )
            return fail('RESOURCE_OWNERSHIP_CHANGED');
          postgresId = document['Id'];
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (networkAttempted && networkId === undefined) {
      try {
        const response = await api('GET', `/networks/${name}`, undefined, [200, 404]);
        if (response.status === 200) {
          const document = object(JSON.parse(response.bytes.toString('utf8')));
          const actualLabels = object(document['Labels']);
          if (
            actualLabels['devai.native.nonce'] !== owner.nonce ||
            actualLabels['devai.native.plan'] !== owner.planSha256 ||
            typeof document['Id'] !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(document['Id'])
          )
            return fail('RESOURCE_OWNERSHIP_CHANGED');
          networkId = document['Id'];
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (postgresId !== undefined) {
      try {
        const present = await api('GET', `/containers/${postgresId}/json`, undefined, [200, 404]);
        if (present.status === 200) {
          await ownedContainer(postgresId);
          try {
            await api('POST', `/containers/${postgresId}/stop?t=2`, undefined, [204, 304]);
          } catch (error) {
            errors.push(String(error));
          }
          await api('DELETE', `/containers/${postgresId}?force=1&v=1`, undefined, [204]);
        }
        if (
          (await api('GET', `/containers/${postgresId}/json`, undefined, [200, 404])).status !== 404
        )
          return fail('CONTAINER_LEAKED');
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (networkId !== undefined) {
      try {
        const present = await api('GET', `/networks/${networkId}`, undefined, [200, 404]);
        if (present.status === 200) {
          const document = object(JSON.parse(present.bytes.toString('utf8')));
          const actualLabels = object(document['Labels']);
          if (
            actualLabels['devai.native.nonce'] !== owner.nonce ||
            actualLabels['devai.native.plan'] !== owner.planSha256
          )
            return fail('RESOURCE_OWNERSHIP_CHANGED');
          await api('DELETE', `/networks/${networkId}`, undefined, [204]);
        }
        if ((await api('GET', `/networks/${networkId}`, undefined, [200, 404])).status !== 404)
          return fail('NETWORK_LEAKED');
      } catch (error) {
        errors.push(String(error));
      }
    }
    return errors;
  };
  return Object.freeze({
    verify,
    verifyImage,
    provisionPostgres,
    verifyPostgres,
    cleanup,
    inspect,
  });
}

/** Finite read-only discovery for the parent's exact supervisor --inspect operation. */
export async function inspectNativeDockerArtifacts(
  docker: Omit<NativeDockerBinding, 'engine'>,
  images: { readonly postgres: string; readonly localstack?: string },
  ledger: NativeServiceLifecycle[] = [],
) {
  return createOwnedDockerEngine(
    { ...docker, engine: { id: '', serverVersion: '', apiVersion: '' } },
    { nonce: '1'.repeat(64), planSha256: hash(JSON.stringify({ docker, images })) },
    ledger,
  ).inspect(images);
}

/** Until the complete actual testcontainers protocol is accepted, no request is forwarded. */
export async function startOwnedDockerBroker(options: {
  readonly path: string;
  readonly nonce: string;
}) {
  if (!isAbsolute(options.path) || !/^[a-f0-9]{64}$/u.test(options.nonce))
    return fail('BROKER_PLAN_INVALID');
  const refusals: { method: string; path: string }[] = [];
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    refusals.push({ method: incoming.method ?? '', path: incoming.url ?? '' });
    incoming.resume();
    outgoing.writeHead(403, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ message: 'NATIVE_SERVICE_LOCALSTACK_PROTOCOL_UNSUPPORTED' }));
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(options.path, accept);
  });
  const stat = statSync(options.path);
  return Object.freeze({
    path: options.path,
    dev: stat.dev,
    ino: stat.ino,
    refusals,
    close: () =>
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
  });
}

/** Pure finite dispatcher shared by the Linux control host and private parent transport. */
export function createNativeServiceControlDispatcher(options: {
  readonly nonce: string;
  readonly kinds: readonly NativeServiceFixtureKind[];
  readonly redisProcessControl: NativeRedisProcessControl | null;
  readonly limits: NativeServiceControlContext['limits'];
  readonly backend: {
    readonly start: (
      kind: NativeServiceFixtureKind,
      request: NativeServiceControlRequest & { readonly operation: 'start' },
    ) => Promise<NativeServiceStartResult>;
    readonly stop: (
      handle: string,
      request?: NativeServiceControlRequest & { readonly operation: 'stop' },
    ) => Promise<void>;
    readonly redisProcessControl?: (
      handle: string,
      operation: 'redis-pause' | 'redis-resume',
      request?: NativeServiceControlRequest & {
        readonly operation: 'redis-pause' | 'redis-resume';
      },
    ) => Promise<void>;
  };
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(options.nonce) ||
    !validNativeRedisProcessControl(options.redisProcessControl) ||
    (options.redisProcessControl !== null &&
      (!options.kinds.includes('redis') ||
        typeof options.backend.redisProcessControl !== 'function')) ||
    options.kinds.length === 0 ||
    new Set(options.kinds).size !== options.kinds.length ||
    options.kinds.some(
      (kind) => !['postgres', 'redis', 'localstack-s3', 'localstack-s3-kms'].includes(kind),
    ) ||
    Object.keys(options.limits).sort().join(',') !==
      'maxConcurrent,maxInstances,perKind,requestTimeoutMs' ||
    !Number.isSafeInteger(options.limits.maxInstances) ||
    options.limits.maxInstances < 1 ||
    options.limits.maxInstances > 128 ||
    !Number.isSafeInteger(options.limits.maxConcurrent) ||
    options.limits.maxConcurrent < 1 ||
    options.limits.maxConcurrent > options.limits.maxInstances ||
    !Number.isSafeInteger(options.limits.requestTimeoutMs) ||
    options.limits.requestTimeoutMs < 100 ||
    options.limits.requestTimeoutMs > 120_000 ||
    options.limits.perKind === null ||
    typeof options.limits.perKind !== 'object' ||
    Array.isArray(options.limits.perKind) ||
    Object.keys(options.limits.perKind).sort().join(',') !== [...options.kinds].sort().join(',') ||
    options.kinds.some((kind) => {
      const ceiling = options.limits.perKind[kind];
      return (
        ceiling === undefined ||
        ceiling === null ||
        typeof ceiling !== 'object' ||
        Array.isArray(ceiling) ||
        Object.keys(ceiling).join(',') !== 'maxInstances' ||
        !Number.isSafeInteger(ceiling.maxInstances) ||
        ceiling.maxInstances < 1 ||
        ceiling.maxInstances > options.limits.maxInstances
      );
    })
  )
    return fail('CONTROL_PLAN_INVALID');
  options = {
    ...options,
    kinds: Object.freeze([...options.kinds]),
    redisProcessControl:
      options.redisProcessControl === null
        ? null
        : Object.freeze({ ...options.redisProcessControl }),
    limits: Object.freeze({
      ...options.limits,
      perKind: Object.freeze(
        Object.fromEntries(
          Object.entries(options.limits.perKind).map(([kind, ceiling]) => [
            kind,
            Object.freeze({ ...ceiling }),
          ]),
        ),
      ),
    }),
    backend: Object.freeze({ ...options.backend }),
  };
  const active = new Map<string, NativeServiceStartResult>();
  const queues = new Map<string, Promise<unknown>>();
  const paused = new Set<string>();
  const uncertainControls = new Set<string>();
  const transitions = new Map<string, number>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const serialize = async <T>(handle: string, action: () => Promise<T>): Promise<T> => {
    const prior = queues.get(handle) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(action);
    queues.set(handle, task);
    try {
      return await task;
    } finally {
      if (queues.get(handle) === task) queues.delete(handle);
    }
  };
  const cancelWatchdog = (handle: string): void => {
    const timer = watchdogs.get(handle);
    if (timer !== undefined) clearTimeout(timer);
    watchdogs.delete(handle);
  };
  const resumeForCleanup = async (handle: string): Promise<void> => {
    cancelWatchdog(handle);
    if (paused.has(handle) || uncertainControls.has(handle)) {
      if (!options.backend.redisProcessControl) return fail('CONTROL_REDIS_BACKEND_MISSING');
      await options.backend.redisProcessControl(handle, 'redis-resume');
      paused.delete(handle);
      uncertainControls.delete(handle);
    }
  };
  const seen = new Set<string>();
  const seenRequestIds = new Set<string>();
  const stopping = new Set<string>();
  const startsPerKind = new Map<NativeServiceFixtureKind, number>();
  const failures: { operation: string; error: string }[] = [];
  let starting = 0;
  let starts = 0;
  let closing = false;
  const cleanupActive = async (): Promise<void> => {
    for (const handle of active.keys()) {
      if (stopping.has(handle)) continue;
      stopping.add(handle);
      try {
        await serialize(handle, async () => {
          await resumeForCleanup(handle);
          await options.backend.stop(handle);
          active.delete(handle);
        });
      } catch (cause) {
        failures.push({
          operation: 'cleanup',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        stopping.delete(handle);
      }
    }
  };
  const error = (
    code: NativeServiceControlError,
    request?: Record<string, unknown>,
  ): NativeServiceControlResponse => {
    failures.push({ operation: 'refuse', error: code });
    return {
      schemaVersion: '1.0.0',
      nonce: options.nonce,
      scope:
        typeof request?.['scope'] === 'string' && /^(?:main|[a-f0-9]{32})$/u.test(request['scope'])
          ? request['scope']
          : 'main',
      requestId:
        typeof request?.['requestId'] === 'string' && /^[a-f0-9]{32}$/u.test(request['requestId'])
          ? request['requestId']
          : '0'.repeat(32),
      error: code,
    };
  };
  const dispatch = async (input: unknown): Promise<NativeServiceControlResponse> => {
    if (closing)
      return error(
        'SHUTTING_DOWN',
        input !== null && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : undefined,
      );
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      return error('INVALID_REQUEST');
    const request = input as Record<string, unknown>;
    if (
      request['schemaVersion'] !== '1.0.0' ||
      request['nonce'] !== options.nonce ||
      typeof request['scope'] !== 'string' ||
      !/^(?:main|[a-f0-9]{32})$/u.test(request['scope']) ||
      typeof request['requestId'] !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(request['requestId']) ||
      seenRequestIds.has(request['requestId']) ||
      Object.keys(request).sort().join(',') !==
        (request['operation'] === 'start'
          ? 'kind,nonce,operation,requestId,schemaVersion,scope'
          : 'handle,nonce,operation,requestId,schemaVersion,scope')
    )
      return error('INVALID_REQUEST', request);
    if (
      seenRequestIds.size >=
      options.limits.maxInstances * 4 +
        (options.redisProcessControl?.maxTransitionsPerInstance ?? 0) *
          (options.limits.perKind.redis?.maxInstances ?? 0) *
          2
    )
      return error('LIMIT_EXCEEDED', request);
    seenRequestIds.add(request['requestId']);
    const correlation = { scope: request['scope'], requestId: request['requestId'] };
    if (request['operation'] === 'start') {
      const kind = request['kind'];
      if (typeof kind !== 'string' || !options.kinds.includes(kind as NativeServiceFixtureKind))
        return error('INVALID_REQUEST', request);
      if (
        starts >= options.limits.maxInstances ||
        (startsPerKind.get(kind as NativeServiceFixtureKind) ?? 0) >=
          (options.limits.perKind[kind as NativeServiceFixtureKind]?.maxInstances ?? 0) ||
        active.size + starting >= options.limits.maxConcurrent
      )
        return error('LIMIT_EXCEEDED', request);
      starts += 1;
      startsPerKind.set(
        kind as NativeServiceFixtureKind,
        (startsPerKind.get(kind as NativeServiceFixtureKind) ?? 0) + 1,
      );
      starting += 1;
      try {
        const result = await options.backend.start(
          kind as NativeServiceFixtureKind,
          request as NativeServiceControlRequest & { operation: 'start' },
        );
        if (
          result.operation !== 'start' ||
          result.kind !== kind ||
          result.host !== '127.0.0.1' ||
          !/^[a-f0-9]{64}$/u.test(result.handle) ||
          seen.has(result.handle) ||
          !Number.isSafeInteger(result.port) ||
          result.port < 1 ||
          result.port > 65535
        )
          return fail('CONTROL_BACKEND_RESULT_INVALID');
        if (
          result.kind === 'postgres' &&
          (!result.credentials.username ||
            !result.credentials.password ||
            !result.credentials.database)
        )
          return fail('CONTROL_BACKEND_RESULT_INVALID');
        if (
          (result.kind === 'localstack-s3' || result.kind === 'localstack-s3-kms') &&
          (!result.credentials.accessKeyId ||
            !result.credentials.secretAccessKey ||
            result.credentials.region !== 'us-east-1')
        )
          return fail('CONTROL_BACKEND_RESULT_INVALID');
        seen.add(result.handle);
        const endpointCollision = [...active.values()].some(
          (fixture) => fixture.host === result.host && fixture.port === result.port,
        );
        active.set(result.handle, structuredClone(result));
        // Retain the new handle before refusing, so even a failed stop remains cleanup-owned.
        if (endpointCollision) {
          closing = true;
          await cleanupActive();
          return fail('CONTROL_BACKEND_ENDPOINT_COLLISION');
        }
        // An interrupted client never abandons the resource owned by the backend.
        if (closing) {
          await options.backend.stop(result.handle);
          active.delete(result.handle);
          return error('SHUTTING_DOWN', request);
        }
        return { schemaVersion: '1.0.0', nonce: options.nonce, ...correlation, ...result };
      } catch (cause) {
        failures.push({
          operation: 'start',
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return error('START_FAILED', request);
      } finally {
        starting -= 1;
      }
    }
    if (request['operation'] === 'redis-pause' || request['operation'] === 'redis-resume') {
      const handle = request['handle'];
      const control = options.redisProcessControl;
      if (
        control === null ||
        typeof handle !== 'string' ||
        active.get(handle)?.kind !== 'redis' ||
        stopping.has(handle)
      )
        return error('INVALID_REQUEST', request);
      try {
        return await serialize(handle, async () => {
          if (closing || active.get(handle)?.kind !== 'redis')
            return error('UNKNOWN_HANDLE', request);
          const target = request['operation'] === 'redis-pause';
          const changes = paused.has(handle) !== target;
          if (changes && (transitions.get(handle) ?? 0) >= control.maxTransitionsPerInstance)
            return error('LIMIT_EXCEEDED', request);
          if (!options.backend.redisProcessControl) return fail('CONTROL_REDIS_BACKEND_MISSING');
          uncertainControls.add(handle);
          await options.backend.redisProcessControl(
            handle,
            request['operation'] as 'redis-pause' | 'redis-resume',
            request as NativeServiceControlRequest & { operation: 'redis-pause' | 'redis-resume' },
          );
          uncertainControls.delete(handle);
          if (changes) transitions.set(handle, (transitions.get(handle) ?? 0) + 1);
          if (!target || changes) cancelWatchdog(handle);
          if (target) {
            paused.add(handle);
            // Idempotent pause cannot extend the lifetime of an existing pause.
            if (changes) {
              watchdogs.set(
                handle,
                setTimeout(() => {
                  closing = true;
                  failures.push({ operation: 'redis-pause-watchdog', error: 'TIMEOUT' });
                  void serialize(handle, () => resumeForCleanup(handle))
                    .then(cleanupActive)
                    .catch((cause) =>
                      failures.push({
                        operation: 'redis-pause-watchdog-cleanup',
                        error: String(cause),
                      }),
                    );
                }, control.maxPausedMs),
              );
            }
          } else paused.delete(handle);
          return {
            schemaVersion: '1.0.0',
            nonce: options.nonce,
            ...correlation,
            operation: request['operation'] as 'redis-pause' | 'redis-resume',
            handle,
            paused: target,
          };
        });
      } catch (cause) {
        failures.push({ operation: String(request['operation']), error: String(cause) });
        closing = true;
        await cleanupActive();
        return error('PROCESS_CONTROL_FAILED', request);
      }
    }
    if (request['operation'] === 'stop') {
      const handle = request['handle'];
      if (typeof handle !== 'string' || !active.has(handle) || stopping.has(handle))
        return error('UNKNOWN_HANDLE', request);
      stopping.add(handle);
      try {
        await serialize(handle, async () => {
          await resumeForCleanup(handle);
          await options.backend.stop(
            handle,
            request as NativeServiceControlRequest & { operation: 'stop' },
          );
          active.delete(handle);
        });
        return {
          schemaVersion: '1.0.0',
          nonce: options.nonce,
          ...correlation,
          operation: 'stop',
          handle,
          stopped: true,
        };
      } catch (cause) {
        failures.push({
          operation: 'stop',
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return error('STOP_FAILED', request);
      } finally {
        stopping.delete(handle);
      }
    }
    return error('INVALID_REQUEST', request);
  };
  return Object.freeze({
    dispatch,
    failures,
    activeHandles: () => Object.freeze([...active.keys()]),
    close: async (): Promise<void> => {
      closing = true;
      const deadline = Date.now() + options.limits.requestTimeoutMs;
      while ((starting !== 0 || stopping.size !== 0) && Date.now() < deadline)
        await new Promise((accept) => setTimeout(accept, 10));
      if (starting !== 0 || stopping.size !== 0) return fail('CONTROL_CLEANUP_TIMEOUT');
      await cleanupActive();
      if (active.size !== 0) return fail('CONTROL_RESOURCE_LEAKED');
    },
  });
}

/** Linux-kernel socket only; the owning container has a separate PID namespace and private parent transport. */
export async function startNativeLinuxServiceControlSocket(options: {
  readonly path: '/runtime/control/control.sock';
  readonly nonce: string;
  readonly kinds: readonly NativeServiceFixtureKind[];
  readonly redisProcessControl: NativeRedisProcessControl | null;
  readonly limits: NativeServiceControlContext['limits'];
  readonly backend: {
    readonly start: (
      kind: NativeServiceFixtureKind,
      request: NativeServiceControlRequest & { readonly operation: 'start' },
    ) => Promise<NativeServiceStartResult>;
    readonly stop: (
      handle: string,
      request?: NativeServiceControlRequest & { readonly operation: 'stop' },
    ) => Promise<void>;
    readonly redisProcessControl?: (
      handle: string,
      operation: 'redis-pause' | 'redis-resume',
      request?: NativeServiceControlRequest & {
        readonly operation: 'redis-pause' | 'redis-resume';
      },
    ) => Promise<void>;
  };
}) {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 1000 ||
    options.path !== '/runtime/control/control.sock'
  )
    return fail('LINUX_CONTROL_HOST_INVALID');
  const directory = dirname(options.path);
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    realpathSync(directory) !== directory ||
    parent.uid !== 1000 ||
    (parent.mode & 0o777) !== 0o700
  )
    return fail('LINUX_CONTROL_ROOT_INVALID');
  const dispatcher = createNativeServiceControlDispatcher(options);
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const failures: string[] = [];
  let closing = false;
  const server = createSocketServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let answered = false;
    const correlation = { scope: 'main', requestId: '0'.repeat(32) };
    const answer = (response: NativeServiceControlResponse): void => {
      if (answered) return;
      answered = true;
      clearTimeout(deadline);
      socket.end(`${JSON.stringify(response)}\n`);
    };
    const refuse = (error: NativeServiceControlError): void => {
      failures.push(error);
      answer({ schemaVersion: '1.0.0', nonce: options.nonce, ...correlation, error });
    };
    const deadline = setTimeout(() => refuse('TIMEOUT'), options.limits.requestTimeoutMs);
    socket.on('error', (error) => {
      failures.push(error.message);
    });
    socket.once('close', () => {
      clearTimeout(deadline);
      if (!answered) failures.push('CLIENT_DISCONNECTED');
      sockets.delete(socket);
    });
    socket.on('data', (chunk: Buffer) => {
      if (answered) {
        failures.push('MULTIPLE_REQUESTS');
        socket.destroy();
        return;
      }
      if (closing) {
        refuse('SHUTTING_DOWN');
        return;
      }
      if (buffer.length + chunk.length > 64 * 1024) {
        refuse('INVALID_REQUEST');
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (
        buffer
          .subarray(newline + 1)
          .toString('utf8')
          .trim() !== ''
      ) {
        refuse('INVALID_REQUEST');
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      } catch {
        refuse('INVALID_REQUEST');
        return;
      }
      if (request !== null && typeof request === 'object' && !Array.isArray(request)) {
        const fields = request as Record<string, unknown>;
        if (typeof fields['scope'] === 'string' && /^(?:main|[a-f0-9]{32})$/u.test(fields['scope']))
          correlation.scope = fields['scope'];
        if (typeof fields['requestId'] === 'string' && /^[a-f0-9]{32}$/u.test(fields['requestId']))
          correlation.requestId = fields['requestId'];
      }
      // Stop accepting input while this one request is being dispatched.
      socket.pause();
      const operation = dispatcher
        .dispatch(request)
        .then(answer)
        .catch(() => refuse('BACKEND_UNAVAILABLE'));
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(options.path, accept);
  });
  chmodSync(options.path, 0o600);
  const socketIdentity = lstatSync(options.path);
  if (!socketIdentity.isSocket() || socketIdentity.uid !== 1000 || socketIdentity.nlink !== 1)
    return fail('LINUX_CONTROL_SOCKET_INVALID');
  return Object.freeze({
    socket: Object.freeze({ path: options.path, dev: socketIdentity.dev, ino: socketIdentity.ino }),
    namespace: readlinkSync('/proc/self/ns/net'),
    failures,
    dispatcher,
    close: async (): Promise<void> => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      await Promise.all(pending);
      await dispatcher.close();
    },
  });
}
