import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  realpathSync,
  opendirSync,
  fsyncSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@devai-nyx/utils';
import {
  decodeReconciliationOwnerRecord,
  verifyReconciliationOwnerRecord,
  type ReconciliationOwnerRecord,
} from '../runtime/reconciliation-owner-record.js';
import {
  readReconciliationAdmissionAnchor,
  type ReconciliationAdmissionAnchor,
} from './host-reconciliation-admission.js';
import type { ReconciliationHostIdentity } from './reconciliation-host-context.js';

type Code =
  | 'RECONCILIATION_PROVISION_INVALID'
  | 'RECONCILIATION_PROVISION_STALE'
  | 'RECONCILIATION_PROVISION_UNSUPPORTED'
  | 'RECONCILIATION_PROVISION_REVIEW_INVALID';
export class ReconciliationProvisionError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.name = 'ReconciliationProvisionError';
    this.code = code;
  }
}
export function provisionFail(code: Code = 'RECONCILIATION_PROVISION_INVALID'): never {
  throw new ReconciliationProvisionError(code);
}
export function provisionSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function provisionBytesSha(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export interface NativeReconciliationPaths {
  readonly repository_root: string;
  readonly git_dir: string;
  readonly common_dir: string;
  readonly private_root: string;
}
export interface NativeDirectoryIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtime_ns: string;
  readonly uid: string;
  readonly mode: string;
}
export interface NativeFileIdentity extends NativeDirectoryIdentity {
  readonly size_bytes: string;
  readonly mtime_ns: string;
  readonly ctime_ns: string;
}
interface PrivateFile {
  readonly bytes: Uint8Array;
  readonly identity: NativeFileIdentity;
  readonly sha256: string;
}
export interface NativeReconciliationNamespace {
  readonly devai: NativeDirectoryIdentity | null;
  readonly root: NativeDirectoryIdentity | null;
  readonly anchor: ReconciliationAdmissionAnchor | null;
  readonly issuer:
    | (PrivateFile & { readonly record: Extract<ReconciliationOwnerRecord, { kind: 'issuer' }> })
    | null;
  readonly witness: Readonly<Record<string, unknown>>;
  readonly sha256: string;
}
function uid(): bigint {
  if (typeof process.geteuid !== 'function') provisionFail('RECONCILIATION_PROVISION_UNSUPPORTED');
  return BigInt(process.geteuid());
}
function directoryIdentity(stat: BigIntStats): NativeDirectoryIdentity {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
    uid: String(stat.uid),
    mode: `0${(stat.mode & 0o7777n).toString(8).padStart(3, '0')}`,
  });
}
function fileIdentity(stat: BigIntStats): NativeFileIdentity {
  if (
    !stat.isFile() ||
    stat.uid !== uid() ||
    stat.nlink !== 1n ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.size <= 0n ||
    stat.size > 1048576n
  )
    provisionFail();
  return Object.freeze({
    ...directoryIdentity(stat),
    size_bytes: String(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  });
}
function optionalStat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export function readNativeDirectory(
  path: string,
  privateLeaf = true,
): NativeDirectoryIdentity | null {
  const stat = optionalStat(path);
  if (stat === undefined) return null;
  if (
    !stat.isDirectory() ||
    stat.uid !== uid() ||
    realpathSync(path) !== path ||
    (privateLeaf ? (stat.mode & 0o7777n) !== 0o700n : (stat.mode & 0o022n) !== 0n)
  )
    provisionFail();
  return directoryIdentity(stat);
}
export function assertNativeProvisionFilesystem(paths: NativeReconciliationPaths): void {
  // Darwin assigns numeric VFS types at registration time. Query the actual
  // f_fstypename through the system df's exact APFS filter, never a numeric ID.
  const existing = optionalStat(paths.private_root) ? paths.private_root : paths.git_dir;
  const filesystem =
    process.platform === 'darwin'
      ? spawnSync('/bin/df', ['-T', 'apfs', existing], {
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
          timeout: 1000,
          maxBuffer: 8192,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        })
      : null;
  if (
    !filesystem ||
    filesystem.error ||
    filesystem.signal !== null ||
    filesystem.status !== 0 ||
    typeof filesystem.stdout !== 'string' ||
    !filesystem.stdout.trim() ||
    filesystem.stderr !== ''
  )
    provisionFail('RECONCILIATION_PROVISION_UNSUPPORTED');
}
export function readNativePrivateFile(path: string): PrivateFile {
  const initial = fileIdentity(lstatSync(path, { bigint: true }));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (provisionSha(fileIdentity(fstatSync(fd, { bigint: true }))) !== provisionSha(initial))
      provisionFail('RECONCILIATION_PROVISION_STALE');
    const bytes = Buffer.alloc(Number(initial.size_bytes));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) provisionFail();
      offset += count;
    }
    if (
      provisionSha(fileIdentity(fstatSync(fd, { bigint: true }))) !== provisionSha(initial) ||
      provisionSha(fileIdentity(lstatSync(path, { bigint: true }))) !== provisionSha(initial)
    )
      provisionFail('RECONCILIATION_PROVISION_STALE');
    return { bytes, identity: initial, sha256: provisionBytesSha(bytes) };
  } finally {
    closeSync(fd);
  }
}
function seedMetadata(root: string, expected: ReconciliationAdmissionAnchor): void {
  if (
    expected.root !== root ||
    provisionSha(readNativeDirectory(root)) !== provisionSha(expected.root_identity)
  )
    provisionFail('RECONCILIATION_PROVISION_STALE');
  const seed = fileIdentity(lstatSync(join(root, 'admission.sqlite'), { bigint: true }));
  if (
    provisionSha({ ...seed, size_bytes: Number(seed.size_bytes) }) !==
    provisionSha(expected.seed_identity)
  )
    provisionFail('RECONCILIATION_PROVISION_STALE');
}
function directoryEntries(path: string, limit: number): string[] {
  const directory = opendirSync(path, { bufferSize: Math.min(32, limit + 1) });
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return names.sort();
      if (names.length === limit) provisionFail();
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
}
function approvedRecords(
  root: string,
  issuer: Extract<ReconciliationOwnerRecord, { kind: 'issuer' }>,
  issuerSha: string,
): Readonly<Record<string, unknown>> | null {
  const directory = readNativeDirectory(root);
  if (directory === null) return null;
  const entries = directoryEntries(root, 4096);
  const result: Record<string, unknown> = {};
  let total = 0;
  for (const approval of entries) {
    if (!/^[0-9a-f]{64}$/u.test(approval)) provisionFail();
    const approvalRoot = join(root, approval);
    const identity = readNativeDirectory(approvalRoot);
    if (!identity) provisionFail();
    const names = directoryEntries(approvalRoot, 4096);
    if (!names.includes('approval.json') || names.length > 4096) provisionFail();
    const files: Record<string, unknown> = {};
    for (const name of names) {
      if (
        ++total > 16384 ||
        !(
          name === 'approval.json' ||
          name === 'lease.json' ||
          /^grant-[0-9]{6}\.json$/u.test(name) ||
          /^(intent|phase)-0[1-4]\.json$/u.test(name)
        )
      )
        provisionFail();
      const file = readNativePrivateFile(join(approvalRoot, name));
      const decoded = decodeReconciliationOwnerRecord(file.bytes);
      const record = verifyReconciliationOwnerRecord(decoded, issuer.private_key_base64);
      if (
        record.kind === 'issuer' ||
        record.repository_id !== issuer.repository_id ||
        record.worktree_id !== issuer.worktree_id ||
        record.approval_id !== approval ||
        record.issuer_sha256 !== issuerSha
      )
        provisionFail();
      if (
        (name === 'approval.json' && record.kind !== 'approval') ||
        (name === 'lease.json' && record.kind !== 'lease') ||
        (name.startsWith('intent-') &&
          (record.kind !== 'phase-intent' || name !== `intent-${record.phase}.json`)) ||
        (name.startsWith('phase-') &&
          (record.kind !== 'phase-completion' || name !== `phase-${record.phase}.json`)) ||
        (name.startsWith('grant-') &&
          ((record.kind !== 'renewal' && record.kind !== 'revocation') ||
            record.sequence < 2 ||
            name !== `grant-${String(record.sequence).padStart(6, '0')}.json`))
      )
        provisionFail();
      files[name] = { identity: file.identity, sha256: file.sha256 };
    }
    result[approval] = { identity, files };
    if (
      provisionSha(identity) !== provisionSha(readNativeDirectory(approvalRoot)) ||
      provisionSha(names) !== provisionSha(directoryEntries(approvalRoot, 4096))
    )
      provisionFail('RECONCILIATION_PROVISION_STALE');
  }
  if (
    provisionSha(directory) !== provisionSha(readNativeDirectory(root)) ||
    provisionSha(entries) !== provisionSha(directoryEntries(root, 4096))
  )
    provisionFail('RECONCILIATION_PROVISION_STALE');
  return { identity: directory, entries: result };
}

/** Fixed private reader. Passing a frozen anchor avoids raw seed opens while locked. */
export function readNativeReconciliationNamespace(
  paths: NativeReconciliationPaths,
  host: ReconciliationHostIdentity,
  lockedAnchor?: ReconciliationAdmissionAnchor,
): NativeReconciliationNamespace {
  assertNativeProvisionFilesystem(paths);
  const devai = readNativeDirectory(dirname(paths.private_root), false);
  const root = readNativeDirectory(paths.private_root);
  let anchor: ReconciliationAdmissionAnchor | null = null;
  let issuer: NativeReconciliationNamespace['issuer'] = null;
  let approvals: Readonly<Record<string, unknown>> | null = null;
  const names = root === null ? [] : directoryEntries(paths.private_root, 3);
  if (names.some((name) => !['admission.sqlite', 'issuer.json', 'approvals'].includes(name)))
    provisionFail();
  if (names.includes('admission.sqlite')) {
    if (lockedAnchor) {
      seedMetadata(paths.private_root, lockedAnchor);
      anchor = lockedAnchor;
    } else anchor = readReconciliationAdmissionAnchor(paths.private_root);
  } else if (lockedAnchor) provisionFail('RECONCILIATION_PROVISION_STALE');
  if (names.includes('issuer.json')) {
    if (!anchor) provisionFail();
    const file = readNativePrivateFile(join(paths.private_root, 'issuer.json'));
    const decoded = decodeReconciliationOwnerRecord(file.bytes);
    if (decoded.kind !== 'issuer') provisionFail();
    const record = verifyReconciliationOwnerRecord(decoded, decoded.private_key_base64);
    if (
      record.kind !== 'issuer' ||
      record.repository_id !== host.repository_id ||
      record.worktree_id !== host.worktree_id ||
      record.host_identity_sha256 !== host.host_identity_sha256 ||
      provisionSha(record.admission_anchor) !== provisionSha(anchor)
    )
      provisionFail();
    issuer = { ...file, record };
    approvals = approvedRecords(join(paths.private_root, 'approvals'), record, file.sha256);
  } else if (names.includes('approvals')) provisionFail();
  if (
    provisionSha(root) !== provisionSha(readNativeDirectory(paths.private_root)) ||
    provisionSha(devai) !== provisionSha(readNativeDirectory(dirname(paths.private_root), false)) ||
    (root !== null && provisionSha(names) !== provisionSha(directoryEntries(paths.private_root, 3)))
  )
    provisionFail('RECONCILIATION_PROVISION_STALE');
  const witness = Object.freeze({
    devai,
    root,
    anchor,
    issuer: issuer ? { identity: issuer.identity, sha256: issuer.sha256 } : null,
    approvals,
  });
  return { devai, root, anchor, issuer, witness, sha256: provisionSha(witness) };
}
export function syncNativeDirectory(path: string): void {
  const initial = lstatSync(path, { bigint: true });
  if (!initial.isDirectory() || initial.uid !== uid() || realpathSync(path) !== path)
    provisionFail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    if (
      provisionSha(directoryIdentity(initial)) !==
      provisionSha(directoryIdentity(fstatSync(fd, { bigint: true })))
    )
      provisionFail('RECONCILIATION_PROVISION_STALE');
    fsyncSync(fd);
    if (
      provisionSha(directoryIdentity(initial)) !==
      provisionSha(directoryIdentity(lstatSync(path, { bigint: true })))
    )
      provisionFail('RECONCILIATION_PROVISION_STALE');
  } finally {
    closeSync(fd);
  }
}
/** Called before native admission; never while its SQLite connection is live. */
export function syncNativePrecursor(root: string, anchor: ReconciliationAdmissionAnchor): void {
  seedMetadata(root, anchor);
  const fd = openSync(join(root, 'admission.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = fileIdentity(fstatSync(fd, { bigint: true }));
    if (
      provisionSha({ ...identity, size_bytes: Number(identity.size_bytes) }) !==
      provisionSha(anchor.seed_identity)
    )
      provisionFail('RECONCILIATION_PROVISION_STALE');
    fsyncSync(fd);
    seedMetadata(root, anchor);
  } finally {
    closeSync(fd);
  }
  syncNativeDirectory(root);
}
