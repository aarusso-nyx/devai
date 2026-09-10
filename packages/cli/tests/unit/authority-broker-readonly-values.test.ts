// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { describe, expect, it } from 'vitest';
import { readOnlyProcess } from '../../src/authority/broker.js';

function request(executable: unknown, args: unknown): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

function allowed(
  executable: unknown,
  args: unknown,
  parent?: string,
  capabilities: readonly string[] = [],
): boolean {
  return readOnlyProcess(request(executable, args), parent, capabilities);
}

describe('authority broker read-only process values', () => {
  it.each([
    [undefined, []],
    ['git', undefined],
    ['git', 'status'],
  ])('rejects malformed process input %j %j', (executable, args) => {
    expect(allowed(executable, args)).toBe(false);
  });

  it('permits only the declared exact Git provenance lookup', () => {
    expect(
      allowed('/usr/bin/git', ['config', '--get', 'remote.origin.url'], undefined, ['proc:git']),
    ).toBe(true);
    expect(allowed('git', ['config', '--get', 'remote.origin.url'])).toBe(false);
    expect(
      allowed('git', ['config', '--get', 'remote.upstream.url'], undefined, ['proc:git']),
    ).toBe(false);
    expect(allowed('git', ['config', '--get'], undefined, ['proc:git'])).toBe(false);
    expect(
      allowed('other', ['config', '--get', 'remote.origin.url'], undefined, ['proc:git']),
    ).toBe(false);
    expect(
      allowed('git', ['config', '--get', 'remote.origin.url', 'extra'], undefined, ['proc:git']),
    ).toBe(false);
    expect(allowed('git', ['other', '--get', 'remote.origin.url'], undefined, ['proc:git'])).toBe(
      false,
    );
    expect(allowed('git', ['config', 'other', 'remote.origin.url'], undefined, ['proc:git'])).toBe(
      false,
    );
  });

  it('permits exact sense lint and rejects altered invocations', () => {
    expect(allowed('/usr/bin/npx', ['eslint', '--format=json', 'src/a.ts'], 'sense run')).toBe(
      true,
    );
    expect(allowed('npx', ['eslint', '--format=json', 'src/a.ts'], 'round run')).toBe(false);
    expect(allowed('npx', ['eslint', '--format=stylish', 'src/a.ts'], 'sense run')).toBe(false);
    expect(allowed('npx', ['eslint', '--format=json'], 'sense run')).toBe(false);
    expect(allowed('other', ['eslint', '--format=json', 'src/a.ts'], 'sense run')).toBe(false);
    expect(allowed('npx', ['eslint', '--format=json', 'src/a.ts', 'extra'], 'sense run')).toBe(
      false,
    );
    expect(allowed('npx', ['other', '--format=json', 'src/a.ts'], 'sense run')).toBe(false);
    expect(allowed('npx', ['eslint', '--format=json', 1], 'sense run')).toBe(false);
  });

  it.each([
    [['tsc', '--noEmit'], true],
    [['tsc', '--noEmit', '-p', 'tsconfig.json'], true],
    [['tsc', '--noEmit', '-p', 'nested/tsconfig.json'], true],
    [['tsc', '--noEmit', '-p', '../tsconfig.json'], false],
    [['tsc', '--noEmit', '-p', '/tmp/tsconfig.json'], false],
    [['tsc', '--noEmit', '-p', 'tsconfig.json', 'extra'], false],
    [['tsc', '--emit'], false],
  ] as const)('classifies exact sense TypeScript argv %j as %s', (args, result) => {
    expect(allowed('npx', args, 'sense run')).toBe(result);
  });

  it.each([
    ['round run', 'npx', ['tsc', '--noEmit']],
    ['sense run', 'other', ['tsc', '--noEmit']],
    ['sense run', 'npx', ['other', '--noEmit']],
  ] as const)('rejects altered TypeScript boundary %s %s %j', (parent, executable, args) => {
    expect(allowed(executable, args, parent)).toBe(false);
  });

  it.each([
    [['-r', 'build'], true],
    [['-r', 'test'], false],
    [['vitest', 'run'], true],
    [['vitest', 'run', '--config', 'tests/config/t1.unit.config.ts'], true],
    [['vitest', 'run', '--config', 'tests/config/t3.integration.config.ts'], true],
    [['vitest', 'run', '--config', 'tests/config/t4.regression.config.ts'], true],
    [['vitest', 'run', '--config', 'tests/config/t5.e2e.config.ts'], true],
    [['vitest', 'run', '--config', 'tests/config/unbound.config.ts'], false],
  ] as const)('classifies exact sense pnpm argv %j as %s', (args, result) => {
    expect(allowed('/opt/pnpm', args, 'sense run')).toBe(result);
  });

  it.each([
    ['round run', 'pnpm', ['-r', 'build']],
    ['sense run', 'other', ['-r', 'build']],
    ['sense run', 'pnpm', ['other', 'build']],
    ['sense run', 'pnpm', ['-r', 'build', 'extra']],
    ['round run', 'pnpm', ['vitest', 'run']],
    ['sense run', 'other', ['vitest', 'run']],
    ['sense run', 'pnpm', ['other', 'run']],
    ['sense run', 'pnpm', ['vitest', 'other']],
    ['sense run', 'pnpm', ['vitest', 'run', '--config', 'tests/config/t1.unit.config.ts', 'extra']],
  ] as const)('rejects altered pnpm boundary %s %s %j', (parent, executable, args) => {
    expect(allowed(executable, args, parent)).toBe(false);
  });

  it.each([
    ['true', [], true],
    ['/usr/bin/false', [], true],
    ['true', ['extra'], false],
    ['node', ['-e', 'process.exit(0)'], true],
    ['/usr/bin/node', ['-e', 'process.exit(1);'], true],
    ['node', ['-e', ' process.exit(0)'], false],
    ['node', ['-e', 'process.exit(0); trailing'], false],
    ['node', ['-e', 'process.exit(2)'], false],
    ['other', ['-e', 'process.exit(0)'], false],
    ['node', ['-e', 'process.exit(0)', 'extra'], false],
    ['node', ['other', 'process.exit(0)'], false],
    ['tool', ['--version'], true],
    ['tool', ['--help'], true],
    ['tool', ['--help', 'extra'], false],
  ] as const)('classifies generic probe %s %j as %s', (executable, args, result) => {
    expect(allowed(executable, args)).toBe(result);
  });

  it('permits only exact package audit forms', () => {
    expect(allowed('pnpm', ['audit', '--json'])).toBe(true);
    expect(allowed('pnpm', ['audit'])).toBe(false);
    expect(allowed('other', ['audit', '--json'])).toBe(false);
    expect(allowed('pnpm', ['audit', '--json', 'extra'])).toBe(false);
    expect(allowed('pnpm', ['other', '--json'])).toBe(false);
    expect(allowed('pnpm', ['audit', 'other'])).toBe(false);
    expect(allowed('npm', ['audit', '--json', '--package-lock-only'])).toBe(true);
    expect(allowed('npm', ['audit', '--json'])).toBe(false);
    expect(allowed('npm', ['audit', '--package-lock-only', '--json'])).toBe(false);
    expect(allowed('other', ['audit', '--json', '--package-lock-only'])).toBe(false);
    expect(allowed('npm', ['audit', '--json', '--package-lock-only', 'extra'])).toBe(false);
    expect(allowed('npm', ['other', '--json', '--package-lock-only'])).toBe(false);
    expect(allowed('npm', ['audit', 'other', '--package-lock-only'])).toBe(false);
    expect(allowed('npm', ['audit', '--json', 'other'])).toBe(false);
  });

  it('permits only exact shell command-discovery probes', () => {
    expect(allowed('sh', ['-lc', 'command -v claude'])).toBe(true);
    expect(allowed('sh', ['-lc', 'command -v codex'])).toBe(true);
    expect(allowed('sh', ['-lc', ' command -v claude'])).toBe(false);
    expect(allowed('sh', ['-lc', 'command -v claude; true'])).toBe(false);
    expect(allowed('bash', ['-lc', 'command -v claude'])).toBe(false);
    expect(allowed('sh', ['other', 'command -v claude'])).toBe(false);
    expect(allowed('sh', ['-lc', 1])).toBe(false);
  });

  it.each([
    ['command', ['-v'], true],
    ['docker', ['version'], true],
    ['docker', ['run'], false],
    ['gh', ['auth'], true],
    ['git', ['status'], true],
    ['git', ['push'], false],
    ['which', ['mmdc'], true],
    ['which', ['node'], false],
  ] as const)('classifies the allowlisted command %s %j as %s', (executable, args, result) => {
    expect(allowed(executable, args)).toBe(result);
  });
});
