import { execFileSync } from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import {
  hasNonBindingControlFlow,
  shellSegments,
  disablesErrexit,
  isFailClosedExecutableSegment,
} from './harness-invariant-alignment-workflow.js';

export function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Normalized alignment-evidence view. R21 accepts this shape directly for
 * host-produced evidence, and also derives it from DEVAI's canonical pair:
 * a SensorReading under `.devai/state/sensor-readings/` plus the matching
 * `sense.readings.record` entry in `record/proofs/chain.json`.
 */
interface AlignmentEvidence {
  readonly id?: unknown;
  readonly command?: unknown;
  readonly status?: unknown;
  readonly candidate_sha?: unknown;
  readonly completed_at?: unknown;
  readonly timestamp?: unknown;
  readonly lifecycle?: unknown;
  readonly env?: { readonly commit?: unknown };
}

interface EvidenceFile {
  readonly path: string;
  readonly record: AlignmentEvidence;
}

function loadEvidenceFiles(dir: string): EvidenceFile[] {
  const stat = safeStat(dir);
  if (stat === null || !stat.isDirectory()) return [];
  const records: EvidenceFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return records;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const entryStat = safeStat(path);
    if (entryStat?.isDirectory()) {
      records.push(...loadEvidenceFiles(path));
      continue;
    }
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) {
        records.push(
          ...(parsed
            .filter((item) => typeof item === 'object' && item !== null)
            .map((record) => ({ path, record: record as AlignmentEvidence })) as EvidenceFile[]),
        );
      } else if (typeof parsed === 'object' && parsed !== null) {
        records.push({ path, record: parsed as AlignmentEvidence });
      }
    } catch {
      // Malformed evidence cannot promote alignment.
    }
  }
  return records;
}

interface EvidenceChainRecord {
  readonly actor?: unknown;
  readonly action?: unknown;
  readonly status?: unknown;
  readonly timestamp?: unknown;
  readonly context?: { readonly git?: { readonly head_sha?: unknown } };
  readonly artifacts?: ReadonlyArray<{ readonly path?: unknown; readonly sha256?: unknown }>;
  readonly notes?: readonly unknown[];
}

/**
 * The `sense.readings.record` receipts that bind one stored reading file. Reading ids
 * are content-derived, so the same store path is recorded again at every candidate
 * whose reading has the same content, and the chain keeps every earlier receipt.
 * Only a receipt whose digest names the file's current bytes binds it (ADR-SCR-0008,
 * ADR-SCR-0013); a digest that names other bytes is a finding, never evidence. A chain
 * whose receipts for the path carry no digest keeps the earlier first-receipt rule.
 */
function readingReceipts(
  chainRecords: readonly EvidenceChainRecord[],
  relativePath: string,
  absolutePath: string,
): readonly EvidenceChainRecord[] {
  const receipts = chainRecords.filter(
    (entry) =>
      entry.action === 'sense.readings.record' &&
      entry.artifacts?.some((artifact) => artifact.path === relativePath) === true,
  );
  const digestOf = (entry: EvidenceChainRecord): unknown =>
    entry.artifacts?.find((artifact) => artifact.path === relativePath)?.sha256;
  if (!receipts.some((entry) => typeof digestOf(entry) === 'string')) return receipts.slice(0, 1);
  let bytes: string;
  try {
    bytes = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return [];
  }
  return receipts.filter((entry) => digestOf(entry) === bytes);
}

export function loadEvidence(repoRoot: string, dir: string): AlignmentEvidence[] {
  const files = loadEvidenceFiles(dir);
  let chainRecords: readonly EvidenceChainRecord[] = [];
  try {
    const chain = JSON.parse(readFileSync(join(repoRoot, 'record/proofs/chain.json'), 'utf8')) as {
      readonly records?: readonly EvidenceChainRecord[];
    };
    chainRecords = chain.records ?? [];
  } catch {
    // Direct normalized records remain valid input; canonical readings without
    // their chain receipt remain deliberately non-promoting.
  }

  return files.flatMap(({ path, record }): AlignmentEvidence[] => {
    if (typeof record.candidate_sha === 'string') return [record];
    const testResultId = record.id;
    const testResultCommit = record.env?.commit;
    if (typeof testResultId === 'string' && typeof testResultCommit === 'string') {
      const receipt = chainRecords.find(
        (entry) =>
          entry.actor === 'devai-record-run' &&
          typeof entry.action === 'string' &&
          entry.action.startsWith('test-run.') &&
          entry.status === 'completed' &&
          entry.context?.git?.head_sha === testResultCommit &&
          entry.notes?.some(
            (note) =>
              typeof note === 'string' && note.startsWith(`test-result id: ${testResultId};`),
          ) === true,
      );
      if (receipt !== undefined) {
        return [
          {
            ...record,
            candidate_sha: testResultCommit,
            completed_at:
              typeof receipt.timestamp === 'string'
                ? receipt.timestamp
                : (record.completed_at ?? record.timestamp),
            lifecycle: record.lifecycle ?? 'supported',
          },
        ];
      }
    }
    const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
    // One evidence view per binding receipt: the same bytes recorded at several
    // candidates bind each of them, and an unbound reading stays as read.
    const bound = readingReceipts(chainRecords, relativePath, path).flatMap(
      (receipt): AlignmentEvidence[] => {
        const candidateSha = receipt.context?.git?.head_sha;
        if (typeof candidateSha !== 'string') return [];
        return [
          {
            ...record,
            candidate_sha: candidateSha,
            completed_at:
              typeof receipt.timestamp === 'string'
                ? receipt.timestamp
                : (record.completed_at ?? record.timestamp),
          },
        ];
      },
    );
    return bound.length > 0 ? bound : [record];
  });
}

export function candidateHead(repoRoot: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

function evidenceCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ');
  }
  return '';
}

function isObservationProjectionPath(path: string): boolean {
  return (
    path === 'record/proofs/chain.json' ||
    path.startsWith('record/proofs/sensor-readings/') ||
    path.startsWith('record/proofs/work/test-results/')
  );
}

function evidenceSubjectMatchesCandidate(
  repoRoot: string,
  subjectSha: string,
  candidateSha: string,
): boolean {
  if (subjectSha.toLowerCase() === candidateSha.toLowerCase()) return true;
  if (!/^[0-9a-f]{40}$/i.test(subjectSha) || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
    return false;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', subjectSha, candidateSha], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    const changed = execFileSync('git', ['diff', '--name-only', `${subjectSha}..${candidateSha}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/u)
      .filter(Boolean);
    return changed.length > 0 && changed.every(isObservationProjectionPath);
  } catch {
    return false;
  }
}

export function hasFreshCandidateEvidence(
  repoRoot: string,
  records: readonly AlignmentEvidence[],
  candidate: string,
  candidateHead: string,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return false;
  }
  return records.some((record) => {
    if (record.status !== 'pass') return false;
    if (
      typeof record.candidate_sha !== 'string' ||
      !evidenceSubjectMatchesCandidate(repoRoot, record.candidate_sha, candidateHead)
    ) {
      return false;
    }
    if (record.lifecycle === 'experimental') return false;
    const completedAt = record.completed_at ?? record.timestamp;
    if (typeof completedAt !== 'string') return false;
    const completedMs = Date.parse(completedAt);
    if (!Number.isFinite(completedMs) || completedMs > nowMs || nowMs - completedMs > maxAgeMs) {
      return false;
    }
    const command = evidenceCommand(record.command);
    if (hasNonBindingControlFlow(command)) return false;
    if (shellSegments(command).some(disablesErrexit)) return false;
    return shellSegments(command).some((segment) =>
      isFailClosedExecutableSegment(segment, candidate),
    );
  });
}
