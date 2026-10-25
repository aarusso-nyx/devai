import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import {
  RECONCILIATION_ADMISSION_SEED_SHA256,
  RECONCILIATION_ADMISSION_SEED_SIZE,
} from './reconciliation-admission-seed.js';

type AdmissionCode =
  | 'RECONCILIATION_ADMISSION_ANCHOR_INVALID'
  | 'RECONCILIATION_ADMISSION_STALE'
  | 'RECONCILIATION_ADMISSION_BUSY'
  | 'RECONCILIATION_ADMISSION_REENTRANT'
  | 'RECONCILIATION_ADMISSION_CALLBACK_INVALID'
  | 'RECONCILIATION_ADMISSION_UNAVAILABLE'
  | 'RECONCILIATION_ADMISSION_RELEASE_INDETERMINATE';

export class ReconciliationAdmissionError extends Error {
  readonly code: AdmissionCode;
  readonly stage?: 'rollback' | 'close';
  constructor(code: AdmissionCode, stage?: 'rollback' | 'close') {
    super(code);
    this.name = 'ReconciliationAdmissionError';
    this.code = code;
    if (stage !== undefined) this.stage = stage;
  }
}

interface RootIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtime_ns: string;
  readonly uid: string;
  readonly mode: '0700';
}
interface SeedIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtime_ns: string;
  readonly uid: string;
  readonly mode: '0600';
  readonly size_bytes: 8192;
  readonly mtime_ns: string;
  readonly ctime_ns: string;
}

/** Internal state witness only. It is not an approval or mutation capability. */
export interface ReconciliationAdmissionAnchor {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'reconciliation-admission-anchor';
  readonly root: string;
  readonly root_identity: RootIdentity;
  readonly seed_identity: SeedIdentity;
  readonly seed_sha256: typeof RECONCILIATION_ADMISSION_SEED_SHA256;
}

// A retained owner also prevents a later raw close from dropping a POSIX lock.
const liveAnchors = new Map<string, { database?: DatabaseSync; rawFd?: number }>();
const nativePromise = Promise;
const nativePromiseThen = Promise.prototype.then;
const nativePromiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
const ROOT_KEYS = ['dev', 'ino', 'birthtime_ns', 'uid', 'mode'] as const;
const SEED_KEYS = [...ROOT_KEYS, 'size_bytes', 'mtime_ns', 'ctime_ns'] as const;
const ANCHOR_KEYS = [
  'schemaVersion',
  'kind',
  'root',
  'root_identity',
  'seed_identity',
  'seed_sha256',
];
const SCHEMA_SQL = 'SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY name';
const ROW_SQL = 'SELECT singleton,version FROM admission_protocol ORDER BY singleton';
const EXPECTED_SCHEMA = [
  {
    type: 'table',
    name: 'admission_protocol',
    tbl_name: 'admission_protocol',
    rootpage: 2,
    sql: 'CREATE TABLE admission_protocol(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1))',
  },
];

function invalid(): never {
  throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_ANCHOR_INVALID');
}
function stale(): never {
  throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_STALE');
}
function key(stat: Pick<BigIntStats, 'dev' | 'ino'>): string {
  return `${stat.dev}:${stat.ino}`;
}
function effectiveUid(): bigint {
  if (!['darwin', 'linux'].includes(process.platform) || typeof process.geteuid !== 'function')
    throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_UNAVAILABLE');
  return BigInt(process.geteuid());
}
function rootIdentity(stat: BigIntStats): RootIdentity {
  if (!stat.isDirectory() || stat.uid !== effectiveUid() || (stat.mode & 0o7777n) !== 0o700n)
    invalid();
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
    uid: String(stat.uid),
    mode: '0700',
  });
}
function seedIdentity(stat: BigIntStats): SeedIdentity {
  if (
    !stat.isFile() ||
    stat.uid !== effectiveUid() ||
    stat.nlink !== 1n ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.size !== BigInt(RECONCILIATION_ADMISSION_SEED_SIZE)
  )
    invalid();
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
    uid: String(stat.uid),
    mode: '0600',
    size_bytes: 8192,
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  });
}
function sidecarsAbsent(root: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      lstatSync(join(root, `admission.sqlite${suffix}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      invalid();
    }
    invalid();
  }
}
function sameFields(a: object, b: object, keys: readonly string[]): boolean {
  return keys.every(
    (field) => (a as Record<string, unknown>)[field] === (b as Record<string, unknown>)[field],
  );
}
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every((k) => typeof k === 'string' && keys.includes(k)))
    return undefined;
  const data = Object.create(null) as Record<string, unknown>;
  for (const field of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return undefined;
    data[field] = descriptor.value;
  }
  return data;
}
function decimal(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 30 &&
    !/[^0-9]/u.test(value) &&
    (value === '0' || value[0] !== '0')
  );
}
function witness(value: unknown): ReconciliationAdmissionAnchor {
  const data = plain(value, ANCHOR_KEYS);
  if (
    !data ||
    data.schemaVersion !== '1.0.0' ||
    data.kind !== 'reconciliation-admission-anchor' ||
    typeof data.root !== 'string' ||
    data.seed_sha256 !== RECONCILIATION_ADMISSION_SEED_SHA256
  )
    invalid();
  const root = plain(data.root_identity, ROOT_KEYS);
  const seed = plain(data.seed_identity, SEED_KEYS);
  if (
    !root ||
    !seed ||
    root.mode !== '0700' ||
    seed.mode !== '0600' ||
    seed.size_bytes !== 8192 ||
    !['dev', 'ino', 'birthtime_ns', 'uid'].every(
      (field) => decimal(root[field]) && decimal(seed[field]),
    ) ||
    !decimal(seed.mtime_ns) ||
    !decimal(seed.ctime_ns)
  )
    invalid();
  return {
    schemaVersion: '1.0.0',
    kind: 'reconciliation-admission-anchor',
    root: data.root,
    root_identity: root as unknown as RootIdentity,
    seed_identity: seed as unknown as SeedIdentity,
    seed_sha256: RECONCILIATION_ADMISSION_SEED_SHA256,
  };
}
function sameWitness(a: ReconciliationAdmissionAnchor, b: ReconciliationAdmissionAnchor): boolean {
  return (
    a.root === b.root &&
    a.seed_sha256 === b.seed_sha256 &&
    sameFields(a.root_identity, b.root_identity, ROOT_KEYS) &&
    sameFields(a.seed_identity, b.seed_identity, SEED_KEYS)
  );
}

/** Read only. No SQLite connection, creation, repair or lock acquisition is performed. */
export function readReconciliationAdmissionAnchor(root: string): ReconciliationAdmissionAnchor {
  effectiveUid();
  try {
    if (
      typeof root !== 'string' ||
      !isAbsolute(root) ||
      root.includes('\0') ||
      resolve(root) !== root ||
      realpathSync(root) !== root
    )
      invalid();
    const rootStat = rootIdentity(lstatSync(root, { bigint: true }));
    const path = join(root, 'admission.sqlite');
    const seedStat = lstatSync(path, { bigint: true });
    const ownerKey = key(seedStat);
    if (liveAnchors.has(ownerKey))
      throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_REENTRANT');
    const seed = seedIdentity(seedStat);
    sidecarsAbsent(root);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let readFailed = false;
    let readError: unknown;
    try {
      if (!sameFields(seed, seedIdentity(fstatSync(fd, { bigint: true })), SEED_KEYS)) invalid();
      const bytes = Buffer.alloc(RECONCILIATION_ADMISSION_SEED_SIZE);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) invalid();
        offset += count;
      }
      if (
        createHash('sha256').update(bytes).digest('hex') !== RECONCILIATION_ADMISSION_SEED_SHA256 ||
        !sameFields(seed, seedIdentity(fstatSync(fd, { bigint: true })), SEED_KEYS) ||
        !sameFields(seed, seedIdentity(lstatSync(path, { bigint: true })), SEED_KEYS) ||
        !sameFields(rootStat, rootIdentity(lstatSync(root, { bigint: true })), ROOT_KEYS)
      )
        invalid();
      sidecarsAbsent(root);
    } catch (error) {
      readFailed = true;
      readError = error;
    }
    try {
      closeSync(fd);
    } catch {
      liveAnchors.set(ownerKey, { rawFd: fd });
      throw new ReconciliationAdmissionError(
        'RECONCILIATION_ADMISSION_RELEASE_INDETERMINATE',
        'close',
      );
    }
    if (readFailed) throw readError;
    return Object.freeze({
      schemaVersion: '1.0.0',
      kind: 'reconciliation-admission-anchor',
      root,
      root_identity: rootStat,
      seed_identity: seed,
      seed_sha256: RECONCILIATION_ADMISSION_SEED_SHA256,
    });
  } catch (error) {
    if (error instanceof ReconciliationAdmissionError) throw error;
    invalid();
  }
}

function nativeFailure(error: unknown): never {
  const descriptor =
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    !types.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'errcode')
      : undefined;
  const code: unknown =
    descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  throw new ReconciliationAdmissionError(
    code === 5 || code === 6
      ? 'RECONCILIATION_ADMISSION_BUSY'
      : 'RECONCILIATION_ADMISSION_UNAVAILABLE',
  );
}
function verifyLocked(db: DatabaseSync, anchor: ReconciliationAdmissionAnchor): void {
  try {
    if (
      realpathSync(anchor.root) !== anchor.root ||
      !sameFields(
        anchor.root_identity,
        rootIdentity(lstatSync(anchor.root, { bigint: true })),
        ROOT_KEYS,
      ) ||
      !sameFields(
        anchor.seed_identity,
        seedIdentity(lstatSync(join(anchor.root, 'admission.sqlite'), { bigint: true })),
        SEED_KEYS,
      )
    )
      stale();
    sidecarsAbsent(anchor.root);
  } catch {
    stale();
  }
  try {
    const schema = db.prepare(SCHEMA_SQL).all();
    const rows = db.prepare(ROW_SQL).all();
    const schemaRow = schema[0];
    const expectedSchema = EXPECTED_SCHEMA[0];
    const row = rows[0];
    if (
      schema.length !== 1 ||
      rows.length !== 1 ||
      schemaRow === undefined ||
      expectedSchema === undefined ||
      row === undefined ||
      !sameFields(schemaRow, expectedSchema, ['type', 'name', 'tbl_name', 'rootpage', 'sql']) ||
      !sameFields(row, { singleton: 1, version: 1 }, ['singleton', 'version'])
    )
      stale();
  } catch (error) {
    if (error instanceof ReconciliationAdmissionError) throw error;
    nativeFailure(error);
  }
}
function discardOrdinaryPromiseRejection(value: object): void {
  // Only intrinsic Promise constructor/species lookup is permitted. Custom
  // promises are outside the trusted synchronous callback contract.
  let current: object | null = value;
  while (current !== null) {
    if (types.isProxy(current)) return;
    const constructor = Object.getOwnPropertyDescriptor(current, 'constructor');
    if (constructor !== undefined) {
      if (!Object.hasOwn(constructor, 'value') || constructor.value !== nativePromise) return;
      const species = Object.getOwnPropertyDescriptor(nativePromise, Symbol.species);
      if (species?.get !== nativePromiseSpecies || species?.set !== undefined) return;
      Reflect.apply(nativePromiseThen, value, [undefined, () => undefined]);
      return;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
}
function deferred(value: unknown): boolean {
  if (value === null || !['object', 'function'].includes(typeof value)) return false;
  if (types.isProxy(value)) return true;
  if (types.isPromise(value)) {
    discardOrdinaryPromiseRejection(value as object);
    return true;
  }
  if (types.isGeneratorObject(value)) return true;
  let current: object | null = value as object;
  while (current !== null) {
    if (types.isProxy(current) || Object.getOwnPropertyDescriptor(current, 'then') !== undefined)
      return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

/** Internal trusted synchronous critical section. No authority is derived from its arguments. */
export function withReconciliationAdmissionSteps<T>(
  root: string,
  expected: ReconciliationAdmissionAnchor,
  callback: () => T,
): T {
  if (
    typeof callback !== 'function' ||
    types.isProxy(callback) ||
    types.isAsyncFunction(callback) ||
    types.isGeneratorFunction(callback)
  )
    throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_CALLBACK_INVALID');
  const expectedWitness = witness(expected);
  const actual = readReconciliationAdmissionAnchor(root);
  if (!sameWitness(actual, expectedWitness)) stale();
  const ownerKey = `${actual.seed_identity.dev}:${actual.seed_identity.ino}`;
  const owner: { database?: DatabaseSync } = {};
  liveAnchors.set(ownerKey, owner);
  let db: DatabaseSync | undefined;
  let began = false;
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    try {
      // rw forbids creation. URI/flags are generated here, never supplied by caller.
      db = new DatabaseSync(`${pathToFileURL(join(root, 'admission.sqlite')).href}?mode=rw`, {
        timeout: 0,
        allowExtension: false,
      });
      owner.database = db;
      db.exec('BEGIN IMMEDIATE');
      began = true;
    } catch (error) {
      nativeFailure(error);
    }
    verifyLocked(db, actual);
    result = callback();
    if (deferred(result))
      throw new ReconciliationAdmissionError('RECONCILIATION_ADMISSION_CALLBACK_INVALID');
    verifyLocked(db, actual);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let failure: 'rollback' | 'close' | undefined;
  if (db !== undefined) {
    if (began) {
      try {
        db.exec('ROLLBACK');
      } catch {
        failure = 'rollback';
      }
    }
    try {
      db.close();
    } catch {
      failure = 'close';
    }
  }
  if (failure !== undefined) {
    throw new ReconciliationAdmissionError(
      'RECONCILIATION_ADMISSION_RELEASE_INDETERMINATE',
      failure,
    );
  }
  liveAnchors.delete(ownerKey);
  if (operationFailed) throw operationError;
  return result as T;
}
