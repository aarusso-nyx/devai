import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator } from '../../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const schema = JSON.parse(
  readFileSync(resolve(ROOT, 'law/schemas/release-publication-receipt.schema.json'), 'utf8'),
) as { examples: readonly Readonly<Record<string, unknown>>[] };

function legacyReceipt(): Record<string, unknown> {
  const value = schema.examples[0];
  if (value === undefined) throw new Error('missing publication receipt example');
  return structuredClone(value) as Record<string, unknown>;
}

function opaqueArtifact(kind = 'package-tarball'): Record<string, unknown> {
  return {
    kind,
    sink_id: 'release-sink',
    opaque_handle: 'release-transaction:package-tarball',
    sha256: 'a'.repeat(64),
    size_bytes: 1024,
  };
}

function currentReceipt(): Record<string, unknown> {
  return {
    ...legacyReceipt(),
    schemaVersion: '1.1.0',
    artifacts: [opaqueArtifact()],
  };
}

describe('release publication receipt artifact version boundary', () => {
  const validate = getValidator('release-publication-receipt.schema.json');

  it('retains the exact legacy path projection for version 1.0.0', () => {
    const receipt = legacyReceipt();
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(receipt['schemaVersion']).toBe('1.0.0');
    expect((receipt['artifacts'] as readonly Record<string, unknown>[])[0]).toHaveProperty('path');
  });

  it('accepts the current opaque sink-handle projection only for version 1.1.0', () => {
    const receipt = currentReceipt();
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(receipt['artifacts']).toEqual([opaqueArtifact()]);
  });

  it.each([
    ['opaque artifact under legacy version', { ...legacyReceipt(), artifacts: [opaqueArtifact()] }],
    ['path artifact under current version', { ...legacyReceipt(), schemaVersion: '1.1.0' }],
    [
      'mixed current projection',
      {
        ...currentReceipt(),
        artifacts: [
          opaqueArtifact(),
          (legacyReceipt()['artifacts'] as readonly Record<string, unknown>[])[0],
        ],
      },
    ],
    [
      'unknown opaque kind',
      { ...currentReceipt(), artifacts: [opaqueArtifact('evidence-bundle')] },
    ],
    [
      'unsafe opaque handle',
      {
        ...currentReceipt(),
        artifacts: [{ ...opaqueArtifact(), opaque_handle: '../published-package' }],
      },
    ],
    [
      'additional opaque locator field',
      {
        ...currentReceipt(),
        artifacts: [{ ...opaqueArtifact(), path: 'dist/package.tgz' }],
      },
    ],
  ])('rejects %s', (_label, receipt) => {
    expect(validate(receipt)).toBe(false);
  });
});
