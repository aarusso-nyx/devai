import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Loud-skip guard (D-109 follow-up). Dozens of integration suites use
 * a skipIfNotBuilt pattern: when the assembled CLI bundle is absent
 * they silently skip. That silence masked 24 real failures for weeks
 * — "16 skipped" read as success in the R13/R14 gate reports while the
 * skipped tests were red whenever anyone actually built.
 *
 * This test deliberately FAILS (never skips) when the CLI is not
 * built, so an unbuilt integration run produces one loud red instead
 * of a quiet pile of skips. Run `pnpm typecheck` (tsc -b) first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'packages', 'cli', 'dist', 'runtime', 'index', 'bin.js');

describe('built-CLI guard', () => {
  it('the assembled CLI bundle exists — skipIfNotBuilt suites are actually running', () => {
    expect(
      existsSync(BIN),
      'assembled CLI bundle missing: every skipIfNotBuilt suite is silently skipping. Build the CLI before running integration tests.',
    ).toBe(true);
  });
});
// Invariants: INV-DEVAI-001
