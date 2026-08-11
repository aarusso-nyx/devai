import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanInvOverrides } from '../../src/inv-override/index.js';

describe('scanInvOverrides', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devai-ovr-'));
    mkdirSync(join(dir, 'packages/cli/src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a well-formed override block', () => {
    const src = [
      'export function x() {',
      '  // inv-override: INV-DEVAI-005',
      '  // reason: legacy task lifecycle for migration test',
      '  // ticket: ENG-1234',
      '  // expires: 2999-Q4',
      '  // approver: @aarusso',
      '  return 42;',
      '}',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.findings).toHaveLength(0);
    expect(result.overrides).toHaveLength(1);
    const o = result.overrides[0];
    expect(o?.invariant_id).toBe('INV-DEVAI-005');
    expect(o?.reason).toContain('legacy task lifecycle');
    expect(o?.id).toMatch(/^OVR-[a-f0-9]{16}$/);
  });

  it('flags missing required fields', () => {
    const src = [
      '// inv-override: INV-DEVAI-005',
      '// reason: missing ticket and approver',
      '// expires: 2999-Q4',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.overrides).toHaveLength(0);
    expect(result.findings[0]?.code).toBe('malformed');
    expect(result.findings[0]?.message).toContain('ticket');
    expect(result.findings[0]?.message).toContain('approver');
  });

  it('flags expired overrides', () => {
    const src = [
      '// inv-override: INV-DEVAI-005',
      '// reason: was overridden in 2020',
      '// ticket: ENG-1',
      '// expires: 2020-Q1',
      '// approver: @aarusso',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.findings[0]?.code).toBe('expired');
  });

  it('flags overrides on constitutional or hard-fail invariants', () => {
    const src = [
      '// inv-override: INV-DEVAI-001',
      '// reason: trying to override constitutional invariant',
      '// ticket: ENG-1',
      '// expires: 2999-Q4',
      '// approver: @aarusso',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const catalog = new Map([['INV-DEVAI-001', { severity: 'constitutional' }]]);
    const result = scanInvOverrides({ repoRoot: dir, invariants: catalog });
    expect(result.findings[0]?.code).toBe('severity-forbids');
    expect(result.findings[0]?.message).toContain('constitutional');
  });

  it('flags unknown invariant ids', () => {
    const src = [
      '// inv-override: INV-NOT-A-REAL-ONE-999',
      '// reason: testing unknown id',
      '// ticket: ENG-1',
      '// expires: 2999-Q4',
      '// approver: @aarusso',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const catalog = new Map([['INV-DEVAI-005', { severity: 'hard-fail' }]]);
    const result = scanInvOverrides({ repoRoot: dir, invariants: catalog });
    expect(result.findings[0]?.code).toBe('unknown-invariant');
  });

  it('accepts YYYY-MM-DD expiry format', () => {
    const src = [
      '// inv-override: INV-DEVAI-005',
      '// reason: date-format expiry',
      '// ticket: ENG-1',
      '// expires: 2999-12-31',
      '// approver: @aarusso',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.overrides).toHaveLength(1);
  });

  it('rejects malformed expires', () => {
    const src = [
      '// inv-override: INV-DEVAI-005',
      '// reason: bad expiry',
      '// ticket: ENG-1',
      '// expires: never',
      '// approver: @aarusso',
    ].join('\n');
    writeFileSync(join(dir, 'packages/cli/src/x.ts'), src);
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.findings[0]?.code).toBe('malformed');
    expect(result.findings[0]?.message).toContain('expires');
  });

  it('skips files without the inv-override: marker (fast path)', () => {
    writeFileSync(
      join(dir, 'packages/cli/src/x.ts'),
      'export const x = 1;\n// nothing to see here',
    );
    const result = scanInvOverrides({ repoRoot: dir });
    expect(result.overrides).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });
});
// Invariants: INV-INVENTORY-001
