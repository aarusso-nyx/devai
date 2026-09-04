import { types } from 'node:util';
import {
  captureExportMutationUnitProjections,
  type ExportMutationUnitProjection,
} from './release-export-mutation.js';
export {
  captureExportMutationUnitProjections,
  type ExportMutationUnitProjection,
} from './release-export-mutation.js';

/** Private host binding; no member supplies an executable callback, key bytes or storage path. */
export interface LegacyProtectedReleaseExportBinding {
  readonly action_id: 'release export';
  readonly repository: { readonly id: string; readonly commit: string; readonly tree: string };
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
  readonly parent_artifact_sink: {
    readonly sink_id: string;
    readonly transaction_handle: string;
    readonly committed_manifest_handle: string;
    readonly committed_manifest_sha256: string;
    readonly committed_manifest_size_bytes: number;
    readonly commit_protocol: 'devai.artifact-sink.two-phase.v1';
  };
  readonly sink_id: string;
  readonly destination: { readonly kind: string; readonly exact_identifier: string };
  readonly trust: {
    readonly trust_root_id: string;
    readonly trust_store_digest_sha256: string;
    readonly key_id: string;
    readonly signature_algorithm: 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha256';
  };
  readonly attempt_id: string;
  readonly export_spec_digest_sha256: string;
  readonly closure_inputs: readonly {
    readonly package_id: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly expected_installed_package: {
      readonly name: '@aarusso-nyx/devai';
      readonly version: string;
      readonly archive_sha256: string;
      readonly content_manifest_sha256: string;
    };
    readonly policy_resolution_digest_sha256: string;
  }[];
}

export interface ProtectedReleaseExportBindingV3 extends Omit<
  LegacyProtectedReleaseExportBinding,
  'closure_inputs'
> {
  readonly closure_inputs: readonly (LegacyProtectedReleaseExportBinding['closure_inputs'][number] & {
    readonly release_unit: string;
  })[];
  readonly mutation_units: readonly ExportMutationUnitProjection[];
}

export type ProtectedReleaseExportBinding =
  LegacyProtectedReleaseExportBinding | ProtectedReleaseExportBindingV3;

const EXPORT_SPEC_DIGEST = '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98';
const EXPORT_SPEC_V3_DIGEST = 'aac1c75a539516a38b567aea9be4490eb3f82fe0ab7b75e46e55e46d3166e37f';
const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
function fail(): never {
  throw new Error('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, maximum = 400): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) return fail();
  return value;
}

function positiveSize(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail();
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}

/** Strict shape validation and capture only; the broker independently grants each live effect. */
export function captureProtectedReleaseExportBinding(
  value: unknown,
): ProtectedReleaseExportBinding {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)) return fail();
    const spec = Object.getOwnPropertyDescriptor(value, 'export_spec_digest_sha256');
    if (!spec?.enumerable || !('value' in spec)) return fail();
    const current = spec.value === EXPORT_SPEC_V3_DIGEST;
    if (!current && spec.value !== EXPORT_SPEC_DIGEST) return fail();
    const binding = record(value, [
      'action_id',
      'repository',
      'candidate',
      'plan_receipt_digest_sha256',
      'parent_artifact_sink',
      'sink_id',
      'destination',
      'trust',
      'attempt_id',
      'export_spec_digest_sha256',
      'closure_inputs',
      ...(current ? ['mutation_units'] : []),
    ]);
    if (binding['action_id'] !== 'release export') return fail();
    const repository = record(binding['repository'], ['id', 'commit', 'tree']);
    text(repository['id'], REPOSITORY, 200);
    const commit = text(repository['commit'], /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    const tree = text(repository['tree'], /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    if (commit.length !== tree.length) return fail();
    const candidate = record(binding['candidate'], ['commit', 'tree']);
    if (candidate['commit'] !== commit || candidate['tree'] !== tree) return fail();
    text(binding['plan_receipt_digest_sha256'], SHA256);
    text(binding['attempt_id'], /^RLA-[a-f0-9]{16}$/u);
    const sink = text(binding['sink_id'], OPAQUE, 200);
    const parent = record(binding['parent_artifact_sink'], [
      'sink_id',
      'transaction_handle',
      'committed_manifest_handle',
      'committed_manifest_sha256',
      'committed_manifest_size_bytes',
      'commit_protocol',
    ]);
    if (
      parent['sink_id'] !== sink ||
      parent['commit_protocol'] !== 'devai.artifact-sink.two-phase.v1'
    )
      return fail();
    text(parent['transaction_handle'], OPAQUE);
    text(parent['committed_manifest_handle'], OPAQUE);
    text(parent['committed_manifest_sha256'], SHA256);
    positiveSize(parent['committed_manifest_size_bytes']);
    const destination = record(binding['destination'], ['kind', 'exact_identifier']);
    if (
      typeof destination['kind'] !== 'string' ||
      ![
        'local-staging',
        'external-trust-input',
        'evidence-destination',
        'publication-destination',
      ].includes(destination['kind'])
    )
      return fail();
    text(destination['exact_identifier'], /^[^\p{Cc}\p{Cs}]+$/u, 500);
    const trust = record(binding['trust'], [
      'trust_root_id',
      'trust_store_digest_sha256',
      'key_id',
      'signature_algorithm',
    ]);
    text(trust['trust_root_id'], REPOSITORY, 200);
    text(trust['trust_store_digest_sha256'], SHA256);
    text(trust['key_id'], OPAQUE, 200);
    if (
      typeof trust['signature_algorithm'] !== 'string' ||
      !['ed25519', 'ecdsa-p256-sha256', 'rsa-pss-sha256'].includes(trust['signature_algorithm'])
    )
      return fail();
    const closures = binding['closure_inputs'];
    if (
      !Array.isArray(closures) ||
      types.isProxy(closures) ||
      Object.getPrototypeOf(closures) !== Array.prototype ||
      closures.length === 0 ||
      closures.length > 8192 ||
      Reflect.ownKeys(closures).length !== closures.length + 1
    )
      return fail();
    let previous: string | undefined;
    for (let index = 0; index < closures.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(closures, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
      const closure = record(descriptor.value, [
        'package_id',
        'sha256',
        'size_bytes',
        'expected_installed_package',
        'policy_resolution_digest_sha256',
        ...(current ? ['release_unit'] : []),
      ]);
      if (current) text(closure['release_unit'], /^[^\p{Cc}\p{Cs}]+$/u, 200);
      const packageId = text(
        closure['package_id'],
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u,
        200,
      );
      if (
        previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(packageId)) >= 0
      )
        return fail();
      previous = packageId;
      text(closure['sha256'], SHA256);
      positiveSize(closure['size_bytes']);
      text(closure['policy_resolution_digest_sha256'], SHA256);
      const installed = record(closure['expected_installed_package'], [
        'name',
        'version',
        'archive_sha256',
        'content_manifest_sha256',
      ]);
      if (installed['name'] !== '@aarusso-nyx/devai') return fail();
      text(installed['version'], /^[^\p{Cc}\p{Cs}]+$/u, 200);
      text(installed['archive_sha256'], SHA256);
      text(installed['content_manifest_sha256'], SHA256);
    }
    if (current) {
      captureExportMutationUnitProjections(
        binding['mutation_units'],
        closures.map((entry) => ({
          package_id: entry.package_id as string,
          release_unit: entry.release_unit as string,
        })),
        {
          repository: repository as unknown as ProtectedReleaseExportBinding['repository'],
          plan_receipt_digest_sha256: binding['plan_receipt_digest_sha256'] as string,
        },
        8192,
      );
    }
    return freeze(JSON.parse(JSON.stringify(binding)) as ProtectedReleaseExportBinding);
  } catch {
    return fail();
  }
}
