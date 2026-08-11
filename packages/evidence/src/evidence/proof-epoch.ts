import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import { dirname, join } from 'node:path';

const validateProofEpochLine = getValidator('proof-epoch.schema.json');
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
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (!validateProofEpochLine(line))
      errors.push(`line ${String(position)} fails schema validation`);
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
    recordCount: lines.filter((line) => line.line_type !== 'terminal').length,
    lines,
    errors,
  };
}
