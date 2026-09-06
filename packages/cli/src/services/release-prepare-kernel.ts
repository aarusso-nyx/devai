import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { readProtectedReleasePrepareCapacity } from '@devai-nyx/authority';
import {
  RELEASE_EXPORT_SPEC_ID,
  RELEASE_EXPORT_SPEC_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_FORMAT,
  encodeReleaseExportTranscript,
  verifyReleaseExportProviderResult,
  type ReleaseExportTranscriptLimits,
} from './release-export-transcript.js';
import {
  RELEASE_EXPORT_SPEC_V3_ID,
  RELEASE_EXPORT_SPEC_V3_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT,
  encodeReleaseExportTranscriptV2,
  verifyReleaseExportProviderResultV2,
  verifyReleaseExportProviderResultSetV2,
  captureReleaseExportTranscriptLimits,
  type ReleaseExportProviderResultV2,
} from './release-export-transcript-v2.js';
import {
  RELEASE_EXPORT_SPEC_V4_ID,
  RELEASE_EXPORT_SPEC_V4_DIGEST,
  RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
  encodeReleaseExportTranscriptV3,
  verifyReleaseExportProviderResultV3,
  verifyReleaseExportProviderResultSetV3,
} from './release-export-transcript-v3.js';
import type { ReleaseExportMutationUnitProjection } from './release-export-mutation-contract.js';
import type { ReleaseExportArtifactCommitManifest } from './release-export-artifact-store.js';
import { resolveReleaseMutationRequirements } from './release-lifecycle-execution.js';
import { resolutionForReleasePlanInputResolver } from './release-policy-resolution.js';
import {
  verifyUnitMutationEvidenceClosure,
  verifyUnitMutationEvidenceDocuments,
  type UnitMutationEvidenceSink,
} from './release-unit-mutation-evidence.js';
import type {
  ArtifactSinkCommitIdentity,
  CertificationOutputBlobHandle,
  CertificationPackageEntryManifest,
  GitReleaseBlobLocator,
  OpaqueArtifactIdentity,
  PackageEvidence,
  ReleaseLifecycleRequest,
  ReleaseLifecycleStateV2,
  ReleaseProvider,
  ReleaseProviderResult,
  ReleaseStateMaterial,
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
const CERTIFICATION_MANIFEST_DIGEST_CONTRACT = {
  domain: CERTIFICATION_MANIFEST_DOMAIN,
  payload:
    'utf-8-rfc8785-jcs-of-the-entire-manifest-with-manifest_digest_sha256-omitted;framed-as-domain-utf8-bytes-plus-payload-utf8-bytes',
  canonicalization: 'rfc8785-jcs',
  algorithm: 'sha256',
} as const;
const ENTRY_ORDER = 'ascending-utf-8-byte-collation-by-path;duplicates-refuse' as const;
const COMMIT_PROTOCOL = 'devai.artifact-sink.two-phase.v1' as const;

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

interface VerifiedPackage {
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

interface PackedPackage {
  readonly verified: VerifiedPackage;
  readonly objects: readonly ArtifactSinkObject[];
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitObjectDigest(
  bytes: Buffer,
  type: 'blob' | 'commit' | 'tree',
  format: 'sha1' | 'sha256',
): string {
  return createHash(format)
    .update(Buffer.from(`${type} ${String(bytes.byteLength)}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  return value as Readonly<Record<string, unknown>>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.from(path, 'utf8').toString('utf8') === path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function safeOpaqueIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(value);
}

function packageStem(packageId: string, version: string): string {
  return `${packageId.replace(/^@/u, '').replaceAll('/', '-')}-${version}`.replaceAll(
    /[^A-Za-z0-9._-]/gu,
    '-',
  );
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) throw new Error('release-prepare-unsupported-package-semantics');
  target.write(encoded, offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function ustarPath(path: string): { readonly name: Buffer; readonly prefix: Buffer } {
  if (!safeRelativePath(path)) {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.byteLength <= 100) return { name: bytes, prefix: Buffer.alloc(0) };
  // A slash is one complete UTF-8 byte, so slicing here cannot split a scalar value.
  for (
    let separator = bytes.lastIndexOf(0x2f);
    separator > 0;
    separator = bytes.lastIndexOf(0x2f, separator - 1)
  ) {
    const nameLength = bytes.byteLength - separator - 1;
    if (separator <= 155 && nameLength > 0 && nameLength <= 100) {
      return { name: bytes.subarray(separator + 1), prefix: bytes.subarray(0, separator) };
    }
  }
  throw new Error('release-prepare-unsupported-package-semantics');
}

function tarHeader(path: string, mode: number, size: number): Buffer {
  const fields = ustarPath(path);
  const header = Buffer.alloc(512);
  fields.name.copy(header, 0);
  fields.prefix.copy(header, 345);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function tar(entries: VerifiedPackage['entries']): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.bytes.byteLength > 8_589_934_591) {
      throw new Error('release-prepare-unsupported-package-semantics');
    }
    const path = `package/${entry.path}`;
    chunks.push(tarHeader(path, entry.mode === '100755' ? 0o755 : 0o644, entry.bytes.byteLength));
    chunks.push(entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storedDeflate(bytes: Buffer): Buffer {
  const blocks: Buffer[] = [];
  const fullBlocks = Math.floor(bytes.byteLength / 65_535);
  for (let index = 0; index < fullBlocks; index += 1) {
    const header = Buffer.alloc(5);
    header[0] = 0x00;
    header.writeUInt16LE(65_535, 1);
    header.writeUInt16LE(0, 3);
    const offset = index * 65_535;
    blocks.push(header, bytes.subarray(offset, offset + 65_535));
  }
  const remainder = bytes.byteLength - fullBlocks * 65_535;
  const finalHeader = Buffer.alloc(5);
  finalHeader[0] = 0x01;
  finalHeader.writeUInt16LE(remainder, 1);
  finalHeader.writeUInt16LE(~remainder & 0xffff, 3);
  blocks.push(finalHeader, bytes.subarray(fullBlocks * 65_535));
  return Buffer.concat(blocks);
}

function deterministicGzip(bytes: Buffer): Buffer {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.byteLength >>> 0, 4);
  return Buffer.concat([header, storedDeflate(bytes), trailer]);
}

function certificationManifestDigest(
  manifest: Omit<CertificationPackageEntryManifest, 'manifest_digest_sha256'>,
): string {
  return createHash('sha256')
    .update(Buffer.from(CERTIFICATION_MANIFEST_DOMAIN, 'utf8'))
    .update(Buffer.from(canonicalJson(manifest), 'utf8'))
    .digest('hex');
}

function certificationReceiptDigest(receipt: Omit<CertificationReceipt, 'receipt_digest_sha256'>) {
  return sha256(Buffer.from(canonicalJson(receipt), 'utf8'));
}

export function finalizeCertificationManifest(
  manifest: Omit<CertificationPackageEntryManifest, 'manifest_digest_sha256'>,
): CertificationPackageEntryManifest {
  return { ...manifest, manifest_digest_sha256: certificationManifestDigest(manifest) };
}

/** Canonicalizes bytes only; this does not prove external finalization or producer provenance. */
export function finalizeCertificationReceipt(
  referent: CertificationReceipt['referent'],
): CertificationReceipt {
  const draft = {
    kind: 'release-certification-evidence-receipt-v1' as const,
    canonicalization: 'utf-8-rfc8785-jcs-sha256' as const,
    referent,
  };
  return { ...draft, receipt_digest_sha256: certificationReceiptDigest(draft) };
}

export function verifyCertificationManifest(
  value: CertificationPackageEntryManifest,
  input: {
    readonly request: ReleaseLifecycleRequest;
    readonly package_id: string;
    readonly package_version: string;
    readonly task_policy_digests: ReadonlySet<string>;
  },
): CertificationPackageEntryManifest {
  const { manifest_digest_sha256: _digest, ...draft } = value;
  const paths = value.entries.map((entry) => entry.path);
  if (
    value.manifest_digest_sha256 !== certificationManifestDigest(draft) ||
    value.package_id !== input.package_id ||
    value.package_version !== input.package_version ||
    value.candidate.commit !== input.request.candidate_locator.commit ||
    value.candidate.tree !== input.request.candidate_locator.tree ||
    !input.task_policy_digests.has(value.task_policy_digest_sha256) ||
    value.entry_order !== ENTRY_ORDER ||
    !same(value.manifest_digest_contract, CERTIFICATION_MANIFEST_DIGEST_CONTRACT) ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path, index) =>
        !safeRelativePath(path) || (index > 0 && utf8Compare(paths[index - 1] ?? '', path) >= 0),
    ) ||
    value.entries.some(
      (entry) =>
        !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size_bytes) ||
        entry.size_bytes < 0 ||
        !['100644', '100755'].includes(entry.mode) ||
        (entry.immutable_blob_locator.kind === 'git-object' &&
          !gitLocatorMatches(entry, input.request, input.package_id)),
    ) ||
    !paths.includes('package.json')
  ) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  return value;
}

function gitLocatorMatches(
  entry: CertificationPackageEntryManifest['entries'][number],
  request: ReleaseLifecycleRequest,
  packageId: string,
): boolean {
  const locator = entry.immutable_blob_locator;
  if (locator.kind !== 'git-object') return false;
  const pkg = request.candidate_locator.release_units
    .flatMap((unit) => unit.package_roster)
    .find((value) => value.package_id === packageId);
  const prefix = pkg?.manifest_path.slice(0, -'package.json'.length);
  const length =
    locator.object_format === 'sha1' ? 40 : locator.object_format === 'sha256' ? 64 : 0;
  return (
    prefix !== undefined &&
    length > 0 &&
    [locator.commit, locator.tree, locator.object_id].every(
      (id) => typeof id === 'string' && id.length === length && /^[0-9a-f]+$/u.test(id),
    ) &&
    locator.repository === request.repository_locator.id &&
    locator.commit === request.candidate_locator.commit &&
    locator.tree === request.candidate_locator.tree &&
    locator.path === `${prefix}${entry.path}` &&
    safeRelativePath(locator.path) &&
    locator.mode === entry.mode &&
    locator.size_bytes === entry.size_bytes &&
    locator.content_digest_sha256 === entry.sha256
  );
}

async function verifyGitMembership(
  source: Pick<ImmutableReleaseContentSource, 'readGitObject'>,
  request: ReleaseLifecycleRequest,
  locator: GitReleaseBlobLocator,
): Promise<void> {
  const read = async (type: 'commit' | 'tree', objectId: string): Promise<Buffer> => {
    const bytes = await source.readGitObject({
      repository: request.repository_locator,
      object_format: locator.object_format,
      object_id: objectId,
      type,
    });
    if (!Buffer.isBuffer(bytes) || gitObjectDigest(bytes, type, locator.object_format) !== objectId)
      throw new Error('release-prepare-git-tree-membership-invalid');
    return Buffer.from(bytes);
  };
  try {
    const commit = await read('commit', locator.commit);
    const firstLine = commit.subarray(0, commit.indexOf(10)).toString('utf8');
    if (firstLine !== `tree ${locator.tree}`) throw new Error('membership');
    let tree = locator.tree;
    const parts = locator.path.split('/');
    const oidBytes = locator.object_format === 'sha1' ? 20 : 32;
    for (const [index, part] of parts.entries()) {
      const bytes = await read('tree', tree);
      const entries = new Map<string, { mode: string; id: string }>();
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > bytes.length)
          throw new Error('tree');
        const mode = bytes.subarray(offset, space).toString('ascii');
        const nameBytes = bytes.subarray(space + 1, nul);
        const name = nameBytes.toString('utf8');
        if (
          !nameBytes.equals(Buffer.from(name)) ||
          !safeRelativePath(name) ||
          name.includes('/') ||
          entries.has(name)
        )
          throw new Error('tree');
        entries.set(name, {
          mode,
          id: bytes.subarray(nul + 1, nul + 1 + oidBytes).toString('hex'),
        });
        offset = nul + 1 + oidBytes;
      }
      const entry = entries.get(part);
      if (entry === undefined) throw new Error('membership');
      if (index === parts.length - 1) {
        if (entry.mode !== locator.mode || entry.id !== locator.object_id)
          throw new Error('membership');
      } else {
        if (entry.mode !== '40000') throw new Error('membership');
        tree = entry.id;
      }
    }
  } catch {
    throw new Error('release-prepare-git-tree-membership-invalid');
  }
}

/** Protected certification uses the same raw-object membership proof before executing source. */
export async function verifyGitCertificationSource(
  source: Pick<ImmutableReleaseContentSource, 'readGitObject' | 'readGitBlob'>,
  request: ReleaseLifecycleRequest,
  locator: GitReleaseBlobLocator,
): Promise<Buffer> {
  if (
    locator.repository !== request.repository_locator.id ||
    locator.commit !== request.candidate_locator.commit ||
    locator.tree !== request.candidate_locator.tree ||
    !safeRelativePath(locator.path) ||
    !['100644', '100755'].includes(locator.mode)
  ) {
    throw new Error('release-prepare-git-locator-invalid');
  }
  await verifyGitMembership(source, request, locator);
  const bytes = await source.readGitBlob({
    repository: request.repository_locator,
    candidate: request.candidate_locator,
    object_id: locator.object_id,
    locator,
  });
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== locator.size_bytes ||
    sha256(bytes) !== locator.content_digest_sha256 ||
    gitObjectDigest(bytes, 'blob', locator.object_format) !== locator.object_id
  ) {
    throw new Error('release-prepare-content-digest-mismatch');
  }
  return Buffer.from(bytes);
}

export async function verifyCertificationOutputClosure(
  source: Pick<ImmutableReleaseContentSource, 'readCertificationOutputClosure'>,
  request: ReleaseLifecycleRequest,
  manifest: CertificationPackageEntryManifest,
): Promise<void> {
  const binding: CertificationOutputClosureBinding = {
    repository: request.repository_locator,
    candidate: { commit: request.candidate_locator.commit, tree: request.candidate_locator.tree },
    task_policy_digest_sha256: manifest.task_policy_digest_sha256,
    package_id: manifest.package_id,
  };
  const outputs = manifest.entries.flatMap((entry) =>
    entry.immutable_blob_locator.kind === 'generated-output'
      ? [
          {
            path: entry.path,
            mode: entry.mode,
            output_blob_handle: entry.immutable_blob_locator.output_blob_handle,
            certification_evidence_receipt:
              entry.immutable_blob_locator.certification_evidence_receipt,
          },
        ]
      : [],
  );
  let observed: CertificationOutputClosure;
  try {
    observed = await source.readCertificationOutputClosure(binding);
  } catch {
    throw new Error('release-certification-generated-output-untrusted');
  }
  if (!same(observed, { ...binding, outputs }))
    throw new Error('release-certification-output-closure-invalid');
}

function verifyCertificationReceipt(
  observed: unknown,
  expected: CertificationReceipt,
): CertificationReceipt {
  const value = object(observed);
  const draft = {
    kind: value['kind'],
    canonicalization: value['canonicalization'],
    referent: value['referent'],
  };
  if (
    !same(value, expected) ||
    value['receipt_digest_sha256'] !== sha256(Buffer.from(canonicalJson(draft), 'utf8'))
  ) {
    throw new Error('release-prepare-immutable-blob-locator-invalid');
  }
  return expected;
}

async function verifyPackage(
  source: ImmutableReleaseContentSource,
  request: ReleaseLifecycleRequest,
  state: Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>,
  unitIndex: number,
  packageIndex: number,
): Promise<VerifiedPackage> {
  const requestUnit = request.candidate_locator.release_units[unitIndex];
  const stateUnit = state.release_units[unitIndex];
  const requestPackage = requestUnit?.package_roster[packageIndex];
  const statePackage = stateUnit?.packages[packageIndex];
  if (
    requestUnit === undefined ||
    stateUnit === undefined ||
    requestPackage === undefined ||
    statePackage === undefined ||
    statePackage.certification_manifest === undefined ||
    statePackage.certification_manifest === null
  ) {
    throw new Error('release-prepare-certification-manifest-invalid');
  }
  const taskPolicyDigests = new Set(
    (state['inputs'] as readonly { readonly kind: string; readonly sha256: string }[])
      .filter((entry) => entry.kind === 'task-policy')
      .map((entry) => entry.sha256),
  );
  const manifest = verifyCertificationManifest(statePackage.certification_manifest, {
    request,
    package_id: requestPackage.package_id,
    package_version: requestUnit.version,
    task_policy_digests: taskPolicyDigests,
  });
  const entries: Array<VerifiedPackage['entries'][number]> = [];
  await verifyCertificationOutputClosure(source, request, manifest);
  for (const entry of manifest.entries) {
    let bytes: Buffer;
    if (entry.immutable_blob_locator.kind === 'git-object') {
      await verifyGitMembership(source, request, entry.immutable_blob_locator);
      try {
        bytes = Buffer.from(
          await source.readGitBlob({
            repository: request.repository_locator,
            candidate: request.candidate_locator,
            object_id: entry.immutable_blob_locator.object_id,
            locator: entry.immutable_blob_locator,
          }),
        );
      } catch {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
      if (
        gitObjectDigest(bytes, 'blob', entry.immutable_blob_locator.object_format) !==
        entry.immutable_blob_locator.object_id
      ) {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
    } else {
      const locator = entry.immutable_blob_locator;
      const expectedReferent = {
        candidate_commit: request.candidate_locator.commit,
        candidate_tree: request.candidate_locator.tree,
        task_policy_digest_sha256: manifest.task_policy_digest_sha256,
        package_id: requestPackage.package_id,
        output_blob_sha256: entry.sha256,
        output_blob_handle: locator.output_blob_handle,
      };
      if (
        locator.output_blob_sha256 !== entry.sha256 ||
        locator.output_blob_handle?.sha256 !== entry.sha256 ||
        locator.output_blob_handle?.size_bytes !== entry.size_bytes ||
        !safeOpaqueIdentity(locator.output_blob_handle?.evidence_sink_id ?? '') ||
        !safeOpaqueIdentity(locator.output_blob_handle?.opaque_handle ?? '') ||
        !same(locator.certification_evidence_receipt.referent, expectedReferent)
      ) {
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
      try {
        const receipt = await source.readCertificationEvidenceReceipt({
          receipt_digest_sha256: locator.certification_evidence_receipt.receipt_digest_sha256,
          evidence_sink_id: locator.output_blob_handle.evidence_sink_id,
        });
        verifyCertificationReceipt(receipt, locator.certification_evidence_receipt);
        bytes = Buffer.from(
          await source.readGeneratedBlob({
            repository: request.repository_locator,
            candidate: request.candidate_locator,
            receipt: locator.certification_evidence_receipt,
            output_blob_sha256: locator.output_blob_sha256,
            output_blob_handle: locator.output_blob_handle,
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'release-prepare-immutable-blob-locator-invalid'
        ) {
          throw error;
        }
        throw new Error('release-prepare-immutable-blob-locator-invalid');
      }
    }
    if (bytes.byteLength !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
      throw new Error('release-prepare-content-digest-mismatch');
    }
    entries.push({ path: entry.path, mode: entry.mode, sha256: entry.sha256, bytes });
  }
  const packageJson = entries.find((entry) => entry.path === 'package.json');
  if (packageJson === undefined) throw new Error('release-prepare-package-entry-coverage-invalid');
  let packageDocument: Readonly<Record<string, unknown>>;
  try {
    packageDocument = object(JSON.parse(packageJson.bytes.toString('utf8')) as unknown);
  } catch {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  if (
    packageDocument['name'] !== requestPackage.package_id ||
    packageDocument['version'] !== requestUnit.version
  ) {
    throw new Error('release-package-manifest-identity-mismatch');
  }
  if (
    packageJson.sha256 !== requestPackage.manifest_digest_sha256 ||
    sha256(packageJson.bytes) !== requestPackage.manifest_digest_sha256
  ) {
    throw new Error('release-package-manifest-identity-mismatch');
  }
  return {
    release_unit: requestUnit.release_unit,
    version: requestUnit.version,
    package_id: requestPackage.package_id,
    certification_manifest: manifest,
    entries,
  };
}

export async function verifyCertificationMaterial(
  request: ReleaseLifecycleRequest,
  material: ReleaseStateMaterial,
  source: ImmutableReleaseContentSource,
  plan: ReleaseMutationPlanReaders = {},
): Promise<void> {
  await verifyCertificationMutationEvidence(request, material, source, plan);
  for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
    for (const packageIndex of unit.package_roster.keys()) {
      await verifyPackage(source, request, material, unitIndex, packageIndex);
    }
  }
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

/** Unit evidence is retained outside publishable package entries and is never a tarball input. */
export async function verifyCertificationMutationEvidence(
  request: ReleaseLifecycleRequest,
  material: Pick<ReleaseStateMaterial, 'release_units' | 'inputs'>,
  source: ReleaseUnitMutationEvidenceReader,
  plan: ReleaseMutationPlanReaders,
): Promise<void> {
  const requirements = resolveReleaseMutationRequirements(request, plan);
  const inputs = JSON.parse(canonicalJson(material.inputs)) as ReleaseStateMaterial['inputs'];
  const units = JSON.parse(
    canonicalJson(material.release_units),
  ) as ReleaseStateMaterial['release_units'];
  const expected = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => pkg.package_id),
  }));
  const observed = units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => pkg.package_id),
  }));
  if (!same(expected, observed)) throw new Error('release-certification-output-closure-invalid');
  if (
    !same(
      requirements.map((unit) => unit.release_unit),
      units.map((unit) => unit.release_unit),
    )
  )
    throw new Error('release-certification-output-closure-invalid');
  for (const [index, requirement] of requirements.entries()) {
    const unit = units[index];
    if (unit === undefined) throw new Error('release-certification-output-closure-invalid');
    const closure = unit.mutation_evidence;
    if (requirement.binding === null) {
      if (closure !== undefined && closure !== null)
        throw new Error('release-certification-generated-output-untrusted');
      continue;
    }
    const maximumBytes = source.unit_mutation_maximum_bytes;
    const readClosure =
      typeof source.readUnitMutationEvidenceClosure === 'function'
        ? source.readUnitMutationEvidenceClosure.bind(source)
        : undefined;
    const readReceipt =
      typeof source.readUnitMutationEvidenceReceipt === 'function'
        ? source.readUnitMutationEvidenceReceipt.bind(source)
        : undefined;
    const readBlob =
      typeof source.readUnitMutationEvidenceBlob === 'function'
        ? source.readUnitMutationEvidenceBlob.bind(source)
        : undefined;
    if (
      closure === undefined ||
      closure === null ||
      typeof readClosure !== 'function' ||
      typeof readReceipt !== 'function' ||
      typeof readBlob !== 'function' ||
      maximumBytes === undefined ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1
    )
      throw new Error('release-certification-generated-output-untrusted');
    const taskDigests = unit.packages.map(
      (pkg) => pkg.certification_manifest?.task_policy_digest_sha256,
    );
    if (
      taskDigests.some(
        (digest) =>
          digest === undefined ||
          !inputs.some((entry) => entry.kind === 'task-policy' && entry.sha256 === digest),
      )
    )
      throw new Error('release-task-policy-identity-mismatch');
    const binding = {
      ...requirement.binding,
      task_policy_digests_sha256: [...new Set(taskDigests as string[])].sort(),
    };
    const resolution = resolutionForReleasePlanInputResolver(plan.resolve_plan_input, {
      candidate: { release_unit: requirement.release_unit },
    });
    const profile = record(resolution?.readInput('release-verification-profile'));
    if (
      profile === undefined ||
      canonicalSha256(profile) !== binding.release_profile_digest_sha256 ||
      !Array.isArray(profile['mutation_roster'])
    )
      throw new Error('release-certification-generated-output-untrusted');
    const roster = profile['mutation_roster']
      .map((entry: unknown) => {
        const row = record(entry);
        const thresholds = record(row?.['thresholds']);
        if (
          typeof row?.['package'] !== 'string' ||
          typeof row['manifest_path'] !== 'string' ||
          typeof thresholds?.['score_min'] !== 'number' ||
          typeof thresholds['survived_max'] !== 'number'
        )
          throw new Error('release-certification-generated-output-untrusted');
        return {
          packageName: row['package'],
          workspace: posix.dirname(row['manifest_path']),
          scoreMin: thresholds['score_min'],
          survivedMax: thresholds['survived_max'],
        };
      })
      .sort((a, b) => utf8Compare(a.packageName, b.packageName));
    verifyUnitMutationEvidenceClosure(closure, binding);
    const retained = readClosure(binding);
    verifyUnitMutationEvidenceClosure(retained, binding);
    if (!same(retained, closure))
      throw new Error('release-certification-generated-output-untrusted');
    const receipt = readReceipt({
      evidence_sink_id: closure.output_contract.evidence_sink_id,
      receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
    });
    if (!same(receipt, closure.receipt))
      throw new Error('release-certification-generated-output-untrusted');
    let contractBytes: Buffer | undefined;
    await verifyUnitMutationEvidenceDocuments({
      closure,
      expected: binding,
      maximum_bytes: maximumBytes,
      read: (identity) => {
        const bytes = readBlob({ binding, identity });
        if (identity.path === closure.output_contract.path) contractBytes = Buffer.from(bytes);
        return bytes;
      },
    });
    if (contractBytes === undefined)
      throw new Error('release-certification-generated-output-untrusted');
    const contracts = record(JSON.parse(contractBytes.toString('utf8')))?.['packages'];
    if (!Array.isArray(contracts))
      throw new Error('release-certification-generated-output-untrusted');
    const packages = contracts
      .map((entry: unknown) => record(entry))
      .sort((a, b) => utf8Compare(String(a?.['packageName']), String(b?.['packageName'])));
    if (
      !same(
        packages.map((entry) => ({
          packageName: entry?.['packageName'],
          workspace: entry?.['workspace'],
        })),
        roster.map((entry) => ({ packageName: entry.packageName, workspace: entry.workspace })),
      )
    )
      throw new Error('release-certification-generated-output-untrusted');
    for (const [packageIndex, entry] of packages.entries()) {
      if (entry?.['requirement'] !== 'required') continue;
      const thresholds = record(entry['thresholds']);
      if (
        thresholds?.['scoreMin'] !== roster[packageIndex]?.scoreMin ||
        thresholds?.['survivedMax'] !== roster[packageIndex]?.survivedMax
      )
        throw new Error('release-certification-generated-output-untrusted');
    }
  }
}

function sinkObject(
  kind: ArtifactSinkObject['kind'],
  logicalName: string,
  bytes: Buffer,
): ArtifactSinkObject {
  return {
    kind,
    logical_name: logicalName,
    bytes,
    sha256: sha256(bytes),
    size_bytes: bytes.byteLength,
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
  };
}

function spdxBytes(value: VerifiedPackage): Buffer {
  const rawSha1 = value.entries.map((entry) =>
    createHash('sha1').update(entry.bytes).digest('hex').toLowerCase(),
  );
  const files = value.entries.map((entry, index) => {
    const archivePath = `package/${entry.path}`;
    return {
      SPDXID: `SPDXRef-File-${sha256(Buffer.from(archivePath, 'utf8'))}`,
      fileName: archivePath,
      checksums: [
        { algorithm: 'SHA1', checksumValue: rawSha1[index] },
        { algorithm: 'SHA256', checksumValue: entry.sha256 },
      ],
      licenseConcluded: 'NOASSERTION',
      licenseInfoInFiles: ['NOASSERTION'],
      copyrightText: 'NOASSERTION',
    };
  });
  const relationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: 'SPDXRef-Package',
    },
    ...value.entries.map((entry) => ({
      spdxElementId: 'SPDXRef-Package',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: `SPDXRef-File-${sha256(Buffer.from(`package/${entry.path}`, 'utf8'))}`,
    })),
  ];
  return Buffer.from(
    canonicalJson({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `${value.package_id}@${value.version}`,
      documentNamespace: `https://devai.nyxk.com.br/spdx/${value.certification_manifest.candidate.commit}/${value.package_id}`,
      creationInfo: {
        created: '1970-01-01T00:00:00Z',
        creators: [`Tool: ${RELEASE_PACK_SPEC_ID}`],
      },
      documentDescribes: ['SPDXRef-Package'],
      packages: [
        {
          name: `${value.package_id}@${value.version}`,
          SPDXID: 'SPDXRef-Package',
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: true,
          packageVerificationCode: {
            packageVerificationCodeValue: createHash('sha1')
              .update(Buffer.from([...rawSha1].sort().join(''), 'utf8'))
              .digest('hex')
              .toLowerCase(),
          },
          licenseConcluded: 'NOASSERTION',
          licenseDeclared: 'NOASSERTION',
          copyrightText: 'NOASSERTION',
          supplier: 'NOASSERTION',
          originator: 'NOASSERTION',
        },
      ],
      files,
      relationships,
    }),
    'utf8',
  );
}

function packPackage(value: VerifiedPackage): PackedPackage {
  const stem = packageStem(value.package_id, value.version);
  const tarballBytes = deterministicGzip(tar(value.entries));
  const sbom = spdxBytes(value);
  const manifest = Buffer.from(
    canonicalJson({
      schemaVersion: '2.0.0',
      kind: 'release-prepared-package-manifest',
      candidate: value.certification_manifest.candidate,
      package_id: value.package_id,
      package_version: value.version,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      certification_manifest_digest_sha256: value.certification_manifest.manifest_digest_sha256,
      artifacts: {
        tarball: { sha256: sha256(tarballBytes), size_bytes: tarballBytes.byteLength },
        sbom: { sha256: sha256(sbom), size_bytes: sbom.byteLength },
      },
    }),
    'utf8',
  );
  return {
    verified: value,
    objects: [
      sinkObject('package-manifest', `${stem}.manifest.json`, manifest),
      sinkObject('package-tarball', `${stem}.tgz`, tarballBytes),
      sinkObject('package-sbom', `${stem}.spdx.json`, sbom),
    ],
  };
}

function toOpaqueIdentity(receipt: ArtifactSinkObjectReceipt): OpaqueArtifactIdentity {
  if (receipt.kind === 'committed-manifest') {
    throw new Error('release-artifact-sink-protocol-invalid');
  }
  return {
    kind: receipt.kind,
    sink_id: receipt.sink_id,
    opaque_handle: receipt.opaque_handle,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
  };
}

function assertObjectReceipt(
  receipt: ArtifactSinkObjectReceipt,
  artifact: ArtifactSinkObject,
  transaction: TrustedArtifactSinkTransaction,
): void {
  if (
    record(receipt) === undefined ||
    receipt.sink_id !== transaction.sink_id ||
    receipt.transaction_handle !== transaction.transaction_handle ||
    !safeOpaqueIdentity(receipt.sink_id) ||
    !safeOpaqueIdentity(receipt.opaque_handle) ||
    !same(receipt, {
      sink_id: transaction.sink_id,
      transaction_handle: transaction.transaction_handle,
      opaque_handle: receipt.opaque_handle,
      kind: artifact.kind,
      logical_name: artifact.logical_name,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    })
  ) {
    throw new Error('release-artifact-sink-protocol-invalid');
  }
}

async function verifyReceiptBytes(
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

/** Rebind retained prepared bytes to their package row; digest checks alone do not prevent swaps. */
export function verifyPreparedPackageManifest(input: {
  readonly bytes: Buffer;
  readonly package: PackageEvidence;
  readonly version: string;
  readonly candidate: { readonly commit: string; readonly tree: string };
}): void {
  const pkg = input.package;
  const certification = pkg.certification_manifest;
  const tarball = pkg.package_tarball;
  const sbom = pkg.package_sbom;
  if (certification == null || tarball == null || sbom == null)
    throw new Error('release-downstream-artifact-reverification-failed');
  const { manifest_digest_sha256, ...draft } = certification;
  const expected = {
    schemaVersion: '2.0.0',
    kind: 'release-prepared-package-manifest',
    candidate: input.candidate,
    package_id: pkg.package_id,
    package_version: input.version,
    pack_spec_id: RELEASE_PACK_SPEC_ID,
    pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
    certification_manifest_digest_sha256: manifest_digest_sha256,
    artifacts: {
      tarball: { sha256: tarball.sha256, size_bytes: tarball.size_bytes },
      sbom: { sha256: sbom.sha256, size_bytes: sbom.size_bytes },
    },
  };
  if (
    certificationManifestDigest(draft) !== manifest_digest_sha256 ||
    certification.package_id !== pkg.package_id ||
    certification.package_version !== input.version ||
    !same(certification.candidate, input.candidate) ||
    !input.bytes.equals(Buffer.from(canonicalJson(expected), 'utf8'))
  )
    throw new Error('release-downstream-artifact-reverification-failed');
}

async function abort(transaction: TrustedArtifactSinkTransaction): Promise<void> {
  try {
    await transaction.abort();
  } catch {
    throw new Error('release-artifact-sink-abort-failed');
  }
}

export function createReleasePrepareProvider(
  input: ReleaseMutationPlanReaders & {
    readonly certified_state: ReleaseLifecycleStateV2;
    readonly content_source: ImmutableReleaseContentSource;
    readonly artifact_sink: TrustedArtifactSink;
  },
): ReleaseProvider {
  const certifiedState = JSON.parse(
    canonicalJson(input.certified_state),
  ) as ReleaseLifecycleStateV2;
  return async (request): Promise<ReleaseProviderResult> => {
    if (
      input.artifact_sink === undefined ||
      input.artifact_sink === null ||
      typeof input.artifact_sink.begin !== 'function'
    ) {
      return { outcome: 'failure', code: 'release-artifact-sink-unavailable' };
    }
    if (
      certifiedState.state !== 'certified' ||
      !same(certifiedState.repository, request.repository_locator) ||
      certifiedState.candidate.commit !== request.candidate_locator.commit ||
      certifiedState.candidate.tree !== request.candidate_locator.tree
    ) {
      return { outcome: 'failure', code: 'release-prepare-certification-manifest-invalid' };
    }
    let transaction: TrustedArtifactSinkTransaction | undefined;
    let committed = false;
    try {
      if (sha256(RELEASE_PACK_SPEC_CANONICAL_BYTES) !== RELEASE_PACK_SPEC_DIGEST) {
        throw new Error('release-prepare-pack-spec-digest-mismatch');
      }
      await verifyCertificationMutationEvidence(
        request,
        certifiedState,
        input.content_source,
        input,
      );
      const verified: VerifiedPackage[] = [];
      for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
        for (const packageIndex of unit.package_roster.keys()) {
          verified.push(
            await verifyPackage(
              input.content_source,
              request,
              certifiedState,
              unitIndex,
              packageIndex,
            ),
          );
        }
      }
      const packed = verified.map(packPackage);
      const logicalNames = packed.flatMap((pkg) =>
        pkg.objects.map((artifact) => artifact.logical_name),
      );
      if (new Set(logicalNames).size !== logicalNames.length) {
        throw new Error('release-prepare-package-entry-coverage-invalid');
      }
      const plan = request.receipt_locators?.find(
        (receipt) => receipt.kind === 'release-plan-receipt',
      );
      if (plan === undefined) throw new Error('release-prepare-capacity-unavailable');
      const capacity = readProtectedReleasePrepareCapacity({
        action_id: 'release prepare',
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        plan_receipt_digest_sha256: plan.receipt_digest_sha256,
      });
      const required = 3 * packed.length + 33;
      if (
        !Number.isSafeInteger(required) ||
        capacity.remaining_batches < required ||
        capacity.remaining_targets < required
      )
        throw new Error('release-prepare-capacity-insufficient');
      const opened = await input.artifact_sink.begin({
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      });
      const openedRecord = record(opened);
      if (openedRecord !== undefined && typeof openedRecord['abort'] === 'function')
        transaction = opened;
      if (
        transaction === undefined ||
        !safeOpaqueIdentity(transaction.sink_id) ||
        !safeOpaqueIdentity(transaction.transaction_handle) ||
        typeof transaction.put !== 'function' ||
        typeof transaction.readArtifact !== 'function' ||
        typeof transaction.commit !== 'function' ||
        typeof transaction.abort !== 'function'
      ) {
        throw new Error('release-artifact-sink-protocol-invalid');
      }
      const receipts: ArtifactSinkObjectReceipt[] = [];
      for (const pkg of packed) {
        for (const artifact of pkg.objects) {
          const receipt = await transaction.put(artifact);
          assertObjectReceipt(receipt, artifact, transaction);
          await verifyReceiptBytes(transaction, receipt);
          receipts.push(receipt);
        }
      }
      const artifacts = receipts
        .map(toOpaqueIdentity)
        .sort((left, right) =>
          utf8Compare(
            `${left.kind}\0${left.sink_id}\0${left.opaque_handle}\0${left.sha256}\0${String(left.size_bytes)}`,
            `${right.kind}\0${right.sink_id}\0${right.opaque_handle}\0${right.sha256}\0${String(right.size_bytes)}`,
          ),
        );
      const commitManifest: ArtifactSinkCommitManifest = {
        schemaVersion: '1.0.0',
        kind: 'release-artifact-sink-commit-manifest',
        sink_id: transaction.sink_id,
        transaction_handle: transaction.transaction_handle,
        repository: request.repository_locator,
        candidate: {
          commit: request.candidate_locator.commit,
          tree: request.candidate_locator.tree,
        },
        pack_spec_id: RELEASE_PACK_SPEC_ID,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        artifacts,
      };
      const commitManifestObject = sinkObject(
        'committed-manifest',
        'release-artifact-sink-commit-manifest.json',
        Buffer.from(canonicalJson(commitManifest), 'utf8'),
      );
      const commitManifestReceipt = await transaction.put(commitManifestObject);
      assertObjectReceipt(commitManifestReceipt, commitManifestObject, transaction);
      await verifyReceiptBytes(transaction, commitManifestReceipt);
      const artifactSink: ArtifactSinkCommitIdentity = {
        sink_id: transaction.sink_id,
        transaction_handle: transaction.transaction_handle,
        committed_manifest_handle: commitManifestReceipt.opaque_handle,
        committed_manifest_sha256: commitManifestReceipt.sha256,
        committed_manifest_size_bytes: commitManifestReceipt.size_bytes,
        commit_protocol: COMMIT_PROTOCOL,
      };
      const byLogicalName = new Map(receipts.map((receipt) => [receipt.logical_name, receipt]));
      const releaseUnits = request.candidate_locator.release_units.map((unit, index) => ({
        release_unit: unit.release_unit,
        version: unit.version,
        ...(certifiedState.release_units[index]?.mutation_evidence === undefined
          ? {}
          : {
              mutation_evidence: certifiedState.release_units[index]?.mutation_evidence,
            }),
        packages: unit.package_roster.map((requestedPackage) => {
          const packageValue = packed.find(
            (candidate) =>
              candidate.verified.release_unit === unit.release_unit &&
              candidate.verified.package_id === requestedPackage.package_id,
          );
          if (packageValue === undefined) throw new Error('release-release-unit-bijection-invalid');
          const identity = (
            kind: 'package-manifest' | 'package-tarball' | 'package-sbom',
          ): OpaqueArtifactIdentity => {
            const artifact = packageValue.objects.find((candidate) => candidate.kind === kind);
            const receipt =
              artifact === undefined ? undefined : byLogicalName.get(artifact.logical_name);
            if (receipt === undefined) throw new Error('release-artifact-sink-protocol-invalid');
            return toOpaqueIdentity(receipt);
          };
          return {
            package_id: requestedPackage.package_id,
            package_manifest: identity('package-manifest'),
            package_tarball: identity('package-tarball'),
            package_sbom: identity('package-sbom'),
            evidence_manifest: null,
            provider_result: null,
            trust: null,
            certification_manifest: packageValue.verified.certification_manifest,
          } satisfies PackageEvidence;
        }),
      }));
      const material: ReleaseStateMaterial = {
        release_units: releaseUnits,
        inputs: certifiedState['inputs'] as ReleaseStateMaterial['inputs'],
        evidence: {
          manifest_digest_sha256: commitManifestReceipt.sha256,
          receipt_digests: [
            ...(certifiedState['evidence'] as ReleaseStateMaterial['evidence']).receipt_digests,
          ],
          independently_checkable: true,
        },
        artifacts,
        artifact_sink: artifactSink,
      };
      let open = true;
      return {
        outcome: 'success',
        material,
        transaction: {
          commit: async () => {
            if (!open || transaction === undefined)
              throw new Error('release-artifact-sink-protocol-invalid');
            // Once atomic commit is attempted, its outcome may be externally uncertain. Never
            // issue an abort that could destroy the only inspectable record of that attempt.
            open = false;
            let receipt: ArtifactSinkCommitReceipt;
            try {
              receipt = await transaction.commit(commitManifestReceipt);
              if (
                record(receipt) === undefined ||
                receipt.committed !== true ||
                !same(receipt, { committed: true, ...artifactSink })
              ) {
                throw new Error('release-artifact-sink-verification-failed');
              }
              await verifyReceiptBytes(transaction, commitManifestReceipt);
              for (const artifactReceipt of receipts)
                await verifyReceiptBytes(transaction, artifactReceipt);
              committed = true;
            } catch {
              throw new Error('release-artifact-sink-commit-unknown');
            }
          },
          rollback: async () => {
            if (transaction !== undefined && !committed && open) {
              open = false;
              await abort(transaction);
            }
          },
          dispose: async () => {
            if (transaction !== undefined && !committed && open) {
              open = false;
              await abort(transaction);
            }
          },
        },
      };
    } catch (error) {
      if (transaction !== undefined && !committed) {
        try {
          await abort(transaction);
        } catch (abortError) {
          return {
            outcome: 'failure',
            code:
              abortError instanceof Error
                ? abortError.message
                : 'release-artifact-sink-abort-failed',
          };
        }
      }
      return {
        outcome: 'failure',
        code:
          error instanceof Error ? error.message : 'release-prepare-certification-manifest-invalid',
      };
    }
  };
}

function opaqueIdentity(value: unknown): OpaqueArtifactIdentity {
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

function artifactProjectionKey(value: OpaqueArtifactIdentity): string {
  return `${value.kind}\0${value.sink_id}\0${value.opaque_handle}\0${value.sha256}\0${String(value.size_bytes)}`;
}

/** Byte and membership continuity only; neither a signature nor a policy verdict. */
async function reverifyExportContinuity(
  state: ReleaseLifecycleStateV2,
  manifest: Readonly<Record<string, unknown>>,
  manifestBytes: Buffer,
  reader: TrustedArtifactReader,
  observed: ReadonlyMap<string, Buffer>,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  const fail = (): never => {
    throw new Error('release-downstream-artifact-reverification-failed');
  };
  const parse = (value: Buffer): Readonly<Record<string, unknown>> => {
    const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)));
    if (!value.equals(Buffer.from(canonicalJson(parsed), 'utf8'))) fail();
    return parsed;
  };
  const exported = manifest as unknown as ReleaseExportArtifactCommitManifest;
  const forward = exported.export_spec_id === RELEASE_EXPORT_SPEC_V4_ID;
  const current = forward || exported.export_spec_id === RELEASE_EXPORT_SPEC_V3_ID;
  const specId = forward
    ? RELEASE_EXPORT_SPEC_V4_ID
    : current
      ? RELEASE_EXPORT_SPEC_V3_ID
      : RELEASE_EXPORT_SPEC_ID;
  const specDigest = forward
    ? RELEASE_EXPORT_SPEC_V4_DIGEST
    : current
      ? RELEASE_EXPORT_SPEC_V3_DIGEST
      : RELEASE_EXPORT_SPEC_DIGEST;
  const sink = state.artifact_sink;
  const binding = exported.binding;
  const parent = exported.parent_artifact_sink;
  if (sink == null) return fail();
  if (
    !same(parse(manifestBytes), manifest) ||
    !same(manifest, {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: sink.sink_id,
      transaction_handle: sink.transaction_handle,
      repository: state.repository,
      candidate: { commit: state.candidate.commit, tree: state.candidate.tree },
      export_spec_id: specId,
      export_spec_digest_sha256: specDigest,
      parent_artifact_sink: parent,
      binding,
      artifacts: state['artifacts'],
    }) ||
    parent.sink_id !== sink.sink_id ||
    parent.transaction_handle === sink.transaction_handle ||
    parent.committed_manifest_handle === sink.committed_manifest_handle ||
    sink.commit_protocol !== COMMIT_PROTOCOL ||
    !same(binding.parent_artifact_sink, parent) ||
    !same(binding.repository, state.repository) ||
    !same(binding.candidate, exported.candidate) ||
    binding.sink_id !== sink.sink_id ||
    binding.export_spec_digest_sha256 !== specDigest
  )
    fail();
  const planBindings = (state['bound_receipts'] as readonly Record<string, unknown>[]).filter(
    (entry) => entry['kind'] === 'release-plan-receipt',
  );
  // Later actions bind their own required receipts (notably offline verification), not a
  // fabricated copy of the export plan receipt. Their exact sink/parent chain remains pinned.
  if (
    (state.state === 'exported' || planBindings.length > 0) &&
    !same(planBindings, [
      {
        kind: 'release-plan-receipt',
        receipt_id: `RPL-${binding.plan_receipt_digest_sha256.slice(0, 16)}`,
        receipt_digest_sha256: binding.plan_receipt_digest_sha256,
        verdict: 'pass',
      },
    ])
  )
    fail();
  const packages = state.release_units
    .flatMap((unit) => unit.packages)
    .sort((a, b) => utf8Compare(a.package_id, b.package_id));
  if (
    packages.length === 0 ||
    new Set(packages.map((pkg) => pkg.package_id)).size !== packages.length ||
    !Array.isArray(binding.closure_inputs) ||
    binding.closure_inputs.length !== packages.length
  )
    fail();
  const parents = packages
    .flatMap((pkg) => [pkg.package_manifest, pkg.package_tarball, pkg.package_sbom])
    .map(opaqueIdentity)
    .sort((a, b) => utf8Compare(artifactProjectionKey(a), artifactProjectionKey(b)));
  const providerSizes = packages.map((pkg) => opaqueIdentity(pkg.provider_result).size_bytes);
  // Bounds derive from the already-pinned artifact sizes, never from embedded transcript text.
  // The protected reader/host separately imposes its absolute storage/transport limits.
  const legacyLimits = {
    maximum_transcript_bytes: Math.max(...providerSizes),
    maximum_provider_result_bytes: Math.max(...providerSizes),
    maximum_packages: packages.length,
  };
  const limits = current ? (exportLimits ?? fail()) : legacyLimits;
  if (providerSizes.some((size) => size > limits.maximum_provider_result_bytes)) fail();
  const { export_spec_digest_sha256, closure_inputs } = binding;
  const transcriptBinding = {
    action_id: binding.action_id,
    repository: binding.repository,
    candidate: binding.candidate,
    plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
    parent_artifact_sink: binding.parent_artifact_sink,
    sink_id: binding.sink_id,
    destination: binding.destination,
    trust: binding.trust,
    attempt_id: binding.attempt_id,
  };
  if (export_spec_digest_sha256 !== specDigest) fail();
  const commonTranscript = {
    version: RELEASE_EXPORT_TRANSCRIPT_FORMAT,
    binding: transcriptBinding,
    parent: parents,
    closures: packages.map((pkg, index) => {
      const closure = closure_inputs[index];
      const evidence = opaqueIdentity(pkg.evidence_manifest);
      if (
        closure === undefined ||
        !same(pkg.trust, binding.trust) ||
        !same(closure, {
          package_id: pkg.package_id,
          ...(current
            ? {
                release_unit:
                  state.release_units.find((unit) =>
                    unit.packages.some((entry) => entry.package_id === pkg.package_id),
                  )?.release_unit ?? fail(),
              }
            : {}),
          sha256: evidence.sha256,
          size_bytes: evidence.size_bytes,
          expected_installed_package: closure.expected_installed_package,
          policy_resolution_digest_sha256: closure.policy_resolution_digest_sha256,
        })
      )
        return fail();
      return {
        package_id: pkg.package_id,
        evidence_manifest: evidence,
        expected_installed_package: closure.expected_installed_package,
        policy_resolution_digest_sha256: closure.policy_resolution_digest_sha256,
      };
    }),
    destination: binding.destination,
    trust: binding.trust,
  };
  let transcript: Buffer;
  if (current) {
    if (!('mutation_units' in binding)) return fail();
    const units: ReleaseExportMutationUnitProjection[] = state.release_units
      .map((unit) => {
        const closure = unit.mutation_evidence;
        if (closure == null) return { release_unit: unit.release_unit, mutation_evidence: null };
        const {
          member_projection_digest_sha256,
          output_contract_digest_sha256: _control,
          ...unitBinding
        } = closure.receipt.referent;
        const closureBytes = Buffer.from(canonicalJson(closure));
        const receiptBytes = Buffer.from(canonicalJson(closure.receipt));
        return {
          release_unit: unit.release_unit,
          mutation_evidence: {
            carrier_package_id:
              unit.packages.map((pkg) => pkg.package_id).sort(utf8Compare)[0] ?? fail(),
            binding: unitBinding,
            closure: { sha256: sha256(closureBytes), size_bytes: closureBytes.length },
            receipt: {
              sha256: sha256(receiptBytes),
              size_bytes: receiptBytes.length,
              receipt_digest_sha256: closure.receipt.receipt_digest_sha256,
            },
            output_contract: closure.output_contract,
            members: closure.members,
            member_projection_digest_sha256,
          },
        };
      })
      .sort((a, b) => utf8Compare(a.release_unit, b.release_unit));
    if (!same(units, binding.mutation_units)) fail();
    const shared = {
      ...commonTranscript,
      mutation_units: units,
      closures: commonTranscript.closures.map((entry) => ({
        ...entry,
        release_unit:
          state.release_units.find((unit) =>
            unit.packages.some((pkg) => pkg.package_id === entry.package_id),
          )?.release_unit ?? fail(),
      })),
    };
    transcript = forward
      ? encodeReleaseExportTranscriptV3(
          {
            ...shared,
            version: RELEASE_EXPORT_TRANSCRIPT_V3_FORMAT,
            certification_units:
              'certification_units' in binding ? binding.certification_units : fail(),
          },
          limits,
        )
      : encodeReleaseExportTranscriptV2(
          { ...shared, version: RELEASE_EXPORT_TRANSCRIPT_V2_FORMAT },
          limits,
        );
  } else {
    if ('mutation_units' in binding) fail();
    transcript = encodeReleaseExportTranscript(
      { ...commonTranscript, version: RELEASE_EXPORT_TRANSCRIPT_FORMAT },
      limits,
    );
  }
  // Transcript validation above closes every parent identity before it reaches the reader.
  if (
    observed.has(parent.committed_manifest_handle) ||
    observed.has(sink.committed_manifest_handle)
  )
    fail();
  const parentBytes = await verifyReceiptBytes(
    reader,
    {
      sink_id: parent.sink_id,
      opaque_handle: parent.committed_manifest_handle,
      sha256: parent.committed_manifest_sha256,
      size_bytes: parent.committed_manifest_size_bytes,
    },
    'release-downstream-artifact-reverification-failed',
  );
  if (
    !same(parse(parentBytes), {
      schemaVersion: '1.0.0',
      kind: 'release-artifact-sink-commit-manifest',
      sink_id: parent.sink_id,
      transaction_handle: parent.transaction_handle,
      repository: state.repository,
      candidate: exported.candidate,
      pack_spec_id: RELEASE_PACK_SPEC_ID,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      artifacts: parents,
    })
  )
    fail();
  for (const unit of state.release_units) {
    for (const pkg of unit.packages) {
      const identity = opaqueIdentity(pkg.package_manifest);
      const value = observed.get(identity.opaque_handle);
      if (value === undefined) return fail();
      verifyPreparedPackageManifest({
        bytes: value,
        package: pkg,
        version: unit.version,
        candidate: exported.candidate,
      });
    }
  }
  let signature: string | undefined;
  for (const pkg of packages) {
    const identity = opaqueIdentity(pkg.provider_result);
    const value = observed.get(identity.opaque_handle);
    if (value === undefined) return fail();
    const result = parse(value);
    if (typeof result['signature'] !== 'string') fail();
    signature ??= result['signature'] as string;
    (forward
      ? verifyReleaseExportProviderResultV3
      : current
        ? verifyReleaseExportProviderResultV2
        : verifyReleaseExportProviderResult)(
      value,
      { package_id: pkg.package_id, transcript, signature },
      limits,
    );
  }
  if (current)
    (forward ? verifyReleaseExportProviderResultSetV3 : verifyReleaseExportProviderResultSetV2)(
      packages.map(
        (pkg) => observed.get(opaqueIdentity(pkg.provider_result).opaque_handle) ?? fail(),
      ),
      { transcript, signature: signature ?? fail() },
      limits,
    );
}

export async function reverifySinkArtifacts(
  state: ReleaseLifecycleStateV2,
  reader: TrustedArtifactReader | undefined,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  const protectedExportLimits =
    exportLimits === undefined ? undefined : captureReleaseExportTranscriptLimits(exportLimits);
  if (state.schemaVersion !== '2.1.0') return;
  const sink = state.artifact_sink;
  if (reader === undefined || sink === undefined || sink === null) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const manifestBytes = await verifyReceiptBytes(
    reader,
    {
      sink_id: sink.sink_id,
      opaque_handle: sink.committed_manifest_handle,
      sha256: sink.committed_manifest_sha256,
      size_bytes: sink.committed_manifest_size_bytes,
    },
    'release-downstream-artifact-reverification-failed',
  );
  let commitManifest: Readonly<Record<string, unknown>>;
  try {
    commitManifest = object(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  } catch {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const members = commitManifest['artifacts'];
  const isExport = ['exported', 'evidence_published', 'publication_dispatched'].includes(
    state.state,
  );
  if (
    isExport &&
    commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
    protectedExportLimits === undefined
  )
    throw new Error('release-downstream-artifact-reverification-failed');
  if (
    commitManifest['schemaVersion'] !== '1.0.0' ||
    commitManifest['kind'] !== 'release-artifact-sink-commit-manifest' ||
    commitManifest['sink_id'] !== sink.sink_id ||
    commitManifest['transaction_handle'] !== sink.transaction_handle ||
    (isExport
      ? !(
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_DIGEST) ||
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V3_DIGEST) ||
          (commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V4_ID &&
            commitManifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V4_DIGEST)
        )
      : commitManifest['pack_spec_id'] !== RELEASE_PACK_SPEC_ID ||
        commitManifest['pack_spec_digest_sha256'] !== RELEASE_PACK_SPEC_DIGEST) ||
    !same(commitManifest['repository'], state.repository) ||
    !same(commitManifest['candidate'], {
      commit: state.candidate.commit,
      tree: state.candidate.tree,
    }) ||
    !Array.isArray(members)
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const expected = (state['artifacts'] as readonly unknown[]).map(opaqueIdentity);
  const normalizedMembers = members.map(opaqueIdentity);
  const sortedExpected = [...expected].sort((left, right) =>
    utf8Compare(artifactProjectionKey(left), artifactProjectionKey(right)),
  );
  const packageProjection = state.release_units.flatMap((unit) =>
    unit.packages.flatMap((pkg) =>
      [
        ['package-manifest', pkg.package_manifest],
        ['package-tarball', pkg.package_tarball],
        ['package-sbom', pkg.package_sbom],
        ['evidence-manifest', pkg.evidence_manifest],
        ['provider-result', pkg.provider_result],
      ].flatMap(([expectedKind, identity]) => {
        if (identity === null || identity === undefined) {
          if (isExport) throw new Error('release-downstream-artifact-reverification-failed');
          return [];
        }
        const normalized = opaqueIdentity(identity);
        if (normalized.kind !== expectedKind || normalized.sink_id !== sink.sink_id) {
          throw new Error('release-downstream-artifact-reverification-failed');
        }
        return [normalized];
      }),
    ),
  );
  const sortedPackageProjection = [...packageProjection].sort((left, right) =>
    utf8Compare(artifactProjectionKey(left), artifactProjectionKey(right)),
  );
  if (
    new Set(expected.map(artifactProjectionKey)).size !== expected.length ||
    new Set(expected.map((artifact) => artifact.opaque_handle)).size !== expected.length ||
    expected.some((artifact) => artifact.opaque_handle === sink.committed_manifest_handle) ||
    (!isExport &&
      expected.some((artifact) =>
        ['evidence-manifest', 'provider-result'].includes(artifact.kind),
      )) ||
    expected.some((artifact) => artifact.sink_id !== sink.sink_id) ||
    !same(expected, sortedExpected) ||
    !same(normalizedMembers, expected) ||
    !same(sortedPackageProjection, expected)
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  const observed = new Map<string, Buffer>();
  for (const identity of expected) {
    if (
      isExport &&
      commitManifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
      identity.kind === 'provider-result' &&
      (protectedExportLimits === undefined ||
        identity.size_bytes > protectedExportLimits.maximum_provider_result_bytes)
    )
      throw new Error('release-downstream-artifact-reverification-failed');
    if (identity.sink_id !== sink.sink_id) {
      throw new Error('release-downstream-artifact-reverification-failed');
    }
    const verified = await verifyReceiptBytes(
      reader,
      identity,
      'release-downstream-artifact-reverification-failed',
    );
    // Hash large parent tarballs/closures independently; retain only small manifests/results
    // for the subsequent package association and aggregate transcript continuity checks.
    if (isExport && ['package-manifest', 'provider-result'].includes(identity.kind))
      observed.set(identity.opaque_handle, verified);
  }
  if (isExport) {
    try {
      await reverifyExportContinuity(
        state,
        commitManifest,
        manifestBytes,
        reader,
        observed,
        protectedExportLimits,
      );
    } catch {
      throw new Error('release-downstream-artifact-reverification-failed');
    }
  }
}

/** Full profile/roster semantics after authenticated export continuity. Reads only bundle artifacts. */
export async function verifyPortableReleaseMutationEvidence(
  request: ReleaseLifecycleRequest,
  state: ReleaseLifecycleStateV2,
  reader: TrustedArtifactReader | undefined,
  plan: ReleaseMutationPlanReaders,
  exportLimits?: ReleaseExportTranscriptLimits,
): Promise<void> {
  const fail = (): never => {
    throw new Error('release-certification-generated-output-untrusted');
  };
  const material = {
    release_units: state.release_units,
    inputs: state['inputs'] as ReleaseStateMaterial['inputs'],
  };
  const requirements = resolveReleaseMutationRequirements(request, plan);
  if (state.schemaVersion !== '2.1.0') {
    if (requirements.some((unit) => unit.binding !== null)) fail();
    return;
  }
  if (reader === undefined || state.artifact_sink == null) return fail();
  const commit = state.artifact_sink;
  const manifestBytes = await verifyReceiptBytes(
    reader,
    {
      sink_id: commit.sink_id,
      opaque_handle: commit.committed_manifest_handle,
      sha256: commit.committed_manifest_sha256,
      size_bytes: commit.committed_manifest_size_bytes,
    },
    'release-certification-generated-output-untrusted',
  );
  const manifest = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
  );
  if (
    manifest['export_spec_id'] === RELEASE_EXPORT_SPEC_ID &&
    manifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_DIGEST
  ) {
    // Exact historical read branch: optional metadata continuity is not mutation verification.
    if (requirements.some((unit) => unit.binding !== null)) fail();
    return;
  }
  if (!(
    (manifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V3_ID &&
      manifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V3_DIGEST) ||
    (manifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V4_ID &&
      manifest['export_spec_digest_sha256'] === RELEASE_EXPORT_SPEC_V4_DIGEST)
  ))
    fail();
  if (requirements.every((unit) => unit.binding === null)) {
    await verifyCertificationMutationEvidence(request, material, {}, plan);
    return;
  }
  if (reader === undefined || exportLimits === undefined) return fail();
  const limits = captureReleaseExportTranscriptLimits(exportLimits);
  const packages = state.release_units.flatMap((unit) => unit.packages);
  if (packages.length === 0 || packages.length > limits.maximum_packages) return fail();
  const raw: Buffer[] = [];
  for (const pkg of packages) {
    const identity = opaqueIdentity(pkg.provider_result);
    if (identity.size_bytes > limits.maximum_provider_result_bytes) fail();
    raw.push(
      await verifyReceiptBytes(
        reader,
        identity,
        'release-certification-generated-output-untrusted',
      ),
    );
  }
  const first = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw[0] ?? fail())),
  );
  if (typeof first['transcript'] !== 'string' || typeof first['signature'] !== 'string')
    return fail();
  const results = (
    manifest['export_spec_id'] === RELEASE_EXPORT_SPEC_V4_ID
      ? verifyReleaseExportProviderResultSetV3
      : verifyReleaseExportProviderResultSetV2
  )(raw, { transcript: Buffer.from(first['transcript']), signature: first['signature'] }, limits);
  const units = new Map<string, NonNullable<ReleaseExportProviderResultV2['mutation_evidence']>>();
  for (const [index, result] of results.entries()) {
    if (result.package_id !== packages[index]?.package_id) fail();
    if (result.mutation_evidence === null) continue;
    if (units.has(result.release_unit)) fail();
    units.set(result.release_unit, result.mutation_evidence);
  }
  // Decoding follows strict codec validation of the complete set and its protected byte budgets.
  // Paths/handles below are only map keys; no original mutation source is available here.
  const decoded = new Map(
    [...units].map(([unit, portable]) => [
      unit,
      {
        closure: JSON.parse(
          Buffer.from(portable.closure.bytes_base64, 'base64').toString('utf8'),
        ) as import('./release-unit-mutation-evidence.js').ReleaseUnitMutationEvidenceClosure,
        receipt: JSON.parse(
          Buffer.from(portable.receipt.bytes_base64, 'base64').toString('utf8'),
        ) as import('./release-unit-mutation-evidence.js').UnitMutationEvidenceReceipt,
        documents: new Map(
          [portable.output_contract, ...portable.members].map((doc) => [
            doc.path,
            Buffer.from(doc.bytes_base64, 'base64'),
          ]),
        ),
      },
    ]),
  );
  await verifyCertificationMutationEvidence(
    request,
    material,
    {
      unit_mutation_maximum_bytes: limits.maximum_provider_result_bytes,
      readUnitMutationEvidenceClosure(binding) {
        return decoded.get(binding.release_unit)?.closure ?? fail();
      },
      readUnitMutationEvidenceReceipt(identity) {
        const matches = [...decoded.values()].filter(
          (unit) =>
            unit.closure.output_contract.evidence_sink_id === identity.evidence_sink_id &&
            unit.receipt.receipt_digest_sha256 === identity.receipt_digest_sha256,
        );
        if (matches.length !== 1) return fail();
        return matches[0]?.receipt ?? fail();
      },
      readUnitMutationEvidenceBlob(input) {
        return Buffer.from(
          decoded.get(input.binding.release_unit)?.documents.get(input.identity.path) ?? fail(),
        );
      },
    },
    plan,
  );
}
