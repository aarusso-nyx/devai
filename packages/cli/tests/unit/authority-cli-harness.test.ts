// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuthorityCliHarness } from '../../src/authority/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const registry = JSON.parse(
  readFileSync(resolve(ROOT, 'law/policy/action-registry.json'), 'utf8'),
) as {
  entries: Array<{
    action_id: string;
    authority_contract: Record<string, unknown>;
  }>;
};
const contracts = registry.entries.map((entry) => entry.authority_contract);

function harness(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof createAuthorityCliHarness> {
  let id = 0;
  return createAuthorityCliHarness({
    action_contracts: contracts,
    random_id: () => `authority-test-${String(++id).padStart(8, '0')}`,
    now: () => '2026-07-27T12:00:00.000Z',
    repository_id: 'repo:test',
    sessions: new Map(),
    handler: async () => undefined,
    final_boundary: async () => undefined,
    intercept_runtime_handoff: (value: unknown) => value,
    ...overrides,
  });
}

async function invoke(
  target: ReturnType<typeof createAuthorityCliHarness>,
  argv: readonly string[],
) {
  return target.invoke({ argv, format: 'json' });
}

function code(result: Awaited<ReturnType<typeof invoke>>): string | undefined {
  const source = result.stderr || result.stdout;
  return source.length === 0 ? undefined : (JSON.parse(source) as { code?: string }).code;
}

describe('authority CLI harness branch matrix', () => {
  it('fails closed for absent, internal, declaration, consent, and session errors', async () => {
    const target = harness();
    const cases: ReadonlyArray<readonly [readonly string[], number, string]> = [
      [['unknown', 'action'], 7, 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND'],
      [['init', 'record'], 2, 'AUTHORITY_INTERNAL_ACTION_NOT_ROUTABLE'],
      [['catalog', 'actions', '--as-role', 'architect'], 2, 'AUTHORITY_DECLARATION_NOT_APPLICABLE'],
      [
        [
          'round',
          'plan',
          '--documents',
          'cli',
          '--as-role',
          'architect',
          '--authority-session',
          'AUTH-SESSION-1234567890ABCDEF',
        ],
        2,
        'AUTHORITY_DECLARATION_CONFLICT',
      ],
      [['round', 'plan', '--documents', 'cli'], 2, 'AUTHORITY_DECLARATION_MISSING'],
      [
        ['round', 'plan', '--documents', 'cli', '--as-role', 'intruder'],
        7,
        'AUTHORITY_DECLARATION_INVALID',
      ],
      [
        ['round', 'plan', '--documents', 'cli', '--authority-session', 'bad'],
        7,
        'AUTHORITY_SESSION_ID_INVALID',
      ],
      [
        [
          'round',
          'plan',
          '--documents',
          'cli',
          '--authority-session',
          'AUTH-SESSION-1234567890ABCDEF',
        ],
        2,
        'AUTHORITY_SESSION_NOT_FOUND',
      ],
      [
        ['round', 'plan', '--documents', 'cli', '--as-role', 'architect'],
        2,
        'AUTHORITY_WRITE_CONSENT_REQUIRED',
      ],
      [
        ['round', 'plan', '--documents', 'cli', '--as-role', 'engineer', '--write'],
        2,
        'AUTHORITY_HUMAN_ROLE_DENIED',
      ],
    ];
    for (const [argv, exit, expectedCode] of cases) {
      const result = await invoke(target, argv);
      expect(result.exit_code, expectedCode).toBe(exit);
      expect(code(result)).toBe(expectedCode);
    }
  });

  it('covers host integration and runtime-handoff refusals', async () => {
    const unavailable = harness({ host_authority: { mode: 'host-integrated', adapter: {} } });
    expect(
      code(
        await invoke(unavailable, [
          'round',
          'plan',
          '--documents',
          'cli',
          '--as-role',
          'architect',
          '--write',
        ]),
      ),
    ).toBe('AUTHORITY_HOST_ADAPTER_UNAVAILABLE');

    const unknownReceipt = harness({ intercept_runtime_handoff: () => ({}) });
    expect(
      code(
        await invoke(unknownReceipt, [
          'round',
          'plan',
          '--documents',
          'cli',
          '--as-role',
          'architect',
          '--write',
        ]),
      ),
    ).toBe('AUTHORITY_CONTEXT_RECEIPT_UNKNOWN');

    const policyMismatch = harness({
      intercept_runtime_handoff: (value: unknown) => ({
        ...(value as Record<string, unknown>),
        policy_binding: { policy_id: 'tampered', resolved_digest_sha256: 'b'.repeat(64) },
      }),
    });
    expect(
      code(
        await invoke(policyMismatch, [
          'round',
          'plan',
          '--documents',
          'cli',
          '--as-role',
          'architect',
          '--write',
        ]),
      ),
    ).toBe('AUTHORITY_POLICY_BINDING_MISMATCH');
  });

  it('allows read, dry-run, direct, and session-backed governed paths', async () => {
    let handlerCalls = 0;
    let boundaryCalls = 0;
    const sessions = new Map<string, Record<string, unknown>>([
      ['AUTH-SESSION-1234567890ABCDEF', { role: 'architect' }],
    ]);
    const target = harness({
      sessions,
      handler: async () => {
        handlerCalls += 1;
      },
      final_boundary: async () => {
        boundaryCalls += 1;
      },
    });

    const readResult = await invoke(target, ['catalog', 'actions']);
    expect(readResult.exit_code, JSON.stringify(readResult)).toBe(0);
    expect(
      (await invoke(target, ['init', 'bind', '--as-role', 'architect', '--write', '--dry-run']))
        .exit_code,
    ).toBe(0);
    expect(
      (
        await invoke(target, [
          'round',
          'plan',
          '--documents',
          'cli',
          '--authority-session',
          'AUTH-SESSION-1234567890ABCDEF',
          '--write',
        ])
      ).exit_code,
    ).toBe(0);
    expect(handlerCalls).toBe(2);
    expect(boundaryCalls).toBe(1);
    expect(target.observations.runtime_inputs.length).toBe(3);
  });
});
