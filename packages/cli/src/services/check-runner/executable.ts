import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;

export interface ResolvedTaskExecutable {
  readonly path: string;
  readonly sha256: string;
}

export function executableToolchainKey(executable: string): string {
  return `executable:${executable}`;
}

export function encodeTaskExecutable(identity: ResolvedTaskExecutable): string {
  return JSON.stringify({ path: identity.path, sha256: identity.sha256 });
}

export function taskExecutableFromToolchain(
  toolchain: Readonly<Record<string, string>>,
  executable: string,
): ResolvedTaskExecutable | undefined {
  const encoded = toolchain[executableToolchainKey(executable)];
  if (encoded === undefined) return undefined;
  try {
    const parsed = JSON.parse(encoded) as Readonly<Record<string, unknown>>;
    if (
      typeof parsed.path !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(String(parsed.sha256)) ||
      JSON.stringify({ path: parsed.path, sha256: parsed.sha256 }) !== encoded
    ) {
      throw new Error('invalid identity');
    }
    return { path: parsed.path, sha256: String(parsed.sha256) };
  } catch {
    throw new Error(`CHECK_RUNNER_TOOLCHAIN_INVALID: executable:${executable}`);
  }
}

export function resolveTaskExecutable(
  repoRoot: string,
  executable: string,
  pathValue: string | undefined = process.env.PATH,
): ResolvedTaskExecutable {
  if (!BARE_EXECUTABLE.test(executable)) {
    throw new Error(`CHECK_RUNNER_DESCRIPTOR: executable must be a bare command: ${executable}`);
  }
  const candidates = [
    join(resolve(repoRoot), 'node_modules', '.bin', executable),
    ...(pathValue ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, executable)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const path = realpathSync(candidate);
      accessSync(path, constants.X_OK);
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      return { path, sha256 };
    } catch {
      // Continue when an unreadable or broken PATH entry precedes a usable executable.
    }
  }
  throw new Error(`CHECK_RUNNER_EXECUTABLE_MISSING: ${executable}`);
}
