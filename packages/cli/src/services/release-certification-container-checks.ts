import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  canonicalContainerPath,
  decodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from './container-archive.js';
import {
  verifyProtectedDependencyInputs,
  type ProtectedDependencyInputs,
  type ProtectedDependencyTransport,
} from './release-dependency-transport.js';
import type { ProtectedMutationProgram } from './release-mutation-program.js';
import type { PlannedTask } from './check-runner/types.js';

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

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('release-certification-container-invalid');
  return value as Record<string, unknown>;
}

/** One planned task run inside the certification container. */
export interface ProtectedContainerExecutionInput {
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
}

/** Refuse host container controls outside the pinned engine, image, toolchain and resource bounds. */
export function assertContainerControls(controls: ProtectedContainerControls): void {
  if (
    !isAbsolute(controls.docker_binary) ||
    !isAbsolute(controls.docker_config_directory) ||
    !/^unix:\/\/\/[^\0\r\n]+$/u.test(controls.engine_socket) ||
    !(
      /@sha256:[0-9a-f]{64}$/u.test(controls.image) || /^sha256:[0-9a-f]{64}$/u.test(controls.image)
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
}

/** Copy each dependency after refusing overlapping mounts and archive digest mismatches. */
export function captureContainerDependencies(
  dependencies: readonly ProtectedContainerDependency[],
): readonly ProtectedContainerDependency[] {
  const mountPaths = new Set<string>();
  return dependencies.map((dependency) => {
    if (
      !canonicalContainerPath(dependency.mount_path) ||
      !(
        dependency.mount_path === 'node_modules' || dependency.mount_path.endsWith('/node_modules')
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
}

/** The isolation flags every certification container is created with. */
export function containerRestrictions(c: ProtectedContainerControls): string[] {
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

/**
 * Refuse a task whose declared outputs, diagnostics, namespaces, working directory,
 * executable or sources are not a closed, canonical, dependency-disjoint population.
 */
export function validateContainerExecutionInputs(
  input: ProtectedContainerExecutionInput,
  c: ProtectedContainerControls,
  dependencies: readonly ProtectedContainerDependency[],
  dependencyTransport: ProtectedDependencyTransport,
) {
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
  verifyProtectedDependencyInputs(dependencyTransport, input.source);
  if (
    sources.size !== input.source.length ||
    [...expected].some((path) => sources.has(path)) ||
    [...sources.keys(), ...input.prior_outputs.keys()].some((path) => inNamespace(path)) ||
    [...sources.keys(), ...expected, ...namespaces.map(({ prefix }) => prefix)].some((path) =>
      dependencies.some(
        (dependency) =>
          path === dependency.mount_path || path.startsWith(`${dependency.mount_path}/`),
      ),
    )
  )
    throw new Error('release-certification-output-closure-invalid');
  return { expected, namespaces, inNamespace, requestedDiagnostics, executable, sources };
}

/** Refuse a stopped container whose host configuration or mounts differ from the isolation contract. */
export function assertContainerIsolation(
  inspected: Record<string, unknown>,
  c: ProtectedContainerControls,
  volume: string,
  dependencies: readonly ProtectedContainerDependency[],
  dependencyVolumes: readonly string[],
): void {
  const host = object(inspected.HostConfig);
  const expectedMounts = [
    { Type: 'volume', Name: volume, Destination: '/workspace', RW: true },
    ...dependencies.map((dependency, index) => ({
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
      }).sort((left, right) => String(left.Destination).localeCompare(String(right.Destination)))
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
}

/**
 * Classify the captured workspace: dependencies and sources unchanged, predecessor outputs
 * unchanged, every other file a declared output, and the required population present.
 */
export function classifyContainerOutputs(args: {
  readonly captured: ReturnType<typeof decodeContainerDependencyArchive>;
  readonly dependencyTransport: ProtectedDependencyTransport;
  readonly sources: ReadonlyMap<string, ContainerArchiveEntry>;
  readonly expected: ReadonlySet<string>;
  readonly inNamespace: (path: string) => boolean;
  readonly namespaces: NonNullable<ProtectedContainerExecutionInput['declared_namespaces']>;
  readonly input: ProtectedContainerExecutionInput;
  readonly failed: boolean;
}): ContainerArchiveEntry[] {
  const {
    captured,
    dependencyTransport,
    sources,
    expected,
    inNamespace,
    namespaces,
    input,
    failed,
  } = args;
  const outputs: ContainerArchiveEntry[] = [];
  const observedSources = new Set<string>();
  const observedOutputs = new Set<string>();
  const observedDependencies = new Set<string>();
  for (const entry of captured) {
    const dependency = dependencyTransport.entries.get(entry.path);
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
    if (entry.mode === '120000') throw new Error('release-certification-source-mode-unsupported');
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
    observedDependencies.size !== dependencyTransport.entries.size ||
    [...input.prior_outputs.keys()].some((path) => !observedOutputs.has(path)) ||
    (!failed &&
      [...expected, ...namespaces.flatMap(({ required_paths }) => required_paths)].some(
        (path) => !observedOutputs.has(path),
      ))
  )
    throw new Error('release-certification-output-closure-invalid');
  return outputs;
}

/** Bounded host transport metadata for a failed container operation; never argv, environment or bytes. */
export function reportContainerOperationFailure(
  argv: readonly string[],
  result: Pick<SpawnSyncReturns<Buffer>, 'error' | 'status' | 'signal'>,
  input: Buffer | undefined,
): void {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // Host transport metadata is useful even when task output is confidential.
  // Never log argv, environment, input bytes, or raw Docker output here.
  const diagnostic = {
    kind: 'release-container-operation-failure',
    operation: argv[0],
    status: Number.isSafeInteger(result.status) ? result.status : null,
    signal:
      typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(result.signal)
        ? result.signal
        : null,
    error_code:
      typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(errorCode)
        ? errorCode
        : result.error === undefined
          ? null
          : 'UNAVAILABLE',
    input_bytes: input?.length ?? 0,
  };
  try {
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  } catch {
    // A diagnostic sink failure must not replace the original refusal.
  }
}

/** Bounded host metadata for an attach that did not end cleanly; task streams stay confidential. */
export function reportContainerAttachFailure(
  execution: Pick<SpawnSyncReturns<Buffer>, 'error' | 'status' | 'signal'>,
  timeoutMs: number,
): void {
  const errorCode = (execution.error as NodeJS.ErrnoException | undefined)?.code;
  try {
    process.stderr.write(
      `${JSON.stringify({
        kind: 'release-container-attach-failure',
        status: Number.isSafeInteger(execution.status) ? execution.status : null,
        signal:
          typeof execution.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(execution.signal)
            ? execution.signal
            : null,
        error_code:
          typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(errorCode)
            ? errorCode
            : execution.error === undefined
              ? null
              : 'UNAVAILABLE',
        timeout_ms: timeoutMs,
      })}\n`,
    );
  } catch {
    // Diagnostic delivery cannot replace the authoritative execution refusal.
  }
}
