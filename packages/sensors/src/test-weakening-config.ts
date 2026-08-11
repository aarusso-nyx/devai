import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsers, SchemaParseError } from '@devai-nyx/schemas';

/**
 * Per-project test-weakening config (Phase 16.F, D-21 evolution).
 *
 * Adopters who want to tune the detector for their codebase's
 * shape author `.devai/config/test-weakening.json`. The file is
 * optional; absence means use the D-21 defaults baked into
 * `senseTestWeakening`.
 *
 * Schema validation is unconditional: a malformed config file
 * is a configuration error, not a silent fallback. The loader
 * throws on schema-validation failure to surface the problem at
 * the boundary (CI gate, not deep inside the detector).
 */

export interface TestWeakeningConfig {
  readonly schemaVersion?: '1.0.0';
  readonly threshold_ratio?: number;
  readonly absolute_decrease_floor?: number;
  readonly skip_added_threshold?: number;
  readonly invariant_reference_removed_threshold?: number;
  readonly ignored_paths?: readonly string[];
}

export const TEST_WEAKENING_CONFIG_REL = '.devai/config/test-weakening.json';

/**
 * D-21 defaults. The defaults stay in code so that omitting the
 * config file (or omitting a single field within it) produces
 * documented, predictable behaviour.
 */
export const TEST_WEAKENING_DEFAULTS: Required<
  Omit<TestWeakeningConfig, 'schemaVersion' | 'ignored_paths'>
> = {
  threshold_ratio: 0.2,
  absolute_decrease_floor: 1,
  skip_added_threshold: 1,
  invariant_reference_removed_threshold: 1,
};

/**
 * Load the project's test-weakening config, merging declared
 * overrides over D-21 defaults. Returns the defaults unchanged
 * when no config file exists at the well-known path.
 */
export function loadTestWeakeningConfig(repoRoot: string): {
  readonly threshold_ratio: number;
  readonly absolute_decrease_floor: number;
  readonly skip_added_threshold: number;
  readonly invariant_reference_removed_threshold: number;
  readonly ignored_paths: readonly string[];
  readonly source: 'defaults' | 'config-file';
} {
  const path = join(repoRoot, TEST_WEAKENING_CONFIG_REL);
  if (!existsSync(path)) {
    return {
      ...TEST_WEAKENING_DEFAULTS,
      ignored_paths: [],
      source: 'defaults',
    };
  }
  let cfg: TestWeakeningConfig;
  try {
    cfg = parsers.testWeakeningConfig.parseJson<TestWeakeningConfig>(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err instanceof SchemaParseError && err.kind === 'schema-validation') {
      throw new Error(
        `loadTestWeakeningConfig: ${path} failed test-weakening-config.schema.json validation: ${JSON.stringify(err.issues)}`,
        { cause: err },
      );
    }
    throw new Error(
      `loadTestWeakeningConfig: ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  return {
    threshold_ratio: cfg.threshold_ratio ?? TEST_WEAKENING_DEFAULTS.threshold_ratio,
    absolute_decrease_floor:
      cfg.absolute_decrease_floor ?? TEST_WEAKENING_DEFAULTS.absolute_decrease_floor,
    skip_added_threshold: cfg.skip_added_threshold ?? TEST_WEAKENING_DEFAULTS.skip_added_threshold,
    invariant_reference_removed_threshold:
      cfg.invariant_reference_removed_threshold ??
      TEST_WEAKENING_DEFAULTS.invariant_reference_removed_threshold,
    ignored_paths: cfg.ignored_paths ?? [],
    source: 'config-file',
  };
}
