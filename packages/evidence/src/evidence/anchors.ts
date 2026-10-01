// ADR-EVI-0002: the line-level cross-check of `record/proofs/chain.json` against every physical
// proof line under `record/proofs/work`, the append-only anchor baseline, the governed historical
// declaration, and the crash-recovery rule. The contract is docs/reference/cli/evidence-verify.md.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  spawnSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadChain, verifyChain, type EvidenceRecord, type VerifyResult } from './chain.js';
import {
  CANONICAL_PROOF_PATH,
  canonicalProofPath,
  proofLineDigest,
  splitProofEpochBytes,
} from './proof-epoch.js';

const validateBaseline = validators.proofAnchorBaseline;
const validateDeclaration = validators.proofOrphanDeclaration;

/** The committed baseline the first verification writes, relative to the repository root. */
export const PROOF_ANCHOR_BASELINE_PATH = 'record/proofs/anchor-baseline.json';
const PROOF_WORK_ROOT = 'record/proofs/work';
const DEFAULT_CHAIN_PATH = 'record/proofs/chain.json';
const HISTORICAL_GAP_KIND = 'historical-gap';
const ACKNOWLEDGED = 'historical gap acknowledged';
const KIND = /^[a-z0-9][a-z0-9_-]*$/u;
const EPOCH_FILE = /^R-[0-9]{4}\.jsonl$/u;
const ROUND = /^R-[0-9]{4}$/u;
const SEQUENCE = /^[1-9][0-9]*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RECORD_ACTION_PREFIX = 'evidence.record.';
const UNANCHORED_NEWEST_REMEDIATION =
  'append its chain entry through evidence record, which computes proof_sha256 from the existing line bytes and writes nothing else; the line itself is never rewritten';

export type ProofLineLabel =
  'anchored' | 'orphan' | 'historical gap acknowledged' | 'UNANCHORED_NEWEST_LINE';

export type ProofAnchorFailure =
  'NO_LINE' | 'DUPLICATE_ANCHOR' | 'DIGEST_MISMATCH' | 'MALFORMED_ANCHOR';

export interface ProofLineFinding {
  readonly path: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly label: ProofLineLabel;
  readonly remediation?: string;
}

export interface ProofAnchorFinding {
  readonly record_id: string;
  readonly path: string | null;
  readonly sequence: number | null;
  readonly status: 'anchored' | 'unresolved';
  readonly reason?: ProofAnchorFailure;
}

export interface ProofDeclarationFinding {
  readonly path: string;
  readonly sequence: number;
  readonly status: 'accepted' | 'rejected';
  readonly reasons: readonly string[];
}

export interface ProofAnchorBaselineSummary {
  readonly path: string;
  readonly cutoff: string;
  readonly created: boolean;
  readonly appended: number;
}

export interface ProofAnchorVerification {
  readonly valid: boolean;
  /** The unchanged `verifyChain` result: sequence, link, manifest hash, and head. */
  readonly chain: VerifyResult;
  readonly baseline: ProofAnchorBaselineSummary | null;
  readonly lines: readonly ProofLineFinding[];
  readonly anchors: readonly ProofAnchorFinding[];
  readonly declarations: readonly ProofDeclarationFinding[];
  /** Every failure; a line is named as `<canonical path>:<sequence>`. */
  readonly errors: readonly string[];
}

export interface ProofAnchorVerificationInputs {
  readonly repoRoot: string;
  readonly chainPath?: string;
  readonly now?: Date;
  /** `--write` consent: only with it may the baseline be created or appended to. */
  readonly write?: boolean;
}

interface BaselineEntry {
  readonly path: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly anchor_status: 'anchored' | 'orphaned';
  readonly observed_at: string;
}

interface Baseline {
  readonly schemaVersion: '1.0.0';
  readonly record: 'ADR-EVI-0002';
  readonly cutoff: string;
  readonly entries: readonly BaselineEntry[];
}

interface PhysicalLine {
  readonly path: string;
  readonly kind: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly newest: boolean;
}

type AnchorClaim =
  | {
      readonly form: 'structured';
      readonly path: unknown;
      readonly sequence: unknown;
      readonly digest: unknown;
    }
  | { readonly form: 'notes'; readonly path: string; readonly sequence: number }
  | {
      readonly form: 'malformed';
      readonly path: string | null;
      readonly sequence: number | null;
      readonly detail: string;
    };

function ref(path: string, sequence: number): string {
  return `${path}:${String(sequence)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, member]) => [key, stable(member)]),
    );
  }
  return value;
}

/** Every physical line under `record/proofs/work`, in canonical path then sequence order. */
function readPhysicalLines(root: string, errors: string[]): Map<string, PhysicalLine> {
  const lines = new Map<string, PhysicalLine>();
  const work = join(root, PROOF_WORK_ROOT);
  if (!existsSync(work) || !lstatSync(work).isDirectory()) return lines;
  for (const kind of readdirSync(work).sort()) {
    const directory = join(work, kind);
    if (!KIND.test(kind) || !lstatSync(directory).isDirectory()) continue;
    for (const file of readdirSync(directory).sort()) {
      const absolute = join(directory, file);
      if (!EPOCH_FILE.test(file) || !lstatSync(absolute).isFile()) continue;
      const path = canonicalProofPath(kind, file.slice(0, -'.jsonl'.length));
      const epoch = splitProofEpochBytes(readFileSync(absolute));
      if (!epoch.ok) {
        errors.push(
          `PROOF_EPOCH_TRUNCATED ${path}: the last byte is not a newline, so no line in it resolves`,
        );
        continue;
      }
      epoch.lines.forEach((bytes, index) => {
        const sequence = index + 1;
        if (bytes.length === 0) {
          errors.push(`PROOF_EPOCH_EMPTY_LINE ${ref(path, sequence)}: an empty line is a defect`);
        }
        lines.set(ref(path, sequence), {
          path,
          kind,
          sequence,
          sha256: proofLineDigest(bytes),
          bytes,
          newest: sequence === epoch.lines.length,
        });
      });
    }
  }
  return lines;
}

/** The anchor a chain entry claims, if any: structured fields first, then the historical notes. */
function anchorClaim(record: EvidenceRecord): AnchorClaim | undefined {
  const fields = record as unknown as Record<string, unknown>;
  if ('proof_path' in fields || 'proof_sequence' in fields || 'proof_sha256' in fields) {
    return {
      form: 'structured',
      path: fields['proof_path'],
      sequence: fields['proof_sequence'],
      digest: fields['proof_sha256'],
    };
  }
  if (typeof record.action !== 'string' || !record.action.startsWith(RECORD_ACTION_PREFIX)) {
    return undefined;
  }
  const kind = record.action.slice(RECORD_ACTION_PREFIX.length);
  const notes = new Map<string, string[]>();
  for (const note of Array.isArray(record.notes) ? record.notes : []) {
    if (typeof note !== 'string') continue;
    const separator = note.indexOf('=');
    if (separator <= 0) continue;
    const key = note.slice(0, separator);
    notes.set(key, [...(notes.get(key) ?? []), note.slice(separator + 1)]);
  }
  const rounds = notes.get('round_id') ?? [];
  const sequences = notes.get('proof_sequence') ?? [];
  const round = rounds.length === 1 ? rounds[0] : undefined;
  const sequence = sequences.length === 1 ? sequences[0] : undefined;
  const validRound = round !== undefined && ROUND.test(round);
  const validSequence = sequence !== undefined && SEQUENCE.test(sequence);
  if (!KIND.test(kind) || !validRound || !validSequence) {
    return {
      form: 'malformed',
      path: KIND.test(kind) && validRound ? canonicalProofPath(kind, round) : null,
      sequence: validSequence ? Number(sequence) : null,
      detail: 'the anchor needs exactly one round_id=R-NNNN and one proof_sequence=<n> note',
    };
  }
  return { form: 'notes', path: canonicalProofPath(kind, round), sequence: Number(sequence) };
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
}

function git(root: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

/** The old side of a full-context `git diff`: context and removed lines, in order. */
function committedText(diff: string): string | undefined {
  const old: string[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    if (!inHunk) {
      if (line.startsWith('new file mode')) return undefined;
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-')) old.push(line.slice(1));
  }
  return old.join('\n');
}

/**
 * The refusal of PROOF_HISTORY_MODIFIED: against the committed HEAD, a proof epoch may only have
 * gained lines and the chain may only have gained entries. Outside a Git work tree, or before the
 * first commit, there is no recorded history to compare, and nothing is refused.
 */
function proofHistoryModifications(root: string, chainPath: string): string[] {
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0) return [];
  const findings: string[] = [];
  const work = git(root, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--unified=0',
    'HEAD',
    '--',
    PROOF_WORK_ROOT,
  ]);
  let file = '';
  let inHunk = false;
  const changed = new Set<string>();
  for (const line of work.stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = line.slice(line.lastIndexOf(' b/') + 3);
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('deleted file mode')) changed.add(file);
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('-') || line.startsWith('\\')) changed.add(file);
  }
  for (const path of [...changed].sort()) {
    findings.push(
      `PROOF_HISTORY_MODIFIED ${path}: a committed proof line was changed or removed in the working tree; restore the committed bytes, never re-anchor or re-declare the line`,
    );
  }
  const chainRelative = relative(root, chainPath);
  if (
    chainRelative.length > 0 &&
    !isAbsolute(chainRelative) &&
    chainRelative !== '..' &&
    !chainRelative.startsWith(`..${sep}`)
  ) {
    const diff = git(root, [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--no-renames',
      '--unified=100000000',
      'HEAD',
      '--',
      chainRelative.split(sep).join('/'),
    ]).stdout;
    const committed = diff.length === 0 ? undefined : committedText(diff);
    if (committed !== undefined) {
      const name = chainRelative.split(sep).join('/');
      let committedRecords: unknown[] | undefined;
      try {
        const parsed = JSON.parse(committed) as unknown;
        if (isRecord(parsed) && Array.isArray(parsed['records'])) {
          committedRecords = parsed['records'] as unknown[];
        }
      } catch {
        committedRecords = undefined;
      }
      const current = existsSync(chainPath) ? loadChain(chainPath).records : [];
      if (committedRecords !== undefined) {
        if (current.length < committedRecords.length) {
          findings.push(
            `PROOF_HISTORY_MODIFIED ${name}: committed chain entries were removed; restore the committed chain`,
          );
        }
        committedRecords.forEach((record, index) => {
          const now = current[index];
          if (now === undefined) return;
          if (JSON.stringify(stable(record)) !== JSON.stringify(stable(now))) {
            const id = isRecord(record) && typeof record['id'] === 'string' ? record['id'] : '';
            findings.push(
              `PROOF_HISTORY_MODIFIED ${name}: committed chain entry ${String(index + 1)} ${id} changed in the working tree; restore the committed chain`,
            );
          }
        });
      }
    }
  }
  return findings;
}

function readBaseline(root: string, errors: string[]): Baseline | null | 'invalid' {
  const absolute = join(root, PROOF_ANCHOR_BASELINE_PATH);
  if (!existsSync(absolute)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (error) {
    errors.push(
      `PROOF_ANCHOR_BASELINE_INVALID ${PROOF_ANCHOR_BASELINE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'invalid';
  }
  if (!validateBaseline(parsed)) {
    errors.push(
      `PROOF_ANCHOR_BASELINE_INVALID ${PROOF_ANCHOR_BASELINE_PATH}: ${JSON.stringify(validateBaseline.errors)}`,
    );
    return 'invalid';
  }
  const baseline = parsed as Baseline;
  const seen = new Set<string>();
  for (const entry of baseline.entries) {
    const key = ref(entry.path, entry.sequence);
    if (seen.has(key)) {
      errors.push(`PROOF_ANCHOR_BASELINE_INVALID ${key}: the entry is listed twice`);
      return 'invalid';
    }
    seen.add(key);
  }
  return baseline;
}

/**
 * `evidence verify --scope chain` under ADR-EVI-0002: the unchanged chain checks, then the
 * cross-check of every anchor against exactly one physical line and of every physical line against
 * exactly one direct anchor or one accepted historical declaration. Only with `write` consent is
 * the baseline created (first run) or appended to (later runs); it never changes an entry.
 */
export function verifyProofAnchors(inputs: ProofAnchorVerificationInputs): ProofAnchorVerification {
  const root = resolve(inputs.repoRoot);
  const chainPath = resolve(root, inputs.chainPath ?? DEFAULT_CHAIN_PATH);
  const observedAt = (inputs.now ?? new Date()).toISOString();
  const write = inputs.write === true;
  const chain = verifyChain(chainPath);
  const errors: string[] = [...chain.errors];
  const refused = (baseline: ProofAnchorBaselineSummary | null): ProofAnchorVerification => ({
    valid: false,
    chain,
    baseline,
    lines: [],
    anchors: [],
    declarations: [],
    errors,
  });

  const history = proofHistoryModifications(root, chainPath);
  if (history.length > 0) {
    errors.push(...history);
    return refused(null);
  }

  const loaded = readBaseline(root, errors);
  if (loaded === 'invalid') return refused(null);
  if (loaded === null && !write) {
    errors.push(
      `PROOF_ANCHOR_BASELINE_MISSING ${PROOF_ANCHOR_BASELINE_PATH}: no anchor baseline is recorded; rerun evidence verify --scope chain with --write to record the first baseline`,
    );
    return refused(null);
  }
  const cutoff = loaded?.cutoff ?? observedAt;
  const baselineEntries = new Map<string, BaselineEntry>(
    (loaded?.entries ?? []).map((entry) => [ref(entry.path, entry.sequence), entry]),
  );

  const lines = readPhysicalLines(root, errors);
  for (const [key, entry] of baselineEntries) {
    const line = lines.get(key);
    if (line === undefined) {
      errors.push(
        `PROOF_LINE_MISSING ${key}: recorded in ${PROOF_ANCHOR_BASELINE_PATH} but absent from the epoch`,
      );
    } else if (line.sha256 !== entry.sha256) {
      errors.push(
        `PROOF_LINE_CHANGED ${key}: ${PROOF_ANCHOR_BASELINE_PATH} records ${entry.sha256}, the line bytes hash to ${line.sha256}`,
      );
    }
  }

  // Every anchor resolves to exactly one physical line whose digest matches.
  const anchors: ProofAnchorFinding[] = [];
  const anchored = new Map<string, string>();
  const digestAnchored = new Set<string>();
  loadChain(chainPath).records.forEach((record, index) => {
    const claim = anchorClaim(record);
    if (claim === undefined) return;
    const recordId = typeof record.id === 'string' ? record.id : `#${String(index + 1)}`;
    const unresolved = (
      reason: ProofAnchorFailure,
      path: string | null,
      sequence: number | null,
      detail: string,
    ): void => {
      anchors.push({ record_id: recordId, path, sequence, status: 'unresolved', reason });
      const named =
        path === null ? '' : ` ${path}${sequence === null ? '' : `:${String(sequence)}`}`;
      errors.push(`${reason} record ${recordId}:${named} ${detail}`);
    };
    if (claim.form === 'malformed') {
      unresolved('MALFORMED_ANCHOR', claim.path, claim.sequence, claim.detail);
      return;
    }
    const path = typeof claim.path === 'string' ? claim.path : null;
    const sequence = typeof claim.sequence === 'number' ? claim.sequence : null;
    if (
      claim.form === 'structured' &&
      (path === null ||
        sequence === null ||
        typeof claim.digest !== 'string' ||
        !DIGEST.test(claim.digest))
    ) {
      unresolved(
        'MALFORMED_ANCHOR',
        path,
        sequence,
        'proof_path, proof_sequence, and proof_sha256 must all be present and well formed',
      );
      return;
    }
    const line =
      path !== null &&
      sequence !== null &&
      CANONICAL_PROOF_PATH.test(path) &&
      Number.isSafeInteger(sequence)
        ? lines.get(ref(path, sequence))
        : undefined;
    if (line === undefined) {
      unresolved('NO_LINE', path, sequence, 'resolves to no physical proof line');
      return;
    }
    const key = ref(line.path, line.sequence);
    const expected =
      claim.form === 'structured' ? (claim.digest as string) : baselineEntries.get(key)?.sha256;
    if (expected !== undefined && expected !== line.sha256) {
      unresolved(
        'DIGEST_MISMATCH',
        line.path,
        line.sequence,
        `expects ${expected}, the line bytes hash to ${line.sha256}`,
      );
      return;
    }
    const first = anchored.get(key);
    if (first !== undefined) {
      unresolved('DUPLICATE_ANCHOR', line.path, line.sequence, `is already anchored by ${first}`);
      return;
    }
    anchored.set(key, recordId);
    if (claim.form === 'structured') digestAnchored.add(key);
    anchors.push({
      record_id: recordId,
      path: line.path,
      sequence: line.sequence,
      status: 'anchored',
    });
  });

  // The append-only baseline: lines not yet present are appended, never changed or removed.
  const additions: BaselineEntry[] = [];
  for (const [key, line] of lines) {
    if (baselineEntries.has(key)) continue;
    const entry: BaselineEntry = {
      path: line.path,
      sequence: line.sequence,
      sha256: line.sha256,
      anchor_status: anchored.has(key) ? 'anchored' : 'orphaned',
      observed_at: observedAt,
    };
    additions.push(entry);
    if (write) baselineEntries.set(key, entry);
  }

  // Governed historical declarations: Architect-authorized, digest-anchored, before the cutoff.
  const declarations: ProofDeclarationFinding[] = [];
  const acknowledged = new Set<string>();
  for (const [key, line] of lines) {
    if (line.kind !== HISTORICAL_GAP_KIND) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.bytes.toString('utf8')) as unknown;
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && parsed['line_type'] !== 'record') continue;
    const payload = isRecord(parsed) ? parsed['payload'] : undefined;
    const reasons = new Set<string>();
    const named: string[] = [];
    const authorization = isRecord(payload) ? payload['authorization'] : undefined;
    if (
      !isRecord(authorization) ||
      authorization['role'] !== 'Architect' ||
      typeof authorization['decision'] !== 'string' ||
      authorization['decision'].trim().length === 0
    ) {
      reasons.add('MISSING_AUTHORIZATION');
    }
    if (!digestAnchored.has(key)) reasons.add('UNANCHORED_DECLARATION');
    if (isRecord(payload) && payload['cutoff'] !== cutoff) reasons.add('CUTOFF_MISMATCH');
    const orphans =
      isRecord(payload) && Array.isArray(payload['orphans']) ? payload['orphans'] : [];
    const seen = new Set<string>();
    for (const orphan of orphans) {
      if (
        !isRecord(orphan) ||
        typeof orphan['path'] !== 'string' ||
        typeof orphan['sequence'] !== 'number' ||
        !Number.isSafeInteger(orphan['sequence'])
      ) {
        reasons.add('INVALID_DECLARATION');
        continue;
      }
      const target = ref(orphan['path'], orphan['sequence']);
      const digest = orphan['sha256'];
      const hasDigest = typeof digest === 'string' && DIGEST.test(digest);
      if (!hasDigest) reasons.add('MISSING_DIGEST');
      if (seen.has(target) || acknowledged.has(target)) reasons.add('DUPLICATE_DECLARATION');
      seen.add(target);
      const physical = lines.get(target);
      if (physical === undefined) {
        reasons.add('NO_LINE');
      } else {
        if (hasDigest && physical.sha256 !== digest) {
          reasons.add('DIGEST_MISMATCH');
          errors.push(
            `DECLARED_DIGEST_MISMATCH ${target}: the declaration ${key} names ${digest}, the line bytes hash to ${physical.sha256}`,
          );
        }
        if (anchored.has(target)) {
          reasons.add('ANCHORED_LINE');
          errors.push(
            `DECLARED_LINE_ANCHORED ${target}: the declaration ${key} names a line that already has a direct anchor`,
          );
        }
      }
      if (baselineEntries.get(target)?.observed_at !== cutoff) reasons.add('POST_CUTOFF');
      named.push(target);
    }
    if (reasons.size === 0 && (named.length === 0 || !validateDeclaration(payload))) {
      reasons.add('INVALID_DECLARATION');
    }
    if (reasons.size === 0) {
      for (const target of named) acknowledged.add(target);
    } else {
      errors.push(
        `DECLARATION_REJECTED ${key}: ${[...reasons].join(', ')}; the lines it names stay orphans`,
      );
    }
    declarations.push({
      path: line.path,
      sequence: line.sequence,
      status: reasons.size === 0 ? 'accepted' : 'rejected',
      reasons: [...reasons],
    });
  }

  // Every physical line has exactly one direct anchor or one accepted declaration.
  const findings: ProofLineFinding[] = [];
  for (const [key, line] of lines) {
    const base = { path: line.path, sequence: line.sequence, sha256: line.sha256 };
    if (anchored.has(key)) {
      findings.push({ ...base, label: 'anchored' });
    } else if (acknowledged.has(key)) {
      findings.push({ ...base, label: ACKNOWLEDGED });
    } else if (line.newest) {
      findings.push({
        ...base,
        label: 'UNANCHORED_NEWEST_LINE',
        remediation: UNANCHORED_NEWEST_REMEDIATION,
      });
      errors.push(`UNANCHORED_NEWEST_LINE ${key}: ${UNANCHORED_NEWEST_REMEDIATION}`);
    } else {
      findings.push({ ...base, label: 'orphan' });
      errors.push(
        `PROOF_LINE_ORPHAN ${key}: no direct anchor and no accepted historical declaration`,
      );
    }
  }

  const created = loaded === null;
  const appended = write ? additions.length : 0;
  if (write && (created || appended > 0)) {
    const next: Baseline = {
      schemaVersion: '1.0.0',
      record: 'ADR-EVI-0002',
      cutoff,
      entries: [...(loaded?.entries ?? []), ...additions],
    };
    if (!validateBaseline(next)) {
      throw new Error(
        `PROOF_ANCHOR_BASELINE_INVALID: the baseline to write does not validate: ${JSON.stringify(validateBaseline.errors)}`,
      );
    }
    const absolute = join(root, PROOF_ANCHOR_BASELINE_PATH);
    if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    valid: errors.length === 0,
    chain,
    baseline: { path: PROOF_ANCHOR_BASELINE_PATH, cutoff, created: write && created, appended },
    lines: findings,
    anchors,
    declarations,
    errors,
  };
}
