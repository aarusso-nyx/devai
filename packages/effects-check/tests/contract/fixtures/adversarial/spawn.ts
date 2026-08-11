import { spawnSync } from 'node:child_process';

declare function defineCommand(input: { name: string; run: () => void }): unknown;

export const command = defineCommand({
  name: 'fixture spawn',
  run: () => {
    spawnSync('git', ['status', '--short']);
  },
});
