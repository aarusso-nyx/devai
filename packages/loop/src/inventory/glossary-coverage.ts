import { join, relative } from 'node:path';
import { listSpecFiles } from '@devai-nyx/spec';
import { readInventorySource, walkFiles } from './walker.js';

export interface TermCoverage {
  readonly id: string;
  readonly term: string;
  readonly used_count: number;
  readonly used_in: readonly string[];
}

export interface GlossaryCoverageResult {
  readonly entries_count: number;
  readonly terms: readonly TermCoverage[];
}

export interface GlossaryCoverageOptions {
  readonly repoRoot: string;
  readonly glossaryDir?: string;
  /** One or more search directories. */
  readonly searchDirs?: readonly string[];
  readonly ignoreDirs?: ReadonlySet<string>;
}

interface GlossaryRecord {
  readonly id: string;
  readonly term: string;
  readonly aliases?: readonly string[];
}

/**
 * For each glossary entry, count how many source files mention its term
 * (case-insensitive substring match across .ts and .md):
 * returns the coverage map so downstream scoring can flag terms that have
 * zero usage (potentially dead concepts).
 *
 * Default search directory is `<repoRoot>/packages/`. When `searchDirs` is
 * supplied it replaces the default.
 */
export function glossaryCoverage(opts: GlossaryCoverageOptions): GlossaryCoverageResult {
  const glossaryDir = opts.glossaryDir ?? join(opts.repoRoot, 'law/glossary');
  const searchDirs =
    opts.searchDirs === undefined || opts.searchDirs.length === 0
      ? [join(opts.repoRoot, 'packages')]
      : [...opts.searchDirs];

  const entries: GlossaryRecord[] = [];
  for (const file of listSpecFiles(glossaryDir, 'GE-')) {
    try {
      const parsed = JSON.parse(readInventorySource(file)) as GlossaryRecord;
      entries.push(parsed);
    } catch {
      // Skip malformed glossary files; spec validate-glossary catches them.
    }
  }

  // Union sources across every search dir, dedupe.
  const sourceSet = new Set<string>();
  for (const dir of searchDirs) {
    for (const f of walkFiles(dir, { extensions: ['.ts', '.md'], ignoreDirs: opts.ignoreDirs })) {
      sourceSet.add(f);
    }
  }
  const sources = [...sourceSet].sort();

  const terms: TermCoverage[] = [];
  for (const entry of entries) {
    const variants = [entry.term, ...(entry.aliases ?? [])].map((t) => t.toLowerCase());
    const usedIn: string[] = [];
    for (const file of sources) {
      let text;
      try {
        text = readInventorySource(file).toLowerCase();
      } catch {
        continue;
      }
      for (const v of variants) {
        if (text.includes(v)) {
          usedIn.push(relative(opts.repoRoot, file));
          break;
        }
      }
    }
    terms.push({
      id: entry.id,
      term: entry.term,
      used_count: usedIn.length,
      used_in: usedIn.sort(),
    });
  }

  terms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries_count: entries.length, terms };
}
