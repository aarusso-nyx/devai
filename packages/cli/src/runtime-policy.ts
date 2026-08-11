import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ProjectPolicy {
  readonly feature_flags?: Readonly<Record<string, boolean>>;
}

export function autonomousLoopEnabled(repoRoot: string): boolean {
  const path = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as ProjectPolicy;
    return config.feature_flags?.['autonomous_loop'] === true;
  } catch {
    return false;
  }
}

export interface ExperimentalActivation {
  readonly repoRoot: string;
  readonly experimental: boolean;
  readonly write: boolean;
}

/** Returns a stable refusal reason, or null when all D-126 grants are present. */
export function experimentalLoopRefusal(opts: ExperimentalActivation): string | null {
  if (!autonomousLoopEnabled(opts.repoRoot)) {
    return 'project opt-in feature_flags.autonomous_loop=true is required';
  }
  if (!opts.experimental) return '--experimental is required';
  if (!opts.write) return '--write is required';
  return null;
}
