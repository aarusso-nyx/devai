import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Monotonically-allocated id helper for `.devai/state/counters.json`.
 *
 * Consolidates four previously-duplicated `next<Kind>Id` implementations
 * (RGR / REL / RTM / a private RGR copy in skills/) onto a single
 * read-bump-write path. Each caller picks its counter key + id prefix;
 * the function preserves unknown keys in the file so multiple counters
 * coexist without clobbering each other.
 *
 * Best-effort persistence: a write failure (read-only filesystem,
 * permission denied) does not throw — the in-process counter still
 * bumps and the caller gets the next id. The next bump would re-read
 * the prior on-disk value, so transient write failures don't permanently
 * desync the file.
 *
 * Mutation is injected by the authority-owning caller. This keeps the
 * layer-0 package acyclic without bypassing the final host-effects adapter.
 */

export const COUNTERS_PATH_REL = '.devai/state/counters.json';

export type CounterKey = 'TASK' | 'RGR' | 'CTG' | 'ESC' | 'REL' | 'RTM' | (string & {});

export interface CounterMutationEffects {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  writeFileSync(path: string, data: string): void;
}

export interface NextCounterIdOptions {
  readonly repoRoot: string;
  readonly key: CounterKey;
  readonly prefix: string;
  readonly effects: CounterMutationEffects;
  /** Minimum digit count for the numeric suffix. Default 4 (RGR-0001). */
  readonly padTo?: number;
}

export function nextCounterId(opts: NextCounterIdOptions): string {
  const padTo = opts.padTo ?? 4;
  const path = join(opts.repoRoot, COUNTERS_PATH_REL);
  let counters: Record<string, number> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        counters = { ...(parsed as Record<string, number>) };
      }
    } catch {
      // keep empty defaults — corrupted/unparseable file is treated as fresh
    }
  }
  const next = (counters[opts.key] ?? 0) + 1;
  counters[opts.key] = next;
  try {
    opts.effects.mkdirSync(join(opts.repoRoot, '.devai/state'), { recursive: true });
    opts.effects.writeFileSync(path, JSON.stringify(counters, null, 2) + '\n');
  } catch {
    // best-effort
  }
  return `${opts.prefix}-${String(next).padStart(padTo, '0')}`;
}
