// Invariants: INV-INVENTORY-001
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanInvOverrides } from '../../src/inv-override/index.js';

let root: string;
const fields = {
  reason: 'temporary migration',
  ticket: 'ENG-42',
  expires: '2026-Q4',
  approver: '@reviewer',
};
function block(patch: Record<string, string> = {}): string {
  return [
    '// inv-override: INV-TEST-001',
    ...Object.entries({ ...fields, ...patch }).map(([key, value]) => `// ${key}: ${value}`),
  ].join('\n');
}
function write(path: string, body = block()): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function scan(options: Partial<Parameters<typeof scanInvOverrides>[0]> = {}) {
  return scanInvOverrides({ repoRoot: root, now: new Date('2026-01-01T00:00:00Z'), ...options });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-override-boundaries-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('override scan population', () => {
  it('includes all supported code extensions and excludes generated or private subtrees', () => {
    const accepted = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].map(
      (ext) => `packages/deep/code.${ext}`,
    );
    for (const path of accepted) write(path);
    for (const directory of ['node_modules', 'dist', '.git', 'coverage', '.vitest-cache', '.devai'])
      write(`packages/${directory}/ignored.ts`);
    for (const path of ['outside/code.ts', 'packages/readme.md', 'packages/noextension'])
      write(path);
    const result = scan();
    expect(result.findings).toEqual([]);
    expect(result.overrides.map((x) => x.file).sort()).toEqual(accepted.sort());
  });
  it('honors explicit roots and extensions without adding defaults', () => {
    write('custom/record.audit');
    write('custom/ignored.ts');
    write('packages/ignored.audit');
    expect(
      scan({ roots: ['missing', 'custom'], extensions: ['.audit'] }).overrides.map((x) => x.file),
    ).toEqual(['custom/record.audit']);
    expect(scan({ roots: [] })).toEqual({ overrides: [], findings: [] });
    expect(scan({ extensions: [] })).toEqual({ overrides: [], findings: [] });
  });
});

describe('override annotation authorization fields', () => {
  it.each([
    ['approver', 'prefix@reviewer'],
    ['approver', '@reviewer!'],
    ['ticket', '!ENG-42'],
    ['ticket', 'ENG-42!'],
    ['adr', 'prefixADR-001'],
    ['adr', 'RFC-001'],
    ['expires', 'prefix2026-Q4'],
    ['expires', '2026-Q4suffix'],
  ])('refuses malformed %s value %s with its source location', (key, value) => {
    write('packages/entry.ts', '\n' + block({ [key]: value }));
    const result = scan();
    expect(result.overrides).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'malformed',
        file: 'packages/entry.ts',
        line: 2,
        invariant_id: 'INV-TEST-001',
        message: expect.stringContaining(key),
      }),
    ]);
  });
  it('retains optional ADR metadata and accurately binds annotation location', () => {
    write('packages/entry.ts', '\n' + block({ adr: 'ADR-001' }));
    const result = scan();
    expect(result.findings).toEqual([]);
    expect(result.overrides).toEqual([
      expect.objectContaining({
        schemaVersion: '1.0.0',
        invariant_id: 'INV-TEST-001',
        file: 'packages/entry.ts',
        line: 2,
        ...fields,
        adr: 'ADR-001',
      }),
    ]);
    write('packages/entry.ts', '\n' + block());
    expect(scan().overrides[0]).not.toHaveProperty('adr');
  });
  it.each(['constitutional', 'hard-fail'])(
    'forbids %s even with otherwise valid approval metadata',
    (severity) => {
      write('packages/entry.ts');
      const result = scan({ invariants: new Map([['INV-TEST-001', { severity }]]) });
      expect(result.overrides).toEqual([]);
      expect(result.findings).toEqual([
        expect.objectContaining({
          code: 'severity-forbids',
          message: expect.stringContaining(severity),
        }),
      ]);
    },
  );
  it('accepts a known overridable invariant without treating the catalog as blanket prohibition', () => {
    write('packages/entry.ts');
    const result = scan({ invariants: new Map([['INV-TEST-001', { severity: 'gate' }]]) });
    expect(result.findings).toEqual([]);
    expect(result.overrides).toHaveLength(1);
  });
  it('recognizes compact and spaced comments but never inline code or trailing header junk', () => {
    write('packages/compact.ts', block().replaceAll('// ', '//').replaceAll(': ', ':'));
    write(
      'packages/spaced.ts',
      block()
        .replaceAll(': ', ' :   ')
        .replace('inv-override :', 'inv-override:')
        .replace('INV-TEST-001', 'INV-TEST-001  '),
    );
    write('packages/inline.ts', 'const x = 1; ' + block());
    write('packages/trailing.ts', block().replace('INV-TEST-001', 'INV-TEST-001 junk'));
    expect(
      scan()
        .overrides.map((x) => x.file)
        .sort(),
    ).toEqual(['packages/compact.ts', 'packages/spaced.ts']);
  });
});

describe('override expiration calendar boundaries', () => {
  it.each([
    ['2026-Q1', '2026-03-31'],
    ['2026-Q2', '2026-06-30'],
    ['2026-Q3', '2026-09-30'],
    ['2026-Q4', '2026-12-31'],
    ['2028-02-29', '2028-02-29'],
    ['2026-01-09', '2026-01-09'],
  ])('accepts the final second of %s and refuses the following UTC day', (expires, lastDay) => {
    write('packages/entry.ts', block({ expires }));
    const end = new Date(`${lastDay}T23:59:59.000Z`);
    const valid = scan({ now: end });
    expect(valid.findings).toEqual([]);
    expect(valid.overrides).toHaveLength(1);
    const expired = scan({ now: new Date(end.getTime() + 1000) });
    expect(expired.overrides).toEqual([]);
    expect(expired.findings).toEqual([
      expect.objectContaining({ code: 'expired', message: `inv-override expired on ${expires}` }),
    ]);
  });
});

describe('independent override blocks', () => {
  it('binds each adjacent override to its own authorization metadata', () => {
    const first = block({ reason: 'first migration', ticket: 'ENG-1', approver: '@first' });
    const second = block({
      reason: 'second migration',
      ticket: 'ENG-2',
      approver: '@second',
    }).replace('INV-TEST-001', 'INV-TEST-002');
    write('packages/entry.ts', `${first}\n${second}`);
    const result = scan();
    expect(result.findings).toEqual([]);
    expect(
      result.overrides.map(({ invariant_id, reason, ticket, approver, line }) => ({
        invariant_id,
        reason,
        ticket,
        approver,
        line,
      })),
    ).toEqual([
      {
        invariant_id: 'INV-TEST-001',
        reason: 'first migration',
        ticket: 'ENG-1',
        approver: '@first',
        line: 1,
      },
      {
        invariant_id: 'INV-TEST-002',
        reason: 'second migration',
        ticket: 'ENG-2',
        approver: '@second',
        line: 6,
      },
    ]);
  });

  it('does not borrow missing approval fields from the next override block', () => {
    write('packages/entry.ts', `// inv-override: INV-INCOMPLETE\n${block()}`);
    const result = scan();
    expect(result.overrides.map(({ invariant_id }) => invariant_id)).toEqual(['INV-TEST-001']);
    expect(result.findings).toEqual([
      {
        code: 'malformed',
        file: 'packages/entry.ts',
        line: 1,
        invariant_id: 'INV-INCOMPLETE',
        message: 'inv-override missing required field(s): reason, ticket, expires, approver',
      },
    ]);
  });
});

describe('override metadata isolation and record identity', () => {
  it.each(['reason', 'ticket', 'expires', 'approver'])(
    'reports missing %s at the annotation header',
    (field) => {
      const body = block()
        .split('\n')
        .filter((line) => !line.startsWith(`// ${field}:`))
        .join('\n');
      write('packages/entry.ts', `\n${body}`);
      expect(scan()).toEqual({
        overrides: [],
        findings: [
          {
            code: 'malformed',
            file: 'packages/entry.ts',
            line: 2,
            invariant_id: 'INV-TEST-001',
            message: `inv-override missing required field(s): ${field}`,
          },
        ],
      });
    },
  );

  it.each(['const value = 1; ', '\n', '/* boundary */\n'])(
    'does not attach metadata beyond code or a block boundary %j',
    (boundary) => {
      const lines = block().split('\n');
      write('packages/entry.ts', `${lines[0]}\n${boundary}${lines.slice(1).join('\n')}`);
      expect(scan()).toEqual({
        overrides: [],
        findings: [
          {
            code: 'malformed',
            file: 'packages/entry.ts',
            line: 1,
            invariant_id: 'INV-TEST-001',
            message: 'inv-override missing required field(s): reason, ticket, expires, approver',
          },
        ],
      });
    },
  );

  it('binds stable record IDs to exact source location and reason using independent hash vectors', () => {
    // Python hashlib.sha256 over invariant|file|line|reason, first 16 hex digits.
    write('packages/entry.ts', `\n${block()}`);
    expect(scan().overrides.map(({ id }) => id)).toEqual(['OVR-610eccc80f6e64b4']);
    expect(scan().overrides.map(({ id }) => id)).toEqual(['OVR-610eccc80f6e64b4']);
    write('packages/entry.ts', `\n${block({ reason: 'different reason' })}`);
    expect(scan().overrides.map(({ id }) => id)).toEqual(['OVR-768f940ce73a4807']);
  });
});
