import { describe, expect, it } from 'vitest';
import { readOnlyDevaiChild } from '../../src/authority/sense-run-child.js';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';

const entries = canonicalRegistry();
const canonicalSenseRun = entries.find((candidate) => candidate.handler === 'sense run');
if (canonicalSenseRun === undefined) throw new Error('MISSING_REGISTRY_ENTRY:sense run');
const readAction = {
  ...canonicalSenseRun,
  name: 'sense test',
  handler: 'sense test',
  internal_name: 'sense-test',
  path: ['sense', 'test'],
  effects: 'read',
} satisfies RegistryEntry;
const cliPath = '/tmp/devai-cli.js';

function childArgs(...args: readonly string[]): readonly string[] {
  return [cliPath, ...args];
}

describe('readOnlyDevaiChild authority boundary', () => {
  it('accepts only a read-only child with the exact current CLI identity and repository tail', () => {
    const previous = process.argv;
    process.argv = [...previous];
    process.argv[1] = cliPath;
    try {
      expect(readAction.effects).toBe('read');
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'test', 'unit', '--repo-root', '/tmp/repo'),
          [readAction],
          'sense run',
        ),
      ).toBe(true);
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'test', 'unit', '--repo-root'),
          [readAction],
          'sense run',
        ),
      ).toBe(false);
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'test', 'unit', '--repo-root', '/tmp/repo', '--extra'),
          [readAction],
          'sense run',
        ),
      ).toBe(false);
    } finally {
      process.argv = previous;
    }
  });

  it('rejects executable, parent-action, arity, and CLI-identity mismatches before action lookup', () => {
    const previous = process.argv;
    process.argv = [...previous];
    process.argv[1] = cliPath;
    try {
      const valid = childArgs('sense', 'test', 'unit', '--repo-root', '/tmp/repo');
      const cases: readonly [
        string,
        string,
        readonly unknown[],
        readonly RegistryEntry[],
        string | undefined,
      ][] = [
        ['wrong executable', '/usr/local/bin/nodejs', valid, [readAction], 'sense run'],
        ['wrong parent action', '/usr/local/bin/node', valid, [readAction], undefined],
        ['too few arguments', '/usr/local/bin/node', [cliPath], [readAction], 'sense run'],
        [
          'wrong CLI path',
          '/usr/local/bin/node',
          ['/tmp/other-cli.js', ...valid.slice(1)],
          [readAction],
          'sense run',
        ],
        [
          'non-string CLI argument',
          '/usr/local/bin/node',
          [42, ...valid.slice(1)],
          [readAction],
          'sense run',
        ],
      ];
      for (const [label, executable, args, registry, parentAction] of cases) {
        expect(readOnlyDevaiChild(executable, args, registry, parentAction), label).toBe(false);
      }
    } finally {
      process.argv = previous;
    }
  });

  it('rejects every write, publish, execution, role, and authority-session flag', () => {
    const previous = process.argv;
    process.argv = [...previous];
    process.argv[1] = cliPath;
    try {
      for (const forbidden of [
        '--write',
        '--allow-publish',
        '--publish',
        '--execute',
        '--apply',
        '--as-role',
        '--authority-session',
      ]) {
        expect(
          readOnlyDevaiChild(
            '/usr/local/bin/node',
            childArgs('sense', 'test', 'unit', '--repo-root', forbidden),
            [readAction],
            'sense run',
          ),
          forbidden,
        ).toBe(false);
      }
    } finally {
      process.argv = previous;
    }
  });

  it('accepts each supported sense test mode and rejects unsupported modes or malformed tails', () => {
    const previous = process.argv;
    process.argv = [...previous];
    process.argv[1] = cliPath;
    try {
      for (const mode of ['unit', 'integration', 'regression', 'e2e', 'all']) {
        expect(
          readOnlyDevaiChild(
            '/usr/local/bin/node',
            childArgs('sense', 'test', mode, '--repo-root', '/tmp/repo'),
            [readAction],
            'sense run',
          ),
          mode,
        ).toBe(true);
      }
      for (const args of [
        childArgs('sense', 'test', 'smoke', '--repo-root', '/tmp/repo'),
        childArgs('sense', 'test', 'unit', '--workspace', '/tmp/repo'),
        childArgs('sense', 'test', 'unit', '--repo-root'),
      ]) {
        expect(readOnlyDevaiChild('/usr/local/bin/node', args, [readAction], 'sense run')).toBe(
          false,
        );
      }
    } finally {
      process.argv = previous;
    }
  });

  it('requires a matching read action and rejects write-effect or prefix-confusable entries', () => {
    const previous = process.argv;
    process.argv = [...previous];
    process.argv[1] = cliPath;
    try {
      const prefixWrite = {
        ...readAction,
        path: ['sense'],
        effects: 'local-write',
      } satisfies RegistryEntry;
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'test', 'unit', '--repo-root', '/tmp/repo'),
          [prefixWrite, readAction],
          'sense run',
        ),
      ).toBe(true);
      const writeAction = canonicalSenseRun;
      expect(writeAction.effects).not.toBe('read');
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'run', '--repo-root', '/tmp/repo'),
          [writeAction],
          'sense run',
        ),
      ).toBe(false);
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'testing', 'unit', '--repo-root', '/tmp/repo'),
          [readAction],
          'sense run',
        ),
      ).toBe(false);
      expect(
        readOnlyDevaiChild(
          '/usr/local/bin/node',
          childArgs('sense', 'test', 'unit', '--repo-root', '/tmp/repo'),
          [readAction],
          'sense run',
        ),
      ).toBe(true);
    } finally {
      process.argv = previous;
    }
  });
});
