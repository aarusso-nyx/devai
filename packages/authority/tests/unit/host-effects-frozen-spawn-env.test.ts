import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runWithAuthorityHostEffects,
  spawnSync,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
  type SpawnSyncOptions,
} from '../../src/boundaries/host-effects.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';

// Constitution Articles 6, 10 and 41: the broker authorizes the exact immutable
// request before native execution; Node's coverage propagation must not alter it.
const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai frozen spawn ç-'));
  roots.push(root);
  return root;
}

async function scopeFor(
  invocationId: string,
  applyEffect: AuthorityHostEffectScope['apply_effect'],
): Promise<AuthorityHostEffectScope> {
  const issuer = createIssuer(await runtimeApi(), {
    issuer_id: `frozen-spawn-${invocationId}`,
    invocation_id: invocationId,
  });
  disposers.push(() => issuer.dispose());
  return {
    action_id: 'sense run',
    invocation_id: invocationId,
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: applyEffect,
  };
}

describe.each(['argv', 'options'] as const)(
  'frozen spawnSync environment (%s overload)',
  (overload) => {
    it('propagates coverage and inherited environment without changing the authorized request', async () => {
      const root = fixture();
      const coverage = join(root, 'coverage');
      const prototype = Object.freeze({ DEVAI_INHERITED: 'inherited value' });
      const env = Object.freeze(
        Object.assign(Object.create(prototype) as NodeJS.ProcessEnv, { DEVAI_OWN: 'own value' }),
      );
      const script =
        'process.stdout.write(JSON.stringify({coverage:process.env.NODE_V8_COVERAGE,own:process.env.DEVAI_OWN,inherited:process.env.DEVAI_INHERITED}))';
      const argv = Object.freeze(['-e', script]);
      const options = Object.freeze({
        cwd: root,
        env,
        encoding: 'utf8' as const,
        timeout: 10_000,
        ...(overload === 'options' ? { input: script } : {}),
      });
      const requests: AuthorityHostEffectRequest[] = [];
      const scope = await scopeFor(`coverage-${overload}`, (request, apply) => {
        requests.push(request);
        expect(request.kind).toBe('process');
        expect(request.symbol).toBe('spawnSync');
        expect(request.arguments[0]).toBe(process.execPath);
        expect(request.arguments[overload === 'argv' ? 2 : 1]).toBe(options);
        expect((request.arguments[overload === 'argv' ? 2 : 1] as typeof options).env).toBe(env);
        if (overload === 'argv') expect(request.arguments[1]).toBe(argv);
        expect(Object.hasOwn(env, 'NODE_V8_COVERAGE')).toBe(false);
        return apply();
      });
      const previousCoverage = process.env.NODE_V8_COVERAGE;
      try {
        process.env.NODE_V8_COVERAGE = coverage;
        const result = runWithAuthorityHostEffects(scope, () =>
          overload === 'argv'
            ? spawnSync(process.execPath, argv, options)
            : spawnSync(process.execPath, options),
        );
        expect(result.error).toBeUndefined();
        expect(result.status, String(result.stderr)).toBe(0);
        expect(JSON.parse(String(result.stdout))).toEqual({
          coverage,
          own: 'own value',
          inherited: 'inherited value',
        });
        expect(requests).toHaveLength(1);
        expect(Object.isFrozen(options)).toBe(true);
        expect(Object.isFrozen(env)).toBe(true);
        expect(Object.getPrototypeOf(env)).toBe(prototype);
        expect(Object.getOwnPropertyNames(env)).toEqual(['DEVAI_OWN']);
        expect(env.DEVAI_OWN).toBe('own value');
        expect(env.DEVAI_INHERITED).toBe('inherited value');
        expect(Object.hasOwn(env, 'NODE_V8_COVERAGE')).toBe(false);
      } finally {
        if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
        else process.env.NODE_V8_COVERAGE = previousCoverage;
      }
    });

    it('refuses before reading the execution environment or starting the child', async () => {
      const root = fixture();
      const marker = join(root, 'child-started');
      let envReads = 0;
      const env = Object.freeze(
        Object.defineProperty({}, 'DEVAI_PROBE', {
          enumerable: true,
          get: () => {
            envReads += 1;
            return 'probe';
          },
        }),
      );
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
      const argv = Object.freeze(['-e', script]);
      const options = Object.freeze({
        cwd: root,
        env,
        timeout: 10_000,
        ...(overload === 'options' ? { input: script } : {}),
      });
      let authorizationCalls = 0;
      const refusal = new Error('AUTHORITY_TEST_REFUSED');
      const scope = await scopeFor(`denied-${overload}`, (request) => {
        authorizationCalls += 1;
        expect(request.arguments[overload === 'argv' ? 2 : 1]).toBe(options);
        if (overload === 'argv') expect(request.arguments[1]).toBe(argv);
        throw refusal;
      });
      expect(() =>
        runWithAuthorityHostEffects(scope, () =>
          overload === 'argv'
            ? spawnSync(process.execPath, argv, options)
            : spawnSync(process.execPath, options),
        ),
      ).toThrow(refusal);
      expect(authorizationCalls).toBe(1);
      expect(envReads).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(Object.isFrozen(options)).toBe(true);
      expect(Object.isFrozen(env)).toBe(true);
    });
    it('preserves own environment values that shadow inherited setters and readonly fields', async () => {
      const root = fixture();
      let setterCalls = 0;
      const prototype = Object.freeze(
        Object.defineProperties(
          {},
          {
            TOKEN: {
              enumerable: true,
              get: () => 'inherited token',
              set: () => {
                setterCalls += 1;
              },
            },
            READONLY: { enumerable: true, value: 'inherited readonly', writable: false },
          },
        ),
      );
      const env = Object.freeze(
        Object.create(prototype, {
          TOKEN: { enumerable: true, value: 'own token' },
          READONLY: { enumerable: true, value: 'own readonly' },
        }) as NodeJS.ProcessEnv,
      );
      const script =
        'process.stdout.write(JSON.stringify({token:process.env.TOKEN,readonly:process.env.READONLY}))';
      const argv = Object.freeze(['-e', script]);
      const options = Object.freeze({
        cwd: root,
        env,
        encoding: 'utf8' as const,
        timeout: 10_000,
        ...(overload === 'options' ? { input: script } : {}),
      });
      const scope = await scopeFor(`shadow-${overload}`, (request, apply) => {
        expect(request.arguments[overload === 'argv' ? 2 : 1]).toBe(options);
        return apply();
      });
      const result = runWithAuthorityHostEffects(scope, () =>
        overload === 'argv'
          ? spawnSync(process.execPath, argv, options)
          : spawnSync(process.execPath, options),
      );
      expect(result.error).toBeUndefined();
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout))).toEqual({
        token: 'own token',
        readonly: 'own readonly',
      });
      expect(setterCalls).toBe(0);
      expect(Object.getPrototypeOf(env)).toBe(prototype);
      expect(env.TOKEN).toBe('own token');
      expect(env.READONLY).toBe('own readonly');
    });
  },
);

it('retains native refusal for an array in the third options slot even when it carries env', async () => {
  const root = fixture();
  const marker = join(root, 'invalid-options-child-started');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  const argv = Object.freeze(['-e', script]);
  const options = Object.freeze(
    Object.assign([], { env: Object.freeze({ DEVAI_PROBE: 'probe' }) }),
  );
  let authorizationCalls = 0;
  const scope = await scopeFor('invalid-array-options', (request, apply) => {
    authorizationCalls += 1;
    expect(request.arguments[1]).toBe(argv);
    expect(request.arguments[2]).toBe(options);
    return apply();
  });
  expect(() =>
    runWithAuthorityHostEffects(scope, () =>
      spawnSync(process.execPath, argv, options as unknown as SpawnSyncOptions),
    ),
  ).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  expect(authorizationCalls).toBe(1);
  expect(existsSync(marker)).toBe(false);
});
