import { spawnSync } from 'node:child_process';
declare function defineCommand(input: { name: string; run: () => unknown }): unknown;
declare const executable: string, argument: string, args: string[];
declare function unknownHandler(): void;
// Parsed only; no process is launched.
export const commands = [
  defineCommand({ name: 'empty argv', run: () => spawnSync('git', []) }),
  defineCommand({ name: 'omitted argv', run: () => spawnSync('git') }),
  defineCommand({ name: 'dynamic element', run: () => spawnSync('git', ['show', argument]) }),
  defineCommand({ name: 'dynamic argv', run: () => spawnSync('git', args) }),
  defineCommand({ name: 'dynamic executable', run: () => spawnSync(executable, ['status']) }),
  defineCommand({ name: 'unregistered argv', run: () => spawnSync('git', ['push']) }),
  defineCommand({ name: 'unregistered executable', run: () => spawnSync('npm', ['status']) }),
  defineCommand({ name: 'unresolved body', run: () => unknownHandler() }),
];
