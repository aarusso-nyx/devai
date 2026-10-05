import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';

/** Canonical location of the adopter migration manifest in the source tree and the package. */
export const ADOPTER_MIGRATIONS_RELATIVE = 'law/policy/adopter-migrations.json';

export type UpgradeSegment =
  | 'constitution'
  | 'operational-law'
  | 'subprocess-effects'
  | 'adopter-policy'
  | 'authority'
  | 'host-adapters'
  | 'harness-ci';

export type MigrationKind =
  | 'rebind'
  | 'owned-key-retirement'
  | 'changed-default'
  | 'constitution'
  | 'new-obligation'
  | 'opt-in-capability'
  | 'new-action';

export type ObligationCheck =
  | 'adopter-policy-receipt'
  | 'constitution-version'
  | 'proof-anchor-baseline'
  | 'thresholds-soft-gate';

export interface MigrationChange {
  readonly id: string;
  readonly kind: MigrationKind;
  readonly summary: string;
  readonly decision_records: readonly string[];
  readonly issues?: readonly number[];
  readonly segments: readonly UpgradeSegment[];
  readonly files: readonly string[];
  readonly decision_required?: boolean;
  readonly retired_pointers?: readonly string[];
  readonly default?: {
    readonly policy: string;
    readonly source_key: 'domains' | 'glob_guards' | 'scorecard_na' | 'thresholds';
    readonly added: readonly string[];
  };
  readonly constitution?: { readonly from: string; readonly to: string };
  readonly obligation?: { readonly check: ObligationCheck; readonly requirement: string };
}

export interface MigrationRelease {
  readonly version: string;
  readonly status: 'released' | 'unreleased';
  readonly date?: string;
  readonly changes: readonly MigrationChange[];
}

export interface AdopterMigrations {
  readonly schemaVersion: '1.0.0';
  readonly id: 'adopter-migrations';
  readonly baseline: string;
  readonly segments: readonly UpgradeSegment[];
  readonly releases: readonly MigrationRelease[];
}

/** Compare two `major.minor.patch` versions; any pre-release suffix is ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) =>
    (value.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Validate a manifest document: its schema, ascending release order without duplicates,
 * and change ids that carry their own release version. Throws `ADOPTER_MIGRATIONS_INVALID`.
 */
export function parseAdopterMigrations(
  document: unknown,
  validator: typeof getValidator = getValidator,
): AdopterMigrations {
  const validate = validator('adopter-migrations.schema.json');
  if (validate(document) !== true) {
    throw new Error(`ADOPTER_MIGRATIONS_INVALID:${JSON.stringify(validate.errors)}`);
  }
  const manifest = document as AdopterMigrations;
  let previous = manifest.baseline;
  const ids = new Set<string>();
  for (const release of manifest.releases) {
    if (compareVersions(release.version, previous) <= 0) {
      throw new Error(`ADOPTER_MIGRATIONS_INVALID:release ${release.version} is out of order`);
    }
    previous = release.version;
    for (const change of release.changes) {
      if (!change.id.startsWith(`MIG-${release.version}-`) || ids.has(change.id)) {
        throw new Error(`ADOPTER_MIGRATIONS_INVALID:change ${change.id} in ${release.version}`);
      }
      ids.add(change.id);
    }
  }
  return manifest;
}

/** Load the manifest shipped in the installed package (or the source tree under test). */
export function loadAdopterMigrations(
  validator: typeof getValidator = getValidator,
): AdopterMigrations {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, `../../${ADOPTER_MIGRATIONS_RELATIVE}`),
    resolve(moduleRoot, `../../../../${ADOPTER_MIGRATIONS_RELATIVE}`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('ADOPTER_MIGRATIONS_UNAVAILABLE');
  return parseAdopterMigrations(JSON.parse(readFileSync(path, 'utf8')) as unknown, validator);
}

/** The releases strictly above `from` and at or below `to`, in ascending order. */
export function releasesInRange(
  manifest: AdopterMigrations,
  from: string,
  to: string,
): readonly MigrationRelease[] {
  return manifest.releases.filter(
    (release) =>
      compareVersions(release.version, from) > 0 && compareVersions(release.version, to) <= 0,
  );
}
