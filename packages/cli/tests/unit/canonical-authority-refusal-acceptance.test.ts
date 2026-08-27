// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance: every current action reaches the production authority
// pre-dispatch boundary and exposes its required refusal in both output formats.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeCliArgv } from '../../src/authority/index.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';

const originalArgv = [...process.argv];
const originalStdout = process.stdout.write;
let current: readonly RegistryEntry[] = [];

beforeAll(async () => {
  process.argv = [process.execPath, 'devai', '--help'];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await import('../../src/bin.js');
  current = getFullRegistry();
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

afterAll(() => {
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

function allowedRoles(entry: RegistryEntry): readonly string[] {
  const subject = entry.authority_contract.subject;
  if (subject.kind === 'human') return subject.allowed_roles;
  return subject.kind === 'derived-machine' && subject.initiator !== 'none'
    ? subject.initiator.allowed_roles
    : [];
}

function refusal(entry: RegistryEntry, args: readonly string[], format: 'human' | 'json') {
  const invocationArgs = entry.name === 'sense run' ? ['llm_judge', ...args] : args;
  const result = authorizeCliArgv(
    [process.execPath, 'devai', ...entry.path, ...invocationArgs, '--format', format],
    current,
  );
  expect(result, entry.name).toBeDefined();
  if (result === undefined) throw new Error(`authority refusal missing for ${entry.name}`);
  return result;
}

function expectCode(result: ReturnType<typeof refusal>, code: string): void {
  expect(result.exit_code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.authority).toMatchObject({ code });
  expect(result.stderr).not.toBe('');
}

describe('canonical production authority refusal acceptance', () => {
  it('emits concrete remediation and structured context for common refusals', () => {
    const check = current.find((entry) => entry.name === 'check');
    const sense = current.find((entry) => entry.name === 'sense run');
    if (check === undefined || sense === undefined) throw new Error('canonical actions missing');

    const denied = refusal(check, ['--affected', '--run', '--as-role', 'architect'], 'json');
    expect(JSON.parse(denied.stderr)).toMatchObject({
      code: 'AUTHORITY_HUMAN_ROLE_DENIED',
      remediation: 'Declare one of: inspector via --as-role.',
      context: { allowed_roles: ['inspector'], supplied_role: 'architect' },
    });

    const overDeclared = authorizeCliArgv(
      [process.execPath, 'devai', 'sense', 'run', 'lint', '--write', '--format', 'json'],
      current,
    );
    expect(overDeclared).toBeDefined();
    expect(JSON.parse(overDeclared?.stderr ?? '{}')).toMatchObject({
      code: 'AUTHORITY_DECLARATION_NOT_APPLICABLE',
      remediation: "This action's effect is 'read'; remove --write.",
      context: { effect: 'read', declared: { write: true } },
    });

    const unbound = mkdtempSync(join(tmpdir(), 'devai-authority-unbound-'));
    try {
      const missing = authorizeCliArgv(
        [
          process.execPath,
          'devai',
          'check',
          '--suite',
          'standard',
          '--repo-root',
          unbound,
          '--format',
          'json',
        ],
        current,
      );
      expect(missing).toBeDefined();
      const missingEnvelope = JSON.parse(missing?.stderr ?? '{}') as {
        remediation: string;
        context: { commands: string[] };
      };
      expect(missingEnvelope).toMatchObject({
        code: 'AUTHORITY_POLICY_MISSING',
        refs: { doc: 'docs/adopters/install.md' },
        context: {
          repository_root: unbound,
          commands: [
            `devai init bind --target ${unbound} --tier tier1 --constitution --as-role architect --write`,
            `devai init bind --target ${unbound} --operational-law --as-role architect --write`,
            `devai init bind --target ${unbound} --subprocess-effects --as-role architect --write`,
            `devai init bind --target ${unbound} --as-role architect --write`,
          ],
        },
      });
      expect(missingEnvelope.remediation).toContain(
        `1. devai init bind --target ${unbound} --tier tier1 --constitution`,
      );

      mkdirSync(join(unbound, '.devai/pin'), { recursive: true });
      writeFileSync(join(unbound, '.devai/pin/constitution.md'), '# bound\n', 'utf8');
      const policyOnly = authorizeCliArgv(
        [
          process.execPath,
          'devai',
          'check',
          '--suite',
          'standard',
          '--repo-root',
          unbound,
          '--format',
          'json',
        ],
        current,
      );
      expect(JSON.parse(policyOnly?.stderr ?? '{}')).toMatchObject({
        code: 'AUTHORITY_POLICY_MISSING',
        remediation: `Run: devai init bind --target ${unbound} --as-role architect --write`,
        context: {
          commands: [`devai init bind --target ${unbound} --as-role architect --write`],
        },
      });
    } finally {
      rmSync(unbound, { recursive: true, force: true });
    }
  });

  it('requires no declaration for reads and a declaration for every write-capable action', () => {
    expect(current).toHaveLength(48);
    const unbound = mkdtempSync(join(tmpdir(), 'devai-authority-unbound-'));
    try {
      for (const format of ['human', 'json'] as const) {
        for (const entry of current) {
          const result =
            entry.effects === 'read'
              ? refusal(entry, ['--as-role', 'owner'], format)
              : refusal(
                  entry,
                  entry.name === 'init bind'
                    ? ['--write']
                    : entry.name === 'check'
                      ? ['--repo-root', unbound]
                      : [],
                  format,
                );
          expectCode(
            result,
            entry.effects === 'read'
              ? 'AUTHORITY_DECLARATION_NOT_APPLICABLE'
              : entry.name === 'check'
                ? 'AUTHORITY_POLICY_MISSING'
                : 'AUTHORITY_DECLARATION_MISSING',
          );
        }
      }
    } finally {
      rmSync(unbound, { recursive: true, force: true });
    }
  });

  it('requires write and publication consent before any handler can execute', () => {
    for (const format of ['human', 'json'] as const) {
      for (const entry of current.filter((candidate) => candidate.effects !== 'read')) {
        const role = allowedRoles(entry)[0];
        if (role === undefined)
          throw new Error(`write action has no initiating role: ${entry.name}`);
        if (entry.name !== 'init bind') {
          expectCode(
            refusal(entry, ['--as-role', role], format),
            'AUTHORITY_WRITE_CONSENT_REQUIRED',
          );
        }
        if (entry.effects === 'remote-write') {
          expectCode(
            refusal(entry, ['--as-role', role, '--write'], format),
            'AUTHORITY_PUBLISH_CONSENT_REQUIRED',
          );
        }
      }
    }
  });

  it('rejects a valid but unauthorized human role for every role-restricted write action', () => {
    const roles = ['owner', 'architect', 'inspector', 'engineer', 'auditor'] as const;
    for (const entry of current.filter((candidate) => candidate.effects !== 'read')) {
      const denied = roles.find((role) => !allowedRoles(entry).includes(role));
      if (denied === undefined) continue;
      const args = [
        '--as-role',
        denied,
        '--write',
        ...(entry.effects === 'remote-write' ? ['--publish'] : []),
      ];
      expectCode(refusal(entry, args, 'json'), 'AUTHORITY_HUMAN_ROLE_DENIED');
    }
  });
});
