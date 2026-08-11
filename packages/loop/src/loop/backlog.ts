import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, join } from 'node:path';

/** Append-only round task queue stored as JSON lines and sorted by priority. */

export interface BacklogEntry {
  /** Task id assigned at append time. */
  readonly id: string;
  /** Owning governed round. */
  readonly round_id: string;
  readonly title: string;
  readonly priority: number;
  readonly discipline?: 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
  readonly target_modules?: readonly string[];
  readonly target_substrates?: readonly ('F1' | 'F2' | 'F3' | 'F4' | 'F5')[];
  /** Status; defaults to 'queued' on append. */
  readonly status?:
    | 'queued'
    | 'in_progress'
    | 'awaiting_human_review'
    | 'experimental_blocked'
    | 'completed'
    | 'cancelled';
  readonly description?: string;
  readonly lifecycle?: 'supported' | 'experimental';
  readonly acceptance_commands?: readonly (readonly string[])[];
  readonly db_isolation?: 'database' | 'cluster';
  /** ISO timestamp when first appended. */
  readonly created_at: string;
}

const BACKLOG_PATH_REL = '.devai/state/backlog.jsonl';

export function backlogPath(repoRoot: string): string {
  return join(repoRoot, BACKLOG_PATH_REL);
}

/**
 * Read all entries; an entry's latest record (last appearance by id)
 * wins. Sorted by priority descending, then created_at ascending.
 */
export function readBacklog(repoRoot: string): BacklogEntry[] {
  const path = backlogPath(repoRoot);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  const latest = new Map<string, BacklogEntry>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as BacklogEntry;
      if (!/^R-[0-9]{4}$/u.test(entry.round_id)) continue;
      latest.set(entry.id, entry);
    } catch {
      // skip malformed line
    }
  }
  return [...latest.values()].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

/**
 * Append a new entry. The caller supplies the partial; id +
 * created_at + default status are filled in if absent.
 */
export function appendBacklog(
  repoRoot: string,
  partial: Partial<BacklogEntry> & Pick<BacklogEntry, 'round_id' | 'title' | 'priority'>,
): BacklogEntry {
  const path = backlogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  // Determine next TASK id by reading existing entries.
  const existing = readBacklog(repoRoot);
  let nextN = 1;
  for (const e of existing) {
    const m = /^TASK-(\d+)$/.exec(e.id);
    if (m !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= nextN) nextN = n + 1;
    }
  }
  const id = partial.id ?? `TASK-${String(nextN).padStart(4, '0')}`;
  const entry: BacklogEntry = {
    id,
    round_id: partial.round_id,
    title: partial.title,
    priority: partial.priority,
    status: partial.status ?? 'queued',
    created_at: partial.created_at ?? new Date().toISOString(),
    ...(partial.discipline !== undefined && { discipline: partial.discipline }),
    ...(partial.target_modules !== undefined && { target_modules: partial.target_modules }),
    ...(partial.target_substrates !== undefined && {
      target_substrates: partial.target_substrates,
    }),
    ...(partial.description !== undefined && { description: partial.description }),
    ...(partial.lifecycle !== undefined && { lifecycle: partial.lifecycle }),
    ...(partial.acceptance_commands !== undefined && {
      acceptance_commands: partial.acceptance_commands,
    }),
    ...(partial.db_isolation !== undefined && { db_isolation: partial.db_isolation }),
  };
  appendFileSync(path, JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Update an entry's status. Append-only: writes a new line with the
 * mutated record; `readBacklog` returns the latest by id.
 */
export function updateBacklogStatus(
  repoRoot: string,
  id: string,
  status:
    | 'queued'
    | 'in_progress'
    | 'awaiting_human_review'
    | 'experimental_blocked'
    | 'completed'
    | 'cancelled',
): BacklogEntry | null {
  const entries = readBacklog(repoRoot);
  const current = entries.find((e) => e.id === id);
  if (current === undefined) return null;
  const updated: BacklogEntry = { ...current, status };
  const path = backlogPath(repoRoot);
  appendFileSync(path, JSON.stringify(updated) + '\n');
  return updated;
}

/**
 * Pick the highest-priority queued entry. Returns null when the
 * backlog is empty or every entry is completed/cancelled.
 */
export function pickNextTask(repoRoot: string): BacklogEntry | null {
  for (const e of readBacklog(repoRoot)) {
    if (e.status === 'queued' || e.status === undefined) return e;
  }
  return null;
}

/**
 * Rewrite the backlog with a deduplicated, latest-wins snapshot.
 * Useful for housekeeping after many appends; not required for
 * correctness. Best-effort — failure leaves the original file intact.
 */
export function compactBacklog(repoRoot: string): number {
  const entries = readBacklog(repoRoot);
  const path = backlogPath(repoRoot);
  const content =
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
  try {
    writeFileSync(path, content);
  } catch {
    return 0;
  }
  return entries.length;
}
