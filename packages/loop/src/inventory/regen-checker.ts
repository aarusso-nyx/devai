import { execFileSync, existsSync, readFileSync } from '@devai-nyx/authority';
import { isAbsolute, resolve } from 'node:path';
import { sha256Hex } from './id.js';

export interface RegenEntry {
  readonly name: string;
  readonly command: readonly string[];
  readonly outputs: readonly string[];
  readonly cwd?: string;
}

export interface RegenConfig {
  readonly schemaVersion: string;
  readonly regen: readonly RegenEntry[];
}

export interface RegenCheckResult {
  readonly name: string;
  readonly ok: boolean;
  /** Repo-relative paths whose hash changed between before/after. */
  readonly drifted_files: readonly string[];
  /** Repo-relative paths the command was supposed to produce but didn't. */
  readonly missing_files: readonly string[];
  /** Non-empty when the command itself failed. */
  readonly command_error?: string;
}

export interface CheckRegenOptions {
  readonly repoRoot: string;
  readonly config: RegenConfig;
}

/**
 * Run every regen entry: snapshot its declared `outputs` (sha256 each),
 * execute the command (via execFileSync — no shell), re-snapshot, diff.
 *
 * Returns a result per entry. `ok: true` when every output's hash matches
 * before and after AND no listed output is missing AND the command exited 0.
 *
 * Outputs are resolved relative to `cwd` (which itself is relative to
 * `repoRoot` when not absolute) before snapshotting.
 */
export function checkRegen(opts: CheckRegenOptions): readonly RegenCheckResult[] {
  const results: RegenCheckResult[] = [];
  for (const entry of opts.config.regen) {
    const cwd =
      entry.cwd === undefined
        ? opts.repoRoot
        : isAbsolute(entry.cwd)
          ? entry.cwd
          : resolve(opts.repoRoot, entry.cwd);

    const absoluteOutputs = entry.outputs.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));

    const beforeHashes = new Map<string, string | null>();
    for (const [i, path] of absoluteOutputs.entries()) {
      beforeHashes.set(entry.outputs[i] ?? path, snapshotHash(path));
    }

    let commandError: string | undefined;
    try {
      const [bin, ...args] = entry.command;
      if (bin === undefined) {
        commandError = 'empty command array';
      } else {
        execFileSync(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      }
    } catch (err) {
      commandError = err instanceof Error ? err.message : String(err);
    }

    const drifted: string[] = [];
    const missing: string[] = [];
    for (const [i, path] of absoluteOutputs.entries()) {
      const relName = entry.outputs[i] ?? path;
      const after = snapshotHash(path);
      if (after === null) {
        missing.push(relName);
        continue;
      }
      const before = beforeHashes.get(relName);
      if (before !== null && before !== after) drifted.push(relName);
    }

    results.push({
      name: entry.name,
      ok: commandError === undefined && drifted.length === 0 && missing.length === 0,
      drifted_files: drifted.sort(),
      missing_files: missing.sort(),
      ...(commandError !== undefined && { command_error: commandError }),
    });
  }
  return results;
}

function snapshotHash(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    return sha256Hex(readFileSync(absPath));
  } catch {
    return null;
  }
}

export function loadRegenConfig(path: string): RegenConfig {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text) as RegenConfig;
}
