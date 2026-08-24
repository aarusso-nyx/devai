import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'packages', 'cli', 'dist', 'runtime', 'index', 'bin.js');

describe('local built-CLI guard', () => {
  it('fails loudly before integration cases can silently skip', () => {
    expect(
      existsSync(bin),
      'assembled CLI bundle missing: build the CLI before running integration tests; skipIfNotBuilt cases would otherwise be skipped.',
    ).toBe(true);
  });
});
