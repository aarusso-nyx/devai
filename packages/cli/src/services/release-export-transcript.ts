import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import type {
  ArtifactSinkCommitIdentity,
  OpaqueArtifactIdentity,
  ReleaseLifecycleRequest,
  TrustIdentity,
} from './release-lifecycle-execution.js';
import type { ReleasePackageIdentity } from './release-package-snapshot.js';

export const RELEASE_EXPORT_TRANSCRIPT_FORMAT = 'devai.release-export-transcript-json.v1';
export const RELEASE_EXPORT_PROVIDER_RESULT_FORMAT = 'devai.release-export-provider-result-json.v1';
export const RELEASE_EXPORT_SPEC_ID = 'devai.release-export-closure.v2';
export const RELEASE_EXPORT_SPEC_DIGEST =
  '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98';

export interface ReleaseExportTranscriptBinding {
  readonly action_id: 'release export';
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly plan_receipt_digest_sha256: string;
  readonly parent_artifact_sink: ArtifactSinkCommitIdentity;
  readonly sink_id: string;
  readonly destination: { readonly kind: string; readonly exact_identifier: string };
  readonly trust: TrustIdentity;
  readonly attempt_id: string;
}

/** Already verified identities, never callbacks, paths to dereference, or signing controls. */
export interface ReleaseExportTranscript {
  readonly version: typeof RELEASE_EXPORT_TRANSCRIPT_FORMAT;
  readonly binding: ReleaseExportTranscriptBinding;
  readonly parent: readonly OpaqueArtifactIdentity[];
  readonly closures: readonly {
    readonly package_id: string;
    readonly evidence_manifest: OpaqueArtifactIdentity;
    readonly expected_installed_package: ReleasePackageIdentity;
    readonly policy_resolution_digest_sha256: string;
  }[];
  readonly destination: ReleaseExportTranscriptBinding['destination'];
  readonly trust: TrustIdentity;
}

export interface ReleaseExportTranscriptLimits {
  readonly maximum_transcript_bytes: number;
  readonly maximum_provider_result_bytes: number;
  readonly maximum_packages: number;
}

export interface ReleaseExportProviderResultInput {
  readonly package_id: string;
  /** Full exact canonical signing preimage, retained without a mutable locator. */
  readonly transcript: Buffer;
  readonly signature: string;
}

export interface ReleaseExportProviderResult {
  readonly version: typeof RELEASE_EXPORT_PROVIDER_RESULT_FORMAT;
  readonly package_id: string;
  readonly evidence_manifest: OpaqueArtifactIdentity;
  readonly transcript: string;
  readonly transcript_sha256: string;
  readonly signature: string;
  readonly trust: TrustIdentity;
}

const INVALID = 'release-export-transcript-invalid';
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const LOGICAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PARENT_KINDS = ['package-manifest', 'package-tarball', 'package-sbom'];

function fail(): never {
  throw new Error(INVALID);
}

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return fail();
  }
}

/** Reject accessors and hidden/symbol members before reading any caller-owned value. */
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== names.length
  )
    return fail();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    return fail();
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
  }
  return value as unknown[];
}

function text(value: unknown, pattern: RegExp, maximum = 400): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) return fail();
  return value;
}

function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkLimits(limits: ReleaseExportTranscriptLimits): void {
  const values = record(limits, [
    'maximum_transcript_bytes',
    'maximum_provider_result_bytes',
    'maximum_packages',
  ]);
  for (const value of Object.values(values)) {
    if (size(value) < 1 || (value as number) > 0x7fffffff) fail();
  }
}

function trust(value: unknown): void {
  const item = record(value, [
    'trust_root_id',
    'trust_store_digest_sha256',
    'key_id',
    'signature_algorithm',
  ]);
  text(item['trust_root_id'], /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u, 200);
  text(item['key_id'], LOGICAL, 200);
  text(item['trust_store_digest_sha256'], SHA256);
  if (
    typeof item['signature_algorithm'] !== 'string' ||
    !['ed25519', 'ecdsa-p256-sha256', 'rsa-pss-sha256'].includes(item['signature_algorithm'])
  )
    fail();
}

function destination(value: unknown): void {
  const item = record(value, ['kind', 'exact_identifier']);
  if (
    typeof item['kind'] !== 'string' ||
    ![
      'local-staging',
      'external-trust-input',
      'evidence-destination',
      'publication-destination',
    ].includes(item['kind'])
  )
    fail();
  // Preserve literal spaces and Unicode. This is an exact identifier, never a path lookup.
  text(item['exact_identifier'], /^[^\p{Cc}\p{Cs}]+$/u, 500);
}

function artifact(value: unknown, kind: readonly string[], sink: string): OpaqueArtifactIdentity {
  const item = record(value, ['kind', 'sink_id', 'opaque_handle', 'sha256', 'size_bytes']);
  if (typeof item['kind'] !== 'string' || !kind.includes(item['kind']) || item['sink_id'] !== sink)
    return fail();
  text(item['opaque_handle'], LOGICAL);
  text(item['sha256'], SHA256);
  size(item['size_bytes']);
  return item as unknown as OpaqueArtifactIdentity;
}

function artifactOrder(value: OpaqueArtifactIdentity): string {
  return `${value.kind}\0${value.sink_id}\0${value.opaque_handle}\0${value.sha256}\0${value.size_bytes}`;
}

function ordered(previous: string | undefined, next: string): void {
  if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(next)) >= 0)
    fail();
}

function validate(value: unknown, limits: ReleaseExportTranscriptLimits): ReleaseExportTranscript {
  checkLimits(limits);
  const transcript = record(value, [
    'version',
    'binding',
    'parent',
    'closures',
    'destination',
    'trust',
  ]);
  if (transcript['version'] !== RELEASE_EXPORT_TRANSCRIPT_FORMAT) return fail();
  const binding = record(transcript['binding'], [
    'action_id',
    'repository',
    'candidate',
    'plan_receipt_digest_sha256',
    'parent_artifact_sink',
    'sink_id',
    'destination',
    'trust',
    'attempt_id',
  ]);
  if (binding['action_id'] !== 'release export') return fail();
  const repository = record(binding['repository'], ['id', 'commit', 'tree']);
  text(repository['id'], /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u, 200);
  text(repository['commit'], GIT_ID);
  text(repository['tree'], GIT_ID);
  const candidate = record(binding['candidate'], ['commit', 'tree']);
  if (candidate['commit'] !== repository['commit'] || candidate['tree'] !== repository['tree'])
    return fail();
  text(binding['plan_receipt_digest_sha256'], SHA256);
  text(binding['attempt_id'], /^RLA-[a-f0-9]{16}$/u);
  const sink = text(binding['sink_id'], LOGICAL, 200);
  const parentCommit = record(binding['parent_artifact_sink'], [
    'sink_id',
    'transaction_handle',
    'committed_manifest_handle',
    'committed_manifest_sha256',
    'committed_manifest_size_bytes',
    'commit_protocol',
  ]);
  if (
    parentCommit['sink_id'] !== sink ||
    parentCommit['commit_protocol'] !== 'devai.artifact-sink.two-phase.v1'
  )
    return fail();
  text(parentCommit['transaction_handle'], LOGICAL);
  text(parentCommit['committed_manifest_handle'], LOGICAL);
  text(parentCommit['committed_manifest_sha256'], SHA256);
  if (size(parentCommit['committed_manifest_size_bytes']) === 0) return fail();
  destination(binding['destination']);
  destination(transcript['destination']);
  trust(binding['trust']);
  trust(transcript['trust']);
  if (
    !same(binding['destination'], transcript['destination']) ||
    !same(binding['trust'], transcript['trust'])
  )
    return fail();
  const closures = array(transcript['closures'], limits.maximum_packages);
  const parents = array(transcript['parent'], limits.maximum_packages * 3);
  if (closures.length === 0 || parents.length !== closures.length * 3) return fail();
  const handles = new Set<string>([String(parentCommit['committed_manifest_handle'])]);
  const counts = new Map<string, number>();
  let previous: string | undefined;
  for (const parent of parents) {
    const identity = artifact(parent, PARENT_KINDS, sink);
    ordered(previous, artifactOrder(identity));
    previous = artifactOrder(identity);
    if (handles.has(identity.opaque_handle)) return fail();
    handles.add(identity.opaque_handle);
    counts.set(identity.kind, (counts.get(identity.kind) ?? 0) + 1);
  }
  if (PARENT_KINDS.some((kind) => counts.get(kind) !== closures.length)) return fail();
  previous = undefined;
  for (const closure of closures) {
    const item = record(closure, [
      'package_id',
      'evidence_manifest',
      'expected_installed_package',
      'policy_resolution_digest_sha256',
    ]);
    const packageId = text(item['package_id'], PACKAGE, 214);
    ordered(previous, packageId);
    previous = packageId;
    const identity = artifact(item['evidence_manifest'], ['evidence-manifest'], sink);
    if (handles.has(identity.opaque_handle)) return fail();
    handles.add(identity.opaque_handle);
    const installed = record(item['expected_installed_package'], [
      'name',
      'version',
      'archive_sha256',
      'content_manifest_sha256',
    ]);
    if (installed['name'] !== '@aarusso-nyx/devai') return fail();
    text(
      installed['version'],
      /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
      200,
    );
    text(installed['archive_sha256'], SHA256);
    text(installed['content_manifest_sha256'], SHA256);
    text(item['policy_resolution_digest_sha256'], SHA256);
  }
  return transcript as unknown as ReleaseExportTranscript;
}

function canonicalBytes(value: unknown, maximum: number): Buffer {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.length > maximum) return fail();
  return bytes;
}

function parse(bytes: Buffer, maximum: number): unknown {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) return fail();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!bytes.equals(canonicalBytes(value, maximum))) return fail();
  return value;
}

/** Pure encoding only. Closure, prepared-parent and cryptographic verification remain mandatory. */
export function encodeReleaseExportTranscript(
  transcript: ReleaseExportTranscript,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() =>
    canonicalBytes(validate(transcript, limits), limits.maximum_transcript_bytes),
  );
}

/** Compare with an independently reconstructed complete transcript, not bundle-supplied expectations. */
export function verifyReleaseExportTranscript(
  bytes: Buffer,
  expected: ReleaseExportTranscript,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportTranscript {
  return guarded(() => {
    const expectedBytes = encodeReleaseExportTranscript(expected, limits);
    if (!Buffer.isBuffer(bytes) || !bytes.equals(expectedBytes)) return fail();
    return validate(parse(bytes, limits.maximum_transcript_bytes), limits);
  });
}

export function encodeReleaseExportProviderResult(
  input: ReleaseExportProviderResultInput,
  limits: ReleaseExportTranscriptLimits,
): Buffer {
  return guarded(() => {
    checkLimits(limits);
    record(input, ['package_id', 'transcript', 'signature']);
    const transcript = validate(parse(input.transcript, limits.maximum_transcript_bytes), limits);
    const closure = transcript.closures.find((entry) => entry.package_id === input.package_id);
    if (closure === undefined) return fail();
    text(
      input.signature,
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      16384,
    );
    if (
      input.signature.length === 0 ||
      Buffer.from(input.signature, 'base64').toString('base64') !== input.signature
    )
      return fail();
    const result: ReleaseExportProviderResult = {
      version: RELEASE_EXPORT_PROVIDER_RESULT_FORMAT,
      package_id: input.package_id,
      evidence_manifest: closure.evidence_manifest,
      transcript: input.transcript.toString('utf8'),
      transcript_sha256: hash(input.transcript),
      signature: input.signature,
      trust: transcript.trust,
    };
    return canonicalBytes(result, limits.maximum_provider_result_bytes);
  });
}

/** Continuity check only: callers must independently verify the one aggregate signature. */
export function verifyReleaseExportProviderResult(
  bytes: Buffer,
  expected: ReleaseExportProviderResultInput,
  limits: ReleaseExportTranscriptLimits,
): ReleaseExportProviderResult {
  return guarded(() => {
    const expectedBytes = encodeReleaseExportProviderResult(expected, limits);
    if (!Buffer.isBuffer(bytes) || !bytes.equals(expectedBytes)) return fail();
    return parse(bytes, limits.maximum_provider_result_bytes) as ReleaseExportProviderResult;
  });
}
