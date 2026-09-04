/**
 * External operator prerequisite, not a DEVAI action or candidate-selected adapter.
 * Execute the assembled copy in dist/runtime/host. This tool, its bootstrap seed,
 * Node and the supplied tar executable are independently approved host controls.
 * It grants no lifecycle, evidence, signing or publication authority.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapReleaseHost, verifyReleaseHostArchive } from '../index/release-host-bootstrap.js';

const INVALID = 'release-host-provisioning-invalid';
const DIGEST = /^[a-f0-9]{64}$/u;
const fail = () => {
  throw new Error(INVALID);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const closed = (value, keys) => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    fail();
};
const bounded = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) fail();
};
const sameStat = (left, right) =>
  ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].every(
    (key) => left[key] === right[key],
  );

function readPinned(path, maximum) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  bounded(maximum);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) fail();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameStat(before, fstatSync(descriptor, { bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail();
      offset += count;
    }
    if (
      readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      !sameStat(before, fstatSync(descriptor, { bigint: true })) ||
      !sameStat(before, lstatSync(path, { bigint: true }))
    )
      fail();
    return { bytes, metadata: before };
  } finally {
    closeSync(descriptor);
  }
}

function privateExternalParent(locator) {
  if (typeof locator !== 'string' || !isAbsolute(locator)) fail();
  const parent = realpathSync(locator);
  const metadata = lstatSync(parent, { bigint: true });
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077n) !== 0n ||
    typeof process.getuid !== 'function' ||
    metadata.uid !== BigInt(process.getuid())
  )
    fail();
  // Both normal Git checkouts and linked worktrees have an ancestor .git entry.
  // No candidate repository is a valid operator installation destination.
  for (let current = parent; ; current = dirname(current)) {
    try {
      lstatSync(join(current, '.git'));
      fail();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
  return { parent, metadata };
}

/**
 * All arguments are supplied by the trusted operator, never a release request.
 * The existing pnpm/npm installation is only a possible trusted bootstrap seed:
 * it is never normalized, pruned, relabelled, or used as the checked runtime root.
 * This function always creates a fresh private root and retains it on failure.
 * Like the bootstrap collector, path/stat checks detect races but are not native
 * openat containment. The parent and executable remain operator-owned controls.
 */
export async function provisionReleaseHostPackage(controls) {
  let retainedRoot;
  try {
    closed(controls, ['archive_path', 'expected', 'destination_parent', 'tar', 'limits']);
    closed(controls.tar, ['executable', 'sha256', 'maximum_executable_bytes']);
    closed(controls.limits, [
      'maximum_archive_bytes',
      'maximum_unpacked_bytes',
      'maximum_entries',
      'maximum_depth',
      'timeout_ms',
    ]);
    for (const value of Object.values(controls.limits)) bounded(value);
    if (!DIGEST.test(controls.tar.sha256)) fail();
    const deadline = Date.now() + controls.limits.timeout_ms;
    const source = readPinned(controls.archive_path, controls.limits.maximum_archive_bytes);
    const { timeout_ms: _timeout, ...limits } = controls.limits;
    const archive = verifyReleaseHostArchive({
      expected: controls.expected,
      archive: source.bytes,
      ...limits,
    });
    if (typeof controls.tar.executable !== 'string' || !isAbsolute(controls.tar.executable)) fail();
    const executable = realpathSync(controls.tar.executable);
    const tool = readPinned(executable, controls.tar.maximum_executable_bytes);
    if (hash(tool.bytes) !== controls.tar.sha256 || (tool.metadata.mode & 0o111n) === 0n) fail();
    const destination = privateExternalParent(controls.destination_parent);
    // All archive structure, identities, tool and destination checks precede writes.
    if (Date.now() >= deadline) fail();
    if (!sameStat(destination.metadata, lstatSync(destination.parent, { bigint: true }))) fail();
    retainedRoot = mkdtempSync(join(destination.parent, 'devai-host-'));
    if (!sameStat(tool.metadata, lstatSync(executable, { bigint: true }))) fail();
    const extracted = spawnSync(
      executable,
      ['-x', '-p', '-k', '--no-same-owner', '--strip-components=1', '-f', '-', '-C', retainedRoot],
      {
        input: archive.readTar(),
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        shell: false,
        timeout: Math.max(1, deadline - Date.now()),
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (
      extracted.status !== 0 ||
      extracted.signal !== null ||
      extracted.error !== undefined ||
      Date.now() >= deadline ||
      !sameStat(tool.metadata, lstatSync(executable, { bigint: true }))
    )
      fail();
    privateExternalParent(retainedRoot);
    const host = await bootstrapReleaseHost({
      package_root: retainedRoot,
      expected: archive.identity,
      archive: archive.readArchive(),
      ...limits,
    });
    if (Date.now() >= deadline) fail();
    return Object.freeze({ package_root: retainedRoot, host });
  } catch {
    const error = new Error(INVALID);
    // Operator diagnostics only, never a portable receipt or evidence identity.
    if (retainedRoot !== undefined) error.retained_root = retainedRoot;
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3) fail();
    const controls = JSON.parse(
      readPinned(resolve(process.argv[2]), 1024 * 1024).bytes.toString('utf8'),
    );
    const result = await provisionReleaseHostPackage(controls);
    process.stdout.write(`${JSON.stringify({ package_root: result.package_root })}\n`);
  } catch (error) {
    process.stderr.write(`${INVALID}\n`);
    if (error.retained_root !== undefined)
      process.stderr.write(`Host installation retained: ${error.retained_root}\n`);
    process.exitCode = 1;
  }
}
