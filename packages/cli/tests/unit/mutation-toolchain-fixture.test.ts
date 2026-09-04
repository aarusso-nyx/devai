import { describe, expect, it } from 'vitest';
import { enabled } from '../fixtures/mutation-toolchain/subject.js';

describe('mutation toolchain fixture', () => {
  it('preserves the original boolean assertions', () => {
    expect(enabled(true)).toBe(1);
    expect(enabled(false)).toBe(0);
  });
});
