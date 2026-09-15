import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchemaParseError } from '@devai-nyx/schemas';
import {
  loadTestWeakeningConfig,
  TEST_WEAKENING_DEFAULTS,
} from '../../src/test-weakening-config.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'devai-test-weakening-causes-'));
});

afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

function writeConfig(contents: string): void {
  const dir = join(repoRoot, '.devai', 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'test-weakening.json'), contents);
}

interface ErrorWithCause extends Error {
  readonly cause?: unknown;
}

describe('test weakening config error causes', () => {
  it('preserves the SchemaParseError cause for malformed JSON', () => {
    writeConfig('{ malformed');

    let thrown: ErrorWithCause | undefined;
    try {
      loadTestWeakeningConfig(repoRoot);
    } catch (error) {
      thrown = error as ErrorWithCause;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/is not valid JSON/);
    expect(thrown?.cause).toBeInstanceOf(SchemaParseError);
    expect((thrown?.cause as SchemaParseError).kind).toBe('json-syntax');
  });

  it('preserves the SchemaParseError cause for schema-invalid JSON', () => {
    writeConfig(JSON.stringify({ threshold_ratio: 1.5 }));

    let thrown: ErrorWithCause | undefined;
    try {
      loadTestWeakeningConfig(repoRoot);
    } catch (error) {
      thrown = error as ErrorWithCause;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/test-weakening-config\.schema\.json validation/);
    expect(thrown?.cause).toBeInstanceOf(SchemaParseError);
    expect((thrown?.cause as SchemaParseError).kind).toBe('schema-validation');
    expect((thrown?.cause as SchemaParseError).issues.length).toBeGreaterThan(0);
  });

  it('uses an empty ignored_paths default when the field is omitted', () => {
    writeConfig('{}');

    expect(loadTestWeakeningConfig(repoRoot)).toEqual({
      ...TEST_WEAKENING_DEFAULTS,
      ignored_paths: [],
      source: 'config-file',
    });
  });
});
