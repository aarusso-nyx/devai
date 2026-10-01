import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { dirname, join } from 'node:path';

const validateProofEpochLine = validators.proofEpoch;
const EMPTY_EPOCH_HASH = createHash('sha256').update('DEVAI-PROOF-EPOCH-EMPTY').digest('hex');

export type ProofEpochLineType = 'record' | 'errata' | 'terminal';

export interface ProofEpochLine {
  readonly schemaVersion: '1.0.0';
  readonly line_type: ProofEpochLineType;
  readonly round_id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previous_line_hash: string | null;
  readonly line_hash: string;
  readonly corrects_sequence?: number;
  readonly reason?: string;
  readonly record_count?: number;
  readonly terminal_hash?: string;
}

interface AppendInputs {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp?: Date;
}

export interface AppendErrataInputs extends AppendInputs {
  readonly correctsSequence: number;
  readonly reason: string;
}

export interface CloseProofEpochInputs {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly kind: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly timestamp?: Date;
}

export interface VerifyProofEpochResult {
  readonly valid: boolean;
  readonly closed: boolean;
  readonly head: string | null;
  readonly recordCount: number;
  readonly lines: readonly ProofEpochLine[];
  readonly errors: readonly string[];
}

type UnsignedProofEpochLine = Omit<ProofEpochLine, 'line_hash'>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, stable(member)]),
    );
  }
  return value;
}

export function computeProofEpochLineHash(line: UnsignedProofEpochLine): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(line)))
    .digest('hex');
}

export function proofEpochPath(repoRoot: string, roundId: string, kind: string): string {
  if (!/^R-[0-9]{4}$/u.test(roundId)) throw new Error(`invalid proof epoch round: ${roundId}`);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(kind)) throw new Error(`invalid proof epoch kind: ${kind}`);
  return join(repoRoot, 'record/proofs/work', kind, `${roundId}.jsonl`);
}

function readLines(path: string): ProofEpochLine[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  if (source.length === 0) return [];
  const rawLines = source.split('\n');
  if (rawLines.at(-1) !== '') {
    throw new Error(`proof epoch is truncated (missing final newline): ${path}`);
  }
  rawLines.pop();
  return rawLines.map((line, index) => {
    if (line.length === 0) throw new Error(`proof epoch has an empty line at ${String(index + 1)}`);
    try {
      return JSON.parse(line) as ProofEpochLine;
    } catch (error) {
      throw new Error(
        `proof epoch has invalid JSON at line ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function appendLine(path: string, unsigned: UnsignedProofEpochLine): ProofEpochLine {
  const line: ProofEpochLine = { ...unsigned, line_hash: computeProofEpochLineHash(unsigned) };
  if (!validateProofEpochLine(line)) {
    throw new Error(
      `proof epoch line does not validate: ${JSON.stringify(validateProofEpochLine.errors)}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' });
  return line;
}

function openEpoch(inputs: { repoRoot: string; roundId: string; kind: string }): {
  readonly path: string;
  readonly lines: readonly ProofEpochLine[];
  readonly head: string | null;
} {
  const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
  const lines = readLines(path);
  const check = verifyProofEpoch({ ...inputs, requireClosed: false });
  if (!check.valid) throw new Error(`proof epoch is invalid: ${check.errors.join('; ')}`);
  if (check.closed) throw new Error('proof epoch is closed; post-terminal data is forbidden');
  return { path, lines, head: lines.at(-1)?.line_hash ?? null };
}

export function appendProofEpochRecord(inputs: AppendInputs): ProofEpochLine {
  const epoch = openEpoch(inputs);
  return appendLine(epoch.path, {
    schemaVersion: '1.0.0',
    line_type: 'record',
    round_id: inputs.roundId,
    kind: inputs.kind,
    sequence: epoch.lines.length + 1,
    timestamp: (inputs.timestamp ?? new Date()).toISOString(),
    payload: inputs.payload,
    previous_line_hash: epoch.head,
  });
}

export function appendProofEpochErrata(inputs: AppendErrataInputs): ProofEpochLine {
  const epoch = openEpoch(inputs);
  const target = epoch.lines[inputs.correctsSequence - 1];
  if (target?.line_type !== 'record') {
    throw new Error('proof epoch errata must correct an earlier record sequence');
  }
  if (inputs.reason.trim().length === 0) throw new Error('proof epoch errata requires a reason');
  return appendLine(epoch.path, {
    schemaVersion: '1.0.0',
    line_type: 'errata',
    round_id: inputs.roundId,
    kind: inputs.kind,
    sequence: epoch.lines.length + 1,
    timestamp: (inputs.timestamp ?? new Date()).toISOString(),
    payload: inputs.payload,
    previous_line_hash: epoch.head,
    corrects_sequence: inputs.correctsSequence,
    reason: inputs.reason,
  });
}

export function closeProofEpoch(inputs: CloseProofEpochInputs): ProofEpochLine {
  const epoch = openEpoch(inputs);
  return appendLine(epoch.path, {
    schemaVersion: '1.0.0',
    line_type: 'terminal',
    round_id: inputs.roundId,
    kind: inputs.kind,
    sequence: epoch.lines.length + 1,
    timestamp: (inputs.timestamp ?? new Date()).toISOString(),
    payload: inputs.payload ?? {},
    previous_line_hash: epoch.head,
    record_count: epoch.lines.length,
    terminal_hash: epoch.head ?? EMPTY_EPOCH_HASH,
  });
}

export function verifyProofEpoch(inputs: {
  readonly repoRoot: string;
  readonly roundId: string;
  readonly kind: string;
  readonly requireClosed?: boolean;
}): VerifyProofEpochResult {
  const path = proofEpochPath(inputs.repoRoot, inputs.roundId, inputs.kind);
  const errors: string[] = [];
  let lines: ProofEpochLine[] = [];
  try {
    lines = readLines(path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let previous: string | null = null;
  let terminalCount = 0;
  let recordCount = 0;
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (!validateProofEpochLine(line)) {
      errors.push(`line ${String(position)} fails schema validation`);
      continue;
    }
    if (line.line_type !== 'terminal') recordCount += 1;
    if (line.round_id !== inputs.roundId) errors.push(`line ${String(position)} crosses round`);
    if (line.kind !== inputs.kind) errors.push(`line ${String(position)} crosses kind`);
    if (line.sequence !== position) errors.push(`line ${String(position)} has reordered sequence`);
    if (line.previous_line_hash !== previous)
      errors.push(`line ${String(position)} has broken chain`);
    const { line_hash: actual, ...unsigned } = line;
    const expected = computeProofEpochLineHash(unsigned);
    if (actual !== expected) errors.push(`line ${String(position)} has a tampered hash`);
    if (line.line_type === 'errata') {
      const target = lines[(line.corrects_sequence ?? 0) - 1];
      if ((line.corrects_sequence ?? 0) >= position || target?.line_type !== 'record') {
        errors.push(`line ${String(position)} has invalid forward or non-record errata`);
      }
    }
    if (line.line_type === 'terminal') {
      terminalCount += 1;
      if (position !== lines.length) errors.push(`line ${String(position)} has post-terminal data`);
      if (line.record_count !== index)
        errors.push(`line ${String(position)} has wrong record count`);
      if (line.terminal_hash !== (previous ?? EMPTY_EPOCH_HASH)) {
        errors.push(`line ${String(position)} has wrong terminal hash`);
      }
    }
    previous = actual;
  }
  if (terminalCount > 1) errors.push('proof epoch has duplicate terminals');
  const requireClosed = inputs.requireClosed ?? true;
  if (requireClosed && terminalCount !== 1) errors.push('proof epoch is missing its terminal line');
  return {
    valid: errors.length === 0,
    closed: terminalCount === 1,
    head: previous,
    recordCount,
    lines,
    errors,
  };
}

/* ADR-EVI-0002: the canonical path, the sequence namespace, the newline rule, and the line digest. */

/** `record/proofs/work/<kind>/<round_id>.jsonl`: forward slashes, no dot segment, no leading slash. */
export const CANONICAL_PROOF_PATH =
  /^record\/proofs\/work\/[a-z0-9][a-z0-9_-]*\/R-[0-9]{4}\.jsonl$/u;

/** The canonical repository-relative path of one proof epoch file. */
export function canonicalProofPath(kind: string, roundId: string): string {
  return `record/proofs/work/${kind}/${roundId}.jsonl`;
}

/** The SHA-256 of the line bytes, exclusive of the terminating newline; never the `line_hash`. */
export function proofLineDigest(line: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof line === 'string' ? Buffer.from(line, 'utf8') : line)
    .digest('hex');
}

export type ProofEpochBytes =
  | { readonly ok: true; readonly lines: readonly Buffer[] }
  | { readonly ok: false; readonly reason: 'TRUNCATED' };

/**
 * Splits one epoch file into its physical lines: the bytes between the previous newline (or the
 * start of the file) and the next newline, exclusive of the newline. A non-empty file whose last
 * byte is not a newline is truncated, and none of its lines resolve.
 */
export function splitProofEpochBytes(bytes: Uint8Array): ProofEpochBytes {
  if (bytes.length === 0) return { ok: true, lines: [] };
  if (bytes[bytes.length - 1] !== 0x0a) return { ok: false, reason: 'TRUNCATED' };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return { ok: true, lines };
}

export type ProofAnchorResolution =
  | {
      readonly resolved: true;
      readonly path: string;
      readonly sequence: number;
      readonly sha256: string;
    }
  | { readonly resolved: false; readonly reason: string };

/**
 * Resolves one anchor to exactly one physical line. A non-canonical path, a sequence outside the
 * one-based namespace of its file, a missing file, and a truncated file resolve to no line; the
 * path is never normalized into a match.
 */
export function resolveProofAnchor(
  repoRoot: string,
  anchor: { readonly path: string; readonly sequence: number },
): ProofAnchorResolution {
  if (typeof anchor.path !== 'string' || !CANONICAL_PROOF_PATH.test(anchor.path)) {
    return { resolved: false, reason: 'NON_CANONICAL_PATH' };
  }
  if (!Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1) {
    return { resolved: false, reason: 'INVALID_SEQUENCE' };
  }
  const absolute = join(repoRoot, anchor.path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    return { resolved: false, reason: 'NO_FILE' };
  }
  const epoch = splitProofEpochBytes(readFileSync(absolute));
  if (!epoch.ok) return { resolved: false, reason: epoch.reason };
  const line = epoch.lines[anchor.sequence - 1];
  if (line === undefined) return { resolved: false, reason: 'NO_LINE' };
  return {
    resolved: true,
    path: anchor.path,
    sequence: anchor.sequence,
    sha256: proofLineDigest(line),
  };
}
