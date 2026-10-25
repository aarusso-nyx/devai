import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import { provisionBytesSha } from './reconciliation-host-namespace.js';

export interface ReconciliationPhaseOutput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface ReconciliationPhaseOwned {
  readonly target: string;
  readonly dev: string;
  readonly ino: string;
  readonly birthtime_ns: string;
}
export function reconciliationOwned(stat: BigIntStats, target: string): ReconciliationPhaseOwned {
  return Object.freeze({
    target,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
  });
}
function stamp(stat: BigIntStats) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
    size: String(stat.size),
    mode: String(stat.mode),
    uid: String(stat.uid),
    ctime_ns: String(stat.ctimeNs),
    mtime_ns: String(stat.mtimeNs),
    nlink: String(stat.nlink),
  };
}
function fail(): never {
  throw new Error('RECONCILIATION_PHASE_STALE');
}

/** Bounded, stable, no-follow observation only. The expected digest grants no write authority. */
export function readReconciliationDomainFile(
  path: string,
  expected?: Pick<ReconciliationPhaseOutput, 'sha256' | 'bytes'>,
  durable = false,
  privateMode = true,
) {
  if (realpathSync(dirname(path)) !== dirname(path)) fail();
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(process.geteuid?.() ?? -1) ||
    (before.mode & 0o022n) !== 0n ||
    (privateMode && (before.mode & 0o7777n) !== 0o600n) ||
    before.size < 0n ||
    before.size > 33554432n ||
    (expected && before.size !== BigInt(expected.bytes))
  )
    fail();
  const witness = stamp(before),
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (canonicalJson(stamp(fstatSync(fd, { bigint: true }))) !== canonicalJson(witness)) fail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      (expected && provisionBytesSha(bytes) !== expected.sha256)
    )
      fail();
    if (durable) fsyncSync(fd);
    if (
      canonicalJson(stamp(fstatSync(fd, { bigint: true }))) !== canonicalJson(witness) ||
      canonicalJson(stamp(lstatSync(path, { bigint: true }))) !== canonicalJson(witness)
    )
      fail();
    return Object.freeze({
      bytes,
      sha256: provisionBytesSha(bytes),
      witness: Object.freeze(witness),
      identity: reconciliationOwned(before, path),
    });
  } finally {
    closeSync(fd);
  }
}
export function reconciliationPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Fixed recipe sibling derivation, never a caller-selected effect target. */
export function reconciliationScratch(
  seed: Uint8Array,
  target: string,
  settlement = false,
): string {
  const bytes = createHash('sha256')
    .update(
      canonicalJson({
        domain: settlement
          ? 'devai.reconciliation.settlement-scratch.v1'
          : 'devai.reconciliation.phase-scratch.v1',
        ...(settlement
          ? { completion_sha256: provisionBytesSha(seed) }
          : { lease_sha256: provisionBytesSha(seed) }),
        target,
        purpose: settlement ? 'private-completion-publication' : 'publication',
      }),
    )
    .digest()
    .subarray(0, 16);
  const six = bytes[6],
    eight = bytes[8];
  if (six === undefined || eight === undefined) fail();
  bytes[6] = (six & 15) | 64;
  bytes[8] = (eight & 63) | 128;
  const hex = bytes.toString('hex');
  return `.${basename(target)}.${String(process.pid)}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.publish-staged`;
}
