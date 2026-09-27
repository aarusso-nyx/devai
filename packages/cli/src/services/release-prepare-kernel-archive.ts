import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import {
  safeRelativePath,
  type VerifiedPackage,
  sha256,
  type ArtifactSinkObject,
  RELEASE_PACK_SPEC_ID,
  RELEASE_PACK_SPEC_DIGEST,
  type PackedPackage,
} from './release-prepare-kernel-contract.js';

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

export function tar(entries: VerifiedPackage['entries']): Buffer {
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
  if (fullBlocks > bytes.byteLength) {
    throw new Error('release-prepare-invalid-deflate-block-count');
  }
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

export function deterministicGzip(bytes: Buffer): Buffer {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.byteLength >>> 0, 4);
  return Buffer.concat([header, storedDeflate(bytes), trailer]);
}

export function sinkObject(
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

export function spdxBytes(value: VerifiedPackage): Buffer {
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

export function packPackage(value: VerifiedPackage): PackedPackage {
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
