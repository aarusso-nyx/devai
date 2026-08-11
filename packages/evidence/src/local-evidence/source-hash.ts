import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from '@devai-nyx/authority';
import { join } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';

/**
 * Deterministic digest over every git-tracked file (path, byte
 * length, per-file sha256), excluding the given prefixes — always
 * at least the manifest's own directory, so committing the manifest
 * does not invalidate the hash it carries. Binds a local-evidence
 * claim to the exact tree it was produced from (D-117; ported from
 * the stynx prototype's source-hash.mjs).
 */
export interface SourceHash {
  readonly algorithm: 'sha256';
  readonly value: string;
  readonly fileCount: number;
}

function runGit(repoRoot: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    throw new Error(stderr.length > 0 ? stderr : `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function trackedFiles(repoRoot: string, excludePrefixes: readonly string[]): string[] {
  const normalized = excludePrefixes.map((p) => (p.endsWith('/') ? p : `${p}/`));
  return runGit(repoRoot, ['ls-files', '-z'])
    .toString('utf8')
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => !normalized.some((p) => f === p.slice(0, -1) || f.startsWith(p)))
    .sort();
}

export function computeSourceHash(
  repoRoot: string,
  excludePrefixes: readonly string[],
): SourceHash {
  const files = trackedFiles(repoRoot, excludePrefixes);
  const rootHash = createHash('sha256');

  for (const file of files) {
    rootHash.update(file);
    rootHash.update('\0');

    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      rootHash.update('deleted');
      rootHash.update('\0');
      continue;
    }

    const content = readFileSync(abs);
    const fileHash = createHash('sha256').update(content).digest('hex');
    rootHash.update(String(content.length));
    rootHash.update('\0');
    rootHash.update(fileHash);
    rootHash.update('\0');
  }

  return {
    algorithm: 'sha256',
    value: rootHash.digest('hex'),
    fileCount: files.length,
  };
}
