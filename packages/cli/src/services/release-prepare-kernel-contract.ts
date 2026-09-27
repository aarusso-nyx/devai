import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { type UnitMutationEvidenceSink } from './release-unit-mutation-evidence.js';
import type {
  ArtifactSinkCommitIdentity,
  CertificationOutputBlobHandle,
  CertificationPackageEntryManifest,
  GitReleaseBlobLocator,
  OpaqueArtifactIdentity,
  ReleaseLifecycleRequest,
  TrustedArtifactReader,
  ReceiptResolver,
  ReleasePlanInputResolver,
} from './release-lifecycle-execution.js';

/** Historical identity only; current prepare and downstream authority never select v3. */
export const RELEASE_PACK_SPEC_V3_ID = 'devai.pure-npm-compatible-pack.v3';
export const RELEASE_PACK_SPEC_V3_CANONICAL_BYTES =
  'devai.pure-npm-compatible-pack.v3\nselection=only-certification-package-entry-manifest.entries;exact-set;no-npmignore-no-gitignore-no-files-field-no-default-additions\nentry-order=utf-8-byte-ascending-by-entry.path;duplicate-paths-refuse\narchive-path=package/<entry.path>;utf-8;no-backslash;maximum-100-bytes;no-pax\nentry-types=regular-only;directories-symlinks-hardlinks-device-fifo-pax-global-pax-refuse\nmodes=100644-or-100755-only\nsize=0..8589934591-decimal-bytes\ntar=format-ustar;block=512;name=archive-path;mode=entry.mode;uid=0;gid=0;size=entry.size_bytes;mtime=0;typeflag=0;linkname=empty;magic=ustar\\0;version=00;uname=empty;gname=empty;devmajor=0;devminor=0;prefix=empty\nnumeric-fields=ascii-octal-zero-padded-with-terminal-nul;checksum=unsigned-byte-sum-with-checksum-field-eight-ascii-spaces;payload-padding=zero-to-next-512;end=two-zero-512-blocks\ngzip=header-id1-31-id2-139-cm-8-flg-0-mtime-0-xfl-0-os-255;deflate=stored-blocks-only;block-rule=greedy-consecutive-65535-byte-blocks-in-tar-order-plus-one-final-remainder-block;BFINAL=1-only-on-final-block;empty-tar-stream=one-zero-length-stored-block-with-BFINAL-1;trailer=crc32-ieee-little-endian-plus-isize-mod-2^32-little-endian\nsbom=spdx-json-2.3;utf-8-rfc8785-jcs;spdxVersion=SPDX-2.3;dataLicense=CC0-1.0;SPDXID=SPDXRef-DOCUMENT;name=<package_id>@<package_version>;documentNamespace=https://devai.nyxk.com.br/spdx/<candidate.commit>/<package_id>;creationInfo.created=1970-01-01T00:00:00Z;creationInfo.creators=[Tool: devai.pure-npm-compatible-pack.v3];creationInfo.optionalFields=comment-licenseListVersion=absent;documentDescribes=[SPDXRef-Package];document.optionalFields=comment-externalDocumentRefs-annotations-hasExtractedLicensingInfos-revieweds-snippets=absent;packages=[SPDXRef-Package];package.name=<package_id>@<package_version>;package.SPDXID=SPDXRef-Package;package.downloadLocation=NOASSERTION;package.filesAnalyzed=true;package.packageVerificationCode.value=lowercase-hex(SHA1(utf8-concatenation-of-each-file-raw-byte-SHA1-lowercase-hex-sorted-ascending-lexicographically-by-checksum-value));package.packageVerificationCode.excludedFiles=absent;package.licenseConcluded=NOASSERTION;package.licenseDeclared=NOASSERTION;package.copyrightText=NOASSERTION;package.supplier=NOASSERTION;package.originator=NOASSERTION;package.optionalFields=absent\nfiles=entries-in-entry-order;file.SPDXID=SPDXRef-File-<lowercase-sha256-of-utf8-archive-path>;file.fileName=archive-path;file.checksums=[SHA1:lowercase-raw-byte-sha1,SHA256:lowercase-entry.sha256];file.licenseConcluded=NOASSERTION;file.licenseInfoInFiles=[NOASSERTION];file.copyrightText=NOASSERTION;file.optionalFields=absent\nrelationships=document-DESCRIBES-package-then-package-CONTAINS-file-in-entry-order;annotations-externalRefs-extractedLicensingInfos=absent\n';
export const RELEASE_PACK_SPEC_V3_DIGEST =
  'd287db048eb09efaea20c7e4d6b8b721d34e08eb05b6cbc7f19fba4c666917bd';

export const RELEASE_PACK_SPEC_ID = 'devai.pure-npm-compatible-pack.v4';
export const RELEASE_PACK_SPEC_CANONICAL_BYTES =
  'devai.pure-npm-compatible-pack.v4\nselection=only-certification-package-entry-manifest.entries;exact-set;no-npmignore-no-gitignore-no-files-field-no-default-additions\nentry-order=utf-8-byte-ascending-by-entry.path;duplicate-paths-refuse\narchive-path=package/<entry.path>;valid-unicode-scalar-values;utf-8;relative;no-backslash-no-nul-no-empty-dot-or-dotdot-segments;no-pax\nustar-path=if-archive-path-utf8-bytes<=100:name=archive-path,prefix=empty;otherwise-split-at-rightmost-slash-with-nonempty-prefix-utf8-bytes<=155-and-nonempty-name-utf8-bytes<=100;separator-not-stored;refuse-if-no-valid-split;no-truncation-no-unicode-normalization;name-offset=0,width=100;prefix-offset=345,width=155;unused-bytes=zero;full-width-fields=no-extra-nul\nentry-types=regular-only;directories-symlinks-hardlinks-device-fifo-pax-global-pax-refuse\nmodes=100644-or-100755-only\nsize=0..8589934591-decimal-bytes\ntar=format-ustar;block=512;name=ustar-name;mode=entry.mode;uid=0;gid=0;size=entry.size_bytes;mtime=0;typeflag=0;linkname=empty;magic=ustar\\0;version=00;uname=empty;gname=empty;devmajor=0;devminor=0;prefix=ustar-prefix\nnumeric-fields=ascii-octal-zero-padded-with-terminal-nul;checksum=unsigned-byte-sum-with-checksum-field-eight-ascii-spaces;payload-padding=zero-to-next-512;end=two-zero-512-blocks\ngzip=header-id1-31-id2-139-cm-8-flg-0-mtime-0-xfl-0-os-255;deflate=stored-blocks-only;block-rule=greedy-consecutive-65535-byte-blocks-in-tar-order-plus-one-final-remainder-block;BFINAL=1-only-on-final-block;empty-tar-stream=one-zero-length-stored-block-with-BFINAL-1;trailer=crc32-ieee-little-endian-plus-isize-mod-2^32-little-endian\nsbom=spdx-json-2.3;utf-8-rfc8785-jcs;spdxVersion=SPDX-2.3;dataLicense=CC0-1.0;SPDXID=SPDXRef-DOCUMENT;name=<package_id>@<package_version>;documentNamespace=https://devai.nyxk.com.br/spdx/<candidate.commit>/<package_id>;creationInfo.created=1970-01-01T00:00:00Z;creationInfo.creators=[Tool: devai.pure-npm-compatible-pack.v4];creationInfo.optionalFields=comment-licenseListVersion=absent;documentDescribes=[SPDXRef-Package];document.optionalFields=comment-externalDocumentRefs-annotations-hasExtractedLicensingInfos-revieweds-snippets=absent;packages=[SPDXRef-Package];package.name=<package_id>@<package_version>;package.SPDXID=SPDXRef-Package;package.downloadLocation=NOASSERTION;package.filesAnalyzed=true;package.packageVerificationCode.value=lowercase-hex(SHA1(utf8-concatenation-of-each-file-raw-byte-SHA1-lowercase-hex-sorted-ascending-lexicographically-by-checksum-value));package.packageVerificationCode.excludedFiles=absent;package.licenseConcluded=NOASSERTION;package.licenseDeclared=NOASSERTION;package.copyrightText=NOASSERTION;package.supplier=NOASSERTION;package.originator=NOASSERTION;package.optionalFields=absent\nfiles=entries-in-entry-order;file.SPDXID=SPDXRef-File-<lowercase-sha256-of-utf8-archive-path>;file.fileName=archive-path;file.checksums=[SHA1:lowercase-raw-byte-sha1,SHA256:lowercase-entry.sha256];file.licenseConcluded=NOASSERTION;file.licenseInfoInFiles=[NOASSERTION];file.copyrightText=NOASSERTION;file.optionalFields=absent\nrelationships=document-DESCRIBES-package-then-package-CONTAINS-file-in-entry-order;annotations-externalRefs-extractedLicensingInfos=absent\n';
export const RELEASE_PACK_SPEC_DIGEST =
  '46ba1063f36f48fb6d5082548024b17b274cf475e24a5c1df89faa5f07a46316';

const CERTIFICATION_MANIFEST_DOMAIN = 'DEVAI-CERTIFIED-PACKAGE-ENTRY-MANIFEST-V1\0';
export const CERTIFICATION_MANIFEST_DIGEST_CONTRACT = {
  domain: CERTIFICATION_MANIFEST_DOMAIN,
  payload:
    'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
  canonicalization: 'rfc8785-jcs',
  algorithm: 'sha256',
} as const;
export const ENTRY_ORDER = 'ascending-utf-8-byte-collation-by-path;duplicates-refuse' as const;
export const COMMIT_PROTOCOL = 'devai.artifact-sink.two-phase.v1' as const;

export type CertificationReceipt = Extract<
  CertificationPackageEntryManifest['entries'][number]['immutable_blob_locator'],
  { readonly kind: 'generated-output' }
>['certification_evidence_receipt'];

export interface ImmutableReleaseContentSource extends Partial<
  Pick<
    UnitMutationEvidenceSink,
    | 'unit_mutation_maximum_bytes'
    | 'readUnitMutationEvidenceClosure'
    | 'readUnitMutationEvidenceReceipt'
    | 'readUnitMutationEvidenceBlob'
  >
> {
  /** Raw immutable objects; the kernel independently verifies their framing and tree links. */
  readonly readGitObject: (input: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly object_format: 'sha1' | 'sha256';
    readonly object_id: string;
    readonly type: 'commit' | 'tree';
  }) => Buffer | Promise<Buffer>;
  readonly readGitBlob: (input: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly candidate: ReleaseLifecycleRequest['candidate_locator'];
    readonly object_id: string;
    readonly locator: GitReleaseBlobLocator;
  }) => Buffer | Promise<Buffer>;
  readonly readCertificationEvidenceReceipt: (input: {
    readonly receipt_digest_sha256: string;
    readonly evidence_sink_id: string;
  }) => unknown | Promise<unknown>;
  readonly readCertificationOutputClosure: (
    input: CertificationOutputClosureBinding,
  ) => CertificationOutputClosure | Promise<CertificationOutputClosure>;
  readonly readGeneratedBlob: (input: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly candidate: ReleaseLifecycleRequest['candidate_locator'];
    readonly receipt: CertificationReceipt;
    readonly output_blob_sha256: string;
    readonly output_blob_handle: CertificationOutputBlobHandle;
  }) => Buffer | Promise<Buffer>;
}

export interface CertificationOutputClosureBinding {
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: Pick<ReleaseLifecycleRequest['candidate_locator'], 'commit' | 'tree'>;
  readonly task_policy_digest_sha256: string;
  readonly package_id: string;
}

/** Finalized independently by the protected evidence sink, including packages with no outputs. */
export interface CertificationOutputClosure extends CertificationOutputClosureBinding {
  readonly outputs: readonly {
    readonly path: string;
    readonly mode: '100644' | '100755';
    readonly output_blob_handle: CertificationOutputBlobHandle;
    readonly certification_evidence_receipt: CertificationReceipt;
  }[];
}

export interface ArtifactSinkObject {
  readonly kind: 'package-manifest' | 'package-tarball' | 'package-sbom' | 'committed-manifest';
  readonly logical_name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly pack_spec_id: typeof RELEASE_PACK_SPEC_ID;
  readonly pack_spec_digest_sha256: typeof RELEASE_PACK_SPEC_DIGEST;
}

export interface ArtifactSinkObjectReceipt {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly opaque_handle: string;
  readonly kind: ArtifactSinkObject['kind'];
  readonly logical_name: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly pack_spec_id: typeof RELEASE_PACK_SPEC_ID;
  readonly pack_spec_digest_sha256: typeof RELEASE_PACK_SPEC_DIGEST;
}

export interface ArtifactSinkCommitManifest {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'release-artifact-sink-commit-manifest';
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly repository: ReleaseLifecycleRequest['repository_locator'];
  readonly candidate: Pick<ReleaseLifecycleRequest['candidate_locator'], 'commit' | 'tree'>;
  readonly pack_spec_id: typeof RELEASE_PACK_SPEC_ID;
  readonly pack_spec_digest_sha256: typeof RELEASE_PACK_SPEC_DIGEST;
  readonly artifacts: readonly OpaqueArtifactIdentity[];
}

export interface ArtifactSinkCommitReceipt extends ArtifactSinkCommitIdentity {
  readonly committed: true;
}

export interface TrustedArtifactSinkTransaction extends TrustedArtifactReader {
  readonly sink_id: string;
  readonly transaction_handle: string;
  readonly put: (
    artifact: ArtifactSinkObject,
  ) => ArtifactSinkObjectReceipt | Promise<ArtifactSinkObjectReceipt>;
  readonly commit: (
    committedManifest: ArtifactSinkObjectReceipt,
  ) => ArtifactSinkCommitReceipt | Promise<ArtifactSinkCommitReceipt>;
  readonly abort: () => void | Promise<void>;
}

export interface TrustedArtifactSink {
  readonly begin: (binding: {
    readonly repository: ReleaseLifecycleRequest['repository_locator'];
    readonly candidate: Pick<ReleaseLifecycleRequest['candidate_locator'], 'commit' | 'tree'>;
    readonly pack_spec_id: typeof RELEASE_PACK_SPEC_ID;
    readonly pack_spec_digest_sha256: typeof RELEASE_PACK_SPEC_DIGEST;
  }) => TrustedArtifactSinkTransaction | Promise<TrustedArtifactSinkTransaction>;
}

export interface VerifiedPackage {
  readonly release_unit: string;
  readonly version: string;
  readonly package_id: string;
  readonly certification_manifest: CertificationPackageEntryManifest;
  readonly entries: readonly {
    readonly path: string;
    readonly mode: '100644' | '100755';
    readonly sha256: string;
    readonly bytes: Buffer;
  }[];
}

export interface PackedPackage {
  readonly verified: VerifiedPackage;
  readonly objects: readonly ArtifactSinkObject[];
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitObjectDigest(
  bytes: Buffer,
  type: 'blob' | 'commit' | 'tree',
  format: 'sha1' | 'sha256',
): string {
  return createHash(format)
    .update(Buffer.from(`${type} ${String(bytes.byteLength)}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

export function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.from(path, 'utf8').toString('utf8') === path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function safeOpaqueIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(value);
}

export function certificationManifestDigest(
  manifest: Omit<CertificationPackageEntryManifest, 'manifest_digest_sha256'>,
): string {
  return createHash('sha256')
    .update(Buffer.from(CERTIFICATION_MANIFEST_DOMAIN, 'utf8'))
    .update(Buffer.from(canonicalJson(manifest), 'utf8'))
    .digest('hex');
}

export function certificationReceiptDigest(
  receipt: Omit<CertificationReceipt, 'receipt_digest_sha256'>,
) {
  return sha256(Buffer.from(canonicalJson(receipt), 'utf8'));
}

export interface ReleaseMutationPlanReaders {
  readonly resolve_receipt?: ReceiptResolver;
  readonly resolve_plan_input?: ReleasePlanInputResolver;
}

export type ReleaseUnitMutationEvidenceReader = Partial<
  Pick<
    UnitMutationEvidenceSink,
    | 'unit_mutation_maximum_bytes'
    | 'readUnitMutationEvidenceClosure'
    | 'readUnitMutationEvidenceReceipt'
    | 'readUnitMutationEvidenceBlob'
  >
>;

export async function verifyReceiptBytes(
  reader: TrustedArtifactReader,
  receipt: Pick<ArtifactSinkObjectReceipt, 'sink_id' | 'opaque_handle' | 'sha256' | 'size_bytes'>,
  error = 'release-artifact-sink-verification-failed',
): Promise<Buffer> {
  const observed = await reader.readArtifact({
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
  });
  if (!Buffer.isBuffer(observed)) throw new Error(error);
  const bytes = Buffer.from(observed);
  if (bytes.byteLength !== receipt.size_bytes || sha256(bytes) !== receipt.sha256) {
    throw new Error(error);
  }
  return bytes;
}

export function opaqueIdentity(value: unknown): OpaqueArtifactIdentity {
  const artifact = object(value);
  const kinds = new Set([
    'package-manifest',
    'package-tarball',
    'package-sbom',
    'evidence-manifest',
    'provider-result',
  ]);
  if (
    !kinds.has(String(artifact['kind'])) ||
    typeof artifact['sink_id'] !== 'string' ||
    !safeOpaqueIdentity(artifact['sink_id']) ||
    typeof artifact['opaque_handle'] !== 'string' ||
    !safeOpaqueIdentity(artifact['opaque_handle']) ||
    typeof artifact['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(artifact['sha256']) ||
    typeof artifact['size_bytes'] !== 'number' ||
    !Number.isSafeInteger(artifact['size_bytes']) ||
    artifact['size_bytes'] < 0
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  return artifact as unknown as OpaqueArtifactIdentity;
}

export function artifactProjectionKey(value: OpaqueArtifactIdentity): string {
  return `${value.kind}\0${value.sink_id}\0${value.opaque_handle}\0${value.sha256}\0${String(value.size_bytes)}`;
}
