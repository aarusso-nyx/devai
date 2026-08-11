import { spawnSync } from '@devai-nyx/authority';

/**
 * Shared `gh` CLI wrapper for Phase 28 harness sensors that need
 * GitHub Actions runtime data (28.G performance, 28.H robustness).
 * Implements the graceful-degradation contract from Phase 26.K's
 * harness_green_main: when `gh` is unavailable or auth fails, the
 * caller surfaces status='unknown' with an explicit reason code
 * rather than asserting a verdict it can't justify.
 */

export type GhResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

export interface GhInvokeOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export function invokeGhJson<T = unknown>(opts: GhInvokeOptions): GhResult<T> {
  const result = spawnSync('gh', [...opts.args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, reason: 'gh-cli-unavailable' };
    return { ok: false, reason: `gh-cli-error: ${err.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 256).trim();
    return { ok: false, reason: `gh-cli-nonzero-exit: ${stderr}` };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch (e) {
    return {
      ok: false,
      reason: `gh-cli-parse-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
