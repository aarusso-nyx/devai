import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createOwnedDockerEngine,
  inspectNativeDockerArtifacts,
  startNativeLinuxServiceControlSocket,
  type NativeServiceFixtureKind,
  type NativeServiceControlContext,
  type NativeServiceControlResponse,
  type NativeServiceControlRequest,
  type NativeServiceStartResult,
  type NativeDockerBinding,
  type NativeDockerImage,
  type NativeServiceLifecycle,
} from './native-service-docker-broker.js';

/** Parent-only data; never derived from a public result-population declaration. */
export interface NativeServicePlan {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly repository: string;
  readonly candidate: string;
  readonly candidateTree: string;
  readonly descriptorSha256: string;
  readonly dependencySha256: string;
  readonly supervisor: { readonly path: string; readonly sha256: string };
  readonly broker: { readonly path: string; readonly sha256: string };
  readonly taskId: string;
  readonly population: string;
  readonly profile: 'postgres-http-v1' | 'postgres-http-s3-v1' | 'playwright-chromium-web-v1';
  readonly taskPolicySha256: string;
  readonly inputSha256: string;
  readonly environmentSha256: string;
  readonly docker: NativeDockerBinding;
  readonly postgres: NativeDockerImage;
  readonly localstack?: NativeDockerImage;
  readonly command: {
    readonly executable: string;
    readonly sha256: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  };
  readonly timeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxBuffer: number;
}

export interface NativeServiceResult {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly planSha256: string;
  readonly child: {
    readonly pid: number | null;
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly started: boolean;
    readonly ended: boolean;
  };
  readonly context: { readonly path: string; readonly sha256: string } | null;
  readonly effectiveEnvironmentSha256: string | null;
  readonly lifecycle: readonly NativeServiceLifecycle[];
  readonly cleanup: { readonly complete: boolean; readonly errors: readonly string[] };
  readonly error?: string;
}

const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => {
  throw new Error(`NATIVE_SERVICE_${code}`);
};
const CONTROL_ENVIRONMENT =
  /^(?:PG[A-Z_]*|STYNX_TEST_PG_[A-Z_]+|DOCKER_[A-Z_]+|TESTCONTAINERS_[A-Z_]+|DEVAI_NATIVE_SERVICE_[A-Z_]+)$/u;

function validatePlan(plan: NativeServicePlan): void {
  if (
    plan.schemaVersion !== '1.0.0' ||
    !/^[a-f0-9]{64}$/u.test(plan.nonce) ||
    !/^[a-f0-9]{40}$/u.test(plan.candidate) ||
    !/^[a-f0-9]{40}$/u.test(plan.candidateTree) ||
    typeof plan.taskId !== 'string' ||
    !plan.taskId ||
    typeof plan.population !== 'string' ||
    !plan.population ||
    [
      plan.taskPolicySha256,
      plan.inputSha256,
      plan.environmentSha256,
      plan.command.sha256,
      plan.descriptorSha256,
      plan.dependencySha256,
      plan.supervisor.sha256,
      plan.broker.sha256,
    ].some((value) => !/^[a-f0-9]{64}$/u.test(value))
  )
    return fail('PLAN_INVALID');
  for (const [asset, expected] of [
    [plan.supervisor, fileURLToPath(import.meta.url)],
    [plan.broker, fileURLToPath(new URL('./native-service-docker-broker.js', import.meta.url))],
  ] as const) {
    if (
      asset.path !== realpathSync(expected) ||
      realpathSync(asset.path) !== asset.path ||
      !lstatSync(asset.path).isFile() ||
      hash(readFileSync(asset.path)) !== asset.sha256
    )
      return fail('SUPERVISOR_ASSET_CHANGED');
  }
  // Full backend support is a prerequisite, never a partial provisioning fallback.
  if (plan.profile !== 'postgres-http-v1' || plan.localstack !== undefined)
    return fail('BACKEND_UNIMPLEMENTED');
  if (
    !isAbsolute(plan.repository) ||
    realpathSync(plan.repository) !== plan.repository ||
    !statSync(plan.repository).isDirectory() ||
    !isAbsolute(plan.command.cwd) ||
    realpathSync(plan.command.cwd) !== plan.command.cwd ||
    relative(plan.repository, plan.command.cwd).split(/[\\/]/u).includes('..')
  )
    return fail('CHECKOUT_INVALID');
  if (
    realpathSync(plan.command.executable) !== plan.command.executable ||
    !lstatSync(plan.command.executable).isFile() ||
    hash(readFileSync(plan.command.executable)) !== plan.command.sha256 ||
    realpathSync(process.execPath) !== plan.command.executable
  )
    return fail('CHILD_EXECUTABLE_CHANGED');
  if (
    !Array.isArray(plan.command.argv) ||
    plan.command.argv.some((word) => typeof word !== 'string' || word.includes('\0')) ||
    Object.entries(plan.command.env).some(
      ([key, value]) =>
        CONTROL_ENVIRONMENT.test(key) || typeof value !== 'string' || value.includes('\0'),
    )
  )
    return fail('CHILD_ENVIRONMENT_INVALID');
  if (
    hash(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(plan.command.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      ),
    ) !== plan.environmentSha256
  )
    return fail('CHILD_ENVIRONMENT_CHANGED');
  for (const [value, min, max] of [
    [plan.timeoutMs, 1, 3_600_000],
    [plan.startupTimeoutMs, 100, 120_000],
    [plan.cleanupTimeoutMs, 1000, 60_000],
    [plan.maxBuffer, 1024, 64 * 1024 * 1024],
  ] as const)
    if (!Number.isSafeInteger(value) || value < min || value > max) return fail('LIMIT_INVALID');
}

/** The parent owns the authenticated launch; stdin itself confers no invocation authority. */
export async function superviseNativeServiceTask(
  plan: NativeServicePlan,
): Promise<NativeServiceResult> {
  validatePlan(plan);
  // Copy before the first async boundary: caller mutations cannot replace the effective plan.
  plan = structuredClone(plan);
  const planSha256 = hash(JSON.stringify(plan));
  const lifecycle: NativeServiceLifecycle[] = [];
  const cancellation = new AbortController();
  let stopChild: (() => void) | undefined;
  const interrupt = (): void => {
    cancellation.abort();
    stopChild?.();
  };
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  const engine = createOwnedDockerEngine(
    plan.docker,
    { nonce: plan.nonce, planSha256 },
    lifecycle,
    cancellation.signal,
  );
  let context: NativeServiceResult['context'] = null;
  let effectiveEnvironmentSha256: string | null = null;
  let child: NativeServiceResult['child'] = {
    pid: null,
    status: null,
    signal: null,
    started: false,
    ended: false,
  };
  let failure: string | undefined;
  let cleanupErrors: readonly string[] = [];
  let processCleanupError: string | undefined;
  const fixtureRoot = resolve(
    plan.repository,
    '.devai/state/native-config-traces',
    plan.nonce,
    'runtime/fixtures',
  );
  try {
    await engine.verifyImage(plan.postgres, 'postgres');
    const runtimeRoot = dirname(fixtureRoot);
    if (
      !existsSync(runtimeRoot) ||
      !statSync(runtimeRoot).isDirectory() ||
      realpathSync(runtimeRoot) !== runtimeRoot ||
      existsSync(fixtureRoot)
    )
      return fail('FIXTURE_ROOT_INVALID');
    mkdirSync(fixtureRoot, { mode: 0o700 });
    const password = randomBytes(32).toString('hex');
    const postgres = await engine.provisionPostgres(plan.postgres, password, plan.startupTimeoutMs);
    if (cancellation.signal.aborted) return fail('SUPERVISOR_INTERRUPTED');
    const path = resolve(fixtureRoot, 'service-context.json');
    const document = {
      schemaVersion: '1.0.0',
      nonce: plan.nonce,
      repository: plan.repository,
      candidate: plan.candidate,
      profile: plan.profile,
      postgres,
      fixtureRoot,
    };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    writeFileSync(path, bytes, { mode: 0o400, flag: 'wx' });
    context = { path, sha256: hash(bytes) };
    const env = {
      ...plan.command.env,
      STYNX_TEST_PG_HOST: postgres.host,
      STYNX_TEST_PG_PORT: String(postgres.port),
      STYNX_TEST_PG_USER: 'devai_fixture',
      STYNX_TEST_PG_PASSWORD: password,
      TESTCONTAINERS_RYUK_DISABLED: 'true',
      TESTCONTAINERS_REUSE_ENABLE: 'false',
      DEVAI_NATIVE_SERVICE_CONTEXT: path,
      DEVAI_NATIVE_SERVICE_CONTEXT_SHA256: context.sha256,
    };
    effectiveEnvironmentSha256 = hash(
      JSON.stringify(
        Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ),
    );
    lifecycle.push({
      sequence: lifecycle.length + 1,
      timestamp: new Date().toISOString(),
      operation: 'child-environment',
      resource: plan.command.cwd,
      status: 0,
      requestSha256: hash(JSON.stringify(plan.command.env)),
      responseSha256: effectiveEnvironmentSha256,
    });
    child = await new Promise<NativeServiceResult['child']>((accept, reject) => {
      const running = spawn(plan.command.executable, [...plan.command.argv], {
        cwd: plan.command.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let started = false;
      let exceeded = false;
      let size = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (): void => {
        const pid = running.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          /* An already exited group is absent. */
        }
        killTimer ??= setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* absent */
          }
        }, 1000);
      };
      stopChild = () => {
        exceeded = true;
        terminate();
      };
      if (cancellation.signal.aborted) stopChild();
      const timeout = setTimeout(() => {
        exceeded = true;
        terminate();
      }, plan.timeoutMs);
      const finish = (): void => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        stopChild = undefined;
      };
      const output = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
        size += chunk.length;
        if (size > plan.maxBuffer) {
          exceeded = true;
          terminate();
          return;
        }
        stream.write(chunk);
      };
      running.stdout.on('data', (chunk: Buffer) => output(chunk, process.stdout));
      running.stderr.on('data', (chunk: Buffer) => output(chunk, process.stderr));
      running.once('spawn', () => {
        started = true;
        child = {
          pid: running.pid ?? null,
          status: null,
          signal: null,
          started: true,
          ended: false,
        };
        if (cancellation.signal.aborted) stopChild?.();
        lifecycle.push({
          sequence: lifecycle.length + 1,
          timestamp: new Date().toISOString(),
          operation: 'child-start',
          resource: String(running.pid),
          status: 0,
          requestSha256: hash(
            JSON.stringify({
              executable: plan.command.executable,
              argv: plan.command.argv,
              cwd: plan.command.cwd,
            }),
          ),
          responseSha256: hash(String(running.pid)),
        });
      });
      running.once('error', (error) => {
        finish();
        reject(error);
      });
      running.once('exit', () => {
        if (running.pid === undefined) return;
        try {
          process.kill(-running.pid, 0);
          exceeded = true;
          terminate();
        } catch {
          /* Normal runner exit has no remaining process group. */
        }
      });
      running.once('close', (status, signal) => {
        finish();
        if (exceeded) failure = 'NATIVE_SERVICE_CHILD_INCOMPLETE';
        lifecycle.push({
          sequence: lifecycle.length + 1,
          timestamp: new Date().toISOString(),
          operation: 'child-end',
          resource: String(running.pid),
          status: status ?? -1,
          requestSha256: hash(''),
          responseSha256: hash(JSON.stringify({ status, signal })),
        });
        accept({ pid: running.pid ?? null, status, signal, started, ended: true });
      });
    });
    if (
      hash(readFileSync(context.path)) !== context.sha256 ||
      realpathSync(context.path) !== context.path ||
      lstatSync(context.path).nlink !== 1 ||
      (lstatSync(context.path).mode & 0o777) !== 0o400
    )
      return fail('CONTEXT_CHANGED');
    await engine.verify();
    await engine.verifyPostgres();
    if (cancellation.signal.aborted) return fail('SUPERVISOR_INTERRUPTED');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (child.pid !== null) {
        const pid = child.pid;
        const alive = (): boolean => {
          try {
            process.kill(-pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
            throw error;
          }
        };
        if (alive()) {
          failure = 'NATIVE_SERVICE_CHILD_DESCENDANT_LEAK';
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Absence is checked below. */
          }
          const deadline = Date.now() + Math.min(plan.cleanupTimeoutMs, 5000);
          while (alive() && Date.now() < deadline)
            await new Promise((accept) => setTimeout(accept, 50));
          if (alive()) processCleanupError = 'NATIVE_SERVICE_CHILD_PROCESS_LEAKED';
        }
      }
    } catch (error) {
      processCleanupError = error instanceof Error ? error.message : String(error);
    }
    cleanupErrors = [
      ...(await engine.cleanup(plan.cleanupTimeoutMs)),
      ...(processCleanupError === undefined ? [] : [processCleanupError]),
    ];
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
  }
  return {
    schemaVersion: '1.0.0',
    nonce: plan.nonce,
    planSha256,
    child,
    context,
    effectiveEnvironmentSha256,
    lifecycle,
    cleanup: { complete: cleanupErrors.length === 0, errors: cleanupErrors },
    ...(failure === undefined ? {} : { error: failure }),
  };
}

/** Actual Linux facts from a package-owned helper, never candidate supplied success. */
export interface NativeLinuxIsolationFacts {
  readonly schemaVersion: '1.0.0';
  readonly platform: string;
  readonly architecture: string;
  readonly node: { readonly path: string; readonly version: string; readonly sha256: string };
  readonly uid: number;
  readonly gid: number;
  readonly namespace: string;
  readonly namespaces: {
    readonly pid: string;
    readonly mount: string;
    readonly ipc: string;
    readonly user: string;
  };
  readonly interfaces: readonly {
    readonly name: string;
    readonly flags: string;
    readonly state: string;
  }[];
  readonly addresses: readonly {
    readonly name: string;
    readonly address: string;
    readonly family: string;
  }[];
  readonly ipv4Routes: string;
  readonly ipv6Routes: string;
  readonly ipv6Addresses: string;
  readonly processStatus: string;
  readonly mountInfo: string;
}

/** Executed through the separate host-owned Docker exec channel in the exact pinned image. */
export function inspectNativeLinuxIsolation(): NativeLinuxIsolationFacts {
  if (process.platform !== 'linux') return fail('LINUX_REQUIRED');
  return {
    schemaVersion: '1.0.0',
    platform: process.platform,
    architecture: process.arch,
    node: {
      path: realpathSync(process.execPath),
      version: process.version,
      sha256: hash(readFileSync(process.execPath)),
    },
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    namespace: readlinkSync('/proc/self/ns/net'),
    namespaces: {
      pid: readlinkSync('/proc/self/ns/pid'),
      mount: readlinkSync('/proc/self/ns/mnt'),
      ipc: readlinkSync('/proc/self/ns/ipc'),
      user: readlinkSync('/proc/self/ns/user'),
    },
    interfaces: readdirSync('/sys/class/net')
      .sort()
      .map((name) => ({
        name,
        flags: readFileSync(`/sys/class/net/${name}/flags`, 'utf8').trim(),
        state: readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim(),
      })),
    addresses: Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
      (addresses ?? []).map((address) => ({
        name,
        address: address.address,
        family: address.family,
      })),
    ),
    ipv4Routes: readFileSync('/proc/net/route', 'utf8'),
    ipv6Routes: readFileSync('/proc/net/ipv6_route', 'utf8'),
    ipv6Addresses: readFileSync('/proc/net/if_inet6', 'utf8'),
    processStatus: readFileSync('/proc/self/status', 'utf8'),
    mountInfo: readFileSync('/proc/self/mountinfo', 'utf8'),
  };
}

/** Topology is verified from actual procfs observations in addition to engine configuration. */
export function assertNativeLinuxIsolation(
  facts: NativeLinuxIsolationFacts,
  expected: {
    readonly namespace: string;
    readonly nodeSha256: string;
    readonly architecture: 'arm64' | 'x64';
  },
): void {
  if (
    facts.schemaVersion !== '1.0.0' ||
    facts.platform !== 'linux' ||
    facts.architecture !== expected.architecture ||
    facts.node.path !== '/usr/local/bin/node' ||
    facts.node.version !== 'v24.20.0' ||
    facts.node.sha256 !== expected.nodeSha256 ||
    !/^net:\[[0-9]+\]$/u.test(facts.namespace) ||
    facts.namespace !== expected.namespace ||
    facts.uid !== 1000 ||
    facts.gid !== 1000
  )
    return fail('LINUX_RUNTIME_IDENTITY_INVALID');
  const interfaces = facts.interfaces;
  if (
    new Set(interfaces.map((entry) => entry.name)).size !== interfaces.length ||
    interfaces.filter((entry) => entry.name === 'lo').length !== 1 ||
    interfaces.some(
      (entry) =>
        !/^0x[a-f0-9]+$/u.test(entry.flags) ||
        (entry.name === 'lo'
          ? (Number.parseInt(entry.flags, 16) & 1) !== 1
          : (Number.parseInt(entry.flags, 16) & 1) !== 0 || entry.state !== 'down'),
    ) ||
    facts.addresses.some(
      (entry) => entry.name !== 'lo' || !['127.0.0.1', '::1'].includes(entry.address),
    )
  )
    return fail('LINUX_EXTERNAL_INTERFACE');
  for (const line of facts.ipv4Routes.trim().split('\n').slice(1)) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/u);
    if (
      fields[0] !== 'lo' ||
      fields[1] === undefined ||
      !/^[a-fA-F0-9]{8}$/u.test(fields[1]) ||
      (Number.parseInt(fields[1], 16) & 255) !== 127
    )
      return fail('LINUX_EXTERNAL_ROUTE');
  }
  for (const line of facts.ipv6Routes.trim().split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/u);
    if (
      fields.length !== 10 ||
      fields[9] !== 'lo' ||
      fields[8] === undefined ||
      !/^[a-fA-F0-9]{8}$/u.test(fields[8]) ||
      !(
        (Number.parseInt(fields[8], 16) & 0x200) !== 0 ||
        (fields[0] === '0'.repeat(31) + '1' && fields[1] === '80')
      )
    )
      return fail('LINUX_EXTERNAL_ROUTE');
  }
  for (const line of facts.ipv6Addresses.trim().split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 6 || fields[5] !== 'lo' || fields[0] !== '0'.repeat(31) + '1')
      return fail('LINUX_EXTERNAL_ADDRESS');
  }
  const status = new Map(
    facts.processStatus.split('\n').map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
    }),
  );
  if (
    ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].some(
      (key) => status.get(key) !== '0000000000000000',
    ) ||
    status.get('NoNewPrivs') !== '1' ||
    status.get('Seccomp') !== '2' ||
    !facts.mountInfo.split('\n').some((line) => {
      const fields = line.split(' ');
      return fields[4] === '/' && fields[5]?.split(',').includes('ro');
    })
  )
    return fail('LINUX_CONTAINMENT_INVALID');
}

/** Parent-only bootstrap carried by the separate Linux control container's Docker attach input. */
export interface NativeLinuxControlHostPlan {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly namespace: string;
  readonly path: '/runtime/control/control.sock';
  readonly kinds: readonly NativeServiceFixtureKind[];
  readonly redisProcessControl: NativeServiceControlContext['redisProcessControl'];
  readonly limits: NativeServiceControlContext['limits'];
}

/** No raw Docker endpoint enters this Linux process; every effect is delegated over its parent-only channel. */
async function runNativeLinuxControlHost(): Promise<void> {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done || Buffer.byteLength(first.value) > 64 * 1024)
    return fail('LINUX_CONTROL_BOOTSTRAP_INVALID');
  const plan = JSON.parse(first.value) as NativeLinuxControlHostPlan;
  if (
    plan.schemaVersion !== '1.0.0' ||
    !/^[a-f0-9]{64}$/u.test(plan.nonce) ||
    plan.namespace !== readlinkSync('/proc/self/ns/net') ||
    Object.keys(plan).sort().join(',') !==
      'kinds,limits,namespace,nonce,path,redisProcessControl,schemaVersion'
  )
    return fail('LINUX_CONTROL_BOOTSTRAP_INVALID');
  const pending = new Map<
    string,
    {
      accept: (response: NativeServiceControlResponse) => void;
      reject: (error: Error) => void;
      deadline: ReturnType<typeof setTimeout>;
      scope: string;
      requestId: string;
    }
  >();
  const request = (
    operation: NativeServiceControlRequest,
    origin: 'native' | 'cleanup',
  ): Promise<NativeServiceControlResponse> =>
    new Promise((accept, reject) => {
      const id = randomBytes(32).toString('hex');
      const deadline = setTimeout(() => {
        pending.delete(id);
        reject(new Error('NATIVE_SERVICE_PARENT_TIMEOUT'));
      }, plan.limits.requestTimeoutMs);
      pending.set(id, {
        accept,
        reject,
        deadline,
        scope: operation.scope,
        requestId: operation.requestId,
      });
      process.stdout.write(`${JSON.stringify({ frame: 'request', id, origin, ...operation })}\n`);
    });
  const socket = await startNativeLinuxServiceControlSocket({
    ...plan,
    backend: {
      start: async (_kind, clientRequest) => {
        const result = await request(clientRequest, 'native');
        if ('error' in result || result.operation !== 'start')
          return fail('CONTROL_PARENT_START_FAILED');
        const {
          schemaVersion: _schemaVersion,
          nonce: _nonce,
          scope: _scope,
          requestId: _requestId,
          ...actual
        } = result;
        return actual as NativeServiceStartResult;
      },
      redisProcessControl: async (handle, operation, clientRequest) => {
        const result = await request(
          clientRequest ?? {
            schemaVersion: '1.0.0',
            nonce: plan.nonce,
            scope: 'main',
            requestId: randomBytes(16).toString('hex'),
            operation,
            handle,
          },
          clientRequest === undefined ? 'cleanup' : 'native',
        );
        if (
          'error' in result ||
          result.operation !== operation ||
          result.handle !== handle ||
          result.paused !== (operation === 'redis-pause')
        )
          return fail('CONTROL_PARENT_REDIS_PROCESS_FAILED');
      },
      stop: async (handle, clientRequest) => {
        const result = await request(
          clientRequest ?? {
            schemaVersion: '1.0.0',
            nonce: plan.nonce,
            scope: 'main',
            requestId: randomBytes(16).toString('hex'),
            operation: 'stop',
            handle,
          },
          clientRequest === undefined ? 'cleanup' : 'native',
        );
        if (
          'error' in result ||
          result.operation !== 'stop' ||
          result.handle !== handle ||
          result.stopped !== true
        )
          return fail('CONTROL_PARENT_STOP_FAILED');
      },
    },
  });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: '1.0.0', nonce: plan.nonce, frame: 'ready', socket: socket.socket, namespace: socket.namespace })}\n`,
  );
  let failure: unknown;
  let closePromise: Promise<void> | undefined;
  try {
    for (;;) {
      const next = lines.next();
      const selected =
        closePromise === undefined
          ? { kind: 'line' as const, value: await next }
          : await Promise.race([
              next.then((value) => ({ kind: 'line' as const, value })),
              closePromise.then(() => ({ kind: 'closed' as const })),
            ]);
      if (selected.kind === 'closed') break;
      const incoming = selected.value;
      if (incoming.done) {
        failure = new Error('NATIVE_SERVICE_PARENT_CHANNEL_ENDED');
        break;
      }
      if (Buffer.byteLength(incoming.value) > 64 * 1024)
        return fail('CONTROL_PARENT_RESPONSE_INVALID');
      const frame = JSON.parse(incoming.value) as Record<string, unknown>;
      if (frame['schemaVersion'] !== '1.0.0' || frame['nonce'] !== plan.nonce)
        return fail('CONTROL_PARENT_RESPONSE_INVALID');
      if (
        frame['frame'] === 'close' &&
        Object.keys(frame).sort().join(',') === 'frame,nonce,schemaVersion'
      ) {
        if (closePromise !== undefined) return fail('CONTROL_PARENT_CLOSE_REPEATED');
        closePromise = socket.close();
        continue;
      }
      if (
        frame['frame'] !== 'response' ||
        typeof frame['id'] !== 'string' ||
        Object.keys(frame).sort().join(',') !== 'frame,id,nonce,response,schemaVersion'
      )
        return fail('CONTROL_PARENT_RESPONSE_INVALID');
      const waiting = pending.get(frame['id']);
      if (waiting === undefined) return fail('CONTROL_PARENT_RESPONSE_UNKNOWN');
      const response = frame['response'] as NativeServiceControlResponse;
      if (
        response.schemaVersion !== '1.0.0' ||
        response.nonce !== plan.nonce ||
        response.scope !== waiting.scope ||
        response.requestId !== waiting.requestId
      )
        return fail('CONTROL_PARENT_RESPONSE_INVALID');
      clearTimeout(waiting.deadline);
      pending.delete(frame['id']);
      waiting.accept(response);
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.deadline);
      waiting.reject(new Error('NATIVE_SERVICE_PARENT_CHANNEL_ENDED'));
    }
    pending.clear();
    try {
      await (closePromise ?? socket.close());
    } catch (error) {
      failure ??= error;
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1.0.0', nonce: plan.nonce, frame: 'closed', complete: failure === undefined && socket.failures.length === 0 && socket.dispatcher.failures.length === 0, failures: [...socket.failures, ...socket.dispatcher.failures] })}\n`,
    );
  }
  reader.close();
  process.stdin.pause();
  if (failure !== undefined) throw failure;
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--linux-control-host') {
    await runNativeLinuxControlHost();
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === '--linux-inspect') {
    process.stdout.write(`${JSON.stringify(inspectNativeLinuxIsolation())}\n`);
    return;
  }
  // Only the package-owned parent supplies this control input; native children inherit no such FD.
  const bytes = readFileSync(0);
  if (bytes.length > 4 * 1024 * 1024) return fail('CONTROL_INPUT_TOO_LARGE');
  const input = JSON.parse(bytes.toString('utf8')) as NativeServicePlan;
  if (process.argv.length === 3 && process.argv[2] === '--inspect') {
    const inspection = input as unknown as {
      docker: Omit<NativeDockerBinding, 'engine'>;
      postgres: { reference: string };
      localstack?: { reference: string };
    };
    const ledger: NativeServiceLifecycle[] = [];
    const artifacts = await inspectNativeDockerArtifacts(
      inspection.docker,
      {
        postgres: inspection.postgres.reference,
        ...(inspection.localstack === undefined
          ? {}
          : { localstack: inspection.localstack.reference }),
      },
      ledger,
    );
    writeFileSync(
      3,
      `${JSON.stringify({ schemaVersion: '1.0.0', ...artifacts, lifecycle: ledger })}\n`,
    );
    return;
  }
  if (process.argv.length !== 2) return fail('SUPERVISOR_ARGUMENT_UNSUPPORTED');
  const result = await superviseNativeServiceTask(input);
  writeFileSync(3, `${JSON.stringify(result)}\n`);
  process.exitCode =
    result.cleanup.complete && result.error === undefined ? (result.child.status ?? 1) : 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    try {
      writeFileSync(
        3,
        `${JSON.stringify({ schemaVersion: '1.0.0', error: error instanceof Error ? error.message : String(error), cleanup: { complete: false, errors: ['supervisor incomplete'] } })}\n`,
      );
    } catch {
      /* Missing parent-only result FD never creates a success. */
    }
    process.exitCode = 1;
  });
}
