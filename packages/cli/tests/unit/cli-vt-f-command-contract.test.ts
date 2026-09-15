// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
import type { CAC } from 'cac';
import { describe, expect, it } from 'vitest';
import { verifyTranslation } from '../../src/commands/verify/translation.js';

describe('verify translation shard F command contract', () => {
  it('exposes the exact report-only lifecycle metadata', () => {
    expect(verifyTranslation).toMatchObject({
      name: 'verify translation',
      description: 'Independently validate an untrusted translation witness (report-only)',
      authority: 'sensor',
      lifecycle: 'experimental',
      lifecycle_reason: 'Report-only validation that cannot promote readiness.',
      promotion_criteria: [],
    });
  });

  it('registers the exact command and four supported options', () => {
    const registrations: Array<readonly [string, string]> = [];
    const options: Array<readonly [string, string]> = [];
    let action: unknown;
    const command = {
      option(flags: string, description: string) {
        options.push([flags, description]);
        return command;
      },
      action(callback: unknown) {
        action = callback;
        return command;
      },
    };
    const cli = {
      command(name: string, description: string) {
        registrations.push([name, description]);
        return command;
      },
    };

    verifyTranslation.register(cli as unknown as CAC);

    expect(registrations).toEqual([
      ['verify-translation', 'Independently validate an untrusted translation witness'],
    ]);
    expect(options).toEqual([
      ['--witness <path>', 'Translation witness JSON'],
      ['--repo-root <path>', 'Repository root (default: current directory)'],
      ['--database-url <url>', 'Postgres administrative URL for per-validation isolation'],
      ['--human', 'Emit a human-readable summary instead of JSON'],
    ]);
    expect(action).toBeTypeOf('function');
  });
});
