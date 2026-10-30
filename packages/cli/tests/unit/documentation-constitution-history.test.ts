import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  frozenReconciliationConstitution,
  projectReconciliationConstitution,
} from '../helpers/constitution-history.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const current = readFileSync(resolve(ROOT, 'law/constitution.md'), 'utf8');

describe('exact AUT-0009 predecessor projection', () => {
  it('reverses only the approved complete current delta to the immutable 1.2.0 text', () => {
    expect(projectReconciliationConstitution(current)).toBe(frozenReconciliationConstitution());
  });
  it('accepts the byte-identical frozen historical pin without rewriting it', () => {
    const pin = frozenReconciliationConstitution();
    expect(pin).toBe(frozenReconciliationConstitution());
    expect(projectReconciliationConstitution(pin)).toBe(pin);
  });
  it('binds the genuinely adopted current pin to the exact current source and frozen predecessor', () => {
    const pin = readFileSync(resolve(ROOT, '.devai/pin/constitution.md'), 'utf8');
    expect(pin).toBe(current);
    expect(projectReconciliationConstitution(pin)).toBe(frozenReconciliationConstitution());
  });
  it('refuses an altered current article outside the approved specialization', () => {
    expect(() =>
      projectReconciliationConstitution(current.replace('### Article 9.', '### Article 90.')),
    ).toThrow();
  });
  it('refuses an invented successor version and altered historical bytes', () => {
    expect(() => projectReconciliationConstitution(current.replaceAll('1.2.1', '1.2.2'))).toThrow();
    expect(() =>
      projectReconciliationConstitution(frozenReconciliationConstitution() + '\n'),
    ).toThrow();
  });
});
