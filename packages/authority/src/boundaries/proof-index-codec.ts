import { createHash } from 'node:crypto';

/** Pure bytes only. This module confers no object, index or filesystem authority. */
type ObjectFormat = 'sha1' | 'sha256';
type EntryMode = '100644' | '100755' | '120000' | '160000';
const PROOF_PATH = 'record/proofs/chain.json';
const INVALID = 'PROOF_INDEX_INVALID';
const UNSUPPORTED = 'PROOF_INDEX_FORMAT_UNSUPPORTED';
const REPLACEMENT = 'PROOF_INDEX_REPLACEMENT_REFUSED';

export interface ProofIndexEntry {
  readonly path: string;
  readonly mode: EntryMode;
  readonly oid: string;
  readonly stage: number;
  readonly assume_valid: boolean;
}

export interface ProofIndexSnapshot {
  readonly version: 2;
  readonly object_format: ObjectFormat;
  readonly raw_sha256: string;
  readonly semantic_sha256: string;
  readonly other_entries_sha256: string;
  readonly entries: readonly ProofIndexEntry[];
  readonly has_tree_extension: boolean;
}

export interface ProofIndexUpdate {
  readonly before: ProofIndexSnapshot;
  readonly after: ProofIndexSnapshot;
  readonly bytes_base64: string;
  readonly proof_path: typeof PROOF_PATH;
  readonly blob_oid: string;
  readonly mode: '100644' | '100755';
}

interface ParsedEntry {
  readonly entry: ProofIndexEntry;
  readonly pathBytes: Buffer;
  readonly raw: Buffer;
}
interface ParsedIndex {
  readonly snapshot: ProofIndexSnapshot;
  readonly entries: readonly ParsedEntry[];
  readonly resolveUndo: Buffer | undefined;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function text(bytes: Buffer): string {
  try {
    const result = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(result, 'utf8').equals(bytes)) throw new Error(INVALID);
    return result;
  } catch {
    throw new Error(INVALID);
  }
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

/** Keys are explicitly in UTF8 order; arrays retain Git's validated entry order. */
function semantic(entries: readonly ProofIndexEntry[]): string {
  return sha256(
    JSON.stringify(
      entries.map((entry) => ({
        assume_valid: entry.assume_valid,
        mode: entry.mode,
        oid: entry.oid,
        path: entry.path,
        stage: entry.stage,
      })),
    ),
  );
}

/** Validate the entire depth-first cache tree; its bytes are never entry authority. */
function validateTree(bytes: Buffer, oidSize: number, entryCount: number): void {
  let offset = 0;
  const pending: Array<{ remaining: number; names: Set<string> }> = [];
  let root = true;
  while (root || pending.length > 0) {
    while (pending.at(-1)?.remaining === 0) pending.pop();
    if (!root && pending.length === 0) break;
    const nul = bytes.indexOf(0, offset);
    if (nul < offset) throw new Error(INVALID);
    const name = text(bytes.subarray(offset, nul));
    if (root ? name !== '' : !validPath(name) || name.includes('/')) throw new Error(INVALID);
    if (!root) {
      const parent = pending.at(-1);
      if (parent === undefined || parent.names.has(name)) throw new Error(INVALID);
      parent.names.add(name);
      parent.remaining -= 1;
    }
    const newline = bytes.indexOf(10, nul + 1);
    if (newline < 0) throw new Error(INVALID);
    const counts = text(bytes.subarray(nul + 1, newline));
    const match = /^(-1|0|[1-9][0-9]*) (0|[1-9][0-9]*)$/u.exec(counts);
    if (match === null) throw new Error(INVALID);
    const count = Number(match[1]);
    const children = Number(match[2]);
    if (
      !Number.isSafeInteger(count) ||
      count > entryCount ||
      !Number.isSafeInteger(children) ||
      children > bytes.length / 5
    )
      throw new Error(INVALID);
    offset = newline + 1;
    if (count >= 0) {
      if (offset + oidSize > bytes.length) throw new Error(INVALID);
      offset += oidSize;
    }
    if (children > 0) pending.push({ remaining: children, names: new Set() });
    root = false;
  }
  if (root || offset !== bytes.length) throw new Error(INVALID);
}

/** Resolve-undo is opaque custody, never authority to restore a protected entry. */
function validateResolveUndo(bytes: Buffer, oidSize: number): void {
  let offset = 0;
  const paths = new Set<string>();
  while (offset < bytes.length) {
    const nul = bytes.indexOf(0, offset);
    if (nul < offset) throw new Error(INVALID);
    const path = text(bytes.subarray(offset, nul));
    if (!validPath(path) || paths.has(path)) throw new Error(INVALID);
    // Deliberately bounded path support: Unicode filesystem equivalence is
    // platform-dependent. Ordinary resolve-undo outside this subset is refused.
    if (path.length > 4096 || !/^[\x20-\x7e]+$/u.test(path)) throw new Error(UNSUPPORTED);
    const foldedPath = path.toLowerCase();
    if (foldedPath === PROOF_PATH || foldedPath === 'law/security/authorization.json')
      throw new Error(UNSUPPORTED);
    paths.add(path);
    offset = nul + 1;
    const modes: string[] = [];
    for (let stage = 0; stage < 3; stage += 1) {
      const end = bytes.indexOf(0, offset);
      if (end < offset) throw new Error(INVALID);
      const mode = text(bytes.subarray(offset, end));
      if (!['0', '100644', '100755', '120000', '160000'].includes(mode)) throw new Error(INVALID);
      modes.push(mode);
      offset = end + 1;
    }
    if (modes.every((mode) => mode === '0')) throw new Error(INVALID);
    for (const mode of modes) {
      if (mode === '0') continue;
      if (offset + oidSize > bytes.length) throw new Error(INVALID);
      if (bytes.subarray(offset, offset + oidSize).every((byte) => byte === 0))
        throw new Error(INVALID);
      offset += oidSize;
    }
  }
}

function parse(bytes: Uint8Array, objectFormat: ObjectFormat): ParsedIndex {
  if (!(bytes instanceof Uint8Array)) throw new Error(INVALID);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error(UNSUPPORTED);
  const raw = Buffer.from(bytes);
  const oidSize = objectFormat === 'sha1' ? 20 : 32;
  const limit = raw.length - oidSize;
  if (limit < 12 || !raw.subarray(0, 4).equals(Buffer.from('DIRC'))) throw new Error(INVALID);
  if (!createHash(objectFormat).update(raw.subarray(0, limit)).digest().equals(raw.subarray(limit)))
    throw new Error(INVALID);
  if (raw.readUInt32BE(4) !== 2) throw new Error(UNSUPPORTED);
  const count = raw.readUInt32BE(8);
  const fixed = 42 + oidSize;
  if (count > (limit - 12) / (fixed + 1)) throw new Error(INVALID);
  let offset = 12;
  const entries: ParsedEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (start + fixed >= limit) throw new Error(INVALID);
    const flags = raw.readUInt16BE(start + 40 + oidSize);
    if ((flags & 0x4000) !== 0) throw new Error(UNSUPPORTED);
    const mode = raw.readUInt32BE(start + 24).toString(8);
    if (mode === '40000') throw new Error(UNSUPPORTED);
    if (!['100644', '100755', '120000', '160000'].includes(mode)) throw new Error(INVALID);
    const nul = raw.indexOf(0, start + fixed);
    if (nul < 0 || nul >= limit) throw new Error(INVALID);
    const pathBytes = raw.subarray(start + fixed, nul);
    const path = text(pathBytes);
    if (!validPath(path) || (flags & 0x0fff) !== Math.min(pathBytes.length, 0x0fff))
      throw new Error(INVALID);
    offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
    if (offset > limit || raw.subarray(nul, offset).some((byte) => byte !== 0))
      throw new Error(INVALID);
    const entry: ProofIndexEntry = Object.freeze({
      path,
      mode: mode as EntryMode,
      oid: raw.subarray(start + 40, start + 40 + oidSize).toString('hex'),
      stage: (flags >>> 12) & 3,
      assume_valid: (flags & 0x8000) !== 0,
    });
    const previous = entries.at(-1);
    if (previous !== undefined) {
      const order = Buffer.compare(previous.pathBytes, pathBytes);
      if (
        order > 0 ||
        (order === 0 &&
          (previous.entry.stage >= entry.stage || previous.entry.stage === 0 || entry.stage === 0))
      )
        throw new Error(INVALID);
    }
    entries.push({ entry, pathBytes, raw: raw.subarray(start, offset) });
  }
  let hasTree = false;
  let resolveUndo: Buffer | undefined;
  while (offset < limit) {
    if (offset + 8 > limit) throw new Error(INVALID);
    const signature = raw.subarray(offset, offset + 4);
    const size = raw.readUInt32BE(offset + 4);
    offset += 8;
    if (size > limit - offset) throw new Error(INVALID);
    if (signature.equals(Buffer.from('TREE'))) {
      if (hasTree) throw new Error(INVALID);
      validateTree(raw.subarray(offset, offset + size), oidSize, count);
      hasTree = true;
    } else if (signature.equals(Buffer.from('REUC'))) {
      if (resolveUndo !== undefined) throw new Error(INVALID);
      validateResolveUndo(raw.subarray(offset, offset + size), oidSize);
      resolveUndo = raw.subarray(offset - 8, offset + size);
    } else throw new Error(UNSUPPORTED);
    offset += size;
  }
  const semanticEntries = Object.freeze(entries.map(({ entry }) => entry));
  return {
    entries,
    resolveUndo,
    snapshot: Object.freeze({
      version: 2,
      object_format: objectFormat,
      raw_sha256: sha256(raw),
      semantic_sha256: semantic(semanticEntries),
      other_entries_sha256: semantic(semanticEntries.filter((entry) => entry.path !== PROOF_PATH)),
      entries: semanticEntries,
      has_tree_extension: hasTree,
    }),
  };
}

export function parseProofIndex(bytes: Uint8Array, objectFormat: ObjectFormat): ProofIndexSnapshot {
  return parse(bytes, objectFormat).snapshot;
}

export function planProofIndexUpdate(
  bytes: Uint8Array,
  objectFormat: ObjectFormat,
  replacement: {
    readonly path: typeof PROOF_PATH;
    readonly mode: '100644' | '100755';
    readonly oid: string;
  },
): ProofIndexUpdate {
  const before = parse(bytes, objectFormat);
  const oidSize = objectFormat === 'sha1' ? 20 : 32;
  if (
    replacement === null ||
    typeof replacement !== 'object' ||
    replacement.path !== PROOF_PATH ||
    !['100644', '100755'].includes(replacement.mode) ||
    typeof replacement.oid !== 'string' ||
    !(objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(replacement.oid)
  )
    throw new Error(REPLACEMENT);
  if (!before.entries.some(({ entry }) => entry.path === PROOF_PATH)) throw new Error(REPLACEMENT);
  const path = Buffer.from(PROOF_PATH, 'utf8');
  const fixed = 42 + oidSize;
  const newEntry = Buffer.alloc(Math.ceil((fixed + path.length + 1) / 8) * 8);
  newEntry.writeUInt32BE(parseInt(replacement.mode, 8), 24);
  Buffer.from(replacement.oid, 'hex').copy(newEntry, 40);
  newEntry.writeUInt16BE(path.length, 40 + oidSize);
  path.copy(newEntry, fixed);
  const rawEntries: Buffer[] = [];
  let replaced = false;
  for (const original of before.entries) {
    if (original.entry.path !== PROOF_PATH) rawEntries.push(original.raw);
    else if (!replaced) {
      rawEntries.push(newEntry);
      replaced = true;
    }
  }
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(rawEntries.length, 8);
  const body = Buffer.concat([
    header,
    ...rawEntries,
    ...(before.resolveUndo === undefined ? [] : [before.resolveUndo]),
  ]);
  const output = Buffer.concat([body, createHash(objectFormat).update(body).digest()]);
  const after = parse(output, objectFormat);
  const priorOthers = before.entries.filter(({ entry }) => entry.path !== PROOF_PATH);
  const nextOthers = after.entries.filter(({ entry }) => entry.path !== PROOF_PATH);
  if (
    !(before.resolveUndo ?? Buffer.alloc(0)).equals(after.resolveUndo ?? Buffer.alloc(0)) ||
    before.snapshot.other_entries_sha256 !== after.snapshot.other_entries_sha256 ||
    priorOthers.length !== nextOthers.length ||
    priorOthers.some((entry, index) => !entry.raw.equals(nextOthers[index]?.raw ?? Buffer.alloc(0)))
  )
    throw new Error(INVALID);
  return Object.freeze({
    before: before.snapshot,
    after: after.snapshot,
    bytes_base64: output.toString('base64'),
    proof_path: PROOF_PATH,
    blob_oid: replacement.oid,
    mode: replacement.mode,
  });
}
