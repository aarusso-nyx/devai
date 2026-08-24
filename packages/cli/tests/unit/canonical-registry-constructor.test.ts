import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRegistry, validateActionSurface } from '../../src/define-command.js';
import { buildTrustedAuthoritySources, repositoryIdFor } from '../../src/authority/policy.js';
import {
  invocationIsNonMutating,
  routeArgv,
  ROUTER_INTERNAL_NAMES,
} from '../../src/command-router.js';

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

  it('suggests only commands with a meaningful edit-distance relationship', () => {
    const registry = canonicalRegistry();
    const unrelated = routeArgv(['node', 'devai', 'nosuchcommand'], registry, '1.2.8');
    const typo = routeArgv(['node', 'devai', 'doctr'], registry, '1.2.8');
    expect(unrelated).toMatchObject({ kind: 'output', exitCode: 2 });
    expect(unrelated.kind === 'output' ? unrelated.text : '').toContain('Run devai --help.');
    expect(unrelated.kind === 'output' ? unrelated.text : '').not.toContain('Did you mean');
    expect(typo.kind === 'output' ? typo.text : '').toContain("Did you mean 'devai doctor'?");
  });

  it('rejects option-only positional arguments before dispatch and suggests check spellings', () => {
    const registry = canonicalRegistry();
    const root = mkdtempSync(join(tmpdir(), 'devai-check-positionals-'));
    temporaryRoots.push(root);

    const positional = routeArgv(
      ['node', 'devai', 'check', 'schemas', '--repo-root', root, '--format', 'json'],
      registry,
      '1.2.10',
    );
    expect(positional).toMatchObject({ kind: 'output', exitCode: 2 });
    const positionalError = JSON.parse(
      positional.kind === 'output' ? positional.text : '{}',
    ) as Record<string, unknown>;
    expect(positionalError).toMatchObject({
      code: 'CHECK_SELECTION_INVALID',
      message: 'Check selection is invalid: unexpected argument "schemas".',
      remediation: 'Use --only schemas to run one member, or --suite <name> for a suite.',
      context: { argument: 'schemas', known_member: true },
    });
    expect(existsSync(join(root, '.devai/state'))).toBe(false);

    const valid = routeArgv(
      ['node', 'devai', 'check', '--only', 'schemas', '--repo-root', process.cwd()],
      registry,
      '1.2.10',
    );
    expect(valid.kind).toBe('dispatch');

    const typo = routeArgv(
      [
        'node',
        'devai',
        'check',
        '--only',
        'schemsa',
        '--repo-root',
        process.cwd(),
        '--format',
        'json',
      ],
      registry,
      '1.2.10',
    );
    expect(typo).toMatchObject({ kind: 'output', exitCode: 2 });
    expect(JSON.parse(typo.kind === 'output' ? typo.text : '{}')).toMatchObject({
      code: 'CHECK_MEMBER_UNKNOWN',
      context: { member: 'schemsa', suggestions: expect.arrayContaining(['schemas']) },
    });
    expect(typo.kind === 'output' ? typo.text : '').toContain('--only schemas');

    for (const argv of [
      ['node', 'devai', 'round', 'gap', 'show', 'RGR-0001'],
      ['node', 'devai', 'round', 'gap', 'resolve', 'RGR-0001'],
      ['node', 'devai', 'evidence', 'redact', '42'],
    ]) {
      expect(routeArgv(argv, registry, '1.2.11').kind).toBe('dispatch');
    }

    for (const argv of [
      ['node', 'devai', 'doctor', 'unexpected', '--format', 'json'],
      ['node', 'devai', 'catalog', 'actions', 'unexpected', '--format', 'json'],
    ]) {
      const result = routeArgv(argv, registry, '1.2.10');
      expect(result).toMatchObject({ kind: 'output', exitCode: 2 });
      expect(result.kind === 'output' ? result.text : '').toContain('ROUTE_UNEXPECTED_ARGUMENT');
    }
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
