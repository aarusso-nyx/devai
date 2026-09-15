import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => {
  throw new Error('DEVAI_NPM_CACHE_INVALID');
};
function readRegular(path, maximumBytes) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maximumBytes) fail();
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail();
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

// An explicit operator input, never a candidate-selected download or credential.
// Verify the entire pinned population before adding it to dependency transport.
export function readPinnedNpmCache(control, repository, maximumBytes = 64 * 1024 * 1024) {
  if (control === undefined) return undefined;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) fail();
  const external = (path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || realpathSync(path) !== path) fail();
    const suffix = relative(realpathSync(repository), path);
    if (!(suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))) fail();
  };
  external(control.directory);
  external(control.manifest);
  if (!lstatSync(control.directory).isDirectory() || !lstatSync(control.manifest).isFile()) fail();
  const manifestBytes = readRegular(control.manifest, 4 * 1024 * 1024);
  if (manifestBytes.length > 4 * 1024 * 1024 || hash(manifestBytes) !== control.manifest_sha256)
    fail();
  const manifest = JSON.parse(manifestBytes);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 10000
  )
    fail();
  const actual = [];
  const walk = (directory, prefix = '', depth = 0) => {
    if (depth > 32 || actual.length > 10000) fail();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name),
        relativePath = prefix + name,
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) walk(path, relativePath + '/', depth + 1);
      else if (stat.isFile()) actual.push(relativePath);
      else fail();
    }
  };
  walk(control.directory);
  const expected = manifest.files.map((entry) => entry.path);
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort())
  )
    fail();
  let total = 0;
  const entries = manifest.files.map((entry) => {
    if (
      typeof entry.path !== 'string' ||
      !/^[A-Za-z0-9_./-]+$/u.test(entry.path) ||
      entry.path.split('/').some((part) => ['', '.', '..'].includes(part)) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      fail();
    total += entry.size;
    if (total > maximumBytes) fail();
    const path = join(control.directory, entry.path);
    if (lstatSync(path).size !== entry.size) fail();
    const bytes = readRegular(path, entry.size);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) fail();
    return { path: `.devai-npm-cache/${entry.path}`, mode: '100644', bytes };
  });
  return { entries, manifest_sha256: control.manifest_sha256 };
}
