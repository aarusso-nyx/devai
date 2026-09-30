// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-AUT-0003 IA-004, IA-005 (governed writes), and the bind-time
// half of IA-003: `init bind --adopter-policy` materializes the compiled adopter extension
// into authority-policy.json and names it in the binding receipt, byte-stably; a changed,
// removed, edited, or missing source moves or refuses exactly as the record states. Every
// bind goes through the CLI and every governed write through the broker over the bound
// policy (bootstrap_policy false).
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

type JsonObject = Record<string, unknown>;

const FIXTURES = resolve(import.meta.dirname, '../fixtures/adopter-path-authority');
const SOURCE = 'law/policy/devai-adoption.json';
const POLICY = '.devai/config/authority-policy.json';
const RECEIPT = '.devai/config/adopter-policy-binding.json';
const PACKAGE_EXTENSION = 'devai-adopter-authority';
const EXTENSION = 'detran.path-authority';
const SHA256 = /^[0-9a-f]{64}$/u;
// Six roots, each with two root rules, four test rules, and two architecture rules.
const REFERENCE_RULE_COUNT = 48;

const entries: readonly RegistryEntry[] = canonicalRegistry();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function put(repo: string, path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function text(repo: string, path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}

function json(repo: string, path: string): JsonObject {
  return JSON.parse(text(repo, path)) as JsonObject;
}

function bindAdopterPolicy(repo: string) {
  return runCli([
    'init',
    'bind',
    '--adopter-policy',
    SOURCE,
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
}

async function expectBound(repo: string, source?: string): Promise<void> {
  if (source !== undefined) put(repo, SOURCE, source);
  const result = await bindAdopterPolicy(repo);
  expect(result.exit, result.stderr).toBe(0);
}

/** A repository with constitution 1.0.2, operational law, and the core authority policy. */
async function boundRepository(): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-adopter-authority-materialize-')));
  roots.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const result = await runCli([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
  expect(result.exit, result.stderr).toBe(0);
  return repo;
}

function extensions(repo: string): JsonObject[] {
  return json(repo, POLICY)['additive_extensions'] as JsonObject[];
}

function adopterExtension(repo: string): JsonObject | undefined {
  return extensions(repo).find((extension) => extension['extension_id'] === EXTENSION);
}

function extensionRuleIds(repo: string): string[] {
  return (json(repo, POLICY)['rules'] as JsonObject[])
    .map((rule) => String(rule['rule_id']))
    .filter((id) => id.startsWith('adopter-path-'));
}

function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/u.exec(message)?.[0] ?? message;
}

/** One governed Engineer write through the broker over the bound policy. */
function governedWrite(repo: string, path: string): string {
  const entry = entries.find((candidate) => candidate.name === 'task start');
  if (entry === undefined) throw new Error('missing action task start');
  try {
    const host = createAuthorityHostBroker({
      entry,
      entries,
      argv: [
        process.execPath,
        'devai',
        'task',
        'start',
        '--round',
        'R-0007',
        '--task',
        'TASK-7001',
        '--as-role',
        'engineer',
        '--write',
      ],
      role: 'engineer',
      declaration: { as_role: 'engineer' },
      repository_root: repo,
      package_version: resolveCliVersion(),
      bootstrap_policy: false,
    });
    try {
      return String(
        host.scope.apply_effect(
          { kind: 'filesystem', symbol: 'writeFileSync', arguments: [`${repo}/${path}`, 'x\n'] },
          () => 'POLICY_ALLOW',
        ),
      );
    } finally {
      host.dispose();
    }
  } catch (error) {
    return codeOf(error);
  }
}

describe('IA-004: binding is byte-stable and names the extension it materialized', () => {
  it('binding the reference source twice yields byte-identical policy and receipt', async () => {
    const repo = await boundRepository();
    await expectBound(repo, fixture('reference.json'));
    const first = { policy: text(repo, POLICY), receipt: text(repo, RECEIPT) };

    await expectBound(repo);

    expect({ policy: text(repo, POLICY), receipt: text(repo, RECEIPT) }).toEqual(first);
  });

  it('the receipt and the authority policy name the same adopter extension bytes', async () => {
    const repo = await boundRepository();
    await expectBound(repo, fixture('reference.json'));

    const receipt = json(repo, RECEIPT);
    expect(receipt['authority_extension']).toEqual({
      extension_id: EXTENSION,
      extension_version: '1.1.0',
      digest_sha256: expect.stringMatching(SHA256),
      rule_count: REFERENCE_RULE_COUNT,
    });
    const provenance = receipt['authority_extension'] as JsonObject;
    expect(extensions(repo).map((extension) => extension['extension_id'])).toEqual([
      PACKAGE_EXTENSION,
      EXTENSION,
    ]);
    expect(adopterExtension(repo)).toEqual({
      extension_id: EXTENSION,
      extension_version: '1.1.0',
      digest_sha256: provenance['digest_sha256'],
    });
    expect(extensionRuleIds(repo)).toHaveLength(REFERENCE_RULE_COUNT);
  });

  it('a block without a test class takes the package default selectors', async () => {
    // Rules embed the repository id, so the comparison stays within one repository.
    const repo = await boundRepository();
    const digest = () =>
      (json(repo, RECEIPT)['authority_extension'] as JsonObject | undefined)?.['digest_sha256'];
    const extensionRules = () =>
      (json(repo, POLICY)['rules'] as JsonObject[]).filter((rule) =>
        String(rule['rule_id']).startsWith('adopter-path-'),
      );
    await expectBound(repo, fixture('reference.json'));
    const reference = {
      digest: digest(),
      extension: adopterExtension(repo),
      rules: extensionRules(),
      resolved: json(repo, POLICY)['resolved_digest_sha256'],
    };
    expect(reference.digest).toMatch(SHA256);
    expect(reference.rules).toHaveLength(REFERENCE_RULE_COUNT);

    await expectBound(repo, fixture('default-test-class.json'));

    expect(digest()).toBe(reference.digest);
    expect(adopterExtension(repo)).toEqual(reference.extension);
    expect(extensionRules()).toEqual(reference.rules);
    expect(json(repo, POLICY)['resolved_digest_sha256']).toBe(reference.resolved);
  });

  it('changing one selector changes the extension digest, the resolved digest, and the receipt', async () => {
    const repo = await boundRepository();
    const reference = JSON.parse(fixture('reference.json')) as JsonObject;
    await expectBound(repo, fixture('reference.json'));
    const before = {
      extension: adopterExtension(repo),
      resolved: json(repo, POLICY)['resolved_digest_sha256'],
      receipt: text(repo, RECEIPT),
      provenance: json(repo, RECEIPT)['authority_extension'] as JsonObject | undefined,
    };
    expect(before.extension?.['digest_sha256']).toMatch(SHA256);

    const authority = reference['authority'] as JsonObject;
    const changed = {
      ...reference,
      authority: {
        ...authority,
        classes: {
          ...(authority['classes'] as JsonObject),
          architecture: { selectors: ['**/ddl/**/*.sql', '**/blueprint/**'] },
        },
      },
    };
    await expectBound(repo, `${JSON.stringify(changed, null, 2)}\n`);

    const after = adopterExtension(repo);
    expect(after?.['digest_sha256']).toMatch(SHA256);
    expect(after?.['digest_sha256']).not.toBe(before.extension?.['digest_sha256']);
    expect(json(repo, POLICY)['resolved_digest_sha256']).not.toBe(before.resolved);
    expect(text(repo, RECEIPT)).not.toBe(before.receipt);
    const provenance = json(repo, RECEIPT)['authority_extension'] as JsonObject | undefined;
    expect(provenance?.['digest_sha256']).toBe(after?.['digest_sha256']);
    expect(provenance?.['digest_sha256']).not.toBe(before.provenance?.['digest_sha256']);
    expect(provenance?.['rule_count']).toBe(REFERENCE_RULE_COUNT);
  });

  it('removing the block removes the extension entry and every rule it compiled', async () => {
    const repo = await boundRepository();
    const core = json(repo, POLICY);
    await expectBound(repo, fixture('reference.json'));
    expect(adopterExtension(repo)).toBeDefined();
    expect(extensionRuleIds(repo)).toHaveLength(REFERENCE_RULE_COUNT);

    await expectBound(repo, fixture('without-authority.json'));

    expect(extensions(repo).map((extension) => extension['extension_id'])).toEqual([
      PACKAGE_EXTENSION,
    ]);
    expect(extensionRuleIds(repo)).toEqual([]);
    expect(json(repo, RECEIPT)).not.toHaveProperty('authority_extension');
    const policy = json(repo, POLICY);
    for (const key of ['additive_extensions', 'rules', 'resolved_digest_sha256'] as const) {
      expect(policy[key], key).toEqual(core[key]);
    }
  });
});

describe('IA-005: a source that drifts from its binding refuses every governed write', () => {
  it('reads AUTHORITY_POLICY_DIGEST_MISMATCH after the source is edited without rebinding', async () => {
    const repo = await boundRepository();
    const reference = JSON.parse(fixture('reference.json')) as JsonObject;
    await expectBound(repo, fixture('reference.json'));
    expect(governedWrite(repo, 'packages/core/src/x.ts')).toBe('POLICY_ALLOW');
    expect(governedWrite(repo, 'apps/web/src/x.ts')).toBe('POLICY_ALLOW');

    const authority = reference['authority'] as JsonObject;
    put(
      repo,
      SOURCE,
      `${JSON.stringify({ ...reference, authority: { ...authority, roots: ['apps', 'backend'] } }, null, 2)}\n`,
    );

    // Every governed write, not only one under a declared root, is refused.
    expect(governedWrite(repo, 'apps/web/src/x.ts')).toBe('AUTHORITY_POLICY_DIGEST_MISMATCH');
    expect(governedWrite(repo, 'packages/core/src/x.ts')).toBe('AUTHORITY_POLICY_DIGEST_MISMATCH');
    expect(governedWrite(repo, 'frontend/src/x.ts')).toBe('AUTHORITY_POLICY_DIGEST_MISMATCH');

    await expectBound(repo);
    expect(governedWrite(repo, 'apps/web/src/x.ts')).toBe('POLICY_ALLOW');
    expect(governedWrite(repo, 'frontend/src/x.ts')).toBe('UNCLASSIFIED_RESOURCE');
  });

  it.each([
    ['deleted', (repo: string) => rmSync(join(repo, SOURCE))],
    ['not JSON', (repo: string) => put(repo, SOURCE, '{ "schemaVersion": \n')],
    [
      'schema-invalid',
      (repo: string) =>
        put(
          repo,
          SOURCE,
          `${JSON.stringify({ ...(JSON.parse(fixture('reference.json')) as JsonObject), authority: { roots: ['apps/web'] } })}\n`,
        ),
    ],
  ] as const)(
    'reads ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE when the bound source is %s',
    async (_label, spoil) => {
      const repo = await boundRepository();
      await expectBound(repo, fixture('reference.json'));
      expect(governedWrite(repo, 'apps/web/src/x.ts')).toBe('POLICY_ALLOW');

      spoil(repo);

      expect(governedWrite(repo, 'apps/web/src/x.ts')).toBe('ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE');
      expect(governedWrite(repo, 'packages/core/src/x.ts')).toBe(
        'ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE',
      );
    },
  );
});

describe('IA-003 at bind: a refused source leaves the previous policy and receipt untouched', () => {
  const expected = (
    JSON.parse(fixture('malformed/expected-codes.json')) as {
      refusals: Record<string, string>;
    }
  ).refusals;

  it('the expected-code manifest names every malformed variant', () => {
    const variants = readdirSync(join(FIXTURES, 'malformed'))
      .filter((name) => name !== 'expected-codes.json')
      .sort();
    expect(Object.keys(expected).sort()).toEqual(variants);
  });

  it.each(Object.entries(expected))('%s is refused with %s', async (variant, code) => {
    const repo = await boundRepository();
    await expectBound(repo, fixture('reference.json'));
    const before = { policy: text(repo, POLICY), receipt: text(repo, RECEIPT) };

    put(repo, SOURCE, fixture(`malformed/${variant}`));
    const result = await bindAdopterPolicy(repo);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`\\b${code}\\b`, 'u'));
    expect({ policy: text(repo, POLICY), receipt: text(repo, RECEIPT) }).toEqual(before);
  });
});
