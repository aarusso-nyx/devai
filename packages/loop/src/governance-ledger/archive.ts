import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { GovernanceFinding, GovernanceIntegrityReport } from './records.js';

interface ArchiveManifest {
  readonly files?: readonly {
    readonly path?: unknown;
    readonly sha256?: unknown;
  }[];
}
const DEFAULT_ARCHIVE_DIR = 'law/adr/archive';

export function archiveImmutability(options: {
  readonly repoRoot: string;
  readonly archiveDir?: string;
}): GovernanceIntegrityReport {
  const archiveDir = resolve(options.repoRoot, options.archiveDir ?? DEFAULT_ARCHIVE_DIR);
  const manifestPath = join(archiveDir, 'MANIFEST.json');
  const archiveStat = lstatSync(archiveDir, { throwIfNoEntry: false });
  if (archiveStat === undefined) return { ok: true, findings: [] };
  if (!archiveStat.isDirectory())
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'Archive root must be a directory, not a link.',
          path: relative(options.repoRoot, archiveDir),
        },
      ],
    };
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_MISSING',
          message: `${relative(options.repoRoot, archiveDir)} has no MANIFEST.json.`,
          path: relative(options.repoRoot, archiveDir),
        },
      ],
    };
  }
  let manifest: ArchiveManifest;
  try {
    if (!lstatSync(manifestPath).isFile()) throw new Error('manifest is not a regular file');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest;
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      !Array.isArray(manifest.files)
    )
      throw new Error('manifest files array is required');
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'ARCHIVE_MANIFEST_INVALID',
          message: 'MANIFEST.json must be a regular JSON file containing a files array.',
          path: relative(options.repoRoot, manifestPath),
        },
      ],
    };
  }
  const findings: GovernanceFinding[] = [];
  const declared = new Set<string>();
  const inventory = new Map<string, string>();
  const scan = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) scan(path);
      else if (stat.isFile()) inventory.set(relative(archiveDir, path).split(sep).join('/'), path);
      else
        findings.push({
          code: 'ARCHIVE_FILE_UNSAFE',
          message: 'Archive members must not be links or special files.',
          path: relative(options.repoRoot, path),
        });
    }
  };
  scan(archiveDir);
  for (const entry of manifest.files ?? []) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      /[\\\p{Cc}]/u.test(entry.path) ||
      /^[A-Za-z]:/u.test(entry.path) ||
      !entry.path
        .split('/')
        .every((part: string) => part !== '' && part !== '.' && part !== '..') ||
      entry.path === 'MANIFEST.json' ||
      declared.has(entry.path)
    ) {
      findings.push({
        code: 'ARCHIVE_MANIFEST_INVALID',
        message:
          'Every manifest entry requires a unique canonical member path and lowercase SHA-256.',
        path: relative(options.repoRoot, manifestPath),
      });
      continue;
    }
    declared.add(entry.path);
    const path = inventory.get(entry.path);
    if (path === undefined) {
      findings.push({
        code: 'ARCHIVE_FILE_MISSING',
        message: `${entry.path} is declared but absent.`,
        path: relative(options.repoRoot, join(archiveDir, entry.path)),
      });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== entry.sha256) {
      findings.push({
        code: 'ARCHIVE_HASH_MISMATCH',
        message: `${entry.path} does not match its frozen SHA-256.`,
        path: relative(options.repoRoot, path),
      });
    }
  }
  for (const [rel, path] of inventory) {
    if (rel !== 'MANIFEST.json' && !declared.has(rel)) {
      findings.push({
        code: 'ARCHIVE_FILE_UNDECLARED',
        message: `${rel} is not pinned by MANIFEST.json.`,
        path: relative(options.repoRoot, path),
      });
    }
  }
  return { ok: findings.length === 0, findings };
}
