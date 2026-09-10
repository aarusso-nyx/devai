// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorityActionRegistry,
  createAuthorityCliHarness,
  renderAuthorityResult,
  stripAuthorityArgv,
} from '../../src/authority/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const registry = JSON.parse(
  readFileSync(resolve(ROOT, 'law/policy/action-registry.json'), 'utf8'),
) as {
  entries: Array<{ action_id: string; authority_contract: Record<string, unknown> }>;
};
const contracts = registry.entries.map((entry) => entry.authority_contract);

function contract(actionId: string): Record<string, unknown> {
  const value = contracts.find((candidate) => candidate['action_id'] === actionId);
  if (value === undefined) throw new Error(`missing action contract: ${actionId}`);
  return structuredClone(value);
}

function harness(overrides: Record<string, unknown> = {}) {
  let id = 0;
  return createAuthorityCliHarness({
    action_contracts: contracts,
    random_id: () => `adversarial-${String(++id).padStart(8, '0')}`,
    now: () => '2026-09-09T12:00:00.000Z',
    repository_id: 'repo:adversarial',
    sessions: new Map(),
    handler: async () => undefined,
    final_boundary: async () => undefined,
    intercept_runtime_handoff: (value: unknown) => value,
    ...overrides,
  });
}

async function invoke(target: ReturnType<typeof harness>, argv: readonly string[]) {
  return target.invoke({ argv, format: 'json' });
}

function envelope(result: Awaited<ReturnType<typeof invoke>>): Record<string, unknown> {
  return JSON.parse(result.stderr || result.stdout) as Record<string, unknown>;
}

describe('authority public boundary adversarial behavior', () => {
  it('rejects malformed and incoherent action contracts before registry construction', () => {
    const read = contract('catalog actions');
    const write = contract('round plan');
    const cases: Array<readonly [unknown, string]> = [
      [null, '<unknown>: authority metadata is required'],
      [{ ...read, effect: 'filesystem-write' }, 'catalog actions: unknown effect metadata'],
      [
        { ...read, subject: { kind: 'none', extra: true } },
        'catalog actions: unknown subject metadata',
      ],
      [
        { ...write, subject: { kind: 'human', allowed_roles: [] } },
        'round plan: unknown subject metadata',
      ],
      [{ ...write, consent: { write: 'yes' } }, 'round plan: invalid consent metadata'],
      [{ ...write, planner: { kind: 'guess' } }, 'round plan: unknown planner metadata'],
      [{ ...write, boundary: { kind: 'ambient-write' } }, 'round plan: unknown boundary metadata'],
      [
        { ...write, readiness: { requires_binding: true, independent_acceptance_required: false } },
        'round plan: invalid readiness metadata',
      ],
      [
        { ...read, consent: { ...(read['consent'] as object), write: true } },
        'catalog actions: incoherent authority metadata',
      ],
    ];

    for (const [candidate, message] of cases) {
      expect(() => buildAuthorityActionRegistry([candidate]), message).toThrow(message);
    }
    expect(() => buildAuthorityActionRegistry([read, read])).toThrow(
      'catalog actions: duplicate metadata',
    );
  });

  it('maps failure classes and refuses malformed successful authority output', () => {
    const failures = [
      [{ ok: false, category: 'refused', code: 'AUTHORITY_DECLARATION_MISSING' }, 2],
      [{ ok: false, category: 'dependency-error', code: 'AUTHORITY_SERVICE_UNAVAILABLE' }, 5],
      [{ ok: false, category: 'refused', code: 'AUTHORITY_HOST_TIMEOUT' }, 6],
      [{ ok: false, category: 'refused', code: 'AUTHORITY_RESULT_INVALID' }, 7],
    ] as const;
    for (const [failure, exit] of failures) {
      const result = renderAuthorityResult(failure, 'json');
      expect(result.exit_code, failure.code).toBe(exit);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: failure.code,
        exit,
        refs: { doc: 'law/constitution.md#article-6' },
      });
    }

    const missingCode = renderAuthorityResult({ ok: false, category: 'refused' }, 'json');
    expect(missingCode.exit_code).toBe(7);
    expect(JSON.parse(missingCode.stderr)).toMatchObject({
      code: 'AUTHORITY_RESULT_INVALID',
      class: 'contract-violation',
      exit: 7,
    });

    const malformed = renderAuthorityResult(
      {
        ok: true,
        authority: {
          principal: { kind: 'human', declaration_source: 'session-state', session_id: 'bad' },
        },
      },
      'json',
    );
    expect(malformed.exit_code).toBe(7);
    expect(JSON.parse(malformed.stderr)).toMatchObject({
      code: 'AUTHORITY_OUTPUT_CONTRACT_INVALID',
    });

    const cliDeclared = renderAuthorityResult(
      {
        ok: true,
        authority: {
          principal: { kind: 'human', declaration_source: 'cli-flag' },
        },
      },
      'json',
    );
    expect(cliDeclared.exit_code).toBe(0);

    const unknownDeclarationSource = renderAuthorityResult(
      {
        ok: true,
        authority: {
          principal: { kind: 'human', declaration_source: 'caller-claim' },
        },
      },
      'json',
    );
    expect(unknownDeclarationSource.exit_code).toBe(7);
    expect(JSON.parse(unknownDeclarationSource.stderr)).toMatchObject({
      code: 'AUTHORITY_OUTPUT_CONTRACT_INVALID',
    });

    const successful = renderAuthorityResult(
      { ok: true, value: 3, authority: { code: 'POLICY_ALLOW', principal: null } },
      'json',
    );
    expect(successful).toEqual({
      exit_code: 0,
      stdout: '{"value":3,"authority":{"code":"POLICY_ALLOW","principal":null}}\n',
      stderr: '',
      authority: { code: 'POLICY_ALLOW', principal: null },
    });
    expect(renderAuthorityResult({ ok: true, value: 3 }, 'human')).toEqual({
      exit_code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('removes authority declarations and their values without consuming adjacent options', () => {
    expect(
      stripAuthorityArgv([
        'round',
        'plan',
        '--as-role',
        'architect',
        '--documents',
        'cli',
        '--authority-session',
        'AUTH-SESSION-1234567890ABCDEF',
        '--machine-actor',
        'harness',
        '--write',
      ]),
    ).toEqual(['round', 'plan', '--documents', 'cli', '--write']);
    expect(stripAuthorityArgv(['catalog', 'actions'])).toEqual(['catalog', 'actions']);
  });

  it('dispatches special actions and preserves the authority-bound result shape', async () => {
    const target = harness();

    const bind = await invoke(target, [
      'init',
      'bind',
      '--as-role',
      'architect',
      '--write',
      '--dry-run',
    ]);
    const bindOutput = envelope(bind) as {
      authority: {
        principal: { initiated_by: Record<string, unknown> };
        readiness_eligible: boolean;
      };
      artifacts: Array<Record<string, unknown>>;
      applied: boolean;
    };
    const artifact = bindOutput.artifacts[0];
    expect(bindOutput).toMatchObject({
      authority: {
        code: 'POLICY_ALLOW',
        principal: {
          kind: 'machine',
          actor: 'binding',
          transition: 'bind',
          initiated_by: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
        },
        origin: { kind: 'direct-cli' },
        readiness_eligible: false,
      },
      applied: false,
    });
    expect(artifact).toMatchObject({
      repository_id: 'repo:adversarial',
      path: '.devai/config/authority-policy.json',
      operation: 'create',
    });
    const bytes = Buffer.from(String(artifact?.['canonical_bytes_base64']), 'base64');
    expect(bytes.toString()).toBe(
      '{"policy_id":"devai-authority","repository_id":"repo:adversarial"}',
    );
    expect(artifact?.['digest_sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));

    const ownerApply = envelope(
      await invoke(target, ['init', 'apply', 'owner', '--as-role', 'owner', '--write']),
    );
    expect(ownerApply).toMatchObject({
      authority: { principal: { kind: 'human', role: 'owner' }, readiness_eligible: true },
      recording: {
        action_id: 'init record',
        same_invocation: true,
        initiated_by: { role: 'owner', declaration_source: 'cli-flag' },
        writable_target_kinds: ['harness-state'],
      },
    });
  });

  it('refuses caller-selected machine identity, remote consent gaps, and injected apply receipts', async () => {
    const cases: Array<readonly [ReturnType<typeof harness>, readonly string[], string]> = [
      [
        harness(),
        ['round', 'plan', '--machine-actor', 'harness'],
        'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN',
      ],
      [
        harness(),
        ['release', 'publish', '--as-role', 'owner', '--write'],
        'AUTHORITY_PUBLISH_CONSENT_REQUIRED',
      ],
      [
        harness({ injected_internal_apply_receipt: {} }),
        ['init', 'apply', 'owner', '--as-role', 'owner', '--write'],
        'AUTHORITY_APPLY_RECEIPT_INVALID',
      ],
    ];
    for (const [target, argv, code] of cases) {
      const result = await invoke(target, argv);
      expect(result.exit_code, code).not.toBe(0);
      expect(envelope(result)).toMatchObject({ code });
    }
  });

  it('binds context receipts to every dispatched field and refuses replay', async () => {
    for (const key of ['action_id', 'invocation_id', 'repository_id', 'consent'] as const) {
      const target = harness({
        intercept_runtime_handoff: (value: unknown) => ({
          ...(value as Record<string, unknown>),
          [key]: key === 'consent' ? { write: false } : 'tampered',
        }),
      });
      expect(
        envelope(await invoke(target, ['round', 'plan', '--as-role', 'architect', '--write'])),
        key,
      ).toMatchObject({ code: 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH' });
    }

    let first: Record<string, unknown> | undefined;
    const replay = harness({
      intercept_runtime_handoff: (value: unknown) => {
        first ??= value as Record<string, unknown>;
        return first;
      },
    });
    expect(
      (await invoke(replay, ['round', 'plan', '--as-role', 'architect', '--write'])).exit_code,
    ).toBe(0);
    expect(
      envelope(await invoke(replay, ['round', 'plan', '--as-role', 'architect', '--write'])),
    ).toMatchObject({ code: 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED' });
  });
});
