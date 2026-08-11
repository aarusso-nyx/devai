import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Adoption profiles are minimum assurance declarations. Obligations above the
 * declared floor remain advisory; an absent or invalid declaration uses tier3.
 */

export type AdoptionProfile = 'tier1' | 'tier2' | 'tier3';

export const ADOPTION_PROFILES: readonly AdoptionProfile[] = ['tier1', 'tier2', 'tier3'];

const ORDER: Readonly<Record<AdoptionProfile, number>> = { tier1: 1, tier2: 2, tier3: 3 };

export function isAdoptionProfile(v: unknown): v is AdoptionProfile {
  return typeof v === 'string' && (ADOPTION_PROFILES as readonly string[]).includes(v);
}

/** declared >= required */
export function profileAtLeast(declared: AdoptionProfile, required: AdoptionProfile): boolean {
  return ORDER[declared] >= ORDER[required];
}

/** Read the profile without letting missing or malformed config weaken the floor. */
export function readProfile(repoRoot: string): AdoptionProfile {
  const path = join(repoRoot, '.devai/config/project.json');
  if (!existsSync(path)) return 'tier3';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { profile?: unknown };
    return isAdoptionProfile(parsed.profile) ? parsed.profile : 'tier3';
  } catch {
    return 'tier3';
  }
}
