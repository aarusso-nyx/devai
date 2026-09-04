import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import {
  canonicalContainerPath,
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
import type { PlannedTask, TaskExecutionResult } from './check-runner/types.js';

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

// This trusted PID 1 never receives sink credentials, host paths, or provider objects.
// Exiting PID 1 tears down the complete PID namespace, including detached descendants.
const TASK_BOOTSTRAP = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const p=JSON.parse(process.argv[1]);const hash=x=>crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex');if(process.version!==p.node_version||hash(p.executable.path)!==p.executable.sha256){process.stderr.write('protected-container-toolchain-mismatch');process.exit(125)}const r=cp.spawnSync(p.executable.path,p.argv,{cwd:p.cwd,env:p.environment,stdio:'inherit',timeout:p.timeout_ms,shell:false});if(r.error||r.signal||r.status===null){process.stderr.write('protected-container-task-abnormal');process.exit(124)}process.exit(r.status);`;

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
  readonly identity: Readonly<Record<string, unknown>>;
  #host: ReturnType<typeof createProtectedReleaseHostAdapter> | undefined;

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
    controls: ProtectedContainerControls,
    dependencies: readonly ProtectedContainerDependency[] = [],
  ) {
    this.#controls = JSON.parse(canonicalJson(controls)) as ProtectedContainerControls;
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
    this.identity = Object.freeze({
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
  }

  #run(argv: readonly string[], input?: Buffer, timeout = 60_000) {
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
        maxBuffer: c.maximum_archive_bytes,
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
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=67108864',
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
  } {
    const c = this.#controls;
    const id = `devai-certify-${randomUUID()}`;
    const volume = `${id}-workspace`;
    const dependencyVolumes: string[] = [];
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
      const launch = {
        node_version: c.node_version,
        executable,
        argv: input.task.argv.slice(1),
        cwd: `/workspace/candidate${input.task.cwd === '.' ? '' : `/${input.task.cwd}`}`,
        timeout_ms: input.timeout_ms,
        environment: protectedContainerTaskEnvironment(input.environment),
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
        '--workdir',
        '/workspace/candidate',
        c.image,
        '/usr/local/bin/node',
        '-e',
        TASK_BOOTSTRAP,
        JSON.stringify(launch),
      ]);
      created = true;
      const transport = [...input.source, ...input.prior_outputs.values()].map((entry) => ({
        ...entry,
        path: `candidate/${entry.path}`,
      }));
      this.#checked(['cp', '-a', '-', `${id}:/workspace`], encodeContainerArchive(transport));
      const execution = this.#run(['start', '--attach', id], undefined, input.timeout_ms + 10_000);
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
      const result: TaskExecutionResult = {
        status: Number.isInteger(state.ExitCode) ? (state.ExitCode as number) : null,
        signal: execution.signal,
        stdout: Buffer.from(execution.stdout ?? '').toString('utf8'),
        stderr: Buffer.from(execution.stderr ?? '').toString('utf8'),
        ...(execution.error === undefined && state.OOMKilled === false && state.Error === ''
          ? {}
          : { errorCode: 'PROTECTED_CONTAINER_ABNORMAL' }),
      };
      const failed =
        result.status !== 0 || result.signal !== null || result.errorCode !== undefined;
      if (failed && requestedDiagnostics === undefined) {
        completed = true;
        return { result, outputs: [] };
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
      if (requestedDiagnostics === undefined) return { result, outputs };
      const outputsByPath = new Map(outputs.map((entry) => [entry.path, entry]));
      // Failed task bytes remain diagnostic-only. Capture still proves the complete
      // source/dependency/predecessor population, but missing new outputs are allowed.
      // No receipt, success status, export permission or reusable artifact is issued.
      return {
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
      };
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
        if (volumeCreated) this.#checked(['volume', 'rm', volume]);
      }
      if (!completed && created && !stopped)
        // Namespace uncertainty must override all earlier results; accepting bytes is forbidden.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('release-certification-container-quiescence-unproven');
    }
  }
}
