import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * List all `*.json` files directly under `dir` whose basename matches the
 * given prefix (e.g., 'INV-', 'JNY-', 'GE-'). Returns absolute paths.
 * Returns `[]` if `dir` does not exist, supporting repositories without
 * where the F1 skeleton is in place but no entries have been authored yet.
 */
export function listSpecFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const stat = statSync(dir);
  if (!stat.isDirectory()) return [];
  const entries = readdirSync(dir);
  const matches: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    if (!name.startsWith(prefix)) continue;
    matches.push(join(dir, name));
  }
  return matches.sort();
}
