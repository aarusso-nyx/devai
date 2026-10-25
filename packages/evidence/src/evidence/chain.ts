import {
  computeEvidenceManifestHash,
  buildEvidenceRecord,
  type DraftEvidence,
  type EvidenceRecord,
} from '@devai-nyx/utils';
import { performance } from 'node:perf_hooks';
import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  publishFileNoReplaceSync,
  removeEntryIfIdentitySync,
} from '@devai-nyx/authority';
import { dirname, resolve } from 'node:path';
import { validators } from '@devai-nyx/schemas';

// ADR-EVI-0002: the line-level cross-check lives beside the chain checks it extends.
export {
  verifyProofAnchors,
  type ProofAnchorVerification,
  type ProofAnchorVerificationInputs,
} from './anchors.js';
export { proofLineDigest, resolveProofAnchor, type ProofAnchorResolution } from './proof-epoch.js';

const validateEvidence = validators.evidence;

export type {
  EvidenceContext,
  EvidenceArtifact,
  FindingsSummary,
  RecoveredFrom,
  EvidenceRecord,
  DraftEvidence,
} from '@devai-nyx/utils';

export interface EvidenceChain {
  head: string | null;
  records: EvidenceRecord[];
}

export interface ManifestHashInputs {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly actor_role: string;
  readonly action: string;
  readonly status: string;
  readonly git_head_sha: string | null;
  readonly artifact_sha256s: readonly (string | null)[];
  readonly previous_run_hash: string | null;
}

const DOMAIN_SEPARATOR = 'GENESIS';

export function computeManifestHash(inputs: ManifestHashInputs): string {
  return computeEvidenceManifestHash(inputs);
}

export function extractManifestInputs(record: EvidenceRecord): ManifestHashInputs {
  return {
    id: record.id,
    timestamp: record.timestamp,
    actor: record.actor,
    actor_role: record.actor_role,
    action: record.action,
    status: record.status,
    git_head_sha: record.context.git.head_sha,
    artifact_sha256s: record.artifacts.map((a) => a.sha256),
    previous_run_hash: record.previous_run_hash,
  };
}

function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = `${path}.tmp.${process.pid.toString()}.${Date.now().toString()}`;
  writeFileSync(tmp, contents, { flag: 'wx' });
  renameSync(tmp, path);
}

/** Shared by every normal append, not only recovery requests. No stale lock takeover. */
function withAppendLock<T>(chainPath: string, operation: () => T): T {
  const canonical = resolve(chainPath);
  const lockPath = `${canonical}.append.lock`;
  const deadline = performance.now() + 10_000;
  const owner = {
    operation: 'evidence-chain-append',
    chain_path: canonical,
    pid: process.pid,
    nonce: randomUUID(),
  };
  let identity: ReturnType<typeof publishFileNoReplaceSync>;
  for (;;) {
    // Refuse linked path components, including a symlink masquerading as a parent.
    if (lstatSync(dirname(canonical)).isSymbolicLink())
      throw new Error('PROOF_ANCHOR_RECOVERY_REFUSED: chain parent is a symlink');
    if (existsSync(canonical) && !lstatSync(canonical).isFile())
      throw new Error('PROOF_ANCHOR_RECOVERY_REFUSED: chain is not a regular file');
    if (existsSync(canonical) && lstatSync(canonical).isSymbolicLink())
      throw new Error('PROOF_ANCHOR_RECOVERY_REFUSED: chain is a symlink');
    try {
      identity = publishFileNoReplaceSync(lockPath, `${JSON.stringify(owner)}\n`);
      break;
    } catch (error) {
      // A competitor can change this exact lock target between the guarded
      // prepare and apply. Retry only this publication with a fresh guarded
      // decision; never reinterpret an authority refusal as a stale chain.
      const changedLock =
        error instanceof Error && error.message === 'AUTHORITY_RESOURCE_CHANGED_AFTER_PREPARE';
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !changedLock) throw error;
      if (performance.now() >= deadline) throw error;
      let held: Record<string, unknown>;
      try {
        const stat = lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('foreign lock path');
        held = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`PROOF_ANCHOR_RECOVERY_REFUSED: foreign append lock ${String(readError)}`);
      }
      if (
        held['operation'] !== owner.operation ||
        held['chain_path'] !== canonical ||
        performance.now() >= deadline
      )
        throw new Error(
          'PROOF_ANCHOR_RECOVERY_REFUSED: foreign or unavailable append serialization lock',
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    result = operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    if (removeEntryIfIdentitySync(lockPath, identity) !== 'removed')
      throw new Error('owned lock identity was not removed');
  } catch (cleanup) {
    const detail = JSON.stringify({ path: lockPath, identity }, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    throw new Error(
      `PROOF_ANCHOR_RECOVERY_REFUSED: append lock cleanup incomplete; inspect canonical head and ownership ${detail}; primary=${failed ? String(failure) : 'append completed'}; cleanup=${String(cleanup)}`,
    );
  }
  if (failed) throw failure;
  return result as T;
}

export function initChain(chainPath: string): EvidenceChain {
  if (existsSync(chainPath)) return loadChain(chainPath);
  mkdirSync(dirname(chainPath), { recursive: true });
  return withAppendLock(chainPath, () => {
    if (existsSync(chainPath)) return loadChain(chainPath);
    const empty: EvidenceChain = { head: null, records: [] };
    atomicWriteFileSync(chainPath, JSON.stringify(empty, null, 2) + '\n');
    return empty;
  });
}

export function loadChain(chainPath: string): EvidenceChain {
  const text = readFileSync(chainPath, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`evidence chain at ${chainPath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.records)) {
    throw new Error(`evidence chain at ${chainPath} has an invalid 'records' field`);
  }
  if (obj.head !== null && typeof obj.head !== 'string') {
    throw new Error(`evidence chain at ${chainPath} has an invalid 'head' field`);
  }
  return parsed as EvidenceChain;
}

export function saveChain(chainPath: string, chain: EvidenceChain): void {
  atomicWriteFileSync(chainPath, JSON.stringify(chain, null, 2) + '\n');
}

export function appendRecord(
  chainPath: string,
  draft: DraftEvidence,
  expectedHead?: string,
  beforeAppend?: () => void,
  deriveIdForHead?: (head: string | null) => string,
): EvidenceRecord {
  return withAppendLock(chainPath, () => {
    beforeAppend?.();
    const chain = loadChain(chainPath);
    if (expectedHead !== undefined && chain.head !== expectedHead)
      throw new Error('PROOF_ANCHOR_RECOVERY_STALE_HEAD: canonical head changed at append');
    const record = buildEvidenceRecord(
      draft,
      chain.head,
      chain.records.length + 1,
      deriveIdForHead?.(chain.head) ?? draft.id,
    );
    const ok = validateEvidence(record);
    if (!ok) {
      throw new Error(
        `evidence record does not validate against schema: ${JSON.stringify(validateEvidence.errors)}`,
      );
    }
    chain.records.push(record);
    chain.head = record.manifest_hash;
    saveChain(chainPath, chain);
    return record;
  });
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function verifyChain(chainPath: string): VerifyResult {
  return verifyLoadedChain(loadChain(chainPath));
}

/**
 * The checks of `verifyChain` over a chain already loaded, so a caller that also reads the
 * records verifies exactly the snapshot it reads.
 */
export function verifyLoadedChain(chain: EvidenceChain): VerifyResult {
  const errors: string[] = [];
  let prev: string | null = null;
  for (const [index, record] of chain.records.entries()) {
    if (record.sequence !== undefined && record.sequence !== index + 1) {
      errors.push(
        `record ${record.id}: sequence mismatch (expected ${String(index + 1)}, got ${String(record.sequence)})`,
      );
    }
    const expectedPreviousHash = prev ?? DOMAIN_SEPARATOR;
    if (record.previous_hash !== undefined && record.previous_hash !== expectedPreviousHash) {
      errors.push(
        `record ${record.id}: previous_hash mismatch (expected ${expectedPreviousHash}, got ${record.previous_hash})`,
      );
    }
    if (record.previous_run_hash !== prev) {
      errors.push(
        `record ${record.id}: previous_run_hash mismatch (expected ${prev ?? 'null'}, got ${record.previous_run_hash ?? 'null'})`,
      );
    }
    const expected = computeManifestHash(extractManifestInputs(record));
    if (expected !== record.manifest_hash) {
      errors.push(
        `record ${record.id}: manifest_hash mismatch (expected ${expected}, got ${record.manifest_hash})`,
      );
    }
    prev = record.manifest_hash;
  }
  if (chain.head !== prev) {
    errors.push(`chain head mismatch (expected ${prev ?? 'null'}, got ${chain.head ?? 'null'})`);
  }
  return { valid: errors.length === 0, errors };
}
