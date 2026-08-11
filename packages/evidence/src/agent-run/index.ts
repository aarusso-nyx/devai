import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { canonicalSha256 } from '@devai-nyx/utils';

/**
 * Agent-run evidence emitter. Records what an automated agent action read,
 * wrote, and ran. Schema conforms to agent-run.schema.json and is persisted under
 * record/proofs/work/agent-runs/<run-id>.json. Each record participates in
 * a hash chain via prev_hash + manifest_hash.
 */

export interface AgentRunCaller {
  readonly kind: 'recipe' | 'sense' | 'loop' | 'cli' | 'subagent';
  readonly name: string;
  readonly version?: string;
}

export interface AgentRunCommand {
  readonly argv: readonly string[];
  readonly exit_code: number;
  readonly duration_ms: number;
}

export interface AgentRunSubagent {
  readonly agent_type: string;
  readonly prompt_pc_id: string;
  readonly returned_summary?: string;
  readonly parent_verification?: 'pass' | 'fail' | 'skipped';
}

export interface AgentRunCompliance {
  readonly invariant_ids: readonly string[];
  readonly overrides_in_play?: readonly string[];
}

export interface AgentRunOutcome {
  readonly status: 'pass' | 'fail' | 'review' | 'skipped';
  readonly notes?: readonly string[];
}

export interface AgentRunRecord {
  readonly schemaVersion: '1.0.0';
  readonly run_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly caller: AgentRunCaller;
  readonly files_read: readonly string[];
  readonly files_written: readonly string[];
  readonly commands_run: readonly AgentRunCommand[];
  readonly subagent_invocations?: readonly AgentRunSubagent[];
  readonly compliance: AgentRunCompliance;
  readonly outcome?: AgentRunOutcome;
  readonly prev_hash: string | null;
  readonly manifest_hash: string;
}

/**
 * Mint a UUIDv7-shaped id with the AR- prefix. Format matches the
 * schema's regex. RFC 9562 v7 layout:
 *   - 48-bit big-endian unix-time-ms
 *   - 4-bit version (0111)
 *   - 12-bit random
 *   - 2-bit variant (10)
 *   - 62-bit random
 */
function mintRunId(): string {
  const tsMs = BigInt(Date.now());
  const rand = randomBytes(10);
  // Buffer layout
  const b = Buffer.alloc(16);
  // First 48 bits: tsMs big-endian
  b.writeUIntBE(Number((tsMs >> 16n) & 0xffffffffn), 0, 4);
  b.writeUIntBE(Number(tsMs & 0xffffn), 4, 2);
  // version + 12 random. `rand` is a Buffer; indexed access is
  // `number | undefined` under noUncheckedIndexedAccess. The `?? 0`
  // is safe — `rand` is randomBytes(10), so indices 0..9 are defined.
  b[6] = 0x70 | ((rand[0] ?? 0) & 0x0f);
  b[7] = rand[1] ?? 0;
  // variant + 62 random
  b[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rand[i - 6] ?? 0;
  const hex = b.toString('hex');
  return `AR-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const STATE_DIR_REL = 'record/proofs/work/agent-runs';

function stateDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR_REL);
}

/**
 * Read the last agent-run record (by lexicographic order on filename,
 * which matches chronological order under UUID v7). Returns null when
 * no records exist yet. Used to seed prev_hash for the next emit.
 */
export function readLastAgentRunHash(repoRoot: string): string | null {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const last = files[files.length - 1];
  if (last === undefined) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, last), 'utf8')) as { manifest_hash?: string };
    return parsed.manifest_hash ?? null;
  } catch {
    return null;
  }
}

/** Compute the manifest hash with the current canonical-JSON algorithm. */
function computeManifestHash(record: Omit<AgentRunRecord, 'manifest_hash'>): string {
  return canonicalSha256(record);
}

/** Verify a persisted agent-run record's manifest_hash. */
export function verifyAgentRunHash(record: AgentRunRecord): boolean {
  const { manifest_hash: _stored, ...draft } = record;
  void _stored;
  const recomputed = canonicalSha256(draft);
  return recomputed === record.manifest_hash;
}

export interface EmitAgentRunOptions {
  readonly repoRoot: string;
  readonly caller: AgentRunCaller;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly files_read?: readonly string[];
  readonly files_written?: readonly string[];
  readonly commands_run?: readonly AgentRunCommand[];
  readonly subagent_invocations?: readonly AgentRunSubagent[];
  readonly compliance: AgentRunCompliance;
  readonly outcome?: AgentRunOutcome;
}

/**
 * Build, hash, and persist an agent-run record. Returns the persisted
 * record. Best-effort: persistence failure throws (callers can catch
 * and proceed if non-critical).
 */
export function emitAgentRun(opts: EmitAgentRunOptions): AgentRunRecord {
  const prev_hash = readLastAgentRunHash(opts.repoRoot) ?? 'GENESIS';
  const draft: Omit<AgentRunRecord, 'manifest_hash'> = {
    schemaVersion: '1.0.0',
    run_id: mintRunId(),
    started_at: opts.started_at,
    ended_at: opts.ended_at ?? new Date().toISOString(),
    caller: opts.caller,
    files_read: opts.files_read ?? [],
    files_written: opts.files_written ?? [],
    commands_run: opts.commands_run ?? [],
    ...(opts.subagent_invocations !== undefined && {
      subagent_invocations: opts.subagent_invocations,
    }),
    compliance: opts.compliance,
    ...(opts.outcome !== undefined && { outcome: opts.outcome }),
    prev_hash,
  };
  const manifest_hash = computeManifestHash(draft);
  const record: AgentRunRecord = { ...draft, manifest_hash };
  const dir = stateDir(opts.repoRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.run_id}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * Return the immutable agent-run proof directory.
 */
export function getAgentRunDir(repoRoot: string): string {
  return stateDir(repoRoot);
}
