// ADR-SCR-0017 IA-004; Constitution Articles 29 and 39.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseTestIdiomaticity } from '../../src/test-idiomaticity.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-semantic integration ç '));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, body: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}
function sense(body: string) {
  put(
    'packages/api/src/owned-port.ts',
    'export const ownedPort = { async read() { return 42; } };\n',
  );
  put('packages/api/tests/integration/behavior.test.ts', body);
  return senseTestIdiomaticity({ repoRoot: root, testGlobs: ['packages/api/tests'] });
}
const IMPORT = "import { ownedPort as alias } from '../../src/owned-port.js';\n";
const FINDING = 'TEST_IDIOMATICITY_MOCK_IN_INTEGRATION';

describe('semantic integration substitution boundaries', () => {
  it('ignores mock, fixture and snapshot text in comments and strings', () => {
    const reading = sense(`// vi.mock('../../src/owned-port.js'); beforeEach(() => {});
/* vi.fn(); spyOn(alias, 'read'); expect(1).toMatchSnapshot(); */
const description = "vi.mock('owned'); beforeAll(() => {}); toMatchInlineSnapshot()";
it('exercises arithmetic', () => expect(2 + 2).toBe(4));`);
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      test_files: 1,
      mock_calls: 0,
      fixture_calls: 0,
      snapshot_calls: 0,
      mocks_in_integration_files: 0,
    });
    expect(reading.findings?.map((f) => f.code) ?? []).not.toContain(FINDING);
  });

  it('keeps a call-through observer on a resolved owned import distinct from substitution', () => {
    const reading = sense(
      IMPORT +
        `it('observes actual execution', async () => {
const observer = vi.spyOn(alias, 'read');
expect(await alias.read()).toBe(42); expect(observer).toHaveBeenCalledOnce();
});`,
    );
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(0);
    expect(reading.findings?.map((f) => f.code) ?? []).not.toContain(FINDING);
  });

  it('does not treat observer naming metadata as an owned behavior override', () => {
    const reading = sense(
      IMPORT +
        `it('names a call-through observer', async () => {
const observer = vi.spyOn(alias, 'read').mockName('read observer');
expect(await alias.read()).toBe(42); expect(observer).toHaveBeenCalledOnce();
});`,
    );
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(0);
    expect(reading.findings?.map((f) => f.code) ?? []).not.toContain(FINDING);
  });

  it('retains external-port replacement as a legitimate integration boundary', () => {
    const reading = sense(`import { readFile } from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'payload') }));
it('receives the external payload', async () => expect(await readFile('remote')).toBe('payload'));`);
    expect(reading.metrics?.mocks_in_integration_files).toBe(0);
    expect(reading.findings?.map((f) => f.code) ?? []).not.toContain(FINDING);
  });

  it.each([
    [
      "vi.mock('../../src/owned-port.js', () => ({ ownedPort: { read: () => 0 } }));",
      'expect(await alias.read()).toBe(0);',
    ],
    ["vi.spyOn(alias, 'read').mockResolvedValue(0);", 'expect(await alias.read()).toBe(0);'],
  ])(
    'flags actual owned behavior replacement under an integration directory: %s',
    (replacement, assertion) => {
      const reading = sense(
        IMPORT +
          `it('checks a replaced implementation', async () => { ${replacement} ${assertion} });`,
      );
      expect(reading.status).not.toBe('pass');
      expect(reading.metrics?.mocks_in_integration_files).toBe(1);
      expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
    },
  );

  it.each([
    'useValue({ canActivate: () => true })',
    'useClass(AllowAllGuard)',
    'useFactory({ factory: () => ({ canActivate: () => true }) })',
  ])('flags a resolved owned Nest guard override using %s', (replacement) => {
    put(
      'packages/api/src/auth.guard.ts',
      'export class StynxAuthGuard { canActivate() { throw new Error("real authorization"); } }\n',
    );
    const reading = sense(`import { StynxAuthGuard } from '../../src/auth.guard.js';
import { Test } from '@nestjs/testing';
class AllowAllGuard { canActivate() { return true; } }
it('must exercise real authorization', async () => {
await Test.createTestingModule({}).overrideGuard(StynxAuthGuard).${replacement}.compile();
});`);
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(1);
    expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
  });

  it.each([
    ['static import', "import { runtime } from '../../test/support/runtime.js';", ''],
    [
      'literal dynamic import',
      '',
      "const { runtime } = await import('../../test/support/runtime.js');",
    ],
    ['literal require', '', "const { runtime } = require('../../test/support/runtime.js');"],
  ])(
    'finds an owned guard override through the local helper closure: %s',
    (_mode, prefix, acquisition) => {
      put(
        'packages/api/src/auth.guard.ts',
        'export class StynxAuthGuard { canActivate() { return false; } }\n',
      );
      put(
        'packages/api/test/support/runtime.ts',
        `import { StynxAuthGuard } from '../../src/auth.guard.js';
import { Test } from '@nestjs/testing';
export function runtime() {
return Test.createTestingModule({}).overrideGuard(StynxAuthGuard).useValue({ canActivate: () => true }).compile();
}`,
      );
      const reading = sense(`${prefix}
it('imports the full application', async () => { ${acquisition} const application = await runtime(); expect(application).toBeDefined(); });`);
      expect(reading.status).not.toBe('pass');
      expect(reading.metrics?.test_files).toBe(1);
      expect(reading.metrics?.mocks_in_integration_files).toBe(1);
      expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
    },
  );

  it.each(['await import(helperName)', 'require(helperName)'])(
    'withholds integration substitution standing for computed helper reachability: %s',
    (acquisition) => {
      put(
        'packages/api/src/auth.guard.ts',
        'export class StynxAuthGuard { canActivate() { return false; } }\n',
      );
      put(
        'packages/api/test/support/runtime.ts',
        `import {StynxAuthGuard} from '../../src/auth.guard.js';
import {Test} from '@nestjs/testing';
export const runtime = () => Test.createTestingModule({}).overrideGuard(StynxAuthGuard).useValue({canActivate:()=>true}).compile();`,
      );
      const reading = sense(
        `it('does not establish the helper closure', async()=>{const helperName = '../../test/support/runtime.js'; const {runtime} = ${acquisition}; await runtime();});`,
      );
      expect(reading.status).toBe('review');
      expect(reading.metrics?.test_files).toBe(1);
      expect(reading.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: FINDING,
            message: expect.stringMatching(/unresolved/iu),
          }),
        ]),
      );
    },
  );

  it('resolves a bare workspace guard import as owned instead of assuming an external port', () => {
    put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@fixture/auth': ['packages/auth/src/index.ts'] },
        },
      }),
    );
    put(
      'packages/auth/package.json',
      JSON.stringify({ name: '@fixture/auth', exports: './src/index.ts' }),
    );
    put(
      'packages/auth/src/index.ts',
      'export class StynxAuthGuard { canActivate() { return false; } }\n',
    );
    const reading = sense(`import { StynxAuthGuard } from '@fixture/auth';
import { Test } from '@nestjs/testing';
it('must exercise workspace authorization', async () => {
await Test.createTestingModule({}).overrideGuard(StynxAuthGuard).useValue({ canActivate: () => true }).compile();
});`);
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(1);
    expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
  });

  it('keeps unresolved import ownership explicit rather than treating it as an external port', () => {
    const reading = sense(`vi.mock('../../src/missing-owned.js', () => ({ read: () => 0 }));
it('does not prove ownership', () => expect(0).toBe(0));`);
    expect(reading.status).not.toBe('pass');
    expect(reading.findings?.some((f) => /unknown|unresolved|resolve/iu.test(f.message))).toBe(
      true,
    );
  });

  it('does not combine an injection and a negative assertion from separate test callbacks', () => {
    const reading = sense(
      IMPORT +
        `it('injects without observing', async () => {
vi.spyOn(alias, 'read').mockRejectedValueOnce(new Error('injected'));
});
it('observes without owning the injection', async () => {
await expect(alias.read()).rejects.toThrow('injected');
});`,
    );
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(1);
    expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
  });

  it('recognizes one-shot fault injection only with the awaited matching negative witness', () => {
    const reading = sense(
      IMPORT +
        `it('surfaces the actual failure', async () => {
vi.spyOn(alias, 'read').mockRejectedValueOnce(new Error('injected'));
await expect(alias.read()).rejects.toThrow('injected');
});`,
    );
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(0);
    expect(reading.findings?.map((f) => f.code) ?? []).not.toContain(FINDING);
  });

  it.each([
    "vi.spyOn(alias, 'read').mockRejectedValue(new Error('injected')); await expect(alias.read()).rejects.toThrow('injected');",
    "vi.spyOn(alias, 'read').mockRejectedValueOnce(new Error('injected')); await expect(Promise.reject(new Error('injected'))).rejects.toThrow('injected');",
    "vi.spyOn(alias, 'read').mockRejectedValueOnce(new Error('injected')); expect(alias.read()).rejects.toThrow('injected');",
  ])('keeps an unproven or blanket owned rejection visible: %s', (body) => {
    const reading = sense(
      IMPORT + `it('does not establish a valid fault witness', async () => { ${body} });`,
    );
    expect(reading.status).not.toBe('pass');
    expect(reading.metrics?.mocks_in_integration_files).toBe(1);
    expect(reading.findings?.map((f) => f.code)).toContain(FINDING);
  });
});
