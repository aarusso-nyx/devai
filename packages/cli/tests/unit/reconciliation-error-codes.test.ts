import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandRefusal } from '../../src/cli-error.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const codes = [
  'RECONCILIATION_ADMISSION_ANCHOR_INVALID',
  'RECONCILIATION_ADMISSION_STALE',
  'RECONCILIATION_ADMISSION_BUSY',
  'RECONCILIATION_ADMISSION_REENTRANT',
  'RECONCILIATION_ADMISSION_CALLBACK_INVALID',
  'RECONCILIATION_ADMISSION_UNAVAILABLE',
  'RECONCILIATION_ADMISSION_RELEASE_INDETERMINATE',
] as const;
const reference = new Set(
  readFileSync(resolve(ROOT, 'docs/reference/error-codes.md'), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const code = /^\| `([A-Z][A-Z0-9_]+)` \|/u.exec(line)?.[1];
      return code === undefined ? [] : [code];
    }),
);
const { NOT_CODES } = (await import(
  pathToFileURL(resolve(ROOT, 'scripts/error-code-sources.mjs')).href
)) as { readonly NOT_CODES: ReadonlySet<string> };

describe('reconciliation admission diagnostic consumer census', () => {
  it.each(codes)('includes exact diagnostic %s in the generated reference', (code) => {
    expect(reference.has(code), code).toBe(true);
  });

  it.each(codes)('preserves leading %s through the actual command refusal boundary', (code) => {
    const context = { fixture: 'lower-native-error-consumer-only' };
    const remediation = 'Inspect the exact lower admission refusal before retrying.';
    const bare = commandRefusal(code, 2, context, remediation, 'ACTION_INVOCATION_REFUSED');
    expect(bare).toMatchObject({ code, class: 'routing-authority', exit: 2, context, remediation });
    expect(bare.context).not.toHaveProperty('message');
    const detail = commandRefusal(
      `${code}: safe detail`,
      2,
      context,
      remediation,
      'ACTION_INVOCATION_REFUSED',
    );
    expect(detail).toMatchObject({
      code,
      class: 'routing-authority',
      exit: 2,
      context: { ...context, code_detail: 'safe detail' },
      remediation,
    });
    expect(detail.context).not.toHaveProperty('message');
  });

  it.each(['RECONCILIATION_ADMISSION_SEED_SHA256', 'RECONCILIATION_ADMISSION_SEED_SIZE'])(
    'excludes non-diagnostic seed metadata %s from the scanner and reference',
    (constant) => {
      expect(NOT_CODES.has(constant), constant).toBe(true);
      expect(reference.has(constant), constant).toBe(false);
    },
  );
});
