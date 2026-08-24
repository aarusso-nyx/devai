import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRegistry, validateActionSurface } from '../../src/define-command.js';
import { buildTrustedAuthoritySources, repositoryIdFor } from '../../src/authority/policy.js';
import { invocationIsNonMutating, ROUTER_INTERNAL_NAMES } from '../../src/command-router.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical action registry constructor', () => {
  it('always constructs the complete 44-action surface without handler registration', () => {
    const first = canonicalRegistry();
    const second = canonicalRegistry();
    expect(first).toHaveLength(44);
    expect(first.map((entry) => entry.name)).toContain('audit observe');
    expect(first.map((entry) => entry.name)).toContain('triage classify');
    expect(second).toEqual(first);
    validateActionSurface(first);
  });

  it('keeps every router-specific internal name bound to a live registry action', () => {
    const internalNames = new Set(canonicalRegistry().map((entry) => entry.internal_name));
    expect(ROUTER_INTERNAL_NAMES.every((name) => internalNames.has(name))).toBe(true);
    const source = readFileSync(join(process.cwd(), 'packages/cli/src/command-router.ts'), 'utf8');
    const referenced = [
      ...source.matchAll(/(?:internalName|internal_name) === '([a-z0-9-]+)'/gu),
    ].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.every((name) => name !== undefined && internalNames.has(name))).toBe(true);
  });

  it('limits non-mutating routing exceptions to live, operation-specific cases', () => {
    expect(invocationIsNonMutating('check', ['--task-plan'])).toBe(true);
    expect(invocationIsNonMutating('round-close', ['--post-merge-receipt'])).toBe(true);
    expect(invocationIsNonMutating('init-bind', [])).toBe(true);
    expect(invocationIsNonMutating('init-bind', ['--write'])).toBe(false);
    expect(invocationIsNonMutating('docs-cli', ['--check'])).toBe(false);
    expect(invocationIsNonMutating('state-prune', [])).toBe(false);
  });

  it('derives identical policy provenance from repeated constructions', () => {
    const root = process.cwd();
    const first = buildTrustedAuthoritySources(canonicalRegistry(), root, '1.1.0-rc.1');
    const second = buildTrustedAuthoritySources(canonicalRegistry(), root, '1.1.0-rc.1');
    expect(second.provenance).toEqual(first.provenance);
  });

  it('keeps the canonical repository identity inside a linked worktree', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-authority-worktree-'));
    temporaryRoots.push(temporaryRoot);
    const repositoryRoot = join(temporaryRoot, 'canonical-repository');
    const linkedWorktree = join(temporaryRoot, 'arbitrary-worktree');
    execFileSync('git', ['init', '--quiet', repositoryRoot]);
    execFileSync(
      'git',
      ['-C', repositoryRoot, 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'init'],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'DEVAI Test',
          GIT_AUTHOR_EMAIL: 'devai-test@example.invalid',
          GIT_COMMITTER_NAME: 'DEVAI Test',
          GIT_COMMITTER_EMAIL: 'devai-test@example.invalid',
        },
      },
    );
    execFileSync('git', ['-C', repositoryRoot, 'worktree', 'add', '--quiet', linkedWorktree]);

    expect(repositoryIdFor(repositoryRoot)).toBe('canonical-repository');
    expect(repositoryIdFor(linkedWorktree)).toBe('canonical-repository');
  });

  it('uses the declared project name across different checkout directory names', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-authority-checkouts-'));
    temporaryRoots.push(temporaryRoot);
    const firstCheckout = join(temporaryRoot, 'developer-checkout');
    const secondCheckout = join(temporaryRoot, 'github-runner-checkout');

    for (const checkout of [firstCheckout, secondCheckout]) {
      mkdirSync(join(checkout, '.devai/config'), { recursive: true });
      writeFileSync(
        join(checkout, '.devai/config/project.json'),
        `${JSON.stringify({ schemaVersion: '1.0.0', project_type: 'runtime-host', name: 'teat' })}\n`,
      );
    }

    expect(repositoryIdFor(firstCheckout)).toBe('teat');
    expect(repositoryIdFor(secondCheckout)).toBe('teat');
  });

  it('retains the directory fallback when the declared project name is unavailable', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-authority-fallback-'));
    temporaryRoots.push(temporaryRoot);
    const repositoryRoot = join(temporaryRoot, 'fallback-repository');
    mkdirSync(join(repositoryRoot, '.devai/config'), { recursive: true });
    writeFileSync(join(repositoryRoot, '.devai/config/project.json'), '{not-json}\n');

    expect(repositoryIdFor(repositoryRoot)).toBe('fallback-repository');
  });
});
