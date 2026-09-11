import { describe, expect, it } from 'vitest';

describe('define-command runtime contract boundaries', () => {
  it('attaches exact arguments and public options for every effect class', async () => {
    const { attachRuntimeContracts, canonicalRegistry, defineCommand, getFullRegistry } =
      await import('../../src/define-command.js?cli-shard09-runtime-contracts');
    const canonical = canonicalRegistry();

    for (const entry of canonical) {
      defineCommand({
        name: entry.handler,
        description: entry.description,
        authority: entry.authority,
        lifecycle: entry.lifecycle,
        lifecycle_reason: entry.lifecycle_reason,
        promotion_criteria: entry.promotion_criteria,
        register: () => undefined,
      });
    }

    attachRuntimeContracts(
      canonical.map((entry, index) => ({
        name: entry.internal_name,
        rawName: `${entry.internal_name} <subject-${index}>`,
        options: [
          ...(index % 2 === 0 ? [{ rawName: '--human', description: 'human alias' }] : []),
          { rawName: '--execute', description: 'execute alias' },
          { rawName: '--apply', description: 'apply alias' },
          { rawName: '--write', description: 'write authorization' },
          {
            rawName: `--keep-${index} <value>`,
            description: `${process.cwd()} --execute --apply --human`,
          },
        ],
      })),
    );

    const attached = getFullRegistry();
    expect(new Set(attached.map((entry) => entry.effects))).toEqual(
      new Set(['read', 'harness-write', 'local-write', 'remote-write']),
    );
    for (const [index, entry] of attached.entries()) {
      const expected = [
        {
          flags: `--keep-${index} <value>`,
          description: '<repo-root> --write --write --format human',
        },
        ...(entry.effects === 'read'
          ? []
          : [
              {
                flags: '--as-role <role>',
                description: 'Declare the initiating human role for this invocation.',
              },
              {
                flags: '--authority-session <id>',
                description: 'Use a live repository-bound authority session instead of --as-role.',
              },
              { flags: '--write', description: 'Authorize local mutation.' },
            ]),
        ...(entry.effects === 'remote-write'
          ? [
              {
                flags: '--publish',
                description: 'Authorize remote publication in addition to --write.',
              },
            ]
          : []),
        {
          flags: '--format <format>',
          description: 'Output format when supported: json or human.',
        },
      ];

      expect(entry.runtime_args, entry.name).toBe(`<subject-${index}>`);
      expect(entry.runtime_supports_human, entry.name).toBe(index % 2 === 0);
      expect(entry.runtime_options, entry.name).toEqual(expected);
    }
  });
});
