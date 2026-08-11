import { basename, resolve } from 'node:path';
import type { RegistryEntry } from '../define-command.js';

export function readOnlyDevaiChild(
  executable: string,
  args: readonly unknown[],
  entries: readonly RegistryEntry[],
  parentAction: string | undefined,
): boolean {
  if (parentAction !== 'sense run' || basename(executable) !== 'node' || args.length < 2) {
    return false;
  }
  const currentCli = process.argv[1];
  if (
    typeof currentCli !== 'string' ||
    typeof args[0] !== 'string' ||
    resolve(args[0]) !== resolve(currentCli)
  ) {
    return false;
  }
  const childArgs = args.slice(1).map(String);
  if (
    childArgs.some((arg) =>
      [
        '--write',
        '--allow-publish',
        '--publish',
        '--execute',
        '--apply',
        '--as-role',
        '--authority-session',
      ].includes(arg),
    )
  ) {
    return false;
  }
  const action = entries
    .filter(
      (entry) =>
        entry.path.length <= childArgs.length &&
        entry.path.every((part, index) => childArgs[index] === part),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (action?.effects !== 'read') return false;
  const tail = childArgs.slice(action.path.length);
  if (action.handler === 'sense test') {
    return (
      tail.length === 3 &&
      ['unit', 'integration', 'regression', 'e2e', 'all'].includes(tail[0] ?? '') &&
      tail[1] === '--repo-root'
    );
  }
  return tail.length === 2 && tail[0] === '--repo-root';
}
