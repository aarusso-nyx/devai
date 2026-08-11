import { readdirSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: plant coherence (F2 × T3). Phase 27.G.
 * Per design note at docs/theory/architecture/sensors/plant_coherence.md.
 */

export interface PlantCoherenceOptions {
  readonly repoRoot: string;
  readonly sourceGlobs?: readonly string[];
  readonly maxReviewIncoherent?: number;
  readonly now?: string;
}

const DEFAULT_GLOBS = ['packages/*/src/**'] as const;
const DEFAULT_MAX_REVIEW = 3;

type Bucket = 'kebab' | 'snake' | 'camel' | 'pascal' | 'other';

function classifyBasename(name: string): Bucket {
  const stem = name.replace(/\.[^.]+$/, '');
  if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) return 'pascal';
  if (/_/.test(stem) && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) return 'snake';
  if (/^[a-z][a-zA-Z0-9]*$/.test(stem) && /[A-Z]/.test(stem)) return 'camel';
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem)) return 'kebab';
  return 'other';
}

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function visitDirs(dir: string, onDir: (d: string, files: string[]) => void): void {
  const st = safeStat(dir);
  if (st === null || !st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
    const full = join(dir, e);
    const ss = safeStat(full);
    if (ss === null) continue;
    if (ss.isFile() && /\.(ts|tsx|js|jsx)$/.test(e) && !/\.d\.ts$/.test(e)) {
      files.push(e);
    } else if (ss.isDirectory()) {
      visitDirs(full, onDir);
    }
  }
  if (files.length > 0) onDir(dir, files);
}

function expandWildcardOneLevel(repoRoot: string, glob: string, dirs: string[]): void {
  const prefix = glob.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
  if (!prefix.includes('*')) {
    dirs.push(abs(repoRoot, prefix));
    return;
  }
  const parts = prefix.split('/');
  const wildIdx = parts.findIndex((p) => p.includes('*'));
  if (wildIdx < 0) {
    dirs.push(abs(repoRoot, prefix));
    return;
  }
  const before = parts.slice(0, wildIdx).join('/');
  const after = parts.slice(wildIdx + 1).join('/');
  let entries: string[];
  try {
    entries = readdirSync(abs(repoRoot, before));
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = [before, entry, after].filter((s) => s !== '').join('/');
    dirs.push(abs(repoRoot, next));
  }
}

export function sensePlantCoherence(opts: PlantCoherenceOptions): SensorReading {
  const globs = opts.sourceGlobs ?? DEFAULT_GLOBS;
  const maxReview = opts.maxReviewIncoherent ?? DEFAULT_MAX_REVIEW;
  const rootDirs: string[] = [];
  for (const g of globs) expandWildcardOneLevel(opts.repoRoot, g, rootDirs);

  let dirsScanned = 0;
  let incoherentCount = 0;
  const findings: SensorFinding[] = [];
  for (const root of rootDirs) {
    visitDirs(root, (d, files) => {
      dirsScanned += 1;
      const buckets = new Set<Bucket>();
      for (const f of files) {
        const b = classifyBasename(f);
        if (b !== 'other') buckets.add(b);
      }
      if (buckets.size >= 2) {
        incoherentCount += 1;
        const rel = d.replace(opts.repoRoot + '/', '');
        findings.push({
          severity: 'warning',
          code: 'PLANT_COHERENCE_MIXED_CASING',
          message: `Directory ${rel} mixes ${Array.from(buckets).join(' + ')} casing across ${String(files.length)} files.`,
          file: rel,
        });
      }
    });
  }

  let status: SensorStatus;
  if (dirsScanned === 0) {
    status = 'review';
    findings.push({
      severity: 'info',
      code: 'PLANT_COHERENCE_NO_DIRS',
      message: `No source directories matched globs: ${globs.join(', ')}`,
    });
  } else if (incoherentCount === 0) {
    status = 'pass';
  } else if (incoherentCount <= maxReview) {
    status = 'review';
  } else {
    status = 'fail';
  }

  return buildSensorReading({
    sensorName: 'plant-coherence',
    sensorKind: 'plant_coherence',
    command: ['devai', 'sense-plant-coherence'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      dirs_scanned: dirsScanned,
      incoherent_dirs: incoherentCount,
      max_review_incoherent: maxReview,
    },
  });
}
