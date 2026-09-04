import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeContainerArchive } from '../../packages/cli/dist/services/container-archive.js';

// Independent verification of docker image save bytes; never extracts a layer on the host.
// Source-only prerequisite: pnpm exec tsc -b packages/cli/tsconfig.json --force
// Usage: node verify-toolchain-image.mjs ABS_ARCHIVE sha256:MANIFEST ABS_REPORT
const [archivePath, image, reportPath] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !isAbsolute(archivePath ?? '') ||
  !isAbsolute(reportPath ?? '') ||
  !/^sha256:[0-9a-f]{64}$/u.test(image ?? '')
)
  throw new Error('DEVAI_TOOLCHAIN_VERIFICATION_ARGUMENTS_INVALID');
const maximumBytes = 1024 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = readFileSync(archivePath);
const entries = new Map(
  decodeContainerArchive(archive, maximumBytes).map((entry) => [entry.path, entry.bytes]),
);
const json = (name) => JSON.parse(entries.get(name));
const blob = (descriptor) => {
  if (!/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size))
    throw new Error('DEVAI_TOOLCHAIN_DESCRIPTOR_INVALID');
  const bytes = entries.get(`blobs/${descriptor.digest.replace(':', '/')}`);
  if (!bytes || hash(bytes) !== descriptor.digest.slice(7) || bytes.length !== descriptor.size)
    throw new Error('DEVAI_TOOLCHAIN_BLOB_MISMATCH');
  return bytes;
};
const index = json('index.json');
const descriptor = index.manifests?.find((entry) => entry.digest === image);
if (index.schemaVersion !== 2 || !descriptor) throw new Error('DEVAI_TOOLCHAIN_IMAGE_NOT_EXPORTED');
const manifest = JSON.parse(blob(descriptor));
if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers))
  throw new Error('DEVAI_TOOLCHAIN_MANIFEST_INVALID');
const configuration = JSON.parse(blob(manifest.config));
if (
  configuration.os !== 'linux' ||
  configuration.architecture !== 'arm64' ||
  configuration.rootfs?.type !== 'layers' ||
  configuration.rootfs.diff_ids.length !== manifest.layers.length
)
  throw new Error('DEVAI_TOOLCHAIN_PLATFORM_INVALID');
const layers = manifest.layers.map((layer, index) => {
  const compressed = blob(layer);
  if (
    ![
      'application/vnd.docker.image.rootfs.diff.tar.gzip',
      'application/vnd.oci.image.layer.v1.tar+gzip',
    ].includes(layer.mediaType)
  )
    throw new Error('DEVAI_TOOLCHAIN_LAYER_ENCODING_UNSUPPORTED');
  const raw = gunzipSync(compressed, { maxOutputLength: maximumBytes });
  const diff = `sha256:${hash(raw)}`;
  if (configuration.rootfs.diff_ids[index] !== diff)
    throw new Error('DEVAI_TOOLCHAIN_LAYER_MISMATCH');
  return {
    digest: layer.digest,
    size_bytes: compressed.length,
    diff_id: diff,
    uncompressed_size_bytes: raw.length,
  };
});
const report = {
  protocol: 'devai.protected-toolchain-image.v1',
  image,
  archive_sha256: hash(archive),
  platform: 'linux/arm64',
  local_image: {
    configuration_sha256: manifest.config.digest.slice(7),
    rootfs_diff_ids: configuration.rootfs.diff_ids,
  },
  layers,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
