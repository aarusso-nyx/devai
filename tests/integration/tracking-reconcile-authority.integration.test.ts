// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Integration acceptance for CI reconciliation authority, driven through the
// assembled CLI so the real authority layer runs.
//
// The property under test is that reconcile-only cannot be turned into a way
// to *claim* authority. It replays what an Owner recorded, and any attempt to
// supply an identity or a consent alongside it is refused before a handler
// ever runs. The ordinary interactive path must be untouched.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'packages', 'cli', 'dist', 'runtime', 'index', 'bin.js');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-reconcile-cli-'));
  roots.push(root);
  return root;
}

function run(args: readonly string[], environment: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, ...args, '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  const payload = JSON.parse(`${result.stdout}${result.stderr}`.trim()) as {
    ok?: boolean;
    error?: { code?: string };
  };
  return { ok: payload.ok === true, code: payload.error?.code };
}

describe('reconcile-only refuses caller-claimed authority', () => {
  it('refuses a declared role, a session, or a consent flag', () => {
    const root = repository();
    const claims = [
      ['--as-role', 'owner'],
      ['--authority-session', 'AUTH-SESSION-0f1e2d3c4b5a69788796'],
      ['--write'],
      ['--publish'],
      ['--write', '--publish', '--as-role', 'owner'],
    ] as const;
    for (const claim of claims) {
      const result = run([
        'round',
        'tracking',
        'sync',
        '--repo-root',
        root,
        '--round',
        'R-0042',
        '--reconcile',
        ...claim,
      ]);
      expect(result.code, claim.join(' ')).toBe('TRACKING_RECONCILE_CALLER_AUTHORITY_FORBIDDEN');
    }
  });

  it('refuses an honest reconcile when the repository was never bound', () => {
    const result = run([
      'round',
      'tracking',
      'sync',
      '--repo-root',
      repository(),
      '--round',
      'R-0042',
      '--reconcile',
    ]);
    expect(result.code).toBe('TRACKING_RECONCILE_BINDING_ABSENT');
  });

  it('requires a round, since authority is derived per round and never globally', () => {
    const result = run(['round', 'tracking', 'sync', '--repo-root', repository(), '--reconcile']);
    expect(result.code).toBe('TRACKING_ROUND_REQUIRED');
  });
});

describe('authority-decision recording never disturbs the decision', () => {
  it('writes nothing when authority refuses, because a denied caller has no scope', () => {
    const root = repository();
    // A refused mutating invocation that names a round.
    const result = run(['round', 'close', '--repo-root', root, '--round', 'R-0042']);
    expect(result.ok).toBe(false);
    // No tracking state is created on a denied path.
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });

  it('leaves read actions on their pre-existing hot path, writing nothing', () => {
    const root = repository();
    const result = run(['round', 'tracking', 'status', '--repo-root', root, '--round', 'R-0042']);
    // An unbound repository refuses reads exactly as it did before decision
    // recording existed; the hot path is unchanged.
    expect(result.code).toBe('AUTHORITY_POLICY_MISSING');
    expect(existsSync(join(root, '.devai/state/tracking'))).toBe(false);
  });
});

describe('the interactive path is unchanged', () => {
  it('still demands an explicit role declaration and consent without --reconcile', () => {
    const root = repository();
    expect(run(['round', 'tracking', 'sync', '--repo-root', root, '--round', 'R-0042']).code).toBe(
      'AUTHORITY_DECLARATION_MISSING',
    );
    expect(
      run([
        'round',
        'tracking',
        'sync',
        '--repo-root',
        root,
        '--round',
        'R-0042',
        '--as-role',
        'owner',
      ]).code,
    ).toBe('AUTHORITY_WRITE_CONSENT_REQUIRED');
  });

  it('still demands publish consent for a remote write once write is supplied', () => {
    const root = repository();
    expect(
      run([
        'round',
        'tracking',
        'sync',
        '--repo-root',
        root,
        '--round',
        'R-0042',
        '--as-role',
        'owner',
        '--write',
      ]).code,
    ).toBe('AUTHORITY_PUBLISH_CONSENT_REQUIRED');
  });

  it('keeps activation itself an Owner act that reconcile can never perform', () => {
    const root = repository();
    // --reconcile is not a way to activate: enable has no such path.
    expect(
      run(['round', 'tracking', 'enable', '--repo-root', root, '--round', 'R-0042', '--reconcile'])
        .ok,
    ).toBe(false);
  });
});
