import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  canonicalContainerPath,
  decodeContainerArchive,
  decodeContainerDependencyArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from './container-archive.js';
import {
  validateProtectedDependencyTransport,
  verifyProtectedDependencyInputs,
  type ProtectedDependencyInputs,
  type ProtectedDependencyTransport,
} from './release-dependency-transport.js';
import {
  captureProtectedMutationProgram,
  assertProtectedMutationProgramExecution,
  type ProtectedMutationProgram,
} from './release-mutation-program.js';
import type { PlannedTask, TaskExecutionResult } from './check-runner/types.js';

export interface CapturedProtectedMutationExecution {
  readonly program_identity_sha256: string;
  readonly result: TaskExecutionResult;
  readonly mutation_observation?: Buffer;
  readonly mutation_report?: Buffer;
}
const mutationExecutions = new WeakMap<
  object,
  {
    readonly program: ProtectedMutationProgram;
    readonly captured: CapturedProtectedMutationExecution;
  }
>();

/** Same invocation only. Returned caller buffers/status are never evidence custody. */
export function captureProtectedMutationExecution(
  result: unknown,
  program: ProtectedMutationProgram,
): CapturedProtectedMutationExecution {
  const entry =
    typeof result === 'object' && result !== null ? mutationExecutions.get(result) : undefined;
  if (entry === undefined || entry.program !== program)
    throw new Error('release-certification-mutation-program-invalid');
  return {
    ...entry.captured,
    result: { ...entry.captured.result },
    ...(entry.captured.mutation_observation === undefined
      ? {}
      : { mutation_observation: Buffer.from(entry.captured.mutation_observation) }),
    ...(entry.captured.mutation_report === undefined
      ? {}
      : { mutation_report: Buffer.from(entry.captured.mutation_report) }),
  };
}

export interface ProtectedContainerControls {
  /** Trusted host configuration only; no lifecycle request or candidate file selects these. */
  readonly docker_binary: string;
  readonly docker_binary_sha256: string;
  readonly docker_config_directory: string;
  readonly engine_socket: string;
  readonly engine_version: string;
  readonly image: string;
  /** Required for an unpublished local image Id; independently verified from exported config/layers. */
  readonly local_image?: {
    readonly configuration_sha256: string;
    readonly rootfs_diff_ids: readonly string[];
  };
  readonly node_version: string;
  readonly executables: Readonly<
    Record<string, { readonly path: string; readonly sha256: string }>
  >;
  readonly memory_bytes: number;
  readonly cpus: number;
  readonly pids_limit: number;
  readonly maximum_archive_bytes: number;
}

/** Frozen Linux dependency bytes; relative links are independently validated, never followed on host. */
export interface ProtectedContainerDependency {
  readonly mount_path: string;
  readonly archive: Buffer;
  readonly sha256: string;
  readonly inputs: ProtectedDependencyInputs;
}

interface ProtectedContainerExecutionBinding {
  readonly action_id: 'release certify' | 'release preflight';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly task_policy_digest_sha256: string;
  readonly plan_receipt_digest_sha256: string;
  readonly helper_identity_sha256: string;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('release-certification-container-invalid');
  return value as Record<string, unknown>;
}

function freezeIdentity<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeIdentity);
    Object.freeze(value);
  }
  return value;
}

// This trusted PID 1 never receives sink credentials, host paths, or provider objects.
// Exiting PID 1 tears down the complete PID namespace, including detached descendants.
const TASK_BOOTSTRAP = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const p=JSON.parse(process.argv[1]);const hash=x=>crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex');if(process.version!==p.node_version||hash(p.executable.path)!==p.executable.sha256){process.stderr.write('protected-container-toolchain-mismatch');process.exit(125)}const gi='/workspace/candidate/.git/index',gt='/tmp/devai-protected-git-index';if(fs.existsSync(gi)){fs.copyFileSync(gi,gt);p.environment.GIT_INDEX_FILE=gt}const r=cp.spawnSync(p.executable.path,p.argv,{cwd:p.cwd,env:p.environment,stdio:'inherit',timeout:p.timeout_ms,shell:false});if(r.error||r.signal||r.status===null){process.stderr.write('protected-container-task-abnormal');process.exit(124)}process.exit(r.status);`;

// The host owns this PID 1 and the mounted driver. Worker stdout/stderr never become a
// task result: fd 3/4 are the sole bounded observation/report channels.
// The envelope is written with synchronous fd writes rather than process.stdout.write:
// an async pipe write larger than the pipe buffer loses its unflushed remainder when
// process.exit() follows, which silently truncated every envelope over 64 KiB.
const MUTATION_BOOTSTRAP = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const p=JSON.parse(process.argv[1]);const hash=x=>crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex');const emit=(r,errorAbsent)=>{const b=Buffer.from(JSON.stringify({kind:'devai.protected-mutation-program-result.v1',observation_base64:Buffer.from(r?.output?.[3]??'').toString('base64'),process:{error_absent:errorAbsent,signal:r?.signal??null,status:r?.status??null},report_base64:Buffer.from(r?.output?.[4]??'').toString('base64'),schemaVersion:'1.0.0'}),'utf8');let o=0;while(o<b.length){try{o+=fs.writeSync(1,b,o,b.length-o)}catch(e){if(e.code!=='EAGAIN')throw e}}};if(process.version!==p.node_version||hash(p.executable.path)!==p.executable.sha256){emit(undefined,false);process.exit(125)}const gi='/workspace/candidate/.git/index',gt='/tmp/devai-protected-git-index';if(fs.existsSync(gi)){fs.copyFileSync(gi,gt);p.environment.GIT_INDEX_FILE=gt}let r;try{r=cp.spawnSync(p.executable.path,p.argv,{cwd:p.cwd,env:p.environment,stdio:['ignore','pipe','pipe','pipe','pipe'],timeout:p.timeout_ms,maxBuffer:p.maximum_buffer_bytes,shell:false})}catch{emit(undefined,false);process.exit(124)}emit(r,!r.error);if(r.error||r.signal||r.status===null)process.exit(124);process.exit(r.status);`;

const MUTATION_PROGRAM_ARGV = ['node', '/devai-host/run.mjs'] as const;
const MUTATION_ENVELOPE_KIND = 'devai.protected-mutation-program-result.v1';

function base64(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    throw new Error('release-certification-mutation-program-invalid');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > maximum || decoded.toString('base64') !== value)
    throw new Error('release-certification-mutation-program-invalid');
  return decoded;
}

function mutationEnvelopeLimit(observation: number, report: number): number {
  const encoded = (value: number) => 4 * Math.ceil(value / 3);
  const limit = encoded(observation) + encoded(report) + 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('release-certification-mutation-program-invalid');
  }
  return limit;
}

function mutationProgramManifest(files: readonly ContainerArchiveEntry[], maximum: number): string {
  let total = 0;
  let previous: string | undefined;
  const manifest = files.map((entry) => {
    if (
      entry.mode !== '100644' ||
      !canonicalContainerPath(entry.path) ||
      entry.bytes.byteLength === 0 ||
      entry.bytes.byteLength > maximum ||
      (previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0)
    )
      throw new Error('release-certification-mutation-program-invalid');
    previous = entry.path;
    total += entry.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > maximum)
      throw new Error('release-certification-mutation-program-invalid');
    return {
      path: entry.path,
      mode: entry.mode,
      size_bytes: entry.bytes.byteLength,
      sha256: digest(entry.bytes),
    };
  });
  if (manifest.length === 0) throw new Error('release-certification-mutation-program-invalid');
  return canonicalSha256(manifest);
}

function mutationEnvelope(
  bytes: Buffer,
  observationLimit: number,
  reportLimit: number,
): {
  readonly observation: Buffer;
  readonly report: Buffer;
  readonly process: {
    readonly error_absent: boolean;
    readonly signal: string | null;
    readonly status: number | null;
  };
} {
  if (bytes.byteLength > mutationEnvelopeLimit(observationLimit, reportLimit))
    throw new Error('release-certification-mutation-program-invalid');
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  } catch {
    throw new Error('release-certification-mutation-program-invalid');
  }
  const fields = ['kind', 'observation_base64', 'process', 'report_base64', 'schemaVersion'];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.kind !== MUTATION_ENVELOPE_KIND ||
    value.schemaVersion !== '1.0.0'
  )
    throw new Error('release-certification-mutation-program-invalid');
  const process = object(value.process);
  const signal = process.signal;
  const status = process.status;
  if (
    Object.keys(process).length !== 3 ||
    !Object.hasOwn(process, 'error_absent') ||
    !Object.hasOwn(process, 'signal') ||
    !Object.hasOwn(process, 'status') ||
    typeof process.error_absent !== 'boolean' ||
    (signal !== null && (typeof signal !== 'string' || !/^SIG[A-Z0-9]+$/u.test(signal))) ||
    (status !== null &&
      (typeof status !== 'number' ||
        !Number.isSafeInteger(status) ||
        status < 0 ||
        status > 255)) ||
    (status !== null && signal !== null) ||
    (status === null && signal === null && process.error_absent) ||
    !bytes.equals(Buffer.from(canonicalJson(value), 'utf8'))
  )
    throw new Error('release-certification-mutation-program-invalid');
  return {
    observation: base64(value.observation_base64, observationLimit),
    report: base64(value.report_base64, reportLimit),
    process: {
      error_absent: process.error_absent as boolean,
      signal: signal as string | null,
      status: status as number | null,
    },
  };
}

/** Exact non-inherited task environment shared by execution and private identity binding. */
export function protectedContainerTaskEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    ...environment,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export class ProtectedCertificationContainer {
  readonly #controls: ProtectedContainerControls;
  readonly #dependencies: readonly ProtectedContainerDependency[];
  readonly #dependencyTransport: ProtectedDependencyTransport;
  readonly #identity: Readonly<Record<string, unknown>>;
  #host: ReturnType<typeof createProtectedReleaseHostAdapter> | undefined;

  get identity(): Readonly<Record<string, unknown>> {
    return this.#identity;
  }

  runBound<T>(binding: ProtectedContainerExecutionBinding, operation: () => T): T {
    if (this.#host !== undefined) throw new Error('release-certification-container-in-use');
    this.#host = createProtectedReleaseHostAdapter(binding);
    try {
      return operation();
    } finally {
      this.#host = undefined;
    }
  }

  constructor(
    inputControls: ProtectedContainerControls,
    dependencies: readonly ProtectedContainerDependency[] = [],
  ) {
    // Capture once: validation, advertised identity and execution must never read
    // independently changing values from the caller's original object.
    const controls = JSON.parse(canonicalJson(inputControls)) as ProtectedContainerControls;
    this.#controls = controls;
    if (
      !isAbsolute(controls.docker_binary) ||
      !isAbsolute(controls.docker_config_directory) ||
      !/^unix:\/\/\/[^\0\r\n]+$/u.test(controls.engine_socket) ||
      !(
        /@sha256:[0-9a-f]{64}$/u.test(controls.image) ||
        /^sha256:[0-9a-f]{64}$/u.test(controls.image)
      ) ||
      (controls.image.startsWith('sha256:')
        ? controls.local_image === undefined ||
          !/^[0-9a-f]{64}$/u.test(controls.local_image.configuration_sha256) ||
          controls.local_image.rootfs_diff_ids.length === 0 ||
          controls.local_image.rootfs_diff_ids.some((id) => !/^sha256:[0-9a-f]{64}$/u.test(id))
        : controls.local_image !== undefined) ||
      !/^[0-9a-f]{64}$/u.test(controls.docker_binary_sha256) ||
      !/^v24\./u.test(controls.node_version) ||
      !controls.engine_version ||
      !Number.isSafeInteger(controls.memory_bytes) ||
      controls.memory_bytes < 64 * 1024 * 1024 ||
      !Number.isFinite(controls.cpus) ||
      controls.cpus <= 0 ||
      controls.cpus > 16 ||
      !Number.isSafeInteger(controls.pids_limit) ||
      controls.pids_limit < 2 ||
      controls.pids_limit > 4096 ||
      !Number.isSafeInteger(controls.maximum_archive_bytes) ||
      controls.maximum_archive_bytes < 1024 ||
      controls.executables.node?.path !== '/usr/local/bin/node' ||
      Object.entries(controls.executables).some(
        ([name, value]) =>
          !/^[A-Za-z0-9._-]+$/u.test(name) ||
          !/^\/[A-Za-z0-9._/-]+$/u.test(value.path) ||
          value.path.split('/').includes('..') ||
          !/^[0-9a-f]{64}$/u.test(value.sha256),
      )
    ) {
      throw new Error('release-certification-container-controls-invalid');
    }
    const mountPaths = new Set<string>();
    this.#dependencies = dependencies.map((dependency) => {
      if (
        !canonicalContainerPath(dependency.mount_path) ||
        !(
          dependency.mount_path === 'node_modules' ||
          dependency.mount_path.endsWith('/node_modules')
        ) ||
        [...mountPaths].some(
          (path) =>
            path === dependency.mount_path ||
            path.startsWith(`${dependency.mount_path}/`) ||
            dependency.mount_path.startsWith(`${path}/`),
        ) ||
        digest(dependency.archive) !== dependency.sha256
      ) {
        throw new Error('release-certification-dependency-identity-invalid');
      }
      mountPaths.add(dependency.mount_path);
      return {
        ...dependency,
        archive: Buffer.from(dependency.archive),
        inputs: JSON.parse(canonicalJson(dependency.inputs)) as ProtectedDependencyInputs,
      };
    });
    this.#dependencyTransport = validateProtectedDependencyTransport(
      this.#dependencies,
      controls.maximum_archive_bytes,
    );
    this.#identity = freezeIdentity({
      protocol: 'devai.protected-container-certification.v1',
      image: controls.image,
      ...(controls.local_image === undefined
        ? {}
        : { local_image: JSON.parse(canonicalJson(this.#controls.local_image)) as unknown }),
      engine_version: controls.engine_version,
      node_version: controls.node_version,
      docker_binary_sha256: controls.docker_binary_sha256,
      executables: JSON.parse(canonicalJson(this.#controls.executables)) as unknown,
      dependencies: this.#dependencies.map(({ mount_path, sha256 }) => ({ mount_path, sha256 })),
      dependency_transport_sha256: this.#dependencyTransport.identity_sha256,
      network: 'none',
      rootfs: 'read-only',
      capabilities: 'none',
      privilege_escalation: false,
      pids_limit: controls.pids_limit,
      memory_bytes: controls.memory_bytes,
      cpus: controls.cpus,
    });
    // Prevent replacement or shadowing of the public view. Execution consumes
    // the private identity regardless of public prototype modifications.
    Object.defineProperty(this, 'identity', {
      configurable: false,
      enumerable: true,
      get: () => this.#identity,
    });
  }

  #run(
    argv: readonly string[],
    input?: Buffer,
    timeout = 60_000,
    maximumBuffer = this.#controls.maximum_archive_bytes,
  ) {
    const c = this.#controls;
    if (this.#host === undefined) throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    if (digest(readFileSync(realpathSync(c.docker_binary))) !== c.docker_binary_sha256)
      throw new Error('release-certification-container-controls-invalid');
    const configuration = object(
      JSON.parse(readFileSync(resolve(c.docker_config_directory, 'config.json'), 'utf8')),
    );
    if (canonicalJson(configuration) !== canonicalJson({ auths: {} }))
      throw new Error('release-certification-container-controls-invalid');
    return this.#host.spawnSync(
      c.docker_binary,
      ['--config', c.docker_config_directory, '--host', c.engine_socket, ...argv],
      {
        ...(input === undefined ? {} : { input }),
        encoding: null,
        timeout,
        maxBuffer: maximumBuffer,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
  }

  #checked(argv: readonly string[], input?: Buffer): Buffer {
    const result = this.#run(argv, input);
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout)
    ) {
      throw new Error(`release-certification-container-operation-failed:${argv[0] ?? 'unknown'}`);
    }
    return result.stdout;
  }

  #restrictions(): string[] {
    const c = this.#controls;
    return [
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(c.pids_limit),
      '--memory',
      String(c.memory_bytes),
      '--memory-swap',
      String(c.memory_bytes),
      '--cpus',
      String(c.cpus),
      '--user',
      '10001:10001',
      '--ipc',
      'none',
      '--restart',
      'no',
      // Bounded scratch, still nosuid and nodev. The release DAG packs the candidate
      // package twice under /tmp, which does not fit in 64 MiB, and its tasks build
      // and run their own stub executables there. noexec constrains nothing a task
      // cannot already do through the interpreters it is given; it only turns those
      // checks into unrun ones. Isolation rests on the read-only rootfs, dropped
      // capabilities, no-new-privileges, the unprivileged user and the absent network.
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=536870912',
      '--env',
      'HOME=/tmp',
      '--env',
      'TMPDIR=/tmp',
    ];
  }

  verifyRuntime(): void {
    const version = this.#checked(['version', '--format', '{{.Server.Version}}'])
      .toString('utf8')
      .trim();
    const image = object(
      (
        JSON.parse(
          this.#checked(['image', 'inspect', this.#controls.image]).toString('utf8'),
        ) as unknown[]
      )[0],
    );
    if (
      version !== this.#controls.engine_version ||
      image.Os !== 'linux' ||
      image.Architecture !== 'arm64' ||
      (this.#controls.local_image === undefined
        ? !Array.isArray(image.RepoDigests) ||
          !image.RepoDigests.some(
            (value: unknown) =>
              typeof value === 'string' &&
              value.endsWith(this.#controls.image.slice(this.#controls.image.indexOf('@'))),
          )
        : image.Id !== this.#controls.image ||
          (image.Id !== `sha256:${this.#controls.local_image.configuration_sha256}` &&
            object(object(image.Descriptor).annotations)['config.digest'] !==
              `sha256:${this.#controls.local_image.configuration_sha256}`) ||
          object(image.RootFS).Type !== 'layers' ||
          canonicalJson(object(image.RootFS).Layers) !==
            canonicalJson(this.#controls.local_image.rootfs_diff_ids))
    ) {
      throw new Error('release-certification-container-identity-mismatch');
    }
    // Indirect tools (for example Stryker's process-tree utility) must be checked
    // before tasks start, not only when they happen to be the selected executable.
    const bootstrap = `const fs=require('node:fs'),c=require('node:crypto');const hash=p=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const executables=Object.fromEntries(Object.entries(JSON.parse(process.argv[1])).map(([name,{path}])=>[name,{path,sha256:hash(path)}]));console.log(JSON.stringify({version:process.version,sha256:hash(process.execPath),executables}))`;
    const observed = object(
      JSON.parse(
        this.#checked([
          'run',
          '--rm',
          ...this.#restrictions(),
          this.#controls.image,
          '/usr/local/bin/node',
          '-e',
          bootstrap,
          canonicalJson(this.#controls.executables),
        ]).toString('utf8'),
      ),
    );
    if (
      observed.version !== this.#controls.node_version ||
      observed.sha256 !== this.#controls.executables.node?.sha256 ||
      canonicalJson(object(observed.executables)) !== canonicalJson(this.#controls.executables)
    )
      throw new Error('release-certification-container-identity-mismatch');
  }

  execute(input: {
    readonly task: PlannedTask;
    readonly timeout_ms: number;
    readonly environment: Readonly<Record<string, string>>;
    readonly source: readonly ContainerArchiveEntry[];
    readonly prior_outputs: ReadonlyMap<string, ContainerArchiveEntry>;
    readonly declared_outputs: readonly string[];
    /** Private branded driver transport. Absent means the ordinary task path is unchanged. */
    readonly mutation_program?: ProtectedMutationProgram;
    /** Host-selected diagnostic subset only; never ordinary successful task outputs. */
    readonly diagnostic_output_paths?: readonly string[];
    readonly declared_namespaces?: readonly {
      readonly prefix: string;
      readonly required_paths: readonly string[];
    }[];
  }): {
    readonly result: TaskExecutionResult;
    readonly outputs: readonly ContainerArchiveEntry[];
    readonly diagnostic_outputs?: readonly ContainerArchiveEntry[];
    readonly mutation_observation?: Buffer;
    readonly mutation_report?: Buffer;
  } {
    const c = this.#controls;
    // Select the execution path once. A changing accessor must not bypass the
    // mutation snapshot and then supply a protected program on a later read.
    const mutationProgram = input.mutation_program;
    const diagnosticOutputPaths = input.diagnostic_output_paths;
    const declaredNamespaces = input.declared_namespaces;
    input = {
      task: input.task,
      timeout_ms: input.timeout_ms,
      environment: input.environment,
      source: input.source,
      prior_outputs: input.prior_outputs,
      declared_outputs: input.declared_outputs,
      ...(mutationProgram === undefined ? {} : { mutation_program: mutationProgram }),
      ...(diagnosticOutputPaths === undefined
        ? {}
        : { diagnostic_output_paths: diagnosticOutputPaths }),
      ...(declaredNamespaces === undefined ? {} : { declared_namespaces: declaredNamespaces }),
    };
    if (input.mutation_program !== undefined) {
      // The bytes validated below are the bytes transported later. A host
      // callback or shared caller buffer cannot swap candidate inputs between
      // context validation and the Docker copy/start operations.
      const copy = (entry: ContainerArchiveEntry): ContainerArchiveEntry => ({
        path: entry.path,
        mode: entry.mode,
        bytes: Buffer.from(entry.bytes),
      });
      input = {
        ...input,
        task: JSON.parse(canonicalJson(input.task)) as PlannedTask,
        environment: JSON.parse(canonicalJson(input.environment)) as Readonly<
          Record<string, string>
        >,
        source: Array.from(input.source, copy),
        prior_outputs: new Map(
          Array.from(input.prior_outputs, ([path, entry]) => [path, copy(entry)] as const),
        ),
        declared_outputs: [...input.declared_outputs],
        ...(input.diagnostic_output_paths === undefined
          ? {}
          : { diagnostic_output_paths: [...input.diagnostic_output_paths] }),
        ...(input.declared_namespaces === undefined
          ? {}
          : {
              declared_namespaces: Array.from(input.declared_namespaces, (entry) => ({
                prefix: entry.prefix,
                required_paths: [...entry.required_paths],
              })),
            }),
      };
    }
    const mutation =
      input.mutation_program === undefined
        ? undefined
        : captureProtectedMutationProgram(input.mutation_program);
    const mutationManifest =
      mutation === undefined
        ? undefined
        : mutationProgramManifest(mutation.files, c.maximum_archive_bytes);
    if (input.mutation_program !== undefined)
      assertProtectedMutationProgramExecution(input.mutation_program, {
        container_identity: this.#identity,
        environment: protectedContainerTaskEnvironment(input.environment),
        source: input.source,
        prior_outputs: input.prior_outputs,
      });
    const retain = <
      T extends {
        readonly result: TaskExecutionResult;
        readonly mutation_observation?: Buffer;
        readonly mutation_report?: Buffer;
      },
    >(
      value: T,
    ): T => {
      if (input.mutation_program !== undefined && mutation !== undefined)
        mutationExecutions.set(value, {
          program: input.mutation_program,
          captured: {
            program_identity_sha256: mutation.identity_sha256,
            result: { ...value.result },
            ...(value.mutation_observation === undefined
              ? {}
              : { mutation_observation: Buffer.from(value.mutation_observation) }),
            ...(value.mutation_report === undefined
              ? {}
              : { mutation_report: Buffer.from(value.mutation_report) }),
          },
        });
      return value;
    };
    const id = `devai-certify-${randomUUID()}`;
    const volume = `${id}-workspace`;
    const dependencyVolumes: string[] = [];
    let mutationProgramVolume: string | undefined;
    const loaders: string[] = [];
    let created = false;
    let volumeCreated = false;
    let stopped = false;
    let completed = false;
    const expected = new Set(input.declared_outputs);
    const diagnosticPaths = input.diagnostic_output_paths;
    const namespaces = input.declared_namespaces ?? [];
    const inNamespace = (path: string) =>
      namespaces.some(({ prefix }) => path.startsWith(`${prefix}/`));
    if (
      expected.size !== input.declared_outputs.length ||
      [...expected].some((path) => !canonicalContainerPath(path)) ||
      (diagnosticPaths !== undefined &&
        (!Array.isArray(diagnosticPaths) ||
          [...diagnosticPaths].some(
            (path, index, paths) =>
              typeof path !== 'string' ||
              !canonicalContainerPath(path) ||
              !expected.has(path) ||
              (index > 0 &&
                Buffer.compare(Buffer.from(paths[index - 1] ?? ''), Buffer.from(path)) >= 0),
          ))) ||
      namespaces.some(
        ({ prefix, required_paths }, index) =>
          !canonicalContainerPath(prefix) ||
          required_paths.length === 0 ||
          required_paths.some(
            (path) => !canonicalContainerPath(path) || !path.startsWith(`${prefix}/`),
          ) ||
          namespaces
            .slice(0, index)
            .some(
              (previous) =>
                previous.prefix === prefix ||
                previous.prefix.startsWith(`${prefix}/`) ||
                prefix.startsWith(`${previous.prefix}/`),
            ),
      ) ||
      (input.task.cwd !== '.' && !canonicalContainerPath(input.task.cwd))
    )
      throw new Error('release-certification-output-closure-invalid');
    const requestedDiagnostics = diagnosticPaths === undefined ? undefined : [...diagnosticPaths];
    const executable = c.executables[input.task.argv[0] ?? ''];
    if (
      executable === undefined ||
      canonicalJson(executable) !== canonicalJson(input.task.executable)
    )
      throw new Error('release-certification-container-toolchain-mismatch');
    if (
      mutation !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(mutation.identity_sha256) ||
        input.task.cwd !== '.' ||
        canonicalJson(input.task.argv) !== canonicalJson(MUTATION_PROGRAM_ARGV) ||
        canonicalJson(input.task.executable) !== canonicalJson(c.executables.node) ||
        canonicalJson(mutation.argv) !== canonicalJson(MUTATION_PROGRAM_ARGV) ||
        mutationEnvelopeLimit(
          mutation.maximum_observation_bytes,
          mutation.maximum_raw_report_bytes,
        ) > c.maximum_archive_bytes)
    )
      throw new Error('release-certification-mutation-program-invalid');
    const sources = new Map(input.source.map((entry) => [entry.path, entry]));
    verifyProtectedDependencyInputs(this.#dependencyTransport, input.source);
    if (
      sources.size !== input.source.length ||
      [...expected].some((path) => sources.has(path)) ||
      [...sources.keys(), ...input.prior_outputs.keys()].some((path) => inNamespace(path)) ||
      [...sources.keys(), ...expected, ...namespaces.map(({ prefix }) => prefix)].some((path) =>
        this.#dependencies.some(
          (dependency) =>
            path === dependency.mount_path || path.startsWith(`${dependency.mount_path}/`),
        ),
      )
    )
      throw new Error('release-certification-output-closure-invalid');
    try {
      this.#checked(['volume', 'create', '--label', `devai.certification=${id}`, volume]);
      volumeCreated = true;
      for (const [index] of this.#dependencies.entries()) {
        const dependencyVolume = `${id}-dependency-${index}`;
        this.#checked([
          'volume',
          'create',
          '--label',
          `devai.certification=${id}`,
          dependencyVolume,
        ]);
        dependencyVolumes.push(dependencyVolume);
      }
      if (this.#dependencies.length !== 0) {
        const loader = `${id}-dependency-loader`;
        this.#checked([
          'create',
          '--name',
          loader,
          ...this.#restrictions(),
          '--mount',
          `type=volume,source=${volume},target=/workspace`,
          ...this.#dependencies.flatMap((dependency, index) => [
            '--mount',
            `type=volume,source=${dependencyVolumes[index]},target=/workspace/candidate/${dependency.mount_path}`,
          ]),
          c.image,
          '/usr/local/bin/node',
          '--version',
        ]);
        loaders.push(loader);
        // Cross-volume pnpm links must be unpacked in their already-validated final
        // namespace. A temporary /dependency root changes their meaning and cannot work.
        this.#checked(
          ['cp', '-a', '-', `${loader}:/workspace`],
          encodeContainerDependencyArchive(
            [...this.#dependencyTransport.entries.values()].map((entry) => ({
              ...entry,
              path: `candidate/${entry.path}`,
            })),
          ),
        );
      }
      if (mutation !== undefined) {
        mutationProgramVolume = `${id}-mutation-program`;
        this.#checked([
          'volume',
          'create',
          '--label',
          `devai.certification=${id}`,
          mutationProgramVolume,
        ]);
        const loader = `${id}-mutation-program-loader`;
        this.#checked([
          'create',
          '--name',
          loader,
          ...this.#restrictions(),
          '--mount',
          `type=volume,source=${mutationProgramVolume},target=/devai-host`,
          c.image,
          '/usr/local/bin/node',
          '--version',
        ]);
        loaders.push(loader);
        this.#checked(
          ['cp', '-a', '-', `${loader}:/devai-host`],
          encodeContainerArchive(mutation.files),
        );
        const readback = decodeContainerArchive(
          this.#checked(['cp', `${loader}:/devai-host/.`, '-']),
          c.maximum_archive_bytes,
        );
        if (
          mutationManifest === undefined ||
          mutationProgramManifest(readback, c.maximum_archive_bytes) !== mutationManifest
        )
          throw new Error('release-certification-mutation-program-invalid');
      }
      const launch = {
        node_version: c.node_version,
        executable,
        argv: mutation === undefined ? input.task.argv.slice(1) : mutation.argv.slice(1),
        cwd: `/workspace/candidate${input.task.cwd === '.' ? '' : `/${input.task.cwd}`}`,
        timeout_ms: input.timeout_ms,
        environment: protectedContainerTaskEnvironment(input.environment),
        ...(mutation === undefined
          ? {}
          : {
              maximum_buffer_bytes: mutationEnvelopeLimit(
                mutation.maximum_observation_bytes,
                mutation.maximum_raw_report_bytes,
              ),
            }),
      };
      this.#checked([
        'create',
        '--name',
        id,
        '--label',
        `devai.certification=${id}`,
        ...this.#restrictions(),
        '--mount',
        `type=volume,source=${volume},target=/workspace`,
        ...this.#dependencies.flatMap((dependency, index) => [
          '--mount',
          `type=volume,source=${dependencyVolumes[index]},target=/workspace/candidate/${dependency.mount_path},readonly`,
        ]),
        ...(mutationProgramVolume === undefined
          ? []
          : ['--mount', `type=volume,source=${mutationProgramVolume},target=/devai-host,readonly`]),
        '--workdir',
        '/workspace/candidate',
        c.image,
        '/usr/local/bin/node',
        '-e',
        mutation === undefined ? TASK_BOOTSTRAP : MUTATION_BOOTSTRAP,
        JSON.stringify(launch),
      ]);
      created = true;
      const transport = [...input.source, ...input.prior_outputs.values()].map((entry) => ({
        ...entry,
        path: `candidate/${entry.path}`,
      }));
      this.#checked(['cp', '-a', '-', `${id}:/workspace`], encodeContainerArchive(transport));
      const execution = this.#run(
        ['start', '--attach', id],
        undefined,
        input.timeout_ms + 10_000,
        mutation === undefined
          ? c.maximum_archive_bytes
          : mutationEnvelopeLimit(
              mutation.maximum_observation_bytes,
              mutation.maximum_raw_report_bytes,
            ),
      );
      const inspected = object(
        (JSON.parse(this.#checked(['inspect', id]).toString('utf8')) as unknown[])[0],
      );
      const state = object(inspected.State);
      if (state.Running !== false || state.Pid !== 0 || state.Restarting !== false) {
        this.#checked(['kill', '--signal', 'KILL', id]);
        this.#checked(['wait', id]);
        throw new Error('release-certification-container-quiescence-unproven');
      }
      stopped = true;
      const host = object(inspected.HostConfig);
      const expectedMounts = [
        { Type: 'volume', Name: volume, Destination: '/workspace', RW: true },
        ...this.#dependencies.map((dependency, index) => ({
          Type: 'volume',
          Name: dependencyVolumes[index],
          Destination: `/workspace/candidate/${dependency.mount_path}`,
          RW: false,
        })),
        ...(mutationProgramVolume === undefined
          ? []
          : [
              {
                Type: 'volume',
                Name: mutationProgramVolume,
                Destination: '/devai-host',
                RW: false,
              },
            ]),
      ].sort((left, right) => left.Destination.localeCompare(right.Destination));
      const mounts = Array.isArray(inspected.Mounts)
        ? inspected.Mounts.map((value: unknown) => {
            const mount = object(value);
            return {
              Type: mount.Type,
              Name: mount.Name,
              Destination: mount.Destination,
              RW: mount.RW,
            };
          }).sort((left, right) =>
            String(left.Destination).localeCompare(String(right.Destination)),
          )
        : [];
      if (
        host.NetworkMode !== 'none' ||
        host.ReadonlyRootfs !== true ||
        host.Privileged !== false ||
        host.PidMode !== '' ||
        host.IpcMode !== 'none' ||
        object(host.RestartPolicy).Name !== 'no' ||
        host.Memory !== c.memory_bytes ||
        host.MemorySwap !== c.memory_bytes ||
        host.NanoCpus !== Math.round(c.cpus * 1e9) ||
        host.PidsLimit !== c.pids_limit ||
        canonicalJson(host.CapDrop) !== canonicalJson(['ALL']) ||
        canonicalJson(host.SecurityOpt) !== canonicalJson(['no-new-privileges']) ||
        canonicalJson(mounts) !== canonicalJson(expectedMounts)
      ) {
        throw new Error('release-certification-container-isolation-mismatch');
      }
      let result: TaskExecutionResult = {
        status: Number.isInteger(state.ExitCode) ? (state.ExitCode as number) : null,
        signal: execution.signal,
        stdout: mutation === undefined ? Buffer.from(execution.stdout ?? '').toString('utf8') : '',
        stderr: mutation === undefined ? Buffer.from(execution.stderr ?? '').toString('utf8') : '',
        ...(execution.error === undefined && state.OOMKilled === false && state.Error === ''
          ? {}
          : { errorCode: 'PROTECTED_CONTAINER_ABNORMAL' }),
      };
      const envelope = Buffer.from(execution.stdout ?? '');
      // A broken PID 1 is already an outer failure. It cannot offer a result envelope,
      // but if it did emit one before failing we retain the bounded diagnostic bytes.
      const mutationResult =
        mutation === undefined
          ? undefined
          : envelope.byteLength === 0 &&
              (result.status !== 0 || result.signal !== null || result.errorCode !== undefined)
            ? undefined
            : mutationEnvelope(
                envelope,
                mutation.maximum_observation_bytes,
                mutation.maximum_raw_report_bytes,
              );
      const workerFailed =
        mutationResult !== undefined &&
        (!mutationResult.process.error_absent ||
          mutationResult.process.signal !== null ||
          mutationResult.process.status !== 0);
      // The outer container state remains authoritative. An envelope can preserve failed
      // worker bytes, but neither its contents nor a forged inner success can promote a task.
      if (workerFailed && result.errorCode === undefined)
        result = { ...result, errorCode: 'PROTECTED_CONTAINER_ABNORMAL' };
      if (
        mutationResult !== undefined &&
        result.status === 0 &&
        result.errorCode === undefined &&
        (mutationResult.observation.byteLength === 0 || mutationResult.report.byteLength === 0)
      )
        throw new Error('release-certification-mutation-program-invalid');
      const failed =
        result.status !== 0 || result.signal !== null || result.errorCode !== undefined;
      if (failed && requestedDiagnostics === undefined) {
        completed = true;
        return retain({
          result,
          outputs: [],
          ...(mutationResult === undefined
            ? {}
            : {
                mutation_observation: Buffer.from(mutationResult.observation),
                mutation_report: Buffer.from(mutationResult.report),
              }),
        });
      }
      const captured = decodeContainerDependencyArchive(
        this.#checked(['cp', `${id}:/workspace/candidate/.`, '-']),
        c.maximum_archive_bytes,
      );
      const outputs: ContainerArchiveEntry[] = [];
      const observedSources = new Set<string>();
      const observedOutputs = new Set<string>();
      const observedDependencies = new Set<string>();
      for (const entry of captured) {
        const dependency = this.#dependencyTransport.entries.get(entry.path);
        if (dependency !== undefined) {
          if (
            dependency.mode !== entry.mode ||
            (dependency.mode === '120000' && entry.mode === '120000'
              ? dependency.target !== entry.target
              : dependency.mode === '120000' ||
                entry.mode === '120000' ||
                !dependency.bytes.equals(entry.bytes))
          )
            throw new Error('release-certification-dependency-changed');
          observedDependencies.add(entry.path);
          continue;
        }
        if (entry.mode === '120000')
          throw new Error('release-certification-source-mode-unsupported');
        const source = sources.get(entry.path);
        if (source !== undefined) {
          if (source.mode !== entry.mode || !source.bytes.equals(entry.bytes))
            throw new Error('release-certification-source-changed');
          observedSources.add(entry.path);
        } else {
          if (!expected.has(entry.path) && !inNamespace(entry.path))
            throw new Error('release-certification-output-closure-invalid');
          const predecessor = input.prior_outputs.get(entry.path);
          if (
            predecessor !== undefined &&
            (predecessor.mode !== entry.mode || !predecessor.bytes.equals(entry.bytes))
          )
            throw new Error('release-certification-predecessor-output-changed');
          observedOutputs.add(entry.path);
          outputs.push(entry);
        }
      }
      if (
        observedSources.size !== sources.size ||
        observedDependencies.size !== this.#dependencyTransport.entries.size ||
        [...input.prior_outputs.keys()].some((path) => !observedOutputs.has(path)) ||
        (!failed &&
          [...expected, ...namespaces.flatMap(({ required_paths }) => required_paths)].some(
            (path) => !observedOutputs.has(path),
          ))
      )
        throw new Error('release-certification-output-closure-invalid');
      completed = true;
      if (requestedDiagnostics === undefined)
        return retain({
          result,
          outputs,
          ...(mutationResult === undefined
            ? {}
            : {
                mutation_observation: Buffer.from(mutationResult.observation),
                mutation_report: Buffer.from(mutationResult.report),
              }),
        });
      const outputsByPath = new Map(outputs.map((entry) => [entry.path, entry]));
      // Failed task bytes remain diagnostic-only. Capture still proves the complete
      // source/dependency/predecessor population, but missing new outputs are allowed.
      // No receipt, success status, export permission or reusable artifact is issued.
      return retain({
        result,
        outputs: failed ? [] : outputs,
        diagnostic_outputs: Object.freeze(
          requestedDiagnostics.flatMap((path) => {
            const entry = outputsByPath.get(path);
            return entry === undefined
              ? []
              : [Object.freeze({ ...entry, bytes: Buffer.from(entry.bytes) })];
          }),
        ),
        ...(mutationResult === undefined
          ? {}
          : {
              mutation_observation: Buffer.from(mutationResult.observation),
              mutation_report: Buffer.from(mutationResult.report),
            }),
      });
    } finally {
      // Unproved namespace shutdown preserves resources for diagnosis, never accepts bytes.
      if (created && !stopped) {
        try {
          this.#checked(['kill', '--signal', 'KILL', id]);
          this.#checked(['wait', id]);
          stopped = true;
        } catch {
          /* preserved */
        }
      }
      if (!created || stopped) {
        if (created) this.#checked(['rm', id]);
        for (const loader of loaders) this.#checked(['rm', loader]);
        for (const dependencyVolume of dependencyVolumes)
          this.#checked(['volume', 'rm', dependencyVolume]);
        if (mutationProgramVolume !== undefined)
          this.#checked(['volume', 'rm', mutationProgramVolume]);
        if (volumeCreated) this.#checked(['volume', 'rm', volume]);
      }
      if (!completed && created && !stopped)
        // Namespace uncertainty must override all earlier results; accepting bytes is forbidden.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('release-certification-container-quiescence-unproven');
    }
  }
}
