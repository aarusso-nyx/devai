import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
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
} from './release-lifecycle-execution.js';

export const RELEASE_PACK_SPEC_ID = 'devai.pure-npm-compatible-pack.v3';
export const RELEASE_PACK_SPEC_CANONICAL_BYTES =
  'devai.pure-npm-compatible-pack.v3\nselection=only-certification-package-entry-manifest.entries;exact-set;no-npmignore-no-gitignore-no-files-field-no-default-additions\nentry-order=utf-8-byte-ascending-by-entry.path;duplicate-paths-refuse\narchive-path=package/<entry.path>;utf-8;no-backslash;maximum-100-bytes;no-pax\nentry-types=regular-only;directories-symlinks-hardlinks-device-fifo-pax-global-pax-refuse\nmodes=100644-or-100755-only\nsize=0..8589934591-decimal-bytes\ntar=format-ustar;block=512;name=archive-path;mode=entry.mode;uid=0;gid=0;size=entry.size_bytes;mtime=0;typeflag=0;linkname=empty;magic=ustar\\0;version=00;uname=empty;gname=empty;devmajor=0;devminor=0;prefix=empty\nnumeric-fields=ascii-octal-zero-padded-with-terminal-nul;checksum=unsigned-byte-sum-with-checksum-field-eight-ascii-spaces;payload-padding=zero-to-next-512;end=two-zero-512-blocks\ngzip=header-id1-31-id2-139-cm-8-flg-0-mtime-0-xfl-0-os-255;deflate=stored-blocks-only;block-rule=greedy-consecutive-65535-byte-blocks-in-tar-order-plus-one-final-remainder-block;BFINAL=1-only-on-final-block;empty-tar-stream=one-zero-length-stored-block-with-BFINAL-1;trailer=crc32-ieee-little-endian-plus-isize-mod-2^32-little-endian\nsbom=spdx-json-2.3;utf-8-rfc8785-jcs;spdxVersion=SPDX-2.3;dataLicense=CC0-1.0;SPDXID=SPDXRef-DOCUMENT;name=<package_id>@<package_version>;documentNamespace=https://devai.nyxk.com.br/spdx/<candidate.commit>/<package_id>;creationInfo.created=1970-01-01T00:00:00Z;creationInfo.creators=[Tool: devai.pure-npm-compatible-pack.v3];creationInfo.optionalFields=comment-licenseListVersion=absent;documentDescribes=[SPDXRef-Package];document.optionalFields=comment-externalDocumentRefs-annotations-hasExtractedLicensingInfos-revieweds-snippets=absent;packages=[SPDXRef-Package];package.name=<package_id>@<package_version>;package.SPDXID=SPDXRef-Package;package.downloadLocation=NOASSERTION;package.filesAnalyzed=true;package.packageVerificationCode.value=lowercase-hex(SHA1(utf8-concatenation-of-each-file-raw-byte-SHA1-lowercase-hex-sorted-ascending-lexicographically-by-checksum-value));package.packageVerificationCode.excludedFiles=absent;package.licenseConcluded=NOASSERTION;package.licenseDeclared=NOASSERTION;package.copyrightText=NOASSERTION;package.supplier=NOASSERTION;package.originator=NOASSERTION;package.optionalFields=absent\nfiles=entries-in-entry-order;file.SPDXID=SPDXRef-File-<lowercase-sha256-of-utf8-archive-path>;file.fileName=archive-path;file.checksums=[SHA1:lowercase-raw-byte-sha1,SHA256:lowercase-entry.sha256];file.licenseConcluded=NOASSERTION;file.licenseInfoInFiles=[NOASSERTION];file.copyrightText=NOASSERTION;file.optionalFields=absent\nrelationships=document-DESCRIBES-package-then-package-CONTAINS-file-in-entry-order;annotations-externalRefs-extractedLicensingInfos=absent\n';
export const RELEASE_PACK_SPEC_DIGEST =
  'd287db048eb09efaea20c7e4d6b8b721d34e08eb05b6cbc7f19fba4c666917bd';

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

export interface ImmutableReleaseContentSource {
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

function tarHeader(path: string, mode: number, size: number): Buffer {
  if (!safeRelativePath(path) || Buffer.byteLength(path, 'utf8') > 100) {
    throw new Error('release-prepare-unsupported-package-semantics');
  }
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
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
  source: ImmutableReleaseContentSource,
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
): Promise<void> {
  const expected = request.candidate_locator.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.package_roster.map((pkg) => pkg.package_id),
  }));
  const observed = material.release_units.map((unit) => ({
    release_unit: unit.release_unit,
    version: unit.version,
    packages: unit.packages.map((pkg) => pkg.package_id),
  }));
  if (!same(expected, observed)) throw new Error('release-certification-output-closure-invalid');
  for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
    for (const packageIndex of unit.package_roster.keys()) {
      await verifyPackage(source, request, material, unitIndex, packageIndex);
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

async function abort(transaction: TrustedArtifactSinkTransaction): Promise<void> {
  try {
    await transaction.abort();
  } catch {
    throw new Error('release-artifact-sink-abort-failed');
  }
}

export function createReleasePrepareProvider(input: {
  readonly certified_state: ReleaseLifecycleStateV2;
  readonly content_source: ImmutableReleaseContentSource;
  readonly artifact_sink: TrustedArtifactSink;
}): ReleaseProvider {
  return async (request): Promise<ReleaseProviderResult> => {
    if (
      input.artifact_sink === undefined ||
      input.artifact_sink === null ||
      typeof input.artifact_sink.begin !== 'function'
    ) {
      return { outcome: 'failure', code: 'release-artifact-sink-unavailable' };
    }
    if (
      input.certified_state.state !== 'certified' ||
      !same(input.certified_state.repository, request.repository_locator) ||
      input.certified_state.candidate.commit !== request.candidate_locator.commit ||
      input.certified_state.candidate.tree !== request.candidate_locator.tree
    ) {
      return { outcome: 'failure', code: 'release-prepare-certification-manifest-invalid' };
    }
    let transaction: TrustedArtifactSinkTransaction | undefined;
    let committed = false;
    try {
      if (sha256(RELEASE_PACK_SPEC_CANONICAL_BYTES) !== RELEASE_PACK_SPEC_DIGEST) {
        throw new Error('release-prepare-pack-spec-digest-mismatch');
      }
      const verified: VerifiedPackage[] = [];
      for (const [unitIndex, unit] of request.candidate_locator.release_units.entries()) {
        for (const packageIndex of unit.package_roster.keys()) {
          verified.push(
            await verifyPackage(
              input.content_source,
              request,
              input.certified_state,
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
      const releaseUnits = request.candidate_locator.release_units.map((unit) => ({
        release_unit: unit.release_unit,
        version: unit.version,
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
        inputs: input.certified_state['inputs'] as ReleaseStateMaterial['inputs'],
        evidence: {
          manifest_digest_sha256: commitManifestReceipt.sha256,
          receipt_digests: [
            ...(input.certified_state['evidence'] as ReleaseStateMaterial['evidence'])
              .receipt_digests,
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

export async function reverifySinkArtifacts(
  state: ReleaseLifecycleStateV2,
  reader: TrustedArtifactReader | undefined,
): Promise<void> {
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
  if (
    commitManifest['schemaVersion'] !== '1.0.0' ||
    commitManifest['kind'] !== 'release-artifact-sink-commit-manifest' ||
    commitManifest['sink_id'] !== sink.sink_id ||
    commitManifest['transaction_handle'] !== sink.transaction_handle ||
    commitManifest['pack_spec_id'] !== RELEASE_PACK_SPEC_ID ||
    commitManifest['pack_spec_digest_sha256'] !== RELEASE_PACK_SPEC_DIGEST ||
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
        if (identity === null || identity === undefined) return [];
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
    expected.some((artifact) => artifact.sink_id !== sink.sink_id) ||
    !same(expected, sortedExpected) ||
    !same(normalizedMembers, expected) ||
    !same(sortedPackageProjection, expected)
  ) {
    throw new Error('release-downstream-artifact-reverification-failed');
  }
  for (const identity of expected) {
    if (identity.sink_id !== sink.sink_id) {
      throw new Error('release-downstream-artifact-reverification-failed');
    }
    await verifyReceiptBytes(reader, identity, 'release-downstream-artifact-reverification-failed');
  }
}
