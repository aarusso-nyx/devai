import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRegistry, validateActionSurface } from '../../src/define-command.js';
import { buildTrustedAuthoritySources, repositoryIdFor } from '../../src/authority/policy.js';

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
