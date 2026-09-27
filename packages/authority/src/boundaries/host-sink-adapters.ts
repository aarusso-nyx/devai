import type { ProtectedReleaseRepositoryIdentity } from './release-repository-identity.js';
import {
  captureProtectedReleaseExportBinding,
  type ProtectedReleaseExportBinding,
} from './release-export-binding.js';
import type { AuthorityHostEffectRequest } from './host-atomic-effects.js';
import { scopes, type AuthorityHostEffectScope } from './host-scope.js';
import { readProtectedReleaseExportCapacity } from './host-capacity.js';
import { runSinkUnit } from './host-sink-filesystem.js';
import {
  currentRepositoryBinding,
  nextProtectedOperationSequence,
  requireScope,
} from './host-operation.js';

export interface ProtectedArtifactSinkBinding {
  readonly action_id: 'release prepare';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
  readonly pack_spec_digest_sha256: string;
  readonly sink_id: string;
}

const artifactOperations = new WeakMap<
  object,
  Readonly<{
    binding: ProtectedArtifactSinkBinding & ProtectedReleaseRepositoryIdentity;
    scope: AuthorityHostEffectScope;
    kind: 'artifact-sink';
    operation_id: string;
  }>
>();

export function protectedArtifactSinkHostEffect(request: AuthorityHostEffectRequest) {
  if (request.kind !== 'protected-release' || request.symbol !== 'protectedArtifactSinkOperation')
    return undefined;
  const token = request.arguments[0];
  if (token === null || typeof token !== 'object') return undefined;
  const operation = artifactOperations.get(token);
  return operation?.scope === scopes.getStore() ? operation : undefined;
}

/** Separate prepare-only capability. No execution or certification authority is exposed. */
export function createProtectedArtifactSinkAdapter(binding: ProtectedArtifactSinkBinding) {
  if (
    Object.keys(binding).sort().join(',') !==
      'action_id,pack_spec_digest_sha256,plan_receipt_digest_sha256,repository,sink_id' ||
    Object.keys(binding.repository).sort().join(',') !== 'commit,id,tree'
  )
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  const selected = Object.freeze({
    ...binding,
    repository: Object.freeze({ ...binding.repository }),
  });
  if (
    selected.action_id !== 'release prepare' ||
    typeof selected.repository.id !== 'string' ||
    selected.repository.id.length === 0 ||
    ![selected.repository.commit, selected.repository.tree].every(
      (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value),
    ) ||
    selected.repository.commit.length !== selected.repository.tree.length ||
    ![selected.plan_receipt_digest_sha256, selected.pack_spec_digest_sha256].every(
      (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value),
    ) ||
    typeof selected.sink_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(selected.sink_id)
  )
    throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
  const invoke = <T>(callback: () => T): T => {
    const scope = requireScope('mutation');
    if (scope.action_id !== selected.action_id)
      throw new Error('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
    const token = Object.freeze({});
    const sequence = nextProtectedOperationSequence();
    const operation = Object.freeze({
      binding: currentRepositoryBinding(selected),
      scope,
      kind: 'artifact-sink' as const,
      operation_id: `${scope.invocation_id}-${String(sequence)}`,
    });
    artifactOperations.set(token, operation);
    try {
      return scope.apply_effect(
        { kind: 'protected-release', symbol: 'protectedArtifactSinkOperation', arguments: [token] },
        () => {
          if (artifactOperations.get(token) !== operation || scopes.getStore() !== scope)
            throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
          artifactOperations.delete(token);
          return callback();
        },
      ) as T;
    } finally {
      artifactOperations.delete(token);
    }
  };
  return Object.freeze({
    invokeSink: <T>(callback: () => T, owner?: object): T => {
      const scope = requireScope('mutation');
      return invoke(() => runSinkUnit(scope, owner, 'artifact', callback, selected.sink_id));
    },
  });
}

const exportOperations = new WeakMap<
  object,
  Readonly<{
    binding: ProtectedReleaseExportBinding & ProtectedReleaseRepositoryIdentity;
    scope: AuthorityHostEffectScope;
    kind: 'export-sink' | 'export-signer';
    operation_id: string;
  }>
>();

/** The dedicated export capability cannot be mistaken for prepare or certification authority. */
export function protectedExportHostEffect(request: AuthorityHostEffectRequest) {
  if (request.kind !== 'protected-release' || request.symbol !== 'protectedExportOperation')
    return undefined;
  const token = request.arguments[0];
  if (token === null || typeof token !== 'object') return undefined;
  const operation = exportOperations.get(token);
  return operation?.scope === scopes.getStore() ? operation : undefined;
}

function exportAdapter(
  binding: ProtectedReleaseExportBinding,
  kind: 'export-sink' | 'export-signer',
) {
  const selected = captureProtectedReleaseExportBinding(binding);
  return <T>(callback: () => T): T => {
    const scope = requireScope('mutation');
    if (scope.action_id !== 'release export' || scope.effect !== 'local-write')
      throw new Error('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
    readProtectedReleaseExportCapacity({
      action_id: selected.action_id,
      repository: selected.repository,
      candidate: selected.candidate,
      plan_receipt_digest_sha256: selected.plan_receipt_digest_sha256,
    });
    const token = Object.freeze({});
    const sequence = nextProtectedOperationSequence();
    const operation = Object.freeze({
      binding: currentRepositoryBinding(selected),
      scope,
      kind,
      operation_id: `${scope.invocation_id}-${String(sequence)}`,
    });
    exportOperations.set(token, operation);
    try {
      return scope.apply_effect(
        { kind: 'protected-release', symbol: 'protectedExportOperation', arguments: [token] },
        () => {
          if (exportOperations.get(token) !== operation || scopes.getStore() !== scope)
            throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
          exportOperations.delete(token);
          return callback();
        },
      ) as T;
    } finally {
      exportOperations.delete(token);
    }
  };
}

/** Sink-only capability; never grants a signing operation or reopens the prepared transaction. */
export function createProtectedExportSinkAdapter(binding: ProtectedReleaseExportBinding) {
  const selected = captureProtectedReleaseExportBinding(binding);
  const invoke = exportAdapter(selected, 'export-sink');
  return Object.freeze({
    invokeSink: <T>(callback: () => T, owner: object): T => {
      const scope = requireScope('mutation');
      return invoke(() => runSinkUnit(scope, owner, 'export', callback, selected.sink_id));
    },
  });
}

const exportSignerAccounts = new WeakSet<object>();

/** Separate one-use aggregate signer capability. A throwing/ambiguous invocation is also spent. */
export function createProtectedExportSignerAdapter(binding: ProtectedReleaseExportBinding) {
  const invoke = exportAdapter(binding, 'export-signer');
  let spent = false;
  return Object.freeze({
    invokeSigner: <T>(callback: () => T): T => {
      if (spent) throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      return invoke(() => {
        const scope = requireScope('mutation');
        if (spent || exportSignerAccounts.has(scope.receipt_store))
          throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        spent = true;
        exportSignerAccounts.add(scope.receipt_store);
        return callback();
      });
    },
  });
}
