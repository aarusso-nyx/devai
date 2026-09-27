import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { createDurableReleaseContentStore } from './release-content-store.js';
import type { CertifiedEvidenceCarrierIdentity } from './release-lifecycle-certification.js';
import type { CertificationOutputClosureBinding } from './release-prepare-kernel.js';
import type { CertificationOutputBlobHandle } from './release-lifecycle-execution.js';
import type { UnitMutationEvidenceObject } from './release-unit-mutation-evidence.js';

export const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const TRANSACTION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const RELEASE_UNIT = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

export function fail(): never {
  throw new Error('release-certification-generated-output-untrusted');
}

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function snapshot<T>(value: T): T {
  return JSON.parse(bytes(value).toString('utf8')) as T;
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function safeOutputPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path === path.normalize('NFC') &&
    !path.includes('\\') &&
    !path.includes(':') &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function assertBinding(binding: CertificationOutputClosureBinding): void {
  if (
    !same(binding, {
      repository: binding.repository,
      candidate: binding.candidate,
      task_policy_digest_sha256: binding.task_policy_digest_sha256,
      package_id: binding.package_id,
    }) ||
    !same(binding.repository, {
      id: binding.repository.id,
      commit: binding.repository.commit,
      tree: binding.repository.tree,
    }) ||
    !same(binding.candidate, { commit: binding.candidate.commit, tree: binding.candidate.tree }) ||
    typeof binding.repository.id !== 'string' ||
    binding.repository.id.length === 0 ||
    !GIT_OBJECT.test(binding.candidate.commit) ||
    !GIT_OBJECT.test(binding.candidate.tree) ||
    binding.candidate.commit.length !== binding.candidate.tree.length ||
    binding.repository.commit !== binding.candidate.commit ||
    binding.repository.tree !== binding.candidate.tree ||
    !DIGEST.test(binding.task_policy_digest_sha256) ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(binding.package_id)
  )
    fail();
}

export type CarrierDerivation = Pick<
  CertificationOutputClosureBinding,
  'repository' | 'candidate' | 'task_policy_digest_sha256'
>;
export type CommittedCarrier = CertifiedEvidenceCarrierIdentity & {
  readonly derivation: CarrierDerivation;
};

/** The durable store operations and limits the certification sink methods close over. */
export interface CertificationStoreContext extends Pick<
  ReturnType<typeof createDurableReleaseContentStore>,
  | 'root'
  | 'sinkId'
  | 'checkRoot'
  | 'inspectAncestors'
  | 'read'
  | 'ensureDirectory'
  | 'install'
  | 'objectPath'
  | 'assertWriteAuthority'
> {
  readonly maximumUnitBytes: number;
  readonly maximumCarrierBytes: number;
  readonly unitObject: (identity: UnitMutationEvidenceObject) => Buffer;
  readonly readBlob: (handle: CertificationOutputBlobHandle) => Buffer;
  readonly carrierBytes: (identity: CertifiedEvidenceCarrierIdentity) => Buffer;
  readonly assertCarrierDerivation: (
    value: Buffer,
    derivation: CarrierDerivation,
    release_unit: string,
  ) => void;
}
