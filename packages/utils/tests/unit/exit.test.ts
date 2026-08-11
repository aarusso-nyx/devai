import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, EXIT_FAIL, EXIT_PASS, EXIT_REVIEW, EXIT_USAGE } from '../../src/exit.js';

describe('exit codes', () => {
  it('PASS is 0', () => {
    expect(EXIT_PASS).toBe(0);
  });

  it('REVIEW is 1', () => {
    expect(EXIT_REVIEW).toBe(1);
  });

  it('FAIL is 2', () => {
    expect(EXIT_FAIL).toBe(2);
  });

  it('USAGE is 2 — one usage contract at every layer (R18.C.4, D-133; sysexits EX_USAGE=64 retired)', () => {
    expect(EXIT_USAGE).toBe(2);
  });

  it('CONFIG is 65 (sysexits EX_DATAERR)', () => {
    expect(EXIT_CONFIG).toBe(65);
  });
});
// Invariants: INV-DEVAI-001
