import { AsyncLocalStorage } from 'node:async_hooks';

const activeMember = new AsyncLocalStorage<string>();

/** Internal execution context: the resolver supplies this, never sensor input or argv. */
export function runWithResolvedSensorMember<T>(kind: string, execute: () => T): T {
  return activeMember.run(kind, execute);
}

export function resolvedSensorMember(): string | undefined {
  return activeMember.getStore();
}
