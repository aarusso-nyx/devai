import { createRequire } from 'node:module';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBind } from '../../src/commands/init/index.js';
import { routeArgv } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const initialArgv = process.argv;
const initialExit = process.exitCode;
afterEach(() => {
  process.argv = initialArgv;
  process.exitCode = initialExit;
  vi.restoreAllMocks();
});

function route(args: readonly string[]) {
  const cli = cac('devai-p1-public-boundary');
  initBind.register(cli);
  const argv = ['node', 'devai', 'init-bind', ...args];
  process.argv = argv;
  cli.parse(argv, { run: false });
  return cli;
}

describe('REC-B1-A-P1 public review contract', () => {
  it('P1-01 registers both exact review selectors on the existing init bind route', () => {
    const cli = route(['--review-authority-policy', '--after-constitution', '--write']);
    const registered = cli.commands.flatMap((command) =>
      command.options.map((option) => option.name),
    );
    expect(registered).toContain('reviewAuthorityPolicy');
    expect(registered).toContain('afterConstitution');
  });

  it('P1-23 preserves the ordinary advisory plan without claiming exact future bytes', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const cli = route([]);
    await cli.runMatchedCommand();
    expect(JSON.parse(stdout)).toEqual({ plan: 'authority-policy' });
    expect(stdout).not.toContain('artifact_sha256');
  });

  it('P1-01 authentic RED witness: existing advisory cannot substitute for exact prospective byte review', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    // The exact mode must exist before it can establish any projection or security property.
    const cli = route([
      '--review-authority-policy',
      '--after-constitution',
      '--write',
      '--target',
      '.',
    ]);
    await cli.runMatchedCommand();
    expect(stdout).toContain('AUTHORITY_POLICY_REVIEW_TERMINAL_REQUIRED');
  });
});

const exactArgs = [
  'init',
  'bind',
  '--review-authority-policy',
  '--after-constitution',
  '--target',
  '/fixture/exact',
  '--as-role',
  'architect',
  '--write',
  '--format',
  'json',
];
function publicRoute(args: readonly string[]) {
  return routeArgv(['node', 'devai', ...args], canonicalRegistry(), 'fixture-package');
}
describe('REC-B1-A-P1 public closed selector admission', () => {
  it('P1-01 admits exact opt-in selectors through existing public action', () => {
    expect(publicRoute(exactArgs)).toMatchObject({ kind: 'dispatch' });
  });
  it.each([
    '--authority-session',
    '--machine-actor',
    '--round',
    '--publish',
    '--experimental',
    '--plan',
    '--dry-run',
    '--human',
    '--full',
    '--constitution',
    '--operational-law',
    '--subprocess-effects',
    '--adopter-policy',
    '--host-adapter',
    '--tracking-adapter',
    '--tracking-repository',
    '--tier',
    '--output',
    '--unknown',
    '--review-authority-policy',
  ])(
    'P1-02 rejects conflicting, replay, duplicate or foreign selector %s before dispatch',
    (flag) => {
      expect(publicRoute([...exactArgs, flag])).toMatchObject({
        kind: 'output',
        exitCode: 2,
        text: expect.stringContaining('AUTHORITY_POLICY_REVIEW_SELECTION_INVALID'),
      });
    },
  );
  it.each(['--review-authority-policy', '--after-constitution', '--write', '--target', '--format'])(
    'P1-02 requires exact explicit %s',
    (flag) => {
      const args = [...exactArgs];
      const index = args.indexOf(flag);
      args.splice(index, ['--target', '--as-role', '--format'].includes(flag) ? 2 : 1);
      expect(publicRoute(args)).toMatchObject({ kind: 'output', exitCode: 2 });
    },
  );
  it.each([
    ['--as-role', 'owner'],
    ['--as-role', 'engineer'],
    ['--format', 'human'],
    ['--format', 'yaml'],
  ])('P1-02 refuses %s %s', (flag, value) => {
    const args = [...exactArgs];
    args[args.indexOf(flag) + 1] = value;
    expect(publicRoute(args)).toMatchObject({ kind: 'output', exitCode: 2 });
  });
});

// Terminal/readline are controlled fixture seams; no live terminal or binding is used.
describe('REC-B1-A-P1 two-phase command I/O through actual output boundary', () => {
  it.each(['confirm', 'cancel', 'interrupt', 'wrong', 'expire', 'readline-error'] as const)(
    'command %s flow closes owned handle through the real wrapper',
    async (flow) => {
      const tty = [process.stdin, process.stdout, process.stderr].map((stream) => ({
        stream,
        descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
      }));
      let stdout = '';
      let stderr = '';
      const { EventEmitter } = await import('node:events');
      const terminal = new EventEmitter() as InstanceType<typeof EventEmitter> & { close(): void };
      terminal.close = () => {
        terminal.emit('close');
      };
      vi.resetModules();
      vi.doMock('node:readline', () => ({ createInterface: () => terminal }));
      for (const { stream } of tty)
        Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write);
      const streams = {
        stdout: process.stdout.write,
        stderr: process.stderr.write,
        exit: process.exit,
      };
      const { createAuthorityPolicyReview } = await import('../../src/authority/policy-review.js');
      const { runWithAuthorityPolicyMaterialization } =
        await import('../../src/authority/command-capabilities.js');
      const { reviewAuthorityPolicy } =
        await import('../../src/commands/init/review-authority-policy.js');
      const { attachActionOutputBoundaries } = await import('../../src/action-output.js');
      const publish = vi.fn(() => ({ status: 'created', binding_performed: true }));
      const handle = createAuthorityPolicyReview({
        ready: {
          kind: 'authority-policy-create-review',
          schema_version: '1.0.0',
          status: 'awaiting-exact-confirmation',
          target: '.devai/config/authority-policy.json',
          operation: 'create',
          grants_authority: false,
          invocation_id: 'fixture-io',
        },
        bytes: Buffer.from('{}\n'),
        verifyActual: vi.fn(),
        publish,
      });
      const construct = vi.fn(() => handle);
      const cli = cac('devai-p1-actual-command-io');
      cli.command('init-bind').action(() =>
        reviewAuthorityPolicy({
          reviewAuthorityPolicy: true,
          afterConstitution: true,
          write: true,
          target: '/fixture',
        }),
      );
      process.argv = ['node', 'devai', ...exactArgs];
      attachActionOutputBoundaries(cli.commands, canonicalRegistry());
      let pending: unknown;
      try {
        if (flow === 'expire') vi.useFakeTimers();
        pending = runWithAuthorityPolicyMaterialization(construct, () =>
          cli.commands[0]?.commandAction?.(),
        );
        const first = JSON.parse(stdout.trim());
        const report = first.result.value;
        expect(report.status).toBe('awaiting-exact-confirmation');
        expect(publish).not.toHaveBeenCalled();
        expect(stderr).toContain(`CREATE ${report.plan_sha256} ${report.artifact.sha256}`);
        if (flow === 'confirm')
          terminal.emit('line', `CREATE ${report.plan_sha256} ${report.artifact.sha256}`);
        if (flow === 'cancel') terminal.emit('close');
        if (flow === 'interrupt') terminal.emit('SIGINT');
        if (flow === 'wrong') terminal.emit('line', 'yes');
        if (flow === 'readline-error')
          terminal.emit('error', new Error('fixture terminal failure'));
        if (flow === 'expire') await vi.advanceTimersByTimeAsync(300_000);
        await pending;
        const output = [...stdout.split('\n'), ...stderr.split('\n')]
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line));
        expect(output).toHaveLength(2);
        if (flow === 'confirm') {
          expect(publish).toHaveBeenCalledOnce();
          expect(output[1]).toMatchObject({
            ok: true,
            result: { value: { status: 'created', binding_performed: true } },
          });
        } else {
          expect(publish).not.toHaveBeenCalled();
          if (flow === 'cancel' || flow === 'interrupt')
            expect(output[1]).toMatchObject({
              ok: true,
              result: { value: { status: 'cancelled', binding_performed: false } },
            });
          if (flow === 'wrong')
            expect(JSON.stringify(output[1])).toContain(
              'AUTHORITY_POLICY_REVIEW_CONFIRMATION_MISMATCH',
            );
          if (flow === 'expire')
            expect(JSON.stringify(output[1])).toContain('AUTHORITY_POLICY_REVIEW_EXPIRED');
          if (flow === 'readline-error') expect(output[1]).toMatchObject({ ok: false });
        }
        expect(construct).toHaveBeenCalledOnce();
        expect(process.stdout.write).toBe(streams.stdout);
        expect(process.stderr.write).toBe(streams.stderr);
        expect(process.exit).toBe(streams.exit);
      } finally {
        terminal.emit('close');
        await pending;
        vi.useRealTimers();
        vi.doUnmock('node:readline');
        vi.resetModules();
        for (const { stream, descriptor } of tty) {
          if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
          else delete (stream as { isTTY?: boolean }).isTTY;
        }
      }
    },
  );
});

describe('REC-B1-A-P1 actual action output boundary acceptance', () => {
  it('raw stdout and stderr cannot bypass the owned two-phase transport', async () => {
    let outerStdout = '';
    let outerStderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      outerStdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      outerStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const { attachActionOutputBoundaries } = await import('../../src/action-output.js');
    const cli = cac('devai-p1-real-output-counterexample');
    let resume: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      resume = done;
    });
    cli.command('init-bind').action(async () => {
      process.stdout.write('{"status":"awaiting-exact-confirmation"}\n');
      process.stderr.write('Type CREATE <plan> <artifact>\n');
      await waiting;
    });
    process.argv = ['node', 'devai', ...exactArgs];
    attachActionOutputBoundaries(cli.commands, canonicalRegistry());
    const command = cli.commands[0];
    const pending = command?.commandAction?.();
    try {
      expect(pending).toBeInstanceOf(Promise);
      // This is observed old-boundary behavior, not acceptance of the required new protocol.
      expect(outerStdout).toBe('');
      expect(outerStderr).toBe('');
    } finally {
      resume?.();
      await pending;
    }
    expect(outerStderr).toContain('ACTION_OUTPUT_CONTRACT_VIOLATION');
    expect(outerStderr).toContain('Type CREATE');
  });

  it('actual registered public JSON route exposes READY before confirmation and completes once', async () => {
    const tty = [process.stdin, process.stdout, process.stderr].map((stream) => ({
      stream,
      descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
    }));
    let stdout = '';
    let stderr = '';
    const { EventEmitter } = await import('node:events');
    const terminal = new EventEmitter() as InstanceType<typeof EventEmitter> & { close(): void };
    terminal.close = () => {
      terminal.emit('close');
    };
    vi.resetModules();
    vi.doMock('node:readline', () => ({ createInterface: () => terminal }));
    for (const { stream } of tty)
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const { attachActionOutputBoundaries } = await import('../../src/action-output.js');
    const { initBind: registeredBind } = await import('../../src/commands/init/index.js');
    const { createAuthorityPolicyReview } = await import('../../src/authority/policy-review.js');
    const { runWithAuthorityPolicyMaterialization } =
      await import('../../src/authority/command-capabilities.js');
    const handle = createAuthorityPolicyReview({
      ready: {
        kind: 'authority-policy-create-review',
        schema_version: '1.0.0',
        status: 'awaiting-exact-confirmation',
        grants_authority: false,
        target: '.devai/config/authority-policy.json',
        operation: 'create',
      },
      bytes: Buffer.from('{}\n'),
      verifyActual: vi.fn(),
      publish: vi.fn(),
    });
    const cli = cac('devai-p1-real-public-review');
    registeredBind.register(cli);
    cli.option('--as-role <role>', 'Direct role').option('--format <format>', 'Output format');
    cli.parse(['node', 'devai', 'init-bind', ...exactArgs.slice(2)], { run: false });
    process.argv = ['node', 'devai', ...exactArgs];
    attachActionOutputBoundaries(cli.commands, canonicalRegistry());
    let pending: unknown;
    try {
      pending = runWithAuthorityPolicyMaterialization(
        () => handle,
        () => cli.runMatchedCommand(),
      );
      expect(stdout).toContain('awaiting-exact-confirmation');
      expect(stderr).toContain('CREATE ');
      expect(stdout.trim().split('\n')).toHaveLength(1);
      terminal.emit('close');
      await pending;
      expect(stdout.trim().split('\n')).toHaveLength(2);
    } finally {
      terminal.emit('close');
      await pending;
      vi.doUnmock('node:readline');
      vi.resetModules();
      for (const { stream, descriptor } of tty) {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else delete (stream as { isTTY?: boolean }).isTTY;
      }
    }
  });
});

describe('REC-B1-A-P1 safety without an owned output transport', () => {
  it('P1-03/P1-06 refuses before constructing any artifact when streaming boundary is unavailable', async () => {
    const tty = [process.stdin, process.stdout, process.stderr].map((stream) => ({
      stream,
      descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
    }));
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    for (const { stream } of tty)
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    const { runWithAuthorityPolicyMaterialization } =
      await import('../../src/authority/command-capabilities.js');
    const { reviewAuthorityPolicy } =
      await import('../../src/commands/init/review-authority-policy.js');
    const construct = vi.fn(() => {
      throw new Error('must not prepare');
    });
    try {
      await runWithAuthorityPolicyMaterialization(construct, () =>
        reviewAuthorityPolicy({
          reviewAuthorityPolicy: true,
          afterConstitution: true,
          write: true,
          target: '/fixture',
        }),
      );
      expect(stdout).toContain('AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED');
      expect(stdout).toContain('admitted live output boundary');
      expect(construct).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    } finally {
      for (const { stream, descriptor } of tty) {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else delete (stream as { isTTY?: boolean }).isTTY;
      }
    }
  });
});

describe('P1-05 exact-token selector grammar counterexamples', () => {
  it.each([
    ['--review-authority-policy=true', '--after-constitution=true'],
    ['--review-authority-policy=false', '--after-constitution=false'],
    ['--review-authority-policy=1', '--after-constitution=1'],
    ['--reviewAuthorityPolicy', '--afterConstitution'],
    ['--reviewAuthorityPolicy=true', '--afterConstitution=true'],
    ['--review-authority-policy', '--after-constitution=true'],
  ])('refuses non-exact selector spelling %s %s before dispatch', (review, after) => {
    const args = exactArgs.map((value) =>
      value === '--review-authority-policy'
        ? review
        : value === '--after-constitution'
          ? after
          : value,
    );
    expect(publicRoute(args)).toMatchObject({ kind: 'output', exitCode: 2 });
  });
});

it('valid review routes after production authority stripping while role admission remains at original-argv boundaries', async () => {
  const { stripAuthorityArgv } = await import('../../src/authority/index.js');
  const stripped = stripAuthorityArgv(['node', 'devai', ...exactArgs]);
  expect(stripped).not.toContain('--as-role');
  expect(routeArgv(stripped, canonicalRegistry(), 'fixture-package')).toMatchObject({
    kind: 'dispatch',
  });
});
