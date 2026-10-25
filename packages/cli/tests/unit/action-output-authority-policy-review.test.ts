import { createRequire } from 'node:module';
import type { CAC } from '../../node_modules/cac/dist/index.d.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import {
  attachActionOutputBoundaries,
  requireAuthorityPolicyReviewOutput,
} from '../../src/action-output.js';
import { cliError } from '../../src/cli-error.js';
import { canonicalRegistry } from '../../src/define-command.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};
const originalArgv = process.argv;
const originalExit = process.exitCode;
const tty = [process.stdin, process.stdout, process.stderr].map((stream) => ({
  stream,
  descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
}));
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const { stream, descriptor } of tty) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
});
const exactArgs = [
  'init',
  'bind',
  '--review-authority-policy',
  '--after-constitution',
  '--target',
  '/disposable/fixture',
  '--as-role',
  'architect',
  '--write',
  '--format',
  'json',
];
const readyPayload = () => ({
  kind: 'authority-policy-create-review',
  schema_version: '1.0.0',
  status: 'awaiting-exact-confirmation',
  target: '.devai/config/authority-policy.json',
  operation: 'create',
  grants_authority: false,
});
const cancelled = { status: 'cancelled', binding_performed: false };
const created = { status: 'created', binding_performed: true };
type Output = ReturnType<typeof requireAuthorityPolicyReviewOutput>;
function outputLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}
function wrapped(action: () => unknown, args: readonly string[] = exactArgs, terminal = true) {
  let stdout = '';
  let stderr = '';
  for (const { stream } of tty)
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: terminal });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const before = { stdout: process.stdout.write, stderr: process.stderr.write, exit: process.exit };
  const cli = cac('devai-output-review-fixture');
  const entry = canonicalRegistry().find((row) => row.name === args.slice(0, 2).join(' '));
  if (!entry) throw new Error('output fixture action missing');
  cli.command(entry.internal_name).action(action);
  process.argv = ['node', 'devai', ...args];
  attachActionOutputBoundaries(cli.commands, canonicalRegistry());
  return {
    invoke: () => cli.commands[0]?.commandAction?.(),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    envelopes: () => [...outputLines(stdout), ...outputLines(stderr)],
    assertRestored: () => {
      expect(process.stdout.write).toBe(before.stdout);
      expect(process.stderr.write).toBe(before.stderr);
      expect(process.exit).toBe(before.exit);
    },
  };
}
function begin(): Output {
  const out = requireAuthorityPolicyReviewOutput();
  out.ready(readyPayload());
  out.prompt('Type CREATE fixture-plan fixture-artifact\n');
  return out;
}

describe('REC-B1-A-P1 amended real output boundary', () => {
  it('READY action envelope and stderr prompt are observable while real wrapper is pending', async () => {
    let resume: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      resume = done;
    });
    const f = wrapped(async () => {
      const out = begin();
      await waiting;
      out.complete(cancelled);
    });
    const pending = f.invoke();
    try {
      expect(pending).toBeInstanceOf(Promise);
      expect(f.stdout).toContain('awaiting-exact-confirmation');
      expect(f.stderr).toContain('Type CREATE fixture-plan fixture-artifact');
      expect(f.envelopes()).toHaveLength(1);
      const envelope = f.envelopes()[0];
      expect(validators.actionResult(envelope)).toBe(true);
      expect(envelope).toMatchObject({
        action_id: 'init bind',
        ok: true,
        result: { verdict: 'review', media_type: 'application/json', value: readyPayload() },
      });
    } finally {
      resume?.();
      await pending;
    }
    expect(f.envelopes()).toHaveLength(2);
    expect(f.envelopes()[1]).toMatchObject({ ok: true, result: { value: cancelled } });
    f.assertRestored();
  });

  it.each(['created', 'cancelled'] as const)(
    'emits exactly one deferred %s terminal envelope',
    async (status) => {
      const f = wrapped(() => {
        const out = begin();
        out.complete(status === 'created' ? created : cancelled);
        expect(f.envelopes()).toHaveLength(1);
      });
      await f.invoke();
      expect(f.envelopes()).toHaveLength(2);
      expect(
        f
          .envelopes()
          .filter((row) => (row.result as { verdict?: string } | undefined)?.verdict !== 'review'),
      ).toHaveLength(1);
      expect(f.envelopes()[1]).toMatchObject({ result: { verdict: 'pass', value: { status } } });
      f.assertRestored();
    },
  );

  it('copies pending terminal data and emits it only after async cleanup succeeds', async () => {
    let release: (() => void) | undefined;
    const cleanup = new Promise<void>((done) => {
      release = done;
    });
    const payload = { ...created };
    const f = wrapped(async () => {
      const out = begin();
      out.complete(payload);
      payload.status = 'cancelled';
      await cleanup;
    });
    const pending = f.invoke();
    try {
      expect(f.envelopes()).toHaveLength(1);
    } finally {
      release?.();
      await pending;
    }
    expect(f.envelopes()[1]).toMatchObject({ result: { value: created } });
    f.assertRestored();
  });

  it.each([
    'throw',
    'reject',
    'uncertainty',
    'cleanup',
    'exit',
    'extra-stdout',
    'extra-stderr',
    'missing-terminal',
  ] as const)('honest single terminal failure for %s restores streams and exit', async (mode) => {
    const f = wrapped(async () => {
      const out = begin();
      if (mode === 'cleanup') {
        out.complete(created);
        throw new Error('fixture authority cleanup failed');
      }
      if (mode === 'throw') throw new Error('fixture thrown failure');
      if (mode === 'reject') return Promise.reject(new Error('fixture async rejection'));
      if (mode === 'uncertainty') throw new Error('AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE');
      if (mode === 'exit') {
        process.stderr.write('fixture authority finalization refused with diagnostic\n');
        process.exit(2);
      }
      if (mode === 'extra-stdout') process.stdout.write('unexpected stdout\n');
      if (mode === 'extra-stderr') process.stderr.write('unexpected stderr\n');
      if (mode !== 'missing-terminal') out.complete(created);
    });
    await f.invoke();
    const envelopes = f.envelopes();
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toMatchObject({
      ok: false,
      error: { class: expect.any(String), exit: expect.any(Number) },
    });
    expect(
      envelopes.some(
        (row) =>
          row.ok === true && (row.result as { verdict?: string } | undefined)?.verdict === 'pass',
      ),
    ).toBe(false);
    expect(process.exitCode).not.toBe(0);
    if (mode === 'uncertainty')
      expect(JSON.stringify(envelopes[1])).toContain('AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE');
    f.assertRestored();
  });

  it.each([false, true])(
    'structured refusal ready=%s emits one honest terminal failure',
    async (withReady) => {
      const error = cliError({
        code: 'AUTHORITY_POLICY_REVIEW_CONFIRMATION_MISMATCH',
        class: 'routing-authority',
        exit: 2,
        message: 'fixture mismatch',
        remediation: 'start again',
      });
      const f = wrapped(() => {
        const out = withReady ? begin() : requireAuthorityPolicyReviewOutput();
        out.refuse(error);
        process.exitCode = 2;
      });
      await f.invoke();
      expect(f.envelopes()).toHaveLength(withReady ? 2 : 1);
      expect(f.envelopes().filter((row) => row.ok === false)).toHaveLength(1);
      expect(f.envelopes().at(-1)).toMatchObject({ error: { code: error.code, exit: 2 } });
      f.assertRestored();
    },
  );

  it.each([
    'clone',
    'detached',
    'prompt-before-ready',
    'complete-before-ready',
    'duplicate-ready',
    'duplicate-prompt',
    'duplicate-terminal',
  ] as const)('owned transport rejects %s without a second terminal envelope', async (attack) => {
    const f = wrapped(() => {
      const out = requireAuthorityPolicyReviewOutput();
      if (attack === 'clone') {
        const clone = { ...out };
        expect(() => clone.ready(readyPayload())).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      }
      if (attack === 'detached') {
        const detached = out.ready;
        expect(() => detached(readyPayload())).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      }
      if (attack === 'prompt-before-ready')
        expect(() => out.prompt('foreign')).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      if (attack === 'complete-before-ready')
        expect(() => out.complete(created)).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      out.ready(readyPayload());
      if (attack === 'duplicate-ready')
        expect(() => out.ready(readyPayload())).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      out.prompt('prompt\n');
      if (attack === 'duplicate-prompt')
        expect(() => out.prompt('again')).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      out.complete(cancelled);
      if (attack === 'duplicate-terminal')
        expect(() => out.complete(created)).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
    });
    await f.invoke();
    expect(f.envelopes()).toHaveLength(2);
    expect(f.envelopes()[1]).toMatchObject({ ok: true, result: { value: cancelled } });
    f.assertRestored();
  });

  it('unowned, escaped, reused and foreign-invocation transports grant no output access', async () => {
    expect(requireAuthorityPolicyReviewOutput).toThrow(
      'AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED',
    );
    let escaped: Output | undefined;
    const first = wrapped(() => {
      escaped = begin();
      escaped.complete(cancelled);
    });
    await first.invoke();
    const original = escaped;
    if (!original) throw new Error('fixture did not capture transport');
    expect(() => original.ready(readyPayload())).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
    expect(requireAuthorityPolicyReviewOutput).toThrow(
      'AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED',
    );
    const second = wrapped(() => {
      const out = begin();
      expect(() => original.complete(created)).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      out.complete(cancelled);
    });
    await second.invoke();
    expect(second.envelopes()).toHaveLength(2);
    second.assertRestored();
  });

  it.each([
    'missing-role',
    'wrong-role',
    'session',
    'machine',
    'missing-write',
    'missing-selector',
    'equals',
    'format',
    'target',
    'wrong-action',
    'non-terminal',
  ])('wrong %s cannot activate transport', async (attack) => {
    let args = [...exactArgs];
    if (attack === 'missing-role') args.splice(args.indexOf('--as-role'), 2);
    if (attack === 'wrong-role') args[args.indexOf('--as-role') + 1] = 'owner';
    if (attack === 'session') args.push('--authority-session', 'foreign');
    if (attack === 'machine') args.push('--machine-actor', 'binding');
    if (attack === 'missing-write') args = args.filter((arg) => arg !== '--write');
    if (attack === 'missing-selector') args = args.filter((arg) => arg !== '--after-constitution');
    if (attack === 'equals')
      args = args.map((arg) => (arg === '--after-constitution' ? `${arg}=true` : arg));
    if (attack === 'format') args[args.indexOf('--format') + 1] = 'human';
    if (attack === 'target') args.splice(args.indexOf('--target'), 2);
    if (attack === 'wrong-action') args[1] = 'upgrade';
    let accessError: unknown;
    const f = wrapped(
      () => {
        try {
          requireAuthorityPolicyReviewOutput();
        } catch (error) {
          accessError = error;
        }
        process.stdout.write('{"legacy":true}\n');
      },
      args,
      attack !== 'non-terminal',
    );
    await f.invoke();
    expect(String(accessError)).toContain('AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED');
    expect(f.stdout).not.toContain('awaiting-exact-confirmation');
    f.assertRestored();
  });

  it('ordinary JSON action remains one buffered existing-format envelope', async () => {
    const args = ['init', 'bind', '--target', '/fixture', '--format', 'json'];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const f = wrapped(async () => {
      process.stdout.write('{"plan":"authority-policy"}\n');
      await waiting;
    }, args);
    const pending = f.invoke();
    try {
      expect(f.stdout).toBe('');
    } finally {
      release?.();
      await pending;
    }
    expect(f.envelopes()).toEqual([
      {
        schemaVersion: '1.0.0',
        action_id: 'init bind',
        ok: true,
        result: {
          verdict: 'pass',
          media_type: 'application/json',
          value: { plan: 'authority-policy' },
        },
      },
    ]);
    f.assertRestored();
  });
});

describe('output transport additional custody and publication fidelity', () => {
  it('pre-ready constructor throw emits one failure and restores streams and exit', async () => {
    const f = wrapped(() => {
      requireAuthorityPolicyReviewOutput();
      throw new Error('fixture artifact constructor failed');
    });
    await f.invoke();
    expect(f.envelopes()).toHaveLength(1);
    expect(f.envelopes()[0]).toMatchObject({ ok: false, error: { exit: 6 } });
    expect(f.stdout).not.toContain('awaiting-exact-confirmation');
    f.assertRestored();
  });

  it.each(['argv', 'tty'])('rejects live %s drift before reacquisition or use', async (changed) => {
    const f = wrapped(() => {
      const out = begin();
      const saved = process.argv;
      if (changed === 'argv') process.argv = [...process.argv, '--publish'];
      else Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      try {
        expect(requireAuthorityPolicyReviewOutput).toThrow(/AUTHORITY_POLICY_REVIEW_/u);
        expect(() => out.complete(created)).toThrow('AUTHORITY_POLICY_REVIEW_HANDLE_INVALID');
      } finally {
        process.argv = saved;
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
      }
      out.complete(cancelled);
    });
    await f.invoke();
    expect(f.envelopes()).toHaveLength(2);
    f.assertRestored();
  });

  it('an inherited async-local context cannot reacquire transport after its owner settles', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    let late: Promise<void> | undefined;
    let access: unknown;
    const f = wrapped(() => {
      const out = begin();
      late = waiting.then(() => {
        try {
          requireAuthorityPolicyReviewOutput();
        } catch (error) {
          access = error;
        }
      });
      out.complete(cancelled);
    });
    await f.invoke();
    release?.();
    await late;
    expect(String(access)).toContain('AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED');
    expect(f.envelopes()).toHaveLength(2);
    f.assertRestored();
  });

  it('actual indeterminate publisher error retains path, staged ownership and lossless inode identity in its single failure', async () => {
    const { PublishIndeterminateError } =
      await import('../../../authority/src/boundaries/host-publish.js');
    const identity = { dev: 16777233n, ino: 1115588888n, birthtimeNs: 1792855555555555555n };
    const path = '/disposable/fixture/.devai/config/authority-policy.json';
    const error = new PublishIndeterminateError(
      path,
      true,
      Object.assign(new Error('fixture EIO'), { code: 'EIO' }),
      identity,
    );
    const f = wrapped(() => {
      begin();
      throw error;
    });
    await f.invoke();
    expect(f.envelopes()).toHaveLength(2);
    const terminal = f.envelopes()[1];
    expect(terminal).toMatchObject({
      ok: false,
      error: {
        code: 'ACTION_INVOCATION_REFUSED',
        class: 'infrastructure',
        exit: 6,
        context: {
          publication: {
            code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE',
            path,
            staged_remaining: true,
            identity: {
              dev: identity.dev.toString(),
              ino: identity.ino.toString(),
              birthtimeNs: identity.birthtimeNs.toString(),
            },
          },
        },
      },
    });
    expect(
      f
        .envelopes()
        .some(
          (row) =>
            row.ok === true && (row.result as { verdict?: string } | undefined)?.verdict === 'pass',
        ),
    ).toBe(false);
    f.assertRestored();
  });
});

describe('owned publication-failure transport remains diagnostic data only', () => {
  it.each(['throw', 'exit'] as const)(
    'preserves indeterminate ownership even when later cleanup uses %s',
    async (mode) => {
      const { PublishIndeterminateError } =
        await import('../../../authority/src/boundaries/host-publish.js');
      const identity = { dev: 1n, ino: 2n, birthtimeNs: 9007199254740993n };
      const path = '/disposable/fixture/.devai/config/authority-policy.json';
      const error = new PublishIndeterminateError(path, true, new Error('EIO'), identity);
      const f = wrapped(() => {
        const out = begin();
        expect(out.publicationFailure(error)).toBe(true);
        process.exitCode = 6;
        if (mode === 'exit') {
          process.stderr.write('fixture authority finalization refused with diagnostic\n');
          process.exit(2);
        }
        throw new Error('fixture later authority cleanup failed');
      });
      await f.invoke();
      expect(f.envelopes()).toHaveLength(2);
      expect(f.envelopes()[1]).toMatchObject({
        ok: false,
        error: {
          code: 'ACTION_INVOCATION_REFUSED',
          class: 'infrastructure',
          exit: 6,
          context: {
            publication: {
              code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE',
              path,
              staged_remaining: true,
              identity: { dev: '1', ino: '2', birthtimeNs: '9007199254740993' },
            },
          },
        },
      });
      if (mode === 'exit')
        expect(f.envelopes()[1]).toMatchObject({
          error: {
            context: {
              finalization_failure: {
                exit: 2,
                stderr: expect.stringContaining(
                  'fixture authority finalization refused with diagnostic',
                ),
              },
            },
          },
        });
      f.assertRestored();
    },
  );

  it('cloned publication-failure method rejects, and nonmatching errors cannot manufacture publication status', async () => {
    const f = wrapped(() => {
      const out = begin();
      const clone = { ...out };
      expect(() => clone.publicationFailure(new Error('foreign'))).toThrow(
        'AUTHORITY_POLICY_REVIEW_HANDLE_INVALID',
      );
      expect(out.publicationFailure(new Error('AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE'))).toBe(false);
      expect(
        out.publicationFailure({
          code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE',
          path: '/foreign',
          staged_remaining: true,
          identity: { dev: '1', ino: '2', birthtimeNs: '3' },
        }),
      ).toBe(false);
      out.complete(cancelled);
    });
    await f.invoke();
    expect(f.envelopes()).toHaveLength(2);
    expect(f.envelopes()[1]).toMatchObject({ ok: true, result: { value: cancelled } });
    f.assertRestored();
  });
});
