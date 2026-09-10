// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { cac } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.doUnmock('../../src/authority/broker.js');
  vi.resetModules();
});

async function governedCommand(
  action: () => unknown,
  options: Readonly<{ dryRun?: boolean }> = {},
) {
  vi.resetModules();
  const events: string[] = [];
  vi.doMock('../../src/authority/broker.js', async () => {
    const [{ createAuthorityDecisionIssuer }, { canonicalSha256 }] = await Promise.all([
      import('@devai-nyx/authority'),
      import('@devai-nyx/utils'),
    ]);
    return {
      createAuthorityHostBroker: (input: { entry: { name: string; effects: string } }) => {
        const invocationId = 'authority-finalization-test';
        const issuer = createAuthorityDecisionIssuer({
          issuer_id: 'authority-finalization-test',
          issuer_version: '1.0.0',
          invocation_id: invocationId,
          canonicalSha256,
          randomId: () => 'authority-finalization-receipt',
          now: () => '2026-09-10T00:00:00.000Z',
          receipt_ttl_ms: 30_000,
        });
        return {
          scope: Object.freeze({
            action_id: input.entry.name,
            invocation_id: invocationId,
            effect: options.dryRun === true ? 'read' : input.entry.effects,
            receipt_store: issuer,
            apply_effect: (_request: unknown, apply: () => unknown) => apply(),
          }),
          commit_exact: () => events.push('commit'),
          dispose: () => {
            events.push('dispose');
            issuer.dispose();
          },
        };
      },
    };
  });
  const [{ attachAuthorityCommandBoundaries, authorizeCliArgv }, { canonicalRegistry }] =
    await Promise.all([
      import('../../src/authority/index.js'),
      import('../../src/define-command.js'),
    ]);
  const actionName = options.dryRun === true ? 'sense run' : 'round plan';
  const canonical = canonicalRegistry();
  const selected = canonical.find((candidate) => candidate.name === actionName);
  const entry =
    selected === undefined || options.dryRun !== true
      ? selected
      : {
          ...selected,
          runtime_options: [{ flags: '--dry-run', description: 'Execute without mutations.' }],
        };
  if (entry === undefined) throw new Error(`${actionName} authority fixture missing`);
  const entries = canonical.map((candidate) => (candidate.name === actionName ? entry : candidate));

  const cli = cac('devai-authority-finalization');
  cli.command(entry.internal_name).action(action);
  attachAuthorityCommandBoundaries(cli.commands, [entry]);
  const command = cli.commands[0];
  if (command?.commandAction === undefined) throw new Error('governed command action missing');

  process.argv =
    options.dryRun === true
      ? [
          process.execPath,
          'devai',
          'sense',
          'run',
          'runtime_probe_data',
          '--as-role',
          'auditor',
          '--write',
          '--dry-run',
        ]
      : [
          process.execPath,
          'devai',
          'round',
          'plan',
          '--documents',
          'cli',
          '--as-role',
          'architect',
          '--write',
        ];
  expect(authorizeCliArgv(process.argv, entries)).toBeUndefined();
  return { invoke: () => command.commandAction?.(), events };
}

describe('public authority command finalization', () => {
  it.each([
    [false, ['commit', 'dispose']],
    [true, ['dispose']],
  ] as const)('finalizes a synchronous handler with dryRun=%s', async (dryRun, expected) => {
    const governed = await governedCommand(() => 'sync-result', { dryRun });
    expect(governed.invoke()).toBe('sync-result');
    expect(governed.events).toEqual(expected);
  });

  it.each([
    [false, ['commit', 'dispose']],
    [true, ['dispose']],
  ] as const)('finalizes an asynchronous handler with dryRun=%s', async (dryRun, expected) => {
    let resolveHandler: ((value: string) => void) | undefined;
    const result = new Promise<string>((resolve) => {
      resolveHandler = resolve;
    });
    const governed = await governedCommand(() => result, { dryRun });

    const returned = governed.invoke();
    expect(returned).toBeInstanceOf(Promise);
    expect(governed.events).toEqual([]);
    resolveHandler?.('async-result');
    await expect(returned).resolves.toBe('async-result');
    expect(governed.events).toEqual(expected);
  });

  it('disposes an asynchronous handler boundary before propagating its failure', async () => {
    const governed = await governedCommand(
      () => Promise.reject(new Error('authority handler failure')),
      { dryRun: false },
    );

    await expect(governed.invoke()).rejects.toThrow('authority handler failure');
    expect(governed.events).toEqual(['dispose']);
  });

  it('disposes a synchronous handler boundary before propagating its failure', async () => {
    const governed = await governedCommand(() => {
      throw new Error('authority handler failure');
    });

    expect(governed.invoke).toThrow('authority handler failure');
    expect(governed.events).toEqual(['dispose']);
  });
});
