import { writeFileSync as nodeWriteFileSync } from 'node:fs';

function guarded<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export const writeFileSync = guarded(nodeWriteFileSync) as typeof nodeWriteFileSync;
