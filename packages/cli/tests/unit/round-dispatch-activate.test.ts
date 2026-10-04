// ADR-MDL-0006 IA-001..IA-003: only the Owner, with --write and --experimental, records the
// experimental activation, and only into runtime state; a refused input changes nothing.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cac } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import {
  declaredRoleConsentRefusal,
  readDeclarationRefusal,
} from '../../src/authority/authority-declarations.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { roundDispatchActivate } from '../../src/commands/round/dispatch-activate.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const entries = canonicalRegistry();
const entry = (name: string) => {
  const found = entries.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
};
const code = (result: { readonly stdout: string; readonly stderr: string } | undefined) => {
  if (result === undefined) return undefined;
  const parsed = JSON.parse(result.stderr || result.stdout || '{}') as {
    readonly code?: string;
    readonly error?: { readonly code?: string };
  };
  return parsed.error?.code ?? parsed.code;
};
const argv = (...flags: string[]) => [
  'round',
  'dispatch',
  'activate',
  ...flags,
  '--format',
  'json',
];

function activation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 7 * 24 * 3_600_000).toISOString(),
    runtimes: [{ runtime: 'claude-cli', models: ['claude-opus-5-5'], efforts: ['high'] }],
    disciplines: ['engineer', 'inspector'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 8,
      attempt_wall_clock_minutes: 30,
      tokens_per_invocation: 1_000_000,
    },
    ...overrides,
  };
}

async function activate(root: string, input: unknown) {
  const file = join(root, 'activation-input.json');
  writeFileSync(file, JSON.stringify(input));
  const program = cac('devai-dispatch-activate');
  roundDispatchActivate.register(program);
  let stdout = '';
  let stderr = '';
  const original = { out: process.stdout.write, err: process.stderr.write, code: process.exitCode };
  process.stdout.write = ((chunk: unknown) => (
    (stdout += String(chunk)),
    true
  )) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (
    (stderr += String(chunk)),
    true
  )) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    program.parse(
      ['node', 'devai', 'round-dispatch-activate', '--repo-root', root, '--input', file],
      {
        run: false,
      },
    );
    await withAuthorityHostTestScope(() => program.runMatchedCommand());
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    process.exitCode = original.code;
  }
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-dispatch-activate-'));
  roots.push(root);
  return root;
}

const RECORD = '.devai/state/experimental/activation.json';

describe('experimental consent at the front door (IA-001)', () => {
  const activateEntry = entry('round dispatch activate');

  it('declares an Owner-only, experimental-consent action', () => {
    expect(activateEntry.authority_contract.consent).toEqual({
      write: true,
      allow_publish: false,
      experimental: true,
    });
    expect(
      (
        activateEntry.authority_contract.subject as {
          readonly initiator: { readonly allowed_roles: readonly string[] };
        }
      ).initiator.allowed_roles,
    ).toEqual(['owner']);
  });

  it('admits only the Owner with both --write and --experimental', () => {
    const refusal = (flags: string[], role: string) =>
      code(
        declaredRoleConsentRefusal(argv(...flags), activateEntry, role, undefined, 'json', role),
      );
    expect(refusal(['--write', '--experimental'], 'owner')).toBeUndefined();
    expect(refusal(['--write'], 'owner')).toBe('AUTHORITY_EXPERIMENTAL_CONSENT_REQUIRED');
    expect(refusal(['--experimental'], 'owner')).toBe('AUTHORITY_WRITE_CONSENT_REQUIRED');
    expect(refusal(['--write', '--experimental'], 'engineer')).toBe('AUTHORITY_HUMAN_ROLE_DENIED');
  });

  it('refuses --experimental on every action that does not require it', () => {
    const run = entry('round run');
    expect(
      code(
        declaredRoleConsentRefusal(
          ['round', 'run', '--write', '--experimental', '--format', 'json'],
          run,
          'engineer',
          undefined,
          'json',
          'engineer',
        ),
      ),
    ).toBe('AUTHORITY_DECLARATION_NOT_APPLICABLE');
    const read = entries.find((candidate) => candidate.effects === 'read');
    if (read === undefined) throw new Error('no read action');
    expect(
      code(
        readDeclarationRefusal(
          ['--experimental', '--format', 'json'],
          read,
          undefined,
          undefined,
          'json',
        ),
      ),
    ).toBe('AUTHORITY_DECLARATION_NOT_APPLICABLE');
  });
});

describe('round dispatch activate (IA-002, IA-003)', () => {
  it('records a valid activation only under runtime state', async () => {
    const root = repository();
    const result = await activate(root, activation());
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      activated: true,
      record: RECORD,
      runtimes: ['claude-cli'],
    });
    expect(JSON.parse(readFileSync(join(root, RECORD), 'utf8'))).toMatchObject({
      authority: 'Owner',
    });
    expect(existsSync(join(root, '.devai/config/experimental-execution.json'))).toBe(false);
  });

  it.each([
    [{ authority: 'Engineer' }, 'EXPERIMENTAL_ACTIVATION_INVALID'],
    [{ expires_at: new Date(Date.now() - 1_000).toISOString() }, 'EXPERIMENTAL_ACTIVATION_EXPIRED'],
    [
      { expires_at: new Date(Date.now() + 40 * 24 * 3_600_000).toISOString() },
      'EXPERIMENTAL_ACTIVATION_WINDOW_EXCEEDED',
    ],
    [
      {
        budgets: {
          attempts_per_task: 4,
          attempts_per_invocation: 33,
          attempt_wall_clock_minutes: 30,
          tokens_per_invocation: 1,
        },
      },
      'EXPERIMENTAL_ACTIVATION_BUDGET_EXCEEDS_CEILING',
    ],
  ])(
    'refuses %j with its code and leaves the earlier record untouched',
    async (change, expected) => {
      const root = repository();
      expect((await activate(root, activation())).exit).toBe(0);
      const before = readFileSync(join(root, RECORD), 'utf8');
      const result = await activate(root, activation(change));
      expect(result.exit).not.toBe(0);
      expect(JSON.parse(result.stderr)).toMatchObject({ code: expected });
      expect(readFileSync(join(root, RECORD), 'utf8')).toBe(before);
    },
  );

  it('never treats a hand-placed .devai/config file as an activation', async () => {
    const root = repository();
    mkdirSync(join(root, '.devai/config'), { recursive: true });
    writeFileSync(
      join(root, '.devai/config/experimental-execution.json'),
      JSON.stringify(activation()),
    );
    const { readExperimentalActivation } = await import('@devai-nyx/loop');
    expect(readExperimentalActivation(root, new Date())).toEqual({
      ok: false,
      code: 'EXPERIMENTAL_ACTIVATION_MISSING',
    });
  });
});
