import { resolve as resolvePath, sep } from 'node:path';
import { deepFreeze, failure, isRecord, success, type AnyRecord } from '../runtime/contracts.js';
import { captureProtectedReleaseRepositoryIdentity } from './release-repository-identity.js';
import { captureProtectedReleaseExportBinding } from './release-export-binding.js';

export function logical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.includes('://') &&
    !value.includes('@')
  );
}

function relativePath(value: unknown): value is string {
  return (
    logical(value) &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

export function adapterId(target: AnyRecord): string {
  if (target.kind === 'fs-rename') return 'fs-authority-boundary';
  const protectedAdapter = protectedReleaseBoundaryAdapterId(target);
  if (protectedAdapter !== undefined) return protectedAdapter;
  return `${String(target.kind)}-authority-boundary`;
}

/** Exact internal projection of the frozen protected release adapters, never a generic remote override. */
export function protectedReleaseBoundaryAdapterId(
  target: Readonly<Record<string, unknown>>,
): string | undefined {
  if (target.kind !== 'remote' || target.endpoint_id !== 'host' || target.publication !== false)
    return undefined;
  const provider =
    target.system_id === 'devai-protected-certification-provider-v3' &&
    target.operation_id === 'execute';
  const sink =
    target.system_id === 'trusted-certification-evidence-sink-v1' &&
    target.operation_id === 'write';
  const artifact =
    target.system_id === 'trusted-artifact-sink-v3' && target.operation_id === 'write';
  const exportSink =
    target.system_id === 'trusted-export-artifact-sink-v1' && target.operation_id === 'write';
  const exportSigner =
    target.system_id === 'protected-export-signer-v1' && target.operation_id === 'sign';
  if (!provider && !sink && !artifact && !exportSink && !exportSigner) return undefined;
  const binding = target.protected_release_binding;
  if (!isRecord(binding)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(binding) as unknown;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(binding).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(binding, key);
        return typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor);
      })
    )
      return undefined;
    captureProtectedReleaseRepositoryIdentity({
      authority_repository_id: binding.authority_repository_id,
      expected_release_repository_id: binding.expected_release_repository_id,
      origin_url: binding.origin_url,
      repository: binding.repository,
    });
    if (exportSink || exportSigner) {
      const descriptor = Object.fromEntries(
        Object.entries(binding).filter(
          ([key]) =>
            !['authority_repository_id', 'expected_release_repository_id', 'origin_url'].includes(
              key,
            ),
        ),
      );
      captureProtectedReleaseExportBinding(descriptor);
      if (
        typeof target.protected_operation_id !== 'string' ||
        target.protected_operation_id.length === 0
      )
        return undefined;
      return exportSink ? 'trusted-export-artifact-sink-v1' : 'protected-export-signer-v1';
    }
  } catch {
    return undefined;
  }
  if (
    !isRecord(binding.repository) ||
    Object.keys(binding).sort().join(',') !==
      (artifact
        ? 'action_id,authority_repository_id,expected_release_repository_id,origin_url,pack_spec_digest_sha256,plan_receipt_digest_sha256,repository,sink_id'
        : 'action_id,authority_repository_id,expected_release_repository_id,helper_identity_sha256,origin_url,plan_receipt_digest_sha256,repository,task_policy_digest_sha256') ||
    !(artifact
      ? binding.action_id === 'release prepare'
      : ['release preflight', 'release certify'].includes(binding.action_id)) ||
    (sink && binding.action_id !== 'release certify') ||
    typeof binding.repository.id !== 'string' ||
    binding.repository.id.length === 0 ||
    ![binding.repository.commit, binding.repository.tree].every(
      (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
    ) ||
    !(
      artifact
        ? [binding.plan_receipt_digest_sha256, binding.pack_spec_digest_sha256]
        : [
            binding.task_policy_digest_sha256,
            binding.plan_receipt_digest_sha256,
            binding.helper_identity_sha256,
          ]
    ).every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)) ||
    (artifact &&
      (typeof binding.sink_id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(binding.sink_id))) ||
    typeof target.protected_operation_id !== 'string' ||
    target.protected_operation_id.length === 0
  )
    return undefined;
  return artifact
    ? 'trusted-artifact-sink-v3'
    : provider
      ? 'protected-certification-provider-v3'
      : 'trusted-certification-evidence-sink-v1';
}

export function classifyAuthorityResource(input: unknown, deps: unknown = {}) {
  if (!isRecord(input)) return failure('usage-error', 'AUTHORITY_RESOURCE_TARGET_INVALID');
  const dependencies = isRecord(deps) ? deps : {};
  if (input.kind === 'fs-rename') {
    if (
      !logical(input.repository_id) ||
      input.operation !== 'rename' ||
      !isRecord(input.source) ||
      !isRecord(input.destination) ||
      !logical(input.source.id) ||
      !logical(input.destination.id) ||
      !relativePath(input.source.canonical_relative_path) ||
      !relativePath(input.destination.canonical_relative_path)
    ) {
      return failure('usage-error', 'AUTHORITY_FS_TARGET_INVALID');
    }
    if (
      !String(input.source.canonical_relative_path).startsWith('packages/') ||
      !String(input.destination.canonical_relative_path).startsWith('packages/')
    ) {
      return failure('refused', 'AUTHORITY_RENAME_DESTINATION_DENIED');
    }
    return success(
      deepFreeze({ target: input, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' }),
    );
  }
  if (input.kind === 'fs') {
    if (
      !relativePath(input.canonical_relative_path) ||
      !logical(input.repository_id) ||
      !['create', 'update', 'delete', 'rename'].includes(input.operation)
    ) {
      return failure('usage-error', 'AUTHORITY_FS_TARGET_INVALID');
    }
    // Containment dependencies come only from the trusted host runtime, never from the
    // caller. A caller with no realpath at all is classifying only. Once a realpath is
    // supplied, containment must be established or the target is refused: the repository
    // root must be an absolute path, the realpath result must be a non-empty path, and that
    // result, absolute or relative to the root, resolves inside the root. Nothing here is
    // left unchecked for any shape of result.
    if (typeof dependencies.realpath === 'function') {
      const configuredRoot = dependencies.repository_root;
      if (
        typeof configuredRoot !== 'string' ||
        !configuredRoot.startsWith('/') ||
        configuredRoot.includes('\0')
      ) {
        return failure('refused', 'AUTHORITY_FS_SYMLINK_ESCAPE');
      }
      const resolved = dependencies.realpath(input.canonical_relative_path);
      if (typeof resolved !== 'string' || resolved.length === 0 || resolved.includes('\0')) {
        return failure('refused', 'AUTHORITY_FS_SYMLINK_ESCAPE');
      }
      const root = resolvePath(configuredRoot);
      const candidate = resolvePath(root, resolved);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        return failure('refused', 'AUTHORITY_FS_SYMLINK_ESCAPE');
      }
    }
    return success(
      deepFreeze({ target: input, atomicity: 'whole-plan', adapter_id: 'fs-authority-boundary' }),
    );
  }
  if (input.kind === 'git-ref') {
    // The protected marker is a caller-declared classification hint that only ever takes a
    // boolean. Any other shape is malformed input and is refused, never read as unprotected.
    if (Object.hasOwn(input, 'protected') && typeof input.protected !== 'boolean') {
      return failure('refused', 'AUTHORITY_GIT_REF_INVALID');
    }
    if (input.protected === true && ['delete', 'force-push'].includes(input.operation)) {
      return failure('refused', 'AUTHORITY_GIT_PROTECTED_REF_DENIED');
    }
    if (
      !logical(input.repository_id) ||
      typeof input.ref !== 'string' ||
      !input.ref.startsWith('refs/')
    ) {
      return failure('refused', 'AUTHORITY_GIT_REF_INVALID');
    }
    if (
      input.merge === true ||
      !['create', 'update', 'delete', 'merge', 'push'].includes(input.operation)
    ) {
      return failure('refused', 'AUTHORITY_GIT_OPERATION_INVALID');
    }
    return success(
      deepFreeze({
        target: input,
        adapter_id: 'git-ref-authority-boundary',
        protected: input.protected === true,
      }),
    );
  }
  if (input.kind === 'db') {
    if (
      Object.hasOwn(input, 'password') ||
      Object.hasOwn(input, 'sql') ||
      !logical(input.connection_id) ||
      !logical(input.database_id) ||
      !logical(input.object_id)
    ) {
      return failure('usage-error', 'AUTHORITY_DB_TARGET_SECRET_OR_PAYLOAD');
    }
    if (!['insert', 'update', 'delete', 'ddl', 'execute'].includes(input.operation)) {
      return failure('usage-error', 'AUTHORITY_DB_TARGET_INVALID');
    }
    return success(deepFreeze({ target: input, adapter_id: 'db-authority-boundary' }));
  }
  if (input.kind === 'remote') {
    if (
      Object.hasOwn(input, 'operation') ||
      !logical(input.system_id) ||
      !logical(input.endpoint_id) ||
      !logical(input.operation_id) ||
      typeof input.publication !== 'boolean'
    ) {
      return failure('usage-error', 'AUTHORITY_REMOTE_TARGET_INVALID');
    }
    if (
      input.publication &&
      Object.hasOwn(dependencies, 'consent') &&
      (!isRecord(dependencies.consent) || dependencies.consent.allow_publish !== true)
    ) {
      return failure('refused', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED');
    }
    if (
      [
        'devai-protected-certification-provider-v3',
        'trusted-certification-evidence-sink-v1',
        'trusted-artifact-sink-v3',
        'trusted-export-artifact-sink-v1',
        'protected-export-signer-v1',
      ].includes(input.system_id) &&
      protectedReleaseBoundaryAdapterId(input) === undefined
    ) {
      return failure('refused', 'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    }
    return success(deepFreeze({ target: input, adapter_id: adapterId(input) }));
  }
  return failure('usage-error', 'AUTHORITY_RESOURCE_TARGET_INVALID');
}
