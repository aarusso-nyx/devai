import type { CAC } from 'cac';
import { defineCommand } from '../../define-command.js';

export const mutationRun = defineCommand({
  name: 'mutation run',
  description: 'Deprecated: mutation testing moved to bedel.',
  authority: 'sensor',
  register(cli: CAC): void {
    cli.command('mutation-run', 'Deprecated: use bedel').action(() => {
      process.stdout.write(
        JSON.stringify({
          status: 'not-required',
          code: 'MUTATION_OFFLOADED_TO_BEDEL',
          message: 'Mutation testing moved to bedel (https://github.com/aarusso-nyx/bedel).',
        }) + '\n',
      );
    });
  },
});
