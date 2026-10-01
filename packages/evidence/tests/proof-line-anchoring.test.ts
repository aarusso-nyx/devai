// ADR-EVI-0002 (IA-001 to IA-005): the line-level cross-check of `record/proofs/chain.json`
// against every physical proof line, the append-only anchor baseline, the governed historical
// declaration, and the crash-recovery rule. The contract is docs/reference/cli/evidence-verify.md,
// law/schemas/proof-anchor-baseline.schema.json, and law/schemas/proof-orphan-declaration.schema.json.
// The DETRAN fixture under tests/fixtures/proof-baseline/detran-r0020 is byte-exact and is only
// ever copied into a temporary directory before a run that writes.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../authority/tests/unit/authority-host-test-scope.js';
import * as chainModule from '../src/evidence/chain.js';
import {
  appendRecord,
  computeManifestHash,
  extractManifestInputs,
  initChain,
  loadChain,
  saveChain,
  verifyChain,
  type EvidenceRecord,
} from '../src/evidence/chain.js';
import { appendProofEpochRecord } from '../src/evidence/proof-epoch.js';
import * as verbModule from '../src/evidence/verb-evidence.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

/* ------------------------------------------------------------------------------------------ */
/* The interface TASK-0436 adds. `packages/evidence/src/evidence/chain.ts` exports (directly or */
/* by re-export from `anchors.ts`) the three functions below; `appendVerbEvidence` accepts a     */
/* `proofAnchor` and records `proof_path`, `proof_sequence`, and `proof_sha256` on the entry.  */
/* ------------------------------------------------------------------------------------------ */

type LineLabel = 'anchored' | 'orphan' | 'historical gap acknowledged' | 'UNANCHORED_NEWEST_LINE';
type AnchorFailure = 'NO_LINE' | 'DUPLICATE_ANCHOR' | 'DIGEST_MISMATCH' | 'MALFORMED_ANCHOR';
type DeclarationRejection =
  | 'POST_CUTOFF'
  | 'MISSING_AUTHORIZATION'
  | 'MISSING_DIGEST'
  | 'UNANCHORED_DECLARATION'
  | 'DUPLICATE_DECLARATION';

interface LineFinding {
  readonly path: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly label: LineLabel;
  readonly remediation?: string;
}

interface AnchorFinding {
  readonly record_id: string;
  readonly path: string | null;
  readonly sequence: number | null;
  readonly status: 'anchored' | 'unresolved';
  readonly reason?: AnchorFailure;
}

interface DeclarationFinding {
  readonly path: string;
  readonly sequence: number;
  readonly status: 'accepted' | 'rejected';
  readonly reasons: readonly string[];
}

interface ProofAnchorVerification {
  readonly valid: boolean;
  /** The unchanged `verifyChain` result: sequence, link, manifest hash, and head. */
  readonly chain: { readonly valid: boolean; readonly errors: readonly string[] };
  readonly baseline: {
    readonly path: string;
    readonly cutoff: string;
    readonly created: boolean;
    readonly appended: number;
  };
  readonly lines: readonly LineFinding[];
  readonly anchors: readonly AnchorFinding[];
  readonly declarations: readonly DeclarationFinding[];
  /** Every failure; a line is named as `<canonical path>:<sequence>`. */
  readonly errors: readonly string[];
}

type ProofAnchorResolution =
  | {
      readonly resolved: true;
      readonly path: string;
      readonly sequence: number;
      readonly sha256: string;
    }
  | { readonly resolved: false; readonly reason: string };

interface AnchoringExports {
  readonly verifyProofAnchors: (inputs: {
    readonly repoRoot: string;
    readonly chainPath?: string;
    readonly now?: Date;
    /** `--write` consent: only with it may the baseline be created or appended to. */
    readonly write?: boolean;
  }) => ProofAnchorVerification;
  readonly resolveProofAnchor: (
    repoRoot: string,
    anchor: { readonly path: string; readonly sequence: number },
  ) => ProofAnchorResolution;
  readonly proofLineDigest: (line: Uint8Array | string) => string;
}

function anchoring<K extends keyof AnchoringExports>(name: K): AnchoringExports[K] {
  const exported = (chainModule as unknown as Partial<AnchoringExports>)[name];
  if (typeof exported !== 'function') {
    throw new TypeError(`${name} is not exported from packages/evidence/src/evidence/chain.ts`);
  }
  return exported as AnchoringExports[K];
}

/** A verification with write consent, so the baseline is written or appended. */
const verify = (repoRoot: string, now: Date): ProofAnchorVerification =>
  anchoring('verifyProofAnchors')({ repoRoot, now, write: true });

/** A read-only verification: it never creates or changes the baseline. */
const verifyReadOnly = (repoRoot: string, now: Date): ProofAnchorVerification =>
  anchoring('verifyProofAnchors')({ repoRoot, now });

interface ProofAnchorInput {
  readonly path: string;
  readonly sequence: number;
}

type AppendVerbEvidence = (
  inputs: Parameters<typeof verbModule.appendVerbEvidence>[0] & {
    readonly proofAnchor?: ProofAnchorInput;
  },
) => ReturnType<typeof verbModule.appendVerbEvidence>;

/** The facade's two-step writer, second step: the chain entry that anchors one line by digest. */
function anchorWithDigest(repoRoot: string, kind: string, roundId: string, sequence: number): void {
  const append = verbModule.appendVerbEvidence as AppendVerbEvidence;
  const result = append({
    repoRoot,
    action: `evidence.record.${kind}`,
    status: 'completed',
    notes: [`round_id=${roundId}`, `proof_sequence=${String(sequence)}`],
    proofAnchor: { path: epochPath(kind, roundId), sequence },
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

/** The roster validators TASK-0436 registers for the two Architect schemas. */
function schemaValidator(
  name: 'proofAnchorBaseline' | 'proofOrphanDeclaration',
): (value: unknown) => boolean {
  const validate = (
    validators as unknown as Record<string, ((value: unknown) => boolean) | undefined>
  )[name];
  if (typeof validate !== 'function') {
    throw new TypeError(`validators.${name} is not registered in packages/schemas/src/roster.ts`);
  }
  return validate;
}

/* ------------------------------------------------------------------------------------------ */

const DETRAN = fileURLToPath(
  new URL('../../../tests/fixtures/proof-baseline/detran-r0020', import.meta.url),
);
const BASELINE = 'record/proofs/anchor-baseline.json';
const CHAIN = 'record/proofs/chain.json';
const ACKNOWLEDGED = 'historical gap acknowledged';
const T0 = new Date('2026-10-02T00:00:00.000Z');
const T1 = new Date('2026-10-02T01:00:00.000Z');
const T2 = new Date('2026-10-02T02:00:00.000Z');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-proof-anchoring-'));
  roots.push(root);
  return root;
}

function detranCopy(): string {
  const root = tempRoot();
  cpSync(join(DETRAN, 'record'), join(root, 'record'), { recursive: true });
  return root;
}

function epochPath(kind: string, roundId: string): string {
  return `record/proofs/work/${kind}/${roundId}.jsonl`;
}

function ref(path: string, sequence: number): string {
  return `${path}:${String(sequence)}`;
}

/** Whether a diagnostic names `<path>:<sequence>` exactly, so `:3` never matches `:38`. */
function names(diagnostics: readonly string[], line: string): boolean {
  const escaped = line.replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&');
  const pattern = new RegExp(`${escaped}(?![0-9])`, 'u');
  return diagnostics.some((text) => pattern.test(text));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The physical lines of one epoch file, split on LF, exclusive of the newline. */
function physicalLines(root: string, path: string): Buffer[] {
  const bytes = readFileSync(join(root, path));
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return lines;
}

function lineDigest(root: string, path: string, sequence: number): string {
  const line = physicalLines(root, path)[sequence - 1];
  if (line === undefined) throw new Error(`fixture line ${ref(path, sequence)} is missing`);
  return sha256(line);
}

interface Triple {
  readonly path: string;
  readonly sequence: number;
  readonly sha256: string;
}

/** The 52 orphan identities fixed by the adopter contract CTG-0002.md, parsed from its tables. */
function contractOrphans(): Triple[] {
  const text = readFileSync(join(DETRAN, 'CTG-0002.md'), 'utf8');
  const orphans: Triple[] = [];
  let round: string | null = null;
  for (const line of text.split('\n')) {
    const heading = /^### (R-\d{4}) — `([^`]+)`/u.exec(line);
    if (heading !== null) {
      round = heading[1] ?? null;
      expect(heading[2]).toBe(epochPath('generic', round ?? ''));
      continue;
    }
    if (line.startsWith('### ')) round = null;
    const row = /^\| (\d+)\s+\| `([0-9a-f]{64})` \|$/u.exec(line);
    if (row !== null && round !== null) {
      orphans.push({
        path: epochPath('generic', round),
        sequence: Number(row[1]),
        sha256: row[2] ?? '',
      });
    }
  }
  return orphans;
}

/** The canonical TSV digest CTG-0002.md fixes for its 52 triples. */
function canonicalOrphanDigest(triples: readonly Triple[]): string {
  const sorted = [...triples].sort((left, right) =>
    left.path === right.path
      ? left.sequence - right.sequence
      : Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return sha256(
    sorted
      .map((triple) => `${triple.path}\t${String(triple.sequence)}\t${triple.sha256}\n`)
      .join(''),
  );
}

const CTG_0002_ORPHAN_DIGEST = 'f7e35c3977f6da17344c26605982d046a9f844cb4612d3acbc565ec9f01dd37b';

interface DeclarationOptions {
  readonly cutoff: string;
  readonly orphans: readonly Partial<Triple>[];
  readonly authorization?: Record<string, unknown> | null;
}

/** A payload that validates against proof-orphan-declaration.schema.json unless an option breaks it. */
function declarationPayload(options: DeclarationOptions): Record<string, unknown> {
  const authorization =
    options.authorization === undefined
      ? { role: 'Architect', decision: 'CTG-0002', authorized_at: T1.toISOString() }
      : options.authorization;
  return {
    schemaVersion: '1.0.0',
    declaration: 'historical-gap',
    record: 'ADR-EVI-0002',
    ...(authorization !== null && { authorization }),
    cutoff: options.cutoff,
    cause: 'source_pending',
    orphans: options.orphans,
  };
}

/** Appends a `historical-gap` proof line in round R-0020; anchors it by digest unless told not to. */
function declare(
  root: string,
  payload: Record<string, unknown>,
  anchor: 'digest' | 'notes-only' | 'none' = 'digest',
): Triple {
  const line = appendProofEpochRecord({
    repoRoot: root,
    roundId: 'R-0020',
    kind: 'historical-gap',
    payload,
  });
  const path = epochPath('historical-gap', 'R-0020');
  if (anchor === 'digest') anchorWithDigest(root, 'historical-gap', 'R-0020', line.sequence);
  if (anchor === 'notes-only') {
    appendNotesAnchor(root, 'historical-gap', 'R-0020', line.sequence);
  }
  return { path, sequence: line.sequence, sha256: lineDigest(root, path, line.sequence) };
}

let recordCounter = 0;

/** A historical-form anchor: an `evidence.record.<kind>` entry whose only anchor is its notes. */
function appendNotesAnchor(
  root: string,
  kind: string,
  roundId: string,
  sequence: number,
  notes: readonly string[] = [`round_id=${roundId}`, `proof_sequence=${String(sequence)}`],
): void {
  const chainPath = join(root, CHAIN);
  initChain(chainPath);
  recordCounter += 1;
  appendRecord(chainPath, {
    id: `EV-${recordCounter.toString(16).padStart(16, '0')}`,
    timestamp: T0.toISOString(),
    actor: 'devai-cli',
    actor_role: 'harness',
    action: `evidence.record.${kind}`,
    status: 'completed',
    context: { repo_root: root, git: { head_sha: null, dirty_files: [] } },
    notes,
  });
}

/**
 * A new-form anchor written raw, so that a test can craft a non-canonical path, an out-of-epoch
 * sequence, or a wrong digest. The manifest hash and links are computed exactly as appendRecord
 * does, so the cryptographic chain stays valid and only the anchor is defective.
 */
function appendRawAnchor(
  root: string,
  fields: {
    readonly proof_path: string;
    readonly proof_sequence: number;
    readonly proof_sha256: string;
  },
): void {
  const chainPath = join(root, CHAIN);
  initChain(chainPath);
  const chain = loadChain(chainPath);
  recordCounter += 1;
  const draft = {
    schemaVersion: '1.0.0' as const,
    id: `EV-${recordCounter.toString(16).padStart(16, '0')}`,
    timestamp: T0.toISOString(),
    actor: 'devai-cli',
    actor_role: 'harness',
    action: 'evidence.record.generic',
    status: 'completed',
    context: { repo_root: root, git: { head_sha: null, dirty_files: [] } },
    artifacts: [],
    previous_run_hash: chain.head,
    manifest_hash: '',
    sequence: chain.records.length + 1,
    previous_hash: chain.head ?? 'GENESIS',
    ...fields,
  };
  const record = { ...draft, manifest_hash: computeManifestHash(extractManifestInputs(draft)) };
  chain.records.push(record as EvidenceRecord);
  chain.head = record.manifest_hash;
  saveChain(chainPath, chain);
}

function appendGeneric(root: string, roundId: string, note: string): number {
  return appendProofEpochRecord({
    repoRoot: root,
    roundId,
    kind: 'generic',
    payload: { note },
  }).sequence;
}

function labelled(result: ProofAnchorVerification, label: LineLabel): string[] {
  return result.lines
    .filter((line) => line.label === label)
    .map((line) => ref(line.path, line.sequence));
}

function readBaseline(root: string): {
  cutoff: string;
  entries: {
    path: string;
    sequence: number;
    sha256: string;
    anchor_status: string;
    observed_at: string;
  }[];
} {
  return JSON.parse(readFileSync(join(root, BASELINE), 'utf8')) as ReturnType<typeof readBaseline>;
}

/* ------------------------------------------------------------------------------------------ */

describe('the DETRAN baseline fixture (OE-01)', () => {
  it('holds 119 lines, 67 anchored by notes, and the 52 orphans CTG-0002.md fixes', () => {
    const chain = loadChain(join(DETRAN, CHAIN));
    expect(chain.records).toHaveLength(106);
    expect(verifyChain(join(DETRAN, CHAIN))).toEqual({ valid: true, errors: [] });
    const anchored = new Set<string>();
    for (const record of chain.records) {
      const notes = Object.fromEntries(
        (record.notes ?? []).map((note) => note.split('=', 2) as [string, string]),
      );
      if (notes['proof_sequence'] !== undefined && notes['round_id'] !== undefined) {
        const key = ref(epochPath('generic', notes['round_id']), Number(notes['proof_sequence']));
        expect(anchored.has(key), `duplicate anchor ${key}`).toBe(false);
        anchored.add(key);
      }
    }
    const lines: string[] = [];
    for (let round = 1; round <= 19; round += 1) {
      const path = epochPath('generic', `R-${String(round).padStart(4, '0')}`);
      physicalLines(DETRAN, path).forEach((_, index) => lines.push(ref(path, index + 1)));
    }
    expect(lines).toHaveLength(119);
    expect(lines.filter((line) => anchored.has(line))).toHaveLength(67);
    const orphans = contractOrphans();
    expect(orphans).toHaveLength(52);
    expect(canonicalOrphanDigest(orphans)).toBe(CTG_0002_ORPHAN_DIGEST);
    expect(lines.filter((line) => !anchored.has(line)).sort()).toEqual(
      orphans.map((orphan) => ref(orphan.path, orphan.sequence)).sort(),
    );
    for (const orphan of orphans) {
      expect(lineDigest(DETRAN, orphan.path, orphan.sequence)).toBe(orphan.sha256);
    }
  });
});

describe('the baseline write is gated by write consent', () => {
  it('fails PROOF_ANCHOR_BASELINE_MISSING and writes nothing without a baseline and without write', () => {
    const root = detranCopy();
    const result = verifyReadOnly(root, T0);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('PROOF_ANCHOR_BASELINE_MISSING'))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.includes('--write'))).toBe(true);
    expect(existsSync(join(root, BASELINE))).toBe(false);
    const explicit = anchoring('verifyProofAnchors')({ repoRoot: root, now: T0, write: false });
    expect(explicit.valid).toBe(false);
    expect(explicit.errors.some((error) => error.includes('PROOF_ANCHOR_BASELINE_MISSING'))).toBe(
      true,
    );
    expect(existsSync(join(root, BASELINE))).toBe(false);
  });

  it('reads a written baseline without write and never appends to it', () => {
    const root = tempRoot();
    anchorWithDigest(root, 'generic', 'R-0001', appendGeneric(root, 'R-0001', 'one'));
    expect(verify(root, T0).valid).toBe(true);
    const written = readFileSync(join(root, BASELINE), 'utf8');
    expect(verifyReadOnly(root, T1).valid).toBe(true);
    anchorWithDigest(root, 'generic', 'R-0001', appendGeneric(root, 'R-0001', 'two'));
    const read = verifyReadOnly(root, T2);
    expect(read.errors.some((error) => error.includes('PROOF_ANCHOR_BASELINE_MISSING'))).toBe(
      false,
    );
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(written);
  });
});

describe('IA-001 the historical declaration over the DETRAN baseline', () => {
  it('fails before the declaration listing every one of the 52 orphans and writes the baseline', () => {
    const root = detranCopy();
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.chain).toEqual({ valid: true, errors: [] });
    const expected = contractOrphans().map((orphan) => ref(orphan.path, orphan.sequence));
    expect(labelled(result, 'orphan').sort()).toEqual([...expected].sort());
    expect(labelled(result, 'anchored')).toHaveLength(67);
    expect(labelled(result, ACKNOWLEDGED)).toEqual([]);
    expect(labelled(result, 'UNANCHORED_NEWEST_LINE')).toEqual([]);
    for (const line of expected) {
      expect(names(result.errors, line), line).toBe(true);
    }

    expect(result.baseline).toMatchObject({
      path: BASELINE,
      cutoff: T0.toISOString(),
      created: true,
      appended: 119,
    });
    const baseline = readBaseline(root);
    expect(schemaValidator('proofAnchorBaseline')(baseline)).toBe(true);
    expect(baseline).toMatchObject({
      schemaVersion: '1.0.0',
      record: 'ADR-EVI-0002',
      cutoff: T0.toISOString(),
    });
    expect(baseline.entries).toHaveLength(119);
    expect(baseline.entries.every((entry) => entry.observed_at === T0.toISOString())).toBe(true);
    const orphaned = baseline.entries.filter((entry) => entry.anchor_status === 'orphaned');
    expect(
      orphaned.map(({ path, sequence, sha256: digest }) => ({ path, sequence, sha256: digest })),
    ).toEqual(expect.arrayContaining(contractOrphans()));
    expect(orphaned).toHaveLength(52);
    for (const entry of baseline.entries) {
      expect(entry.sha256).toBe(lineDigest(root, entry.path, entry.sequence));
    }
  });

  it('passes after an anchored Architect declaration, labelling the 52 lines acknowledged', () => {
    const root = detranCopy();
    verify(root, T0);
    const payload = declarationPayload({ cutoff: T0.toISOString(), orphans: contractOrphans() });
    expect(schemaValidator('proofOrphanDeclaration')(payload)).toBe(true);
    const declaration = declare(root, payload);

    const result = verify(root, T1);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    const acknowledged = labelled(result, ACKNOWLEDGED).sort();
    expect(acknowledged).toEqual(
      contractOrphans()
        .map((orphan) => ref(orphan.path, orphan.sequence))
        .sort(),
    );
    expect(labelled(result, 'orphan')).toEqual([]);
    expect(labelled(result, 'anchored')).toContain(ref(declaration.path, declaration.sequence));
    expect(labelled(result, 'anchored')).toHaveLength(68);
    expect(result.declarations).toEqual([
      { path: declaration.path, sequence: declaration.sequence, status: 'accepted', reasons: [] },
    ]);

    // The declaration acknowledges the gap on every later verification, never as restored.
    const again = verify(root, T2);
    expect(again.valid).toBe(true);
    expect(labelled(again, ACKNOWLEDGED)).toHaveLength(52);
  });

  it('keeps the baseline append-only: the cutoff and every entry survive, new lines are appended', () => {
    const root = detranCopy();
    verify(root, T0);
    const first = readFileSync(join(root, BASELINE), 'utf8');
    const declaration = declare(
      root,
      declarationPayload({ cutoff: T0.toISOString(), orphans: contractOrphans() }),
    );
    const result = verify(root, T1);
    expect(result.baseline).toMatchObject({
      cutoff: T0.toISOString(),
      created: false,
      appended: 1,
    });
    const before = JSON.parse(first) as ReturnType<typeof readBaseline>;
    const after = readBaseline(root);
    expect(after.cutoff).toBe(before.cutoff);
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
    expect(after.entries.slice(before.entries.length)).toEqual([
      {
        path: declaration.path,
        sequence: declaration.sequence,
        sha256: declaration.sha256,
        anchor_status: 'anchored',
        observed_at: T1.toISOString(),
      },
    ]);
    verify(root, T2);
    expect(readBaseline(root)).toEqual(after);
  });
});

describe('IA-002 changed bytes fail naming the line; chain cryptography is unchanged', () => {
  it('fails naming an anchored historical line whose bytes changed after the baseline', () => {
    const root = detranCopy();
    expect(verify(root, T0).baseline.created).toBe(true);
    const path = epochPath('generic', 'R-0001');
    const bytes = readFileSync(join(root, path));
    const year = bytes.indexOf('"timestamp":"2026');
    expect(year).toBeGreaterThan(0);
    bytes[year + '"timestamp":"202'.length] = '7'.charCodeAt(0);
    writeFileSync(join(root, path), bytes);
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    expect(names(result.errors, ref(path, 1))).toBe(true);
    expect(result.chain).toEqual({ valid: true, errors: [] });
  });

  it('fails naming the entry when one byte of the baseline file changes', () => {
    const root = detranCopy();
    verify(root, T0);
    const baseline = readBaseline(root);
    const target = baseline.entries.find((entry) => entry.anchor_status === 'anchored');
    if (target === undefined) throw new Error('no anchored baseline entry');
    const text = readFileSync(join(root, BASELINE), 'utf8');
    const flipped = `${target.sha256.startsWith('0') ? '1' : '0'}${target.sha256.slice(1)}`;
    writeFileSync(join(root, BASELINE), text.replace(target.sha256, flipped));
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    expect(names(result.errors, ref(target.path, target.sequence))).toBe(true);
  });

  it('still reports a broken previous-hash link through the unchanged chain checks', () => {
    const root = detranCopy();
    const chainPath = join(root, CHAIN);
    const chain = loadChain(chainPath);
    const victim = chain.records[49];
    if (victim === undefined) throw new Error('fixture chain is shorter than 50 records');
    victim.previous_run_hash = '0'.repeat(64);
    saveChain(chainPath, chain);
    const direct = verifyChain(chainPath);
    expect(direct.valid).toBe(false);
    expect(Object.keys(direct).sort()).toEqual(['errors', 'valid']);
    expect(direct.errors.some((error) => error.includes('previous_run_hash mismatch'))).toBe(true);
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.chain).toEqual(direct);
  });
});

describe('the bidirectional cross-check on a synthetic epoch', () => {
  function anchoredEpoch(): string {
    const root = tempRoot();
    for (const note of ['one', 'two', 'three']) {
      const sequence = appendGeneric(root, 'R-0001', note);
      anchorWithDigest(root, 'generic', 'R-0001', sequence);
    }
    return root;
  }

  it('accepts lines whose new anchors carry the digest of their bytes as structured fields', () => {
    const root = anchoredEpoch();
    const path = epochPath('generic', 'R-0001');
    const records = loadChain(join(root, CHAIN)).records as unknown as Record<string, unknown>[];
    expect(records.map((record) => record['proof_sequence'])).toEqual([1, 2, 3]);
    for (const [index, record] of records.entries()) {
      expect(record).toMatchObject({
        proof_path: path,
        proof_sequence: index + 1,
        proof_sha256: lineDigest(root, path, index + 1),
        notes: ['round_id=R-0001', `proof_sequence=${String(index + 1)}`],
      });
    }
    const result = verify(root, T0);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(labelled(result, 'anchored')).toEqual([ref(path, 1), ref(path, 2), ref(path, 3)]);
    expect(result.anchors.every((anchor) => anchor.status === 'anchored')).toBe(true);
  });

  it('rejects a duplicate anchor of the same line', () => {
    const root = anchoredEpoch();
    anchorWithDigest(root, 'generic', 'R-0001', 2);
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.anchors.some((anchor) => anchor.reason === 'DUPLICATE_ANCHOR')).toBe(true);
    expect(names(result.errors, ref(epochPath('generic', 'R-0001'), 2))).toBe(true);
  });

  it.each([
    ['a missing proof_sequence', ['round_id=R-0001']],
    ['a non-numeric proof_sequence', ['round_id=R-0001', 'proof_sequence=one']],
    ['a malformed round_id', ['round_id=R-1', 'proof_sequence=1']],
    ['a partial key match', ['round_id=R-0001', 'proof_sequence_=1']],
  ])('rejects a record anchor with %s', (_, notes) => {
    const root = anchoredEpoch();
    appendNotesAnchor(root, 'generic', 'R-0001', 1, notes);
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.anchors.some((anchor) => anchor.reason === 'MALFORMED_ANCHOR')).toBe(true);
  });

  it('rejects anchors to a missing line and to a missing file', () => {
    const root = anchoredEpoch();
    appendNotesAnchor(root, 'generic', 'R-0001', 4);
    appendNotesAnchor(root, 'generic', 'R-0009', 1);
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    const missing = result.anchors.filter((anchor) => anchor.reason === 'NO_LINE');
    expect(missing.map((anchor) => [anchor.path, anchor.sequence])).toEqual([
      [epochPath('generic', 'R-0001'), 4],
      [epochPath('generic', 'R-0009'), 1],
    ]);
  });

  it('rejects a new undeclared orphan that is not the newest line of its epoch', () => {
    const root = anchoredEpoch();
    verify(root, T0);
    const orphan = appendGeneric(root, 'R-0001', 'four');
    anchorWithDigest(root, 'generic', 'R-0001', appendGeneric(root, 'R-0001', 'five'));
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    expect(labelled(result, 'orphan')).toEqual([ref(epochPath('generic', 'R-0001'), orphan)]);
    expect(labelled(result, 'UNANCHORED_NEWEST_LINE')).toEqual([]);
  });
});

describe('IA-003 declarations that are rejected leave their orphans reported', () => {
  function expectRejected(
    result: ProofAnchorVerification,
    declaration: Triple,
    reason: DeclarationRejection,
    stillOrphaned: readonly string[],
  ): void {
    expect(result.valid).toBe(false);
    const finding = result.declarations.find(
      (entry) => entry.path === declaration.path && entry.sequence === declaration.sequence,
    );
    expect(finding, JSON.stringify(result.declarations)).toMatchObject({ status: 'rejected' });
    expect(finding?.reasons).toContain(reason);
    expect(labelled(result, ACKNOWLEDGED)).toEqual([]);
    expect(labelled(result, 'orphan')).toEqual(expect.arrayContaining([...stillOrphaned]));
  }

  const contractRefs = (): string[] =>
    contractOrphans().map((orphan) => ref(orphan.path, orphan.sequence));

  it('rejects a declaration naming a line recorded after the cutoff', () => {
    const root = detranCopy();
    verify(root, T0);
    const late = appendGeneric(root, 'R-0021', 'after the cutoff');
    anchorWithDigest(root, 'generic', 'R-0021', appendGeneric(root, 'R-0021', 'anchored'));
    const lateRef = ref(epochPath('generic', 'R-0021'), late);
    expect(labelled(verify(root, T1), 'orphan')).toContain(lateRef);
    // The cutoff rule: entries observed at the first verification carry the cutoff and are
    // eligible; the late line was observed after it.
    const entries = readBaseline(root).entries;
    const lateEntry = entries.find(
      (entry) => entry.path === epochPath('generic', 'R-0021') && entry.sequence === late,
    );
    expect(lateEntry?.observed_at).toBe(T1.toISOString());
    expect(readBaseline(root).cutoff).toBe(T0.toISOString());
    expect(
      entries
        .filter((entry) => !entry.path.endsWith('/R-0021.jsonl'))
        .every((entry) => entry.observed_at === T0.toISOString()),
    ).toBe(true);
    const orphans = [
      ...contractOrphans(),
      {
        path: epochPath('generic', 'R-0021'),
        sequence: late,
        sha256: lineDigest(root, epochPath('generic', 'R-0021'), late),
      },
    ];
    const declaration = declare(root, declarationPayload({ cutoff: T0.toISOString(), orphans }));
    expectRejected(verify(root, T2), declaration, 'POST_CUTOFF', [...contractRefs(), lateRef]);
  });

  it('rejects a declaration without the Architect authorization', () => {
    for (const authorization of [
      null,
      { role: 'Engineer', decision: 'CTG-0002', authorized_at: T1.toISOString() },
      { role: 'Owner', decision: 'CTG-0002', authorized_at: T1.toISOString() },
    ]) {
      const root = detranCopy();
      verify(root, T0);
      const declaration = declare(
        root,
        declarationPayload({ cutoff: T0.toISOString(), orphans: contractOrphans(), authorization }),
      );
      expectRejected(verify(root, T1), declaration, 'MISSING_AUTHORIZATION', contractRefs());
    }
  });

  it('rejects a declaration that omits the digest of one named orphan', () => {
    const root = detranCopy();
    verify(root, T0);
    const [first, ...rest] = contractOrphans();
    if (first === undefined) throw new Error('no contract orphan');
    const declaration = declare(
      root,
      declarationPayload({
        cutoff: T0.toISOString(),
        orphans: [{ path: first.path, sequence: first.sequence }, ...rest],
      }),
    );
    expectRejected(verify(root, T1), declaration, 'MISSING_DIGEST', contractRefs());
  });

  it('rejects a declaration that is not itself anchored with a digest', () => {
    for (const anchor of ['none', 'notes-only'] as const) {
      const root = detranCopy();
      verify(root, T0);
      const declaration = declare(
        root,
        declarationPayload({ cutoff: T0.toISOString(), orphans: contractOrphans() }),
        anchor,
      );
      expectRejected(verify(root, T1), declaration, 'UNANCHORED_DECLARATION', contractRefs());
    }
  });

  it('rejects a second declaration of an already declared line', () => {
    const root = detranCopy();
    verify(root, T0);
    declare(root, declarationPayload({ cutoff: T0.toISOString(), orphans: contractOrphans() }));
    const [first] = contractOrphans();
    if (first === undefined) throw new Error('no contract orphan');
    const second = declare(
      root,
      declarationPayload({ cutoff: T0.toISOString(), orphans: [first] }),
    );
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    const finding = result.declarations.find((entry) => entry.sequence === second.sequence);
    expect(finding?.status).toBe('rejected');
    expect(finding?.reasons).toContain('DUPLICATE_DECLARATION');
  });

  it('rejects a declaration of a line that already has a direct anchor', () => {
    const root = detranCopy();
    verify(root, T0);
    const path = epochPath('generic', 'R-0001');
    const anchoredLine = { path, sequence: 1, sha256: lineDigest(root, path, 1) };
    declare(
      root,
      declarationPayload({
        cutoff: T0.toISOString(),
        orphans: [...contractOrphans(), anchoredLine],
      }),
    );
    expect(verify(root, T1).valid).toBe(false);
  });

  it('fails naming a declared line whose current bytes differ from the declared digest', () => {
    const root = detranCopy();
    verify(root, T0);
    const orphans = contractOrphans();
    const [first, ...rest] = orphans;
    if (first === undefined) throw new Error('no contract orphan');
    declare(
      root,
      declarationPayload({
        cutoff: T0.toISOString(),
        orphans: [{ ...first, sha256: '0'.repeat(64) }, ...rest],
      }),
    );
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    expect(names(result.errors, ref(first.path, first.sequence))).toBe(true);
  });
});

describe('IA-004 crash recovery between the proof line and the chain entry', () => {
  it('reports UNANCHORED_NEWEST_LINE with the remediation, then recovers by appending its entry', () => {
    const root = tempRoot();
    const path = epochPath('generic', 'R-0004');
    anchorWithDigest(root, 'generic', 'R-0004', appendGeneric(root, 'R-0004', 'one'));
    anchorWithDigest(root, 'generic', 'R-0004', appendGeneric(root, 'R-0004', 'two'));
    expect(verify(root, T0).valid).toBe(true);

    // The writer is killed after the proof line and before the chain entry.
    const crashed = appendGeneric(root, 'R-0004', 'three');
    const epochBytes = readFileSync(join(root, path));
    const result = verify(root, T1);
    expect(result.valid).toBe(false);
    expect(labelled(result, 'UNANCHORED_NEWEST_LINE')).toEqual([ref(path, crashed)]);
    expect(labelled(result, 'orphan')).toEqual([]);
    const newest = result.lines.find((line) => line.label === 'UNANCHORED_NEWEST_LINE');
    expect(newest?.remediation).toMatch(/evidence record/u);
    expect(result.errors.some((error) => error.includes('UNANCHORED_NEWEST_LINE'))).toBe(true);
    expect(names(result.errors, ref(path, crashed))).toBe(true);

    // Recovery appends the chain entry from the existing bytes and writes nothing else.
    anchorWithDigest(root, 'generic', 'R-0004', crashed);
    expect(readFileSync(join(root, path))).toEqual(epochBytes);
    const recovered = verify(root, T2);
    expect(recovered.errors).toEqual([]);
    expect(recovered.valid).toBe(true);
  });

  it('treats only the newest line as crash residue; an older unanchored line is an orphan', () => {
    const root = tempRoot();
    const path = epochPath('generic', 'R-0004');
    const older = appendGeneric(root, 'R-0004', 'one');
    anchorWithDigest(root, 'generic', 'R-0004', appendGeneric(root, 'R-0004', 'two'));
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(labelled(result, 'orphan')).toEqual([ref(path, older)]);
    expect(labelled(result, 'UNANCHORED_NEWEST_LINE')).toEqual([]);
  });

  it('fails a new anchor whose digest differs from the line bytes', () => {
    const root = tempRoot();
    const path = epochPath('generic', 'R-0004');
    const sequence = appendGeneric(root, 'R-0004', 'one');
    appendRawAnchor(root, {
      proof_path: path,
      proof_sequence: sequence,
      proof_sha256: 'f'.repeat(64),
    });
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.chain.valid).toBe(true);
    expect(result.anchors.map((anchor) => anchor.reason)).toEqual(['DIGEST_MISMATCH']);
    expect(names(result.errors, ref(path, sequence))).toBe(true);
  });
});

describe('IA-005 canonical paths and the epoch namespace never match loosely', () => {
  function twoEpochs(): { root: string; path: string } {
    const root = tempRoot();
    appendGeneric(root, 'R-0001', 'one');
    appendGeneric(root, 'R-0001', 'two');
    appendGeneric(root, 'R-0002', 'only');
    return { root, path: epochPath('generic', 'R-0001') };
  }

  it('resolves a canonical anchor to the SHA-256 of the line bytes, not the line_hash', () => {
    const { root, path } = twoEpochs();
    const resolution = anchoring('resolveProofAnchor')(root, { path, sequence: 2 });
    const bytes = physicalLines(root, path)[1];
    if (bytes === undefined) throw new Error('second line missing');
    const lineHash = (JSON.parse(bytes.toString('utf8')) as { line_hash: string }).line_hash;
    expect(resolution).toEqual({ resolved: true, path, sequence: 2, sha256: sha256(bytes) });
    expect(sha256(bytes)).not.toBe(lineHash);
    expect(anchoring('proofLineDigest')(bytes)).toBe(sha256(bytes));
    expect(anchoring('proofLineDigest')(bytes.toString('utf8'))).toBe(sha256(bytes));
  });

  it.each([
    ['a backslash path', 'record\\proofs\\work\\generic\\R-0001.jsonl', 1],
    ['a mixed-separator path', 'record/proofs/work/generic\\R-0001.jsonl', 1],
    ['a dot segment', 'record/proofs/work/generic/./R-0001.jsonl', 1],
    ['a dot-dot segment', 'record/proofs/work/other/../generic/R-0001.jsonl', 1],
    ['a leading slash', '/record/proofs/work/generic/R-0001.jsonl', 1],
    ['a leading dot segment', './record/proofs/work/generic/R-0001.jsonl', 1],
    ['a non-canonical kind', 'record/proofs/work/Generic/R-0001.jsonl', 1],
    ['a non-canonical round', 'record/proofs/work/generic/R-1.jsonl', 1],
    ['sequence zero', 'record/proofs/work/generic/R-0001.jsonl', 0],
    ['a sequence beyond the file', 'record/proofs/work/generic/R-0001.jsonl', 3],
    ['a sequence only another epoch has', 'record/proofs/work/generic/R-0002.jsonl', 2],
    ['a fractional sequence', 'record/proofs/work/generic/R-0001.jsonl', 1.5],
  ])('resolves an anchor with %s to no line', (_, path, sequence) => {
    const { root } = twoEpochs();
    expect(anchoring('resolveProofAnchor')(root, { path, sequence })).toMatchObject({
      resolved: false,
    });
  });

  it('resolves no anchor into a file whose last byte is not a newline, and fails it', () => {
    const { root, path } = twoEpochs();
    const bytes = readFileSync(join(root, path));
    writeFileSync(join(root, path), bytes.subarray(0, bytes.length - 1));
    for (const sequence of [1, 2]) {
      expect(anchoring('resolveProofAnchor')(root, { path, sequence })).toMatchObject({
        resolved: false,
      });
    }
    appendNotesAnchor(root, 'generic', 'R-0001', 1);
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(path))).toBe(true);
    expect(result.anchors.some((anchor) => anchor.status === 'unresolved')).toBe(true);
  });

  it.each([
    ['a backslash path', 'record\\proofs\\work\\generic\\R-0001.jsonl', 1],
    ['a dot-dot segment', 'record/proofs/work/x/../generic/R-0001.jsonl', 1],
    ['a sequence outside the epoch', 'record/proofs/work/generic/R-0001.jsonl', 9],
  ])('fails the verification for a chain anchor with %s', (_, path, sequence) => {
    const { root } = twoEpochs();
    const canonical = epochPath('generic', 'R-0001');
    const digest = lineDigest(root, canonical, 1);
    appendRawAnchor(root, { proof_path: path, proof_sequence: sequence, proof_sha256: digest });
    const result = verify(root, T0);
    expect(result.valid).toBe(false);
    expect(result.anchors).toEqual([
      expect.objectContaining({ status: 'unresolved', reason: 'NO_LINE' }),
    ]);
    expect(labelled(result, 'anchored')).toEqual([]);
  });
});
