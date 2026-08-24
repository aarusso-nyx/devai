import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;

export interface ResolvedTaskExecutable {
  readonly path: string;
  readonly sha256: string;
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
