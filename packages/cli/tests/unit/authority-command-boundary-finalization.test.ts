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
  options: Readonly<{
    dryRun?: boolean;
    disposeFailure?: boolean;
    scopeAction?: string;
    scopeEffect?: 'read' | 'harness-write' | 'local-write' | 'remote-write';
    bindReview?: boolean;
    reviewOutput?: boolean;
  }> = {},
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
            action_id: options.scopeAction ?? input.entry.name,
            invocation_id: invocationId,
            effect: options.scopeEffect ?? (options.dryRun === true ? 'read' : input.entry.effects),
            receipt_store: issuer,
            apply_effect: (_request: unknown, apply: () => unknown) => apply(),
          }),
          policy_materialization: () => ({
            start: () => {
              events.push('review-ready');
              return {};
            },
            confirm: () => {
              events.push('review-confirm');
              return {};
            },
          }),
          commit_exact: () => events.push('commit'),
          dispose: () => {
            events.push('dispose');
            issuer.dispose();
            if (options.disposeFailure === true) throw new Error('authority disposal failure');
          },
        };
      },
    };
  });
  // Import one module at a time. Each dynamic import flushes Vitest's pending mock queue
  // (here the previous test's doUnmock, then this doMock), and the queue is cleared only after
  // every entry resolves. Two concurrent imports flush the same queue twice, so under load one
  // import's replayed unmock could land after the other's mock and load the real broker, which
  // refuses with AUTHORITY_POLICY_MISSING or records no commit/dispose events.
  const { attachAuthorityCommandBoundaries, authorizeCliArgv, disposeCliInvocationAuthority } =
    await import('../../src/authority/index.js');
  const { canonicalRegistry } = await import('../../src/define-command.js');
  const actionName =
    options.bindReview === true
      ? 'init bind'
      : options.dryRun === true
        ? 'sense run'
        : 'round plan';
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
    options.bindReview === true
      ? [
          process.execPath,
          'devai',
          'init',
          'bind',
          '--review-authority-policy',
          '--after-constitution',
          '--target',
          '.',
          '--as-role',
          'architect',
          '--write',
          '--format',
          'json',
        ]
      : options.dryRun === true
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
  if (options.reviewOutput) {
    const { attachActionOutputBoundaries } = await import('../../src/action-output.js');
    attachActionOutputBoundaries(cli.commands, entries);
  }
  return {
    disposeInvocation: disposeCliInvocationAuthority,
    invoke: () => command.commandAction?.(),
    events,
  };
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

  it.each([
    ['action identity', { scopeAction: 'catalog actions' }],
    ['effect', { scopeEffect: 'read' as const }],
  ])('refuses a staged scope with the wrong %s and disposes it', async (_label, options) => {
    const handler = vi.fn(() => 'must-not-run');
    const governed = await governedCommand(handler, options);

    expect(governed.invoke).toThrow('AUTHORITY_FINAL_BOUNDARY_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
    expect(governed.events).toEqual(['dispose']);
  });

  it('propagates and remembers a broker disposal failure after clearing the invocation', async () => {
    const governed = await governedCommand(() => 'must-not-run', { disposeFailure: true });

    expect(governed.disposeInvocation).toThrow('authority disposal failure');
    expect(governed.disposeInvocation).toThrow('AUTHORITY_INVOCATION_DISPOSAL_FAILED');
    expect(governed.events).toEqual(['dispose']);
  });
});

describe('REC-B1-A-P1 async review authority scope', () => {
  it('P1-06/P1-07/P1-15 retains invocation-local operation through wait and clears it after confirmation', async () => {
    let resume: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      resume = done;
    });
    let escaped: (() => unknown) | undefined;
    const governed = await governedCommand(
      async () => {
        const { executeAuthorityPolicyMaterialization } =
          await import('../../src/authority/command-capabilities.js');
        escaped = executeAuthorityPolicyMaterialization;
        const handle = executeAuthorityPolicyMaterialization() as {
          start(): unknown;
          confirm(): unknown;
        };
        handle.start();
        await waiting;
        // The same operation remains reachable only in this live async invocation.
        executeAuthorityPolicyMaterialization();
        handle.confirm();
        return 'review-complete';
      },
      { bindReview: true },
    );
    const result = governed.invoke();
    await new Promise<void>((done) => setImmediate(done));
    expect(governed.events).toEqual(['review-ready']);
    resume?.();
    await expect(result).resolves.toBe('review-complete');
    expect(governed.events).toEqual(['review-ready', 'review-confirm', 'commit', 'dispose']);
    expect(() => escaped?.()).toThrow('AUTHORITY_POLICY_MATERIALIZATION_REQUIRED');
  });
});

describe('output transport waits for actual authority finalization', () => {
  it('nested authority disposal failure replaces a pending success with one failure and restores streams', async () => {
    const tty = [process.stdin, process.stdout, process.stderr].map((stream) => ({
      stream,
      descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
    }));
    for (const { stream } of tty)
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    let stdout = '';
    let stderr = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const streams = {
      stdout: process.stdout.write,
      stderr: process.stderr.write,
      exit: process.exit,
    };
    try {
      const governed = await governedCommand(
        async () => {
          const { requireAuthorityPolicyReviewOutput } = await import('../../src/action-output.js');
          const transport = requireAuthorityPolicyReviewOutput();
          transport.ready({
            kind: 'authority-policy-create-review',
            schema_version: '1.0.0',
            status: 'awaiting-exact-confirmation',
            grants_authority: false,
            target: '.devai/config/authority-policy.json',
            operation: 'create',
          });
          transport.prompt('prompt\n');
          transport.complete({ status: 'created', binding_performed: true });
        },
        { bindReview: true, disposeFailure: true, reviewOutput: true },
      );
      await governed.invoke();
      const success = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const failure = stderr
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      expect(success).toHaveLength(1);
      expect(success[0]).toMatchObject({ result: { verdict: 'review' } });
      expect(failure).toHaveLength(1);
      expect(failure[0]).toMatchObject({ ok: false });
      expect(JSON.stringify(failure[0])).toContain('authority disposal failure');
      expect(governed.events).toEqual(['commit', 'dispose']);
      expect(process.stdout.write).toBe(streams.stdout);
      expect(process.stderr.write).toBe(streams.stderr);
      expect(process.exit).toBe(streams.exit);
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const { stream, descriptor } of tty) {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else delete (stream as { isTTY?: boolean }).isTTY;
      }
    }
  });
});
