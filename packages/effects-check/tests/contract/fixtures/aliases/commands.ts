import { writeFileSync as save, readFileSync as read } from 'node:fs';
import { exec as launchShell, execFileSync as launchFile } from 'node:child_process';
declare function defineCommand(input: { name: string; run: () => unknown }): unknown;
function writeFileSync() {
  return 'ordinary local function';
}
function exec() {
  return 'ordinary local function';
}

// Parsed only; neither host writes nor subprocesses are executed.
export const commands = [
  defineCommand({ name: 'aliased write', run: () => save('target', 'data') }),
  defineCommand({ name: 'aliased read', run: () => read('target') }),
  defineCommand({ name: 'aliased shell', run: () => launchShell('git') }),
  defineCommand({ name: 'aliased process', run: () => launchFile('git', ['status']) }),
  defineCommand({
    name: 'local names',
    run: () => {
      writeFileSync();
      exec();
    },
  }),
];
