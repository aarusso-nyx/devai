import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, resolve } from 'node:path';

/** Host-owned physical Git identity; declarations cannot supply an executable. */
export function nativeCoverageGitIdentity(): Readonly<{ path: string; sha256: string }> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const path = realpathSync(resolve(directory, 'git'));
      accessSync(path, constants.X_OK);
      if (!lstatSync(path).isFile()) continue;
      return Object.freeze({
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    } catch {
      /* An unavailable search entry grants no identity. */
    }
  }
  throw new Error('NATIVE_COVERAGE_ADAPTER_GIT_EXECUTABLE_MISSING');
}
