import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getValidator, validators } from '@devai-nyx/schemas';
import {
  canonicalJson,
  computeEvidenceEpochLineHash,
  computeEvidenceManifestHash,
} from '@devai-nyx/utils';
import { requireScope } from './host-operation.js';
import { scopes } from './host-scope.js';
import { parseProofIndex, type ProofIndexSnapshot } from './proof-index-codec.js';
import {
  captureReconciliationHostContext,
  disposeReconciliationHostContext,
  readReconciliationHostIdentity,
  readReconciliationHostPaths,
  type ReconciliationHostIdentity,
} from './reconciliation-host-context.js';
import {
  readReconciliationHostBinding,
  readReconciliationPlanSelectors,
  readReconciliationInitialApprovalInput,
  readReconciliationExistingApprovalInput,
} from './reconciliation-host-operation.js';
import { checkReconciliationClockWindow } from '../runtime/reconciliation-clock.js';
import {
  createReconciliationEffectPlan,
  type ReconciliationEffectPlan,
} from './reconciliation-effect-plan.js';
import {
  readReconciliationHostApproval,
  readReconciliationHostApprovalUnderAdmission,
} from './reconciliation-host-owner.js';
import type { ReconciliationAdmissionAnchor } from './host-reconciliation-admission.js';

import { decodeReconciliationOwnerRecord } from '../runtime/reconciliation-owner-record.js';
import { readNativePrivateFile, provisionBytesSha } from './reconciliation-host-namespace.js';
import { buildReconciliationSelection } from './reconciliation-selection.js';
import { readReconciliationCustodyObjects } from './reconciliation-custody-input.js';

const CHAIN = 'record/proofs/chain.json';
const CATALOGUE = 'law/security/authorization.json';
const BASELINE = 'record/proofs/anchor-baseline.json';
const STAGED = '@staged';
const MAX_BLOB = 32 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_COMMITS = 20000;
const ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'https:ssh:file',
});
const GIT = [
  '--no-optional-locks',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'core.sshCommand=/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oUpdateHostKeys=no -oControlMaster=no -oControlPath=none',
];

type Code =
  | 'RECONCILIATION_PLAN_INVALID'
  | 'RECONCILIATION_PLAN_STALE'
  | 'RECONCILIATION_PLAN_LIMIT'
  | 'RECONCILIATION_PLAN_SOURCE_INVALID'
  | 'RECONCILIATION_PLAN_PUBLICATION_INVALID';
export class ReconciliationPlanError extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = 'ReconciliationPlanError';
  }
}
function fail(code: Code = 'RECONCILIATION_PLAN_INVALID'): never {
  throw new ReconciliationPlanError(code);
}
function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function utf8(bytes: Uint8Array): string {
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(value).equals(Buffer.from(bytes))) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return value;
}
function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function pathSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\\') &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}
function git(root: string, args: readonly string[], input?: string, maximum = MAX_TOTAL): Buffer {
  const result = spawnSync('/usr/bin/git', [...GIT, ...args], {
    cwd: root,
    env: ENV,
    input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
    encoding: 'buffer',
    timeout: 30000,
    maxBuffer: maximum,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0 || result.signal || result.error || !Buffer.isBuffer(result.stdout))
    fail();
  return result.stdout;
}
function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return value as Record<string, unknown>;
}

/** Parse historical formatting without accepting duplicate keys or non-JSON scalars. */
function json(bytes: Uint8Array): unknown {
  const text = utf8(bytes);
  let cursor = 0,
    nodes = 0;
  const whitespace = (): void => {
    while (' \t\n\r'.includes(text[cursor] ?? '!')) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const c = text[cursor++];
      if (c === '\\') {
        cursor++;
        continue;
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, cursor));
        if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value)
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        return value;
      }
    }
    return fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  };
  const scan = (depth: number): void => {
    if (depth > 64 || ++nodes > 1000000) fail('RECONCILIATION_PLAN_LIMIT');
    whitespace();
    const c = text[cursor];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{' || c === '[') {
      const object = c === '{',
        end = object ? '}' : ']';
      cursor++;
      whitespace();
      if (text[cursor] === end) {
        cursor++;
        return;
      }
      const keys = new Set<string>();
      while (cursor < text.length) {
        if (object) {
          whitespace();
          if (text[cursor] !== '"') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const key = string();
          if (keys.has(key)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          keys.add(key);
          whitespace();
          if (text[cursor++] !== ':') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        }
        scan(depth + 1);
        whitespace();
        const separator = text[cursor++];
        if (separator === end) return;
        if (separator !== ',') fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      }
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    }
    const scalar =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        text.slice(cursor),
      )?.[0];
    if (!scalar) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const value: unknown = JSON.parse(scalar);
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    cursor += scalar.length;
  };
  scan(0);
  whitespace();
  if (cursor !== text.length) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return JSON.parse(text) as unknown;
}

interface ChainRecord {
  id: string;
  timestamp: string;
  actor: string;
  actor_role: string;
  action: string;
  status: string;
  context: { git: { head_sha: string | null } };
  artifacts: { sha256: string | null }[];
  previous_run_hash: string | null;
  manifest_hash: string;
  sequence?: number;
  previous_hash?: string;
  proof_path?: string;
  proof_sequence?: number;
  proof_sha256?: string;
  recovered_from?: unknown;
  notes?: string[];
}
interface Chain {
  head: string | null;
  records: ChainRecord[];
}
function chain(bytes: Uint8Array): Chain {
  const parsed = data(json(bytes));
  if (
    Object.keys(parsed).some((key) => key !== 'head' && key !== 'records') ||
    !Object.hasOwn(parsed, 'head') ||
    !Array.isArray(parsed.records) ||
    parsed.records.length > MAX_ENTRIES
  )
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  let previous: string | null = null;
  for (const [index, value] of parsed.records.entries()) {
    if (!validators.evidence(value)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const record = value as ChainRecord;
    if (
      (record.sequence !== undefined && record.sequence !== index + 1) ||
      (record.previous_hash !== undefined && record.previous_hash !== (previous ?? 'GENESIS')) ||
      record.previous_run_hash !== previous ||
      computeEvidenceManifestHash({
        id: record.id,
        timestamp: record.timestamp,
        actor: record.actor,
        actor_role: record.actor_role,
        action: record.action,
        status: record.status,
        git_head_sha: record.context.git.head_sha,
        artifact_sha256s: record.artifacts.map((a) => a.sha256),
        previous_run_hash: previous,
      }) !== record.manifest_hash
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    previous = record.manifest_hash;
  }
  if (parsed.head !== previous) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  return parsed as unknown as Chain;
}
/** Internal strict historical parser; data only, with all original checks. */
export function parseReconciliationChain(bytes: Uint8Array): Readonly<{
  head: string | null;
  records: readonly import('@devai-nyx/utils').EvidenceRecord[];
}> {
  return chain(bytes) as unknown as Readonly<{
    head: string | null;
    records: readonly import('@devai-nyx/utils').EvidenceRecord[];
  }>;
}

interface EpochRow {
  proof_sequence: number;
  proof_sha256: string;
  action: string | null;
  line_type: string;
  payload: Record<string, unknown>;
}
interface Baseline {
  cutoff: string;
  entries: { path: string; sequence: number; sha256: string; observed_at: string }[];
}
function epoch(bytes: Buffer, path: string): EpochRow[] {
  const match = /^record\/proofs\/work\/([^/]+)\/([^/]+)\.jsonl$/u.exec(path);
  if (!match || bytes.length === 0 || bytes.at(-1) !== 10)
    fail('RECONCILIATION_PLAN_SOURCE_INVALID');
  let start = 0,
    previous: string | null = null,
    closed = false;
  const rows: EpochRow[] = [],
    types: string[] = [];
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    const raw = bytes.subarray(start, end);
    start = end + 1;
    const value = json(raw);
    if (!validators.proofEpoch(value)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const line = data(value),
      { line_hash: hash, ...unsigned } = line;
    const sequence = rows.length + 1;
    if (
      closed ||
      line.kind !== match[1] ||
      line.round_id !== match[2] ||
      line.sequence !== sequence ||
      line.previous_line_hash !== previous ||
      hash !== computeEvidenceEpochLineHash(unsigned)
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (
      line.line_type === 'errata' &&
      (typeof line.corrects_sequence !== 'number' ||
        line.corrects_sequence >= sequence ||
        types[line.corrects_sequence - 1] !== 'record')
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (line.line_type === 'terminal') {
      if (
        line.record_count !== sequence - 1 ||
        line.terminal_hash !== (previous ?? sha('DEVAI-PROOF-EPOCH-EMPTY'))
      )
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      closed = true;
    }
    const payload = data(line.payload);
    rows.push({
      proof_sequence: sequence,
      proof_sha256: sha(raw),
      action: typeof payload.action === 'string' ? payload.action : null,
      line_type: String(line.line_type),
      payload,
    });
    types.push(String(line.line_type));
    previous = String(hash);
    if (rows.length > MAX_ENTRIES) fail('RECONCILIATION_PLAN_LIMIT');
  }
  return rows;
}

interface Blob {
  type: 'blob' | 'commit';
  bytes: Buffer;
}
interface File {
  commit: string;
  path: string;
  mode: string;
  blob_oid: string;
  sha256: string;
  bytes: number;
  kind: 'chain' | 'epoch' | 'ancestry' | 'baseline';
}
interface StagedFile {
  path: string;
  stage: number;
  mode: string;
  blob_oid: string;
  sha256: string;
  bytes: number;
}
interface Recovery {
  proof_path: string;
  proof_sequence: number;
  proof_sha256: string;
  source_commit: string | null;
  source_chain_sha256: string | null;
  source_entry_manifest_hash: string | null;
  mode: 'divergent' | 'newest';
}
export interface ReconciliationPlan {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'evidence-reconciliation-plan';
  readonly identity: ReconciliationHostIdentity;
  readonly binding_sha256: string;
  readonly selection: Readonly<{
    parent: string;
    published_ref: string;
    published_tip: string;
    origin_config_sha256: string;
    effective_origin_sha256: string;
  }>;
  readonly bases: readonly string[];
  readonly source_manifest: Readonly<{
    files: readonly File[];
    index: ProofIndexSnapshot;
    staged_files: readonly StagedFile[];
    recovery_obligations: readonly Recovery[];
  }>;
  readonly source_manifest_sha256: string;
  readonly effect_plan: ReconciliationEffectPlan;
  readonly effect_plan_sha256: string;
  readonly grants_authority: false;
}

function indexBytes(path: string): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BLOB)) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.birthtimeNs !== before.birthtimeNs ||
      opened.size !== before.size
    )
      fail('RECONCILIATION_PLAN_STALE');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('RECONCILIATION_PLAN_STALE');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail('RECONCILIATION_PLAN_STALE');
    const after = fstatSync(fd, { bigint: true });
    if (
      after.ctimeNs !== opened.ctimeNs ||
      after.mtimeNs !== opened.mtimeNs ||
      after.size !== opened.size ||
      BigInt(bytes.length) !== opened.size
    )
      fail('RECONCILIATION_PLAN_STALE');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Fixed native observations only. This output is data and cannot authorize an effect. */
export function readReconciliationPlan(repositoryRoot: string): ReconciliationPlan {
  const scope = requireScope('process');
  if (scope.effect !== 'read' || scope.action_id !== 'evidence reconcile plan') fail();
  return capturePlan(repositoryRoot, readReconciliationPlanSelectors());
}

/** Initial review only: exact sealed file bytes and actual sources, without any write authority. */
export function readInitialReconciliationPlan(repositoryRoot: string): ReconciliationPlan {
  return readSealedPlan(repositoryRoot, readReconciliationInitialApprovalInput(), true);
}

/** Saved original data for an existing authenticated approval; this does not revalidate partial effects. */
export function readExistingReconciliationPlan(repositoryRoot: string): ReconciliationPlan {
  return readSealedPlan(repositoryRoot, readReconciliationExistingApprovalInput(), false);
}

function readSealedPlan(
  repositoryRoot: string,
  input: Readonly<{ plan_path: string; plan_sha256: string }>,
  recapture: boolean,
): ReconciliationPlan {
  if (realpathSync(repositoryRoot) !== repositoryRoot || !pathSafe(input.plan_path)) fail();
  const absolute = join(repositoryRoot, input.plan_path);
  if (realpathSync(dirname(absolute)) !== dirname(absolute)) fail();
  const witness = (): string => {
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) fail('RECONCILIATION_PLAN_STALE');
    const stat = lstatSync(absolute, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size > BigInt(MAX_BLOB)
    )
      fail();
    return [
      stat.dev,
      stat.ino,
      stat.birthtimeNs,
      stat.ctimeNs,
      stat.mtimeNs,
      stat.mode,
      stat.size,
    ].join(':');
  };
  const before = witness(),
    bytes = indexBytes(absolute),
    value = json(bytes);
  if (
    !getValidator('evidence-reconciliation-plan.schema.json')(value) ||
    sha(bytes) !== input.plan_sha256 ||
    !bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)) ||
    witness() !== before
  )
    fail('RECONCILIATION_PLAN_INVALID');
  const supplied = value as unknown as ReconciliationPlan;
  if (
    sha(canonicalJson(supplied.source_manifest)) !== supplied.source_manifest_sha256 ||
    sha(canonicalJson(supplied.effect_plan)) !== supplied.effect_plan_sha256 ||
    canonicalJson(createReconciliationEffectPlan(supplied)) !== canonicalJson(supplied.effect_plan)
  )
    fail();
  const actual = recapture
    ? capturePlan(repositoryRoot, {
        selected_parent: supplied.selection.parent,
        published_ref: supplied.selection.published_ref,
      })
    : supplied;
  if (
    canonicalJson(actual) !== canonicalJson(supplied) ||
    witness() !== before ||
    !indexBytes(absolute).equals(bytes) ||
    witness() !== before
  )
    fail('RECONCILIATION_PLAN_STALE');
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(actual);
  return actual;
}

/** Phase01 source recapture. Only exact custody bodies under an authenticated consumed intent are exempt. */
export function revalidateReconciliationCustodySource(
  repositoryRoot: string,
  anchor?: ReconciliationAdmissionAnchor,
): ReconciliationPlan {
  const input = readReconciliationExistingApprovalInput();
  if (input.action_id !== 'evidence reconcile materialize') fail();
  const plan = readExistingReconciliationPlan(repositoryRoot);
  const snapshot =
    anchor === undefined
      ? readReconciliationHostApproval(repositoryRoot, input.approval_id)
      : readReconciliationHostApprovalUnderAdmission(repositoryRoot, input.approval_id, anchor);
  if (
    !snapshot.binding_matches_approval ||
    snapshot.state.plan_sha256 !== input.plan_sha256 ||
    snapshot.state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
    canonicalJson(snapshot.identity) !== canonicalJson(plan.identity)
  )
    fail('RECONCILIATION_PLAN_STALE');
  const phase = snapshot.state.phases.find((entry) => entry.phase === '01');
  const allowed = new Map<string, { sha256: string; bytes: number }>();
  if (phase?.intent_sha256 !== null && phase?.intent_sha256 !== undefined) {
    for (const file of [...plan.effect_plan.custody.objects, plan.effect_plan.custody.manifest])
      allowed.set(file.path, file);
  }
  const actual = capturePlan(
    repositoryRoot,
    { selected_parent: plan.selection.parent, published_ref: plan.selection.published_ref },
    allowed,
  );
  if (canonicalJson(actual) !== canonicalJson(plan)) fail('RECONCILIATION_PLAN_STALE');
  return actual;
}

/** Full source recapture with only authenticated, fixed phase02 artifacts exempt. */
export function revalidateReconciliationSelectionSource(
  repositoryRoot: string,
  anchor: ReconciliationAdmissionAnchor,
): ReconciliationPlan {
  const input = readReconciliationExistingApprovalInput();
  if (input.action_id !== 'evidence reconcile materialize') fail();
  const plan = readExistingReconciliationPlan(repositoryRoot);
  const snapshot = readReconciliationHostApprovalUnderAdmission(
    repositoryRoot,
    input.approval_id,
    anchor,
  );
  if (
    !snapshot.binding_matches_approval ||
    snapshot.state.plan_sha256 !== input.plan_sha256 ||
    snapshot.state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
    canonicalJson(snapshot.identity) !== canonicalJson(plan.identity)
  )
    fail('RECONCILIATION_PLAN_STALE');
  const first = snapshot.state.phases.find((entry) => entry.phase === '01');
  const second = snapshot.state.phases.find((entry) => entry.phase === '02');
  if (!first?.completion_sha256) fail('RECONCILIATION_PLAN_STALE');
  const allowed = new Map<string, { sha256: string; bytes: number }>();
  for (const output of [...plan.effect_plan.custody.objects, plan.effect_plan.custody.manifest])
    allowed.set(output.path, output);
  const context = captureReconciliationHostContext(repositoryRoot, snapshot.identity.repository_id);
  const privateBuffers: Uint8Array[] = [];
  try {
    const paths = readReconciliationHostPaths(context);
    if (second?.intent_sha256) {
      const file = readNativePrivateFile(
        join(paths.private_root, 'approvals', input.approval_id, 'intent-02.json'),
      );
      privateBuffers.push(file.bytes);
      const intent = decodeReconciliationOwnerRecord(file.bytes);
      if (
        file.sha256 !== second.intent_sha256 ||
        intent.kind !== 'phase-intent' ||
        intent.phase !== '02'
      )
        fail();
      const originals = readReconciliationCustodyObjects(repositoryRoot, plan);
      const selected = originals.get(plan.effect_plan.selection.selected_chain_sha256);
      if (!selected) fail();
      const built = buildReconciliationSelection(
        plan,
        snapshot.state,
        intent.clock,
        intent.lease_nonce,
        repositoryRoot,
        selected,
      );
      if (built.outputs_manifest_sha256 !== intent.output_plan_sha256)
        fail('RECONCILIATION_PLAN_STALE');
      const receipt = built.outputs[0],
        candidate = built.outputs[1];
      if (!receipt || !candidate) fail();
      allowed.set(receipt.path, receipt);
      allowed.set(plan.effect_plan.selection.candidate_path, candidate);
      if (snapshot.state.lease_sha256 !== null) {
        const leaseFile = readNativePrivateFile(
          join(paths.private_root, 'approvals', input.approval_id, 'lease.json'),
        );
        privateBuffers.push(leaseFile.bytes);
        const lease = decodeReconciliationOwnerRecord(leaseFile.bytes);
        if (
          leaseFile.sha256 !== snapshot.state.lease_sha256 ||
          lease.kind !== 'lease' ||
          lease.phase !== '02' ||
          lease.original_intent_sha256 !== file.sha256
        )
          fail();
        const bytes = Buffer.from(
          JSON.stringify({
            operation: 'evidence-chain-append',
            chain_path: join(repositoryRoot, plan.effect_plan.selection.active_path),
            pid: lease.pid,
            nonce: lease.nonce,
          }) + '\n',
        );
        allowed.set(plan.effect_plan.selection.append_lock_path, {
          sha256: provisionBytesSha(bytes),
          bytes: bytes.length,
        });
      }
    }
    const actual = capturePlan(
      repositoryRoot,
      { selected_parent: plan.selection.parent, published_ref: plan.selection.published_ref },
      allowed,
    );
    if (canonicalJson(actual) !== canonicalJson(plan)) fail('RECONCILIATION_PLAN_STALE');
    return actual;
  } finally {
    for (const bytes of privateBuffers) bytes.fill(0);
    disposeReconciliationHostContext(context);
  }
}

/** Initial index-CAS recapture: no custody-reader action widening or artifact bypass. */
export function revalidateReconciliationIndexSource(
  repositoryRoot: string,
  anchor: ReconciliationAdmissionAnchor,
): ReconciliationPlan {
  const input = readReconciliationExistingApprovalInput();
  if (input.action_id !== 'evidence reconcile stage-proof') fail();
  const plan = readExistingReconciliationPlan(repositoryRoot);
  const snapshot = readReconciliationHostApprovalUnderAdmission(
    repositoryRoot,
    input.approval_id,
    anchor,
  );
  if (
    !snapshot.binding_matches_approval ||
    snapshot.state.plan_sha256 !== input.plan_sha256 ||
    snapshot.state.source_manifest_sha256 !== plan.source_manifest_sha256 ||
    canonicalJson(snapshot.identity) !== canonicalJson(plan.identity)
  )
    fail('RECONCILIATION_PLAN_STALE');
  const phase = snapshot.state.phases.find((entry) => entry.phase === '02');
  if (!phase?.intent_sha256 || !phase.completion_sha256) fail('RECONCILIATION_PLAN_STALE');
  const context = captureReconciliationHostContext(repositoryRoot, snapshot.identity.repository_id);
  let intentBytes: Uint8Array | undefined;
  try {
    const paths = readReconciliationHostPaths(context);
    const file = readNativePrivateFile(
      join(paths.private_root, 'approvals', input.approval_id, 'intent-02.json'),
    );
    intentBytes = file.bytes;
    const intent = decodeReconciliationOwnerRecord(file.bytes);
    if (
      file.sha256 !== phase.intent_sha256 ||
      intent.kind !== 'phase-intent' ||
      intent.phase !== '02'
    )
      fail();
    const selected = indexBytes(
      join(
        repositoryRoot,
        plan.effect_plan.namespace,
        'objects',
        plan.effect_plan.selection.selected_chain_sha256,
      ),
    );
    if (provisionBytesSha(selected) !== plan.effect_plan.selection.selected_chain_sha256) fail();
    const built = buildReconciliationSelection(
      plan,
      snapshot.state,
      intent.clock,
      intent.lease_nonce,
      repositoryRoot,
      selected,
    );
    if (built.outputs_manifest_sha256 !== intent.output_plan_sha256) fail();
    const receipt = built.outputs[0];
    if (!receipt) fail();
    const allowed = new Map<string, { sha256: string; bytes: number }>();
    for (const output of [
      ...plan.effect_plan.custody.objects,
      plan.effect_plan.custody.manifest,
      receipt,
    ])
      allowed.set(output.path, output);
    const actual = capturePlan(
      repositoryRoot,
      { selected_parent: plan.selection.parent, published_ref: plan.selection.published_ref },
      allowed,
    );
    if (canonicalJson(actual) !== canonicalJson(plan)) fail('RECONCILIATION_PLAN_STALE');
    return actual;
  } finally {
    intentBytes?.fill(0);
    disposeReconciliationHostContext(context);
  }
}

function capturePlan(
  repositoryRoot: string,
  selectors: Readonly<{
    selected_parent: string;
    published_ref: string;
  }>,
  permittedCustody: ReadonlyMap<string, Readonly<{ sha256: string; bytes: number }>> = new Map(),
): ReconciliationPlan {
  let context: ReturnType<typeof captureReconciliationHostContext> | undefined;
  try {
    const scope = requireScope('process');
    if (typeof repositoryRoot !== 'string' || realpathSync(repositoryRoot) !== repositoryRoot)
      fail();
    const binding = readReconciliationHostBinding();
    context = captureReconciliationHostContext(repositoryRoot, binding.identity.repository_id);
    const identity = readReconciliationHostIdentity(context),
      paths = readReconciliationHostPaths(context);
    if (
      canonicalJson(identity) !== canonicalJson(binding.identity) ||
      identity.merge_heads.length === 0
    )
      fail();
    const format = identity.object_format,
      oidPattern = format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
    const parents = [identity.head, ...identity.merge_heads];
    for (const forbidden of [
      join(paths.git_dir, 'shallow'),
      join(paths.common_dir, 'shallow'),
      join(paths.common_dir, 'info', 'grafts'),
      join(paths.common_dir, 'objects', 'info', 'alternates'),
      join(paths.common_dir, 'objects', 'info', 'http-alternates'),
    ]) {
      try {
        lstatSync(forbidden);
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    const actualConfig = (): Buffer =>
      git(repositoryRoot, ['config', '--includes', '--null', '--list'], undefined, 4 * 1024 * 1024);
    const initialConfig = actualConfig();
    if (
      /(?:^|\0)(?:extensions\.partialclone|remote\.[^\n\0]+\.(?:promisor|partialclonefilter))\n/iu.test(
        utf8(initialConfig),
      )
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    if (
      new Set(parents).size !== parents.length ||
      !parents.includes(selectors.selected_parent) ||
      !oidPattern.test(selectors.selected_parent)
    )
      fail();
    const objects = new Map<string, Blob>();
    let charged = 0;
    const load = (ids: readonly string[]): void => {
      const needed = [...new Set(ids)].filter((id) => !objects.has(id));
      if (needed.length === 0) return;
      if (needed.length > MAX_ENTRIES || needed.some((id) => !oidPattern.test(id)))
        fail('RECONCILIATION_PLAN_LIMIT');
      const input = `${needed.join('\n')}\n`;
      const checks = utf8(
        git(repositoryRoot, ['cat-file', '--batch-check'], input, 16 * 1024 * 1024),
      ).split('\n');
      if (checks.pop() !== '' || checks.length !== needed.length) fail();
      const sizes = checks.map((line, index) => {
        const parts = line.split(' '),
          size = Number(parts[2]);
        if (
          parts.length !== 3 ||
          parts[0] !== needed[index] ||
          !['blob', 'commit'].includes(parts[1] ?? '') ||
          !/^(?:0|[1-9][0-9]*)$/u.test(parts[2] ?? '') ||
          !Number.isSafeInteger(size) ||
          size > MAX_BLOB
        )
          fail('RECONCILIATION_PLAN_LIMIT');
        charged += size;
        if (charged > MAX_TOTAL) fail('RECONCILIATION_PLAN_LIMIT');
        return size;
      });
      const output = git(
        repositoryRoot,
        ['cat-file', '--batch'],
        input,
        sizes.reduce((sum, size) => sum + size + 128, 0),
      );
      let offset = 0;
      for (const [index, id] of needed.entries()) {
        const end = output.indexOf(10, offset);
        if (end < 0) fail();
        const header = utf8(output.subarray(offset, end)).split(' '),
          size = sizes[index];
        if (size === undefined || header.join(' ') !== checks[index]) fail();
        const type = header[1];
        if (type !== 'blob' && type !== 'commit') fail();
        offset = end + 1;
        const bytes = output.subarray(offset, offset + size);
        offset += size;
        if (
          bytes.length !== size ||
          output[offset++] !== 10 ||
          createHash(format).update(`${type} ${size}\0`).update(bytes).digest('hex') !== id
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        objects.set(id, { type, bytes });
      }
      if (offset !== output.length) fail();
    };
    const blob = (id: string): Buffer => {
      load([id]);
      const object = objects.get(id);
      if (object?.type !== 'blob') return fail();
      return object.bytes;
    };
    const sourceFiles: File[] = [],
      chains = new Map<string, Chain>(),
      epochVersions = new Map<string, { commit: string; rows: EpochRow[] }[]>();
    const histories: { commit: string; path: string; chain: Chain }[] = [];
    const baselines = new Map<string, Baseline>();
    const ref = (path: string, sequence: number): string => `${path}\0${sequence}`;
    const claims = (
      commit: string,
      source: Chain,
    ): Map<string, { record: ChainRecord; digest: string; structured: boolean }> => {
      const result = new Map<
        string,
        { record: ChainRecord; digest: string; structured: boolean }
      >();
      const baseline = baselines.get(commit);
      const baselineEntries = new Map(
        (baseline?.entries ?? []).map((entry) => [ref(entry.path, entry.sequence), entry]),
      );
      for (const entry of baselineEntries.values()) {
        const row = epochVersions.get(entry.path)?.find((version) => version.commit === commit)
          ?.rows[entry.sequence - 1];
        if (!row || row.proof_sha256 !== entry.sha256) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      }
      for (const record of source.records) {
        const structured =
          Object.hasOwn(record, 'proof_path') ||
          Object.hasOwn(record, 'proof_sequence') ||
          Object.hasOwn(record, 'proof_sha256');
        let path = record.proof_path,
          sequence = record.proof_sequence,
          digest = record.proof_sha256;
        if (!structured) {
          if (!record.action.startsWith('evidence.record.')) continue;
          const kind = record.action.slice('evidence.record.'.length),
            notes = new Map<string, string[]>();
          for (const note of record.notes ?? []) {
            const separator = note.indexOf('=');
            if (separator <= 0) continue;
            const key = note.slice(0, separator);
            notes.set(key, [...(notes.get(key) ?? []), note.slice(separator + 1)]);
          }
          const rounds = notes.get('round_id') ?? [],
            sequences = notes.get('proof_sequence') ?? [];
          const round = rounds[0],
            number = sequences[0];
          if (
            !/^[a-z0-9][a-z0-9_-]*$/u.test(kind) ||
            rounds.length !== 1 ||
            !/^R-[0-9]{4}$/u.test(round ?? '') ||
            sequences.length !== 1 ||
            !/^[1-9][0-9]*$/u.test(number ?? '')
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          path = `record/proofs/work/${kind}/${round}.jsonl`;
          sequence = Number(number);
          digest = baselineEntries.get(ref(path, sequence))?.sha256;
        }
        if (
          typeof path !== 'string' ||
          !/^record\/proofs\/work\/[a-z0-9][a-z0-9_-]*\/R-[0-9]{4}\.jsonl$/u.test(path) ||
          typeof sequence !== 'number' ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          typeof digest !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(digest)
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        const row = epochVersions.get(path)?.find((version) => version.commit === commit)?.rows[
            sequence - 1
          ],
          key = ref(path, sequence);
        if (!row || row.proof_sha256 !== digest || result.has(key))
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        result.set(key, { record, digest, structured });
      }
      return result;
    };
    const add = (
      commit: string,
      path: string,
      mode: string,
      id: string,
      kind: 'chain' | 'epoch' | 'baseline',
    ): void => {
      if (sourceFiles.some((file) => file.commit === commit && file.path === path)) return;
      const bytes = blob(id);
      sourceFiles.push({
        commit,
        path,
        mode,
        blob_oid: id,
        sha256: sha(bytes),
        bytes: bytes.length,
        kind,
      });
      if (kind === 'chain') {
        const parsed = chain(bytes);
        histories.push({ commit, path, chain: parsed });
        if (path === CHAIN) chains.set(commit, parsed);
      } else if (kind === 'baseline') {
        const parsed = json(bytes);
        if (!validators.proofAnchorBaseline(parsed)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        const baseline = parsed as Baseline;
        if (
          new Set(baseline.entries.map((entry) => ref(entry.path, entry.sequence))).size !==
          baseline.entries.length
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        baselines.set(commit, baseline);
      } else {
        const versions = epochVersions.get(path) ?? [];
        versions.push({ commit, rows: epoch(bytes, path) });
        epochVersions.set(path, versions);
      }
    };
    const bases = new Set<string>();
    for (const merge of identity.merge_heads) {
      const found = utf8(git(repositoryRoot, ['merge-base', '--all', identity.head, merge]))
        .trimEnd()
        .split('\n');
      if (found.length === 0 || found.some((oid) => !oidPattern.test(oid))) fail();
      for (const oid of found) bases.add(oid);
    }
    const ancestry = utf8(
      git(repositoryRoot, ['rev-list', '--parents', ...parents], undefined, 16 * 1024 * 1024),
    )
      .trimEnd()
      .split('\n');
    if (
      ancestry.length > MAX_COMMITS ||
      ancestry.some((line) => line.split(' ').some((id) => !oidPattern.test(id)))
    )
      fail('RECONCILIATION_PLAN_LIMIT');
    const commits = ancestry.map((line) => line.split(' ')[0] as string);
    load(commits);
    for (const [ordinal, commit] of commits.entries()) {
      const object = objects.get(commit);
      if (object?.type !== 'commit') fail();
      const headerEnd = object.bytes.indexOf('\n\n');
      if (headerEnd < 0) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      const headers = object.bytes.subarray(0, headerEnd).toString('utf8').split('\n');
      const actualParents = headers
        .filter((line) => line.startsWith('parent '))
        .map((line) => line.slice(7));
      const listedParents = (ancestry[ordinal] ?? '').split(' ').slice(1);
      if (
        !/^tree [a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(headers[0] ?? '') ||
        canonicalJson(actualParents) !== canonicalJson(listedParents) ||
        actualParents.some((parent) => !objects.has(parent))
      )
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      sourceFiles.push({
        commit,
        path: '',
        mode: 'commit',
        blob_oid: commit,
        sha256: sha(object.bytes),
        bytes: object.bytes.length,
        kind: 'ancestry',
      });
    }
    const capturedSources = new Set<string>();
    const readSourceCommit = (commit: string): void => {
      if (capturedSources.has(commit)) return;
      capturedSources.add(commit);
      const listing = utf8(
        git(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'record/proofs/']),
      );
      const entries = listing
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(line);
          if (!match || !pathSafe(match[3] ?? '')) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          return { path: match[3] as string, mode: match[1] as string, id: match[2] as string };
        })
        .filter(
          (entry) =>
            entry.path === CHAIN || entry.path === BASELINE || entry.path.endsWith('.jsonl'),
        );
      if (!entries.some((entry) => entry.path === CHAIN))
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      load(entries.map((entry) => entry.id));
      for (const entry of entries)
        add(
          commit,
          entry.path,
          entry.mode,
          entry.id,
          entry.path === CHAIN ? 'chain' : entry.path === BASELINE ? 'baseline' : 'epoch',
        );
      for (let i = 0; i < histories.length; i++) {
        const history = histories[i];
        if (!history || history.commit !== commit) continue;
        if (histories.length > MAX_ENTRIES) fail('RECONCILIATION_PLAN_LIMIT');
        for (const record of history.chain.records) {
          if (record.recovered_from === undefined) continue;
          const provenance = data(record.recovered_from),
            sourcePath = provenance.source_chain_path;
          if (
            typeof sourcePath !== 'string' ||
            !pathSafe(sourcePath) ||
            sourcePath === history.path
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const line = utf8(git(repositoryRoot, ['ls-tree', commit, '--', sourcePath]));
          const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)\n$/u.exec(line);
          if (!match || match[3] !== sourcePath) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const sourceBytes = blob(match[2] as string);
          if (sha(sourceBytes) !== provenance.source_chain_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          add(commit, sourcePath, match[1] as string, match[2] as string, 'chain');
          const source = histories.find(
            (item) => item.commit === commit && item.path === sourcePath,
          )?.chain;
          const sequence = provenance.source_entry_sequence,
            fork = provenance.fork_sequence;
          if (
            !source ||
            typeof sequence !== 'number' ||
            typeof fork !== 'number' ||
            fork < 1 ||
            !Number.isSafeInteger(fork) ||
            !Number.isSafeInteger(sequence) ||
            sequence <= fork ||
            fork >= source.records.length ||
            fork >= history.chain.records.length
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          const original = source.records[sequence - 1];
          if (
            !original ||
            original.id !== provenance.source_entry_id ||
            original.sequence !== sequence ||
            original.manifest_hash !== provenance.source_entry_manifest_hash ||
            original.recovered_from !== undefined ||
            original.action !== record.action ||
            original.proof_path !== record.proof_path ||
            original.proof_sequence !== record.proof_sequence ||
            original.proof_sha256 !== record.proof_sha256 ||
            canonicalJson(source.records.slice(0, fork)) !==
              canonicalJson(history.chain.records.slice(0, fork))
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        }
      }
      for (const history of histories.filter((item) => item.commit === commit)) {
        claims(commit, history.chain);
      }
    };
    for (const commit of [...new Set([...parents, ...bases])]) readSourceCommit(commit);
    const beforeIndexBytes = indexBytes(join(paths.git_dir, 'index')),
      index = parseProofIndex(beforeIndexBytes, format);
    if (
      index.entries.length > MAX_ENTRIES ||
      index.entries.some(
        (entry) =>
          // Symlink blobs are witnessed as metadata, never followed or admitted
          // as producer text. The staged producer must reject direct link reads.
          !['100644', '100755', '120000'].includes(entry.mode) ||
          (entry.stage !== 0 && entry.path !== CHAIN && entry.path !== CATALOGUE),
      )
    )
      fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    load(index.entries.map((entry) => entry.oid));
    const stagedFiles = index.entries.map((entry) => {
      const bytes = blob(entry.oid);
      return {
        path: entry.path,
        stage: entry.stage,
        mode: entry.mode,
        blob_oid: entry.oid,
        sha256: sha(bytes),
        bytes: bytes.length,
      };
    });
    const stagedBaselineFile = stagedFiles.find(
      (file) => file.path === BASELINE && file.stage === 0,
    );
    if (stagedBaselineFile) {
      const value = json(blob(stagedBaselineFile.blob_oid));
      if (!validators.proofAnchorBaseline(value)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      const baseline = value as Baseline;
      const stagedEntries = new Map(
        baseline.entries.map((entry) => [ref(entry.path, entry.sequence), entry]),
      );
      if (stagedEntries.size !== baseline.entries.length)
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      const sourceEntries = new Map<string, Baseline['entries'][number]>();
      for (const prior of baselines.values()) {
        if (prior.cutoff !== baseline.cutoff) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        for (const entry of prior.entries) {
          const key = ref(entry.path, entry.sequence);
          if (canonicalJson(stagedEntries.get(key)) !== canonicalJson(entry))
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          sourceEntries.set(key, entry);
        }
      }
      if (sourceEntries.size !== stagedEntries.size) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      baselines.set(STAGED, baseline);
    } else if (baselines.size !== 0) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    for (const file of stagedFiles) {
      if (
        file.stage !== 0 ||
        !file.path.startsWith('record/proofs/') ||
        !file.path.endsWith('.jsonl')
      )
        continue;
      if (!['100644', '100755'].includes(file.mode)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      const rows = epoch(blob(file.blob_oid), file.path),
        versions = epochVersions.get(file.path) ?? [];
      if (versions.length === 0) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const version of versions)
        for (const [i, row] of version.rows.entries())
          if (row.proof_sha256 !== rows[i]?.proof_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      if (rows.length !== Math.max(...versions.map((version) => version.rows.length)))
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      versions.push({ commit: STAGED, rows });
      epochVersions.set(file.path, versions);
    }
    for (const versions of epochVersions.values())
      if (!versions.some((version) => version.commit === STAGED))
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    const verifyWorkingTree = (): void => {
      const directories = new Set<string>();
      for (const entry of stagedFiles) {
        if (entry.stage !== 0 || entry.path === CHAIN || entry.path === CATALOGUE) continue;
        const parts = entry.path.split('/');
        let directory = repositoryRoot;
        for (const part of parts.slice(0, -1)) {
          directory = join(directory, part);
          if (!directories.has(directory)) {
            if (!lstatSync(directory).isDirectory()) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
            directories.add(directory);
          }
        }
        const path = join(repositoryRoot, entry.path);
        const before = lstatSync(path, { bigint: true });
        let bytes: Buffer;
        if (entry.mode === '120000') {
          if (!before.isSymbolicLink()) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          bytes = readlinkSync(path, { encoding: 'buffer' });
          const after = lstatSync(path, { bigint: true });
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.ctimeNs !== after.ctimeNs ||
            before.birthtimeNs !== after.birthtimeNs
          )
            fail('RECONCILIATION_PLAN_STALE');
        } else {
          if (!before.isFile() || ((before.mode & 0o100n) !== 0n) !== (entry.mode === '100755'))
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          bytes = indexBytes(path);
        }
        if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      }
    };
    verifyWorkingTree();
    const verifyUntracked = (): void => {
      const untracked = utf8(
        git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
      )
        .split('\0')
        .filter(Boolean);
      for (const path of untracked) {
        const expected = permittedCustody.get(path);
        if (!expected || !pathSafe(path)) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        const absolute = join(repositoryRoot, path);
        if (realpathSync(dirname(absolute)) !== dirname(absolute))
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        const before = lstatSync(absolute, { bigint: true });
        const bytes = indexBytes(absolute);
        const after = lstatSync(absolute, { bigint: true });
        if (
          (before.mode & 0o7777n) !== 0o600n ||
          before.uid !== BigInt(process.geteuid?.() ?? -1) ||
          before.nlink !== 1n ||
          after.nlink !== 1n ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.birthtimeNs !== after.birthtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.mtimeNs !== after.mtimeNs ||
          before.mode !== after.mode ||
          bytes.length !== expected.bytes ||
          sha(bytes) !== expected.sha256
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      }
    };
    verifyUntracked();
    const selected = chains.get(selectors.selected_parent);
    if (!selected) fail();
    const selectedClaims = claims(STAGED, selected),
      acknowledged = new Map<string, string>();
    const selectedBaseline = baselines.get(STAGED);
    for (const [path, versions] of epochVersions) {
      if (!path.startsWith('record/proofs/work/historical-gap/')) continue;
      const rows = versions.find((version) => version.commit === STAGED)?.rows ?? [];
      for (const row of rows) {
        if (row.line_type !== 'record') continue;
        const payload = row.payload;
        const authorization = data(payload.authorization);
        if (
          !validators.proofOrphanDeclaration(payload) ||
          authorization.role !== 'Architect' ||
          typeof authorization.decision !== 'string' ||
          authorization.decision.trim().length === 0 ||
          !selectedBaseline ||
          !selectedClaims.get(ref(path, row.proof_sequence))?.structured ||
          payload.cutoff !== selectedBaseline.cutoff
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        const named = payload.orphans as { path: string; sequence: number; sha256: string }[];
        const seen = new Set<string>();
        for (const orphan of named) {
          const key = ref(orphan.path, orphan.sequence);
          const physical = epochVersions
            .get(orphan.path)
            ?.find((version) => version.commit === STAGED)?.rows[orphan.sequence - 1];
          const baseline = selectedBaseline.entries.find(
            (entry) => ref(entry.path, entry.sequence) === key,
          );
          if (
            !physical ||
            physical.proof_sha256 !== orphan.sha256 ||
            baseline?.observed_at !== selectedBaseline.cutoff ||
            selectedClaims.has(key) ||
            acknowledged.has(key) ||
            seen.has(key)
          )
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          seen.add(key);
        }
        for (const orphan of named)
          acknowledged.set(ref(orphan.path, orphan.sequence), orphan.sha256);
      }
    }
    const recoveries: Recovery[] = [];
    const history = (): string[] =>
      utf8(
        git(
          repositoryRoot,
          ['log', '--full-history', '--format=%H', ...parents, '--', CHAIN],
          undefined,
          2 * 1024 * 1024,
        ),
      )
        .trimEnd()
        .split('\n');
    let chainHistory: string[] | undefined;
    for (const [path, versions] of epochVersions) {
      const longest = versions.find((version) => version.commit === STAGED);
      if (!longest) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const version of versions)
        for (const [i, row] of version.rows.entries())
          if (row.proof_sha256 !== longest.rows[i]?.proof_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const row of longest.rows) {
        const key = ref(path, row.proof_sequence),
          existing = selectedClaims.get(key);
        if (
          (existing && existing.digest !== row.proof_sha256) ||
          (acknowledged.has(key) && acknowledged.get(key) !== row.proof_sha256)
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        if (existing || acknowledged.has(key)) continue;
        if (row.proof_sequence === longest.rows.length) {
          recoveries.push({
            proof_path: path,
            proof_sequence: row.proof_sequence,
            proof_sha256: row.proof_sha256,
            source_commit: null,
            source_chain_sha256: null,
            source_entry_manifest_hash: null,
            mode: 'newest',
          });
          continue;
        }
        chainHistory ??= history();
        if (chainHistory.length > MAX_COMMITS) fail('RECONCILIATION_PLAN_LIMIT');
        let original: { commit: string; record: ChainRecord } | undefined;
        for (const commit of chainHistory) {
          if (!oidPattern.test(commit)) fail();
          if (!chains.has(commit)) {
            const line = utf8(git(repositoryRoot, ['ls-tree', commit, '--', CHAIN]));
            const match =
              /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\trecord\/proofs\/chain\.json\n$/u.exec(
                line,
              );
            if (!match) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
            chains.set(commit, chain(blob(match[2] as string)));
          }
          const matches =
            chains
              .get(commit)
              ?.records.filter(
                (record) =>
                  record.proof_path === path &&
                  record.proof_sequence === row.proof_sequence &&
                  record.proof_sha256 === row.proof_sha256 &&
                  record.recovered_from === undefined,
              ) ?? [];
          if (matches.length > 1) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
          if (matches[0]) {
            original = { commit, record: matches[0] };
            break;
          }
        }
        if (!original) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
        readSourceCommit(original.commit);
        const file = sourceFiles.find(
          (file) => file.commit === original.commit && file.path === CHAIN,
        );
        if (!file) fail();
        recoveries.push({
          proof_path: path,
          proof_sequence: row.proof_sequence,
          proof_sha256: row.proof_sha256,
          source_commit: original.commit,
          source_chain_sha256: file.sha256,
          source_entry_manifest_hash: original.record.manifest_hash,
          mode: 'divergent',
        });
      }
    }
    // Original-anchor discovery can add historical versions after the initial
    // staged-source checks. Every discovered version must still be preserved.
    for (const versions of epochVersions.values()) {
      const staged = versions.find((version) => version.commit === STAGED);
      if (!staged) fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const version of versions)
        for (const [i, row] of version.rows.entries())
          if (row.proof_sha256 !== staged.rows[i]?.proof_sha256)
            fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    }
    const stagedBaseline = baselines.get(STAGED);
    for (const prior of baselines.values()) {
      if (!stagedBaseline || prior.cutoff !== stagedBaseline.cutoff)
        fail('RECONCILIATION_PLAN_SOURCE_INVALID');
      for (const entry of prior.entries)
        if (
          !stagedBaseline.entries.some(
            (candidate) => canonicalJson(candidate) === canonicalJson(entry),
          )
        )
          fail('RECONCILIATION_PLAN_SOURCE_INVALID');
    }
    const publication = (): { tip: string; config: string; effective: string } => {
      const config = sha(actualConfig());
      if (config !== sha(initialConfig)) fail('RECONCILIATION_PLAN_STALE');
      const effectiveBytes = git(
          repositoryRoot,
          ['ls-remote', '--get-url', 'origin'],
          undefined,
          65536,
        ),
        effective = utf8(effectiveBytes).trimEnd();
      if (
        !(
          effective.startsWith('https://') ||
          effective.startsWith('ssh://') ||
          effective.startsWith('file://') ||
          /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/u.test(effective) ||
          (isAbsolute(effective) && realpathSync(effective) === effective)
        ) ||
        /[\r\n]/u.test(effective)
      )
        fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      const lines = utf8(
        git(
          repositoryRoot,
          [
            'ls-remote',
            '--refs',
            '--upload-pack=git-upload-pack',
            'origin',
            selectors.published_ref,
          ],
          undefined,
          65536,
        ),
      ).split('\n');
      if (lines.pop() !== '' || lines.length !== 1) fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      const [tip, ref] = (lines[0] ?? '').split('\t');
      if (!tip || !oidPattern.test(tip) || ref !== selectors.published_ref)
        fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      load([tip]);
      if (objects.get(tip)?.type !== 'commit') fail('RECONCILIATION_PLAN_PUBLICATION_INVALID');
      if (tip !== selectors.selected_parent)
        git(
          repositoryRoot,
          ['merge-base', '--is-ancestor', selectors.selected_parent, tip],
          undefined,
          65536,
        );
      return { tip, config, effective: sha(effectiveBytes) };
    };
    const advertised = publication();
    const manifest = {
      files: sourceFiles.sort((a, b) => compare(a.commit, b.commit) || compare(a.path, b.path)),
      index,
      staged_files: stagedFiles,
      recovery_obligations: recoveries.sort(
        (a, b) => compare(a.proof_path, b.proof_path) || a.proof_sequence - b.proof_sequence,
      ),
    };
    const selection = {
      parent: selectors.selected_parent,
      published_ref: selectors.published_ref,
      published_tip: advertised.tip,
      origin_config_sha256: advertised.config,
      effective_origin_sha256: advertised.effective,
    };
    const manifestSha256 = sha(canonicalJson(manifest));
    const effectPlan = createReconciliationEffectPlan({
      selection,
      source_manifest: manifest,
      source_manifest_sha256: manifestSha256,
    });
    const finalPublication = publication();
    verifyWorkingTree();
    verifyUntracked();
    const final = readReconciliationHostBinding();
    if (
      scope !== scopes.getStore() ||
      canonicalJson(identity) !== canonicalJson(readReconciliationHostIdentity(context)) ||
      canonicalJson(identity) !== canonicalJson(final.identity) ||
      binding.binding_sha256 !== final.binding_sha256 ||
      sha(indexBytes(join(paths.git_dir, 'index'))) !== index.raw_sha256 ||
      canonicalJson(advertised) !== canonicalJson(finalPublication)
    )
      fail('RECONCILIATION_PLAN_STALE');
    checkReconciliationClockWindow(binding.clock, final.clock, 'review');
    const result: ReconciliationPlan = {
      schemaVersion: '1.0.0',
      kind: 'evidence-reconciliation-plan',
      identity,
      binding_sha256: binding.binding_sha256,
      selection,
      bases: [...bases].sort(compare),
      source_manifest: manifest,
      source_manifest_sha256: manifestSha256,
      effect_plan: effectPlan,
      effect_plan_sha256: sha(canonicalJson(effectPlan)),
      grants_authority: false,
    };
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(result);
    return result;
  } catch (error) {
    if (error instanceof ReconciliationPlanError) throw error;
    return fail();
  } finally {
    if (context) disposeReconciliationHostContext(context);
  }
}
