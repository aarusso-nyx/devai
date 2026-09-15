// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { cac } from 'cac';
import { describe, expect, it } from 'vitest';
import { attachAuthorityCommandBoundaries } from '../../src/authority/index.js';
import { canonicalRegistry } from '../../src/define-command.js';

describe('public authority command options', () => {
  it('adds exact declaration options only to commands that can write', () => {
    const entries = canonicalRegistry();
    const read = entries.find((entry) => entry.name === 'catalog actions');
    const write = entries.find((entry) => entry.name === 'round plan');
    if (read === undefined || write === undefined)
      throw new Error('authority fixture action missing');

    const cli = cac('devai-authority-options');
    cli.command(read.internal_name).action(() => undefined);
    cli.command(write.internal_name).action(() => undefined);
    attachAuthorityCommandBoundaries(cli.commands, [read, write]);

    const options = (commandName: string) => {
      const command = cli.commands.find((candidate) => candidate.name === commandName);
      if (command === undefined) throw new Error(`registered command missing: ${commandName}`);
      return command.options.map(({ rawName, description }) => ({ rawName, description }));
    };

    expect(options(read.internal_name)).toEqual([]);
    expect(options(write.internal_name)).toEqual([
      {
        rawName: '--as-role <role>',
        description: 'Declare the initiating human role.',
      },
      {
        rawName: '--authority-session <id>',
        description: 'Use a live repository-bound authority session instead of --as-role.',
      },
    ]);
  });
});
