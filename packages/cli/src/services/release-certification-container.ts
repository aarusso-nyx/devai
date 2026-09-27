import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProtectedReleaseHostAdapter } from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import {
  decodeContainerDependencyArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from './container-archive.js';
import {
  validateProtectedDependencyTransport,
  type ProtectedDependencyTransport,
} from './release-dependency-transport.js';
import type { ProtectedMutationProgram } from './release-mutation-program.js';
import type { TaskExecutionResult } from './check-runner/types.js';
import {
  assertContainerControls,
  assertContainerIsolation,
  captureContainerDependencies,
  classifyContainerOutputs,
  containerRestrictions,
  digest,
  object,
  validateContainerExecutionInputs,
  type ProtectedContainerControls,
  type ProtectedContainerDependency,
  type ProtectedContainerExecutionInput,
  reportContainerAttachFailure,
  reportContainerOperationFailure,
} from './release-certification-container-checks.js';
export type {
  ProtectedContainerControls,
  ProtectedContainerDependency,
  ProtectedContainerExecutionInput,
} from './release-certification-container-checks.js';

export interface CapturedProtectedMutationExecution {
  readonly program_identity_sha256: string;
  readonly result: TaskExecutionResult;
  readonly mutation_observation?: Buffer;
  readonly mutation_report?: Buffer;
}
/** @deprecated Mutation execution belongs to bedel. */
export function captureProtectedMutationExecution(
  _result: unknown,
  _program: ProtectedMutationProgram,
): CapturedProtectedMutationExecution {
  throw new Error('mutation-offloaded-to-bedel');
}

interface ProtectedContainerExecutionBinding {
  readonly action_id: 'release certify' | 'release preflight';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly task_policy_digest_sha256: string;
  readonly plan_receipt_digest_sha256: string;
  readonly helper_identity_sha256: string;
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

// Orphaned descendants are reparented onto PID 1, and a Node PID 1 blocked in spawnSync
// cannot reap them: libuv waits only on handles it owns, so they accumulate as zombies
// until the cgroup pid limit is full and every further fork fails with EAGAIN. Stryker
// shells out to ps for each process tree it tears down, so a real mutation run dies there
// having already produced its evidence. Measured in this container with 2000 orphans: a
// Node PID 1 leaves 2000 zombies and saturates the limit, at 1024 and at 4096 alike; this
// PID 1 leaves none. Raising the limit only moves the failure later.
// A POSIX shell reaps whatever is reparented onto it, so PID 1 is a shell whose only work
// is to run the same bootstrap unchanged and return its exit status. /bin/sh comes from
// the same pinned image as the node binary it launches and adds no trust root the image
// did not already carry. Docker's --init would also reap, but it bind-mounts an init from
// the host into a rootfs whose identity is pinned, which this deliberately avoids.
const REAPING_PID1 = '/usr/local/bin/node -e "$1" "$2" & p=$!; wait "$p"; exit $?';

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
    assertContainerControls(controls);
    this.#dependencies = captureContainerDependencies(dependencies);
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
      reportContainerOperationFailure(argv, result, input);
      throw new Error(`release-certification-container-operation-failed:${argv[0] ?? 'unknown'}`);
    }
    return result.stdout;
  }

  #restrictions(): string[] {
    return containerRestrictions(this.#controls);
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

  execute(input: ProtectedContainerExecutionInput): {
    readonly result: TaskExecutionResult;
    readonly outputs: readonly ContainerArchiveEntry[];
    readonly diagnostic_outputs?: readonly ContainerArchiveEntry[];
    readonly mutation_observation?: Buffer;
    readonly mutation_report?: Buffer;
  } {
    const c = this.#controls;
    if (input.mutation_program !== undefined) throw new Error('mutation-offloaded-to-bedel');
    const retain = <T>(value: T): T => value;
    const id = `devai-certify-${randomUUID()}`;
    const volume = `${id}-workspace`;
    const dependencyVolumes: string[] = [];
    const loaders: string[] = [];
    let created = false;
    let volumeCreated = false;
    let stopped = false;
    let completed = false;
    const { expected, namespaces, inNamespace, requestedDiagnostics, executable, sources } =
      validateContainerExecutionInputs(input, c, this.#dependencies, this.#dependencyTransport);
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
        '/bin/sh',
        '-c',
        REAPING_PID1,
        'devai-protected-pid1',
        TASK_BOOTSTRAP,
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
        c.maximum_archive_bytes,
      );
      // An attach timeout can leave the container running. Preserve only bounded host
      // metadata before shutdown verification refuses; task streams remain confidential.
      if (execution.error !== undefined || execution.signal !== null || execution.status !== 0) {
        reportContainerAttachFailure(execution, input.timeout_ms + 10_000);
      }
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
      assertContainerIsolation(inspected, c, volume, this.#dependencies, dependencyVolumes);
      const result: TaskExecutionResult = {
        status: Number.isInteger(state.ExitCode) ? (state.ExitCode as number) : null,
        signal: execution.signal,
        stdout: Buffer.from(execution.stdout ?? '').toString('utf8'),
        stderr: Buffer.from(execution.stderr ?? '').toString('utf8'),
        ...(execution.error === undefined && state.OOMKilled === false && state.Error === ''
          ? {}
          : { errorCode: 'PROTECTED_CONTAINER_ABNORMAL' }),
      };
      // The worker's stderr reaches PID 1 and is captured here, but a mutation task result
      // deliberately carries neither channel, so without this it is read and dropped and the
      // refusal that follows has no account of itself. The result stays empty; the host's own
      // diagnostic stream is not the task result and not evidence.
      const failed =
        result.status !== 0 || result.signal !== null || result.errorCode !== undefined;
      if (failed && requestedDiagnostics === undefined) {
        completed = true;
        return retain({
          result,
          outputs: [],
        });
      }
      const captured = decodeContainerDependencyArchive(
        this.#checked(['cp', `${id}:/workspace/candidate/.`, '-']),
        c.maximum_archive_bytes,
      );
      const outputs = classifyContainerOutputs({
        captured,
        dependencyTransport: this.#dependencyTransport,
        sources,
        expected,
        inNamespace,
        namespaces,
        input,
        failed,
      });
      completed = true;
      if (requestedDiagnostics === undefined)
        return retain({
          result,
          outputs,
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
      });
    } finally {
      // Unproved namespace shutdown preserves resources for diagnosis, never accepts bytes.
      if (created && !stopped) {
        const inspectStopped = () => {
          const inspection = object(
            (JSON.parse(this.#checked(['inspect', id]).toString('utf8')) as unknown[])[0],
          );
          const state = object(inspection.State);
          return state.Running === false && state.Pid === 0 && state.Restarting === false;
        };
        try {
          // A failed upload may leave a never-started container. Killing that
          // container fails; waiting can hang and hide the original transport error.
          stopped = inspectStopped();
        } catch {
          /* An unavailable observation is not proof of shutdown. */
        }
        if (!stopped) {
          try {
            this.#checked(['kill', '--signal', 'KILL', id]);
            this.#checked(['wait', id]);
            stopped = inspectStopped();
          } catch {
            /* preserved */
          }
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
