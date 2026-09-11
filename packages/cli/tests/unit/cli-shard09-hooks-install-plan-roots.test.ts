import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_NAMES, buildHooksInstallPlan } from '../../src/services/hooks-install/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-hooks-plan-roots-'));
  roots.push(path);
  return path;
}

function put(root: string, path: string, value: string): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

describe('CLI shard 09 hooks install plan and repository roots', () => {
  it('publishes every hook and renders exact default commands', () => {
    expect(HOOK_NAMES).toEqual(['pre-commit', 'pre-push', 'post-merge']);

    const root = fixtureRoot();
    mkdirSync(join(root, '.git/hooks'), { recursive: true });
    const defaultPlan = buildHooksInstallPlan({ targetRoot: root });
    const commitPlan = buildHooksInstallPlan({ targetRoot: root, hook: 'pre-commit' });

    expect(defaultPlan.hook).toBe('pre-push');
    expect(defaultPlan.command).toContain('devai_remote_sha');
    expect(commitPlan.command).toBe(
      './node_modules/.bin/devai check --only forbidden-actions --strict',
    );
  });

  it('preserves exact append separators and optional version fields', () => {
    const root = fixtureRoot();
    mkdirSync(join(root, '.git/hooks'), { recursive: true });

    put(root, '.git/hooks/pre-push', 'legacy-with-newline\n');
    const newline = buildHooksInstallPlan({ targetRoot: root, hook: 'pre-push' });
    expect(newline.action).toBe('append');
    expect(newline.content).toBe(
      'legacy-with-newline\n\n# >>> devai hooks install >>>\n' +
        `${newline.command}\n# <<< devai hooks install <<<\n`,
    );
    expect(newline).not.toHaveProperty('devaiVersion');

    put(root, '.git/hooks/pre-push', 'legacy-without-newline');
    const versionedAppend = buildHooksInstallPlan({
      targetRoot: root,
      hook: 'pre-push',
      devaiVersion: '1.2.3',
    });
    expect(versionedAppend.content).toBe(
      'legacy-without-newline\n\n# >>> devai hooks install >>>\n' +
        `${versionedAppend.command}\n# <<< devai hooks install <<<\n`,
    );
    expect(versionedAppend).toHaveProperty('devaiVersion', '1.2.3');

    put(
      root,
      '.git/hooks/pre-push',
      '# >>> devai hooks install >>>\nold\n# <<< devai hooks install <<<\n',
    );
    const unversionedUpdate = buildHooksInstallPlan({
      targetRoot: root,
      hook: 'pre-push',
      command: 'new',
    });
    expect(unversionedUpdate.action).toBe('update');
    expect(unversionedUpdate).not.toHaveProperty('devaiVersion');

    const versionedUpdate = buildHooksInstallPlan({
      targetRoot: root,
      hook: 'pre-push',
      command: 'new',
      devaiVersion: '2.0.0-rc.1',
    });
    expect(versionedUpdate).toHaveProperty('devaiVersion', '2.0.0-rc.1');
  });

  it('accepts only a complete anchored Git admin pointer to a directory', () => {
    for (const [name, pointer, prepare, expectedRoot] of [
      ['valid-no-space', 'gitdir:../admin', 'directory', '../admin'],
      ['invalid-prefix', 'junk gitdir: ../admin', 'directory', '.git'],
      ['invalid-extra-line', 'gitdir: ../admin\njunk', 'directory', '.git'],
      ['missing-target', 'gitdir: ../missing', 'none', '.git'],
      ['file-target', 'gitdir: ../admin-file', 'file', '.git'],
    ] as const) {
      const container = fixtureRoot();
      const root = join(container, name);
      mkdirSync(root);
      writeFileSync(join(root, '.git'), pointer);
      if (prepare === 'directory') mkdirSync(join(container, 'admin'), { recursive: true });
      if (prepare === 'file') writeFileSync(join(container, 'admin-file'), 'not a directory');

      expect(buildHooksInstallPlan({ targetRoot: root }).path, name).toBe(
        join(root, expectedRoot, 'hooks/pre-push'),
      );
    }
  });

  it('uses a trimmed nonempty Git common directory and otherwise the admin directory', () => {
    const container = fixtureRoot();
    const common = join(container, 'common');
    mkdirSync(join(common, 'hooks'), { recursive: true });

    const linked = join(container, 'linked');
    mkdirSync(join(linked, '.git'), { recursive: true });
    writeFileSync(join(linked, '.git/commondir'), '../../common\n');
    expect(buildHooksInstallPlan({ targetRoot: linked }).path).toBe(join(common, 'hooks/pre-push'));

    const ordinary = join(container, 'ordinary');
    mkdirSync(join(ordinary, '.git/hooks'), { recursive: true });
    writeFileSync(join(ordinary, '.git/commondir'), '  \n');
    expect(buildHooksInstallPlan({ targetRoot: ordinary }).path).toBe(
      join(ordinary, '.git/hooks/pre-push'),
    );
  });
});
