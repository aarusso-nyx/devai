import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const root = resolve('.');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-hook espaço-'));
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'Hook test');
  git('config', 'user.email', 'hook@example.invalid');
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(cwd, 'eslint.config.mjs'),
    "export default [{files:['**/*.js'],rules:{semi:['error','always'],'no-unused-vars':'error'}}];\n",
  );
  writeFileSync(join(cwd, 'code.js'), 'export const initial = 1;\n');
  writeFileSync(join(cwd, 'other.txt'), 'unchanged\n');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  const run = () =>
    spawnSync(process.execPath, [join(root, 'scripts/check-change-hygiene.mjs')], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` },
    });
  return { cwd, git, run };
}
describe('commit automatic fixes', () => {
  it('fixes and stages intended files while leaving unrelated edits untouched', () => {
    const f = fixture();
    writeFileSync(join(f.cwd, 'code.js'), 'export const changed=2\n');
    f.git('add', 'code.js');
    writeFileSync(join(f.cwd, 'other.txt'), 'unstaged secret-free note\n');
    const beforeOtherIndex = f.git('show', ':other.txt');
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git('show', ':code.js')).toBe('export const changed = 2;\n');
    expect(readFileSync(join(f.cwd, 'other.txt'), 'utf8')).toBe('unstaged secret-free note\n');
    expect(f.git('show', ':other.txt')).toBe(beforeOtherIndex);
  });
  it('does not stage an unstaged hunk in a partially staged file', () => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, 'code.js'),
      'export const changed=2\n\n// stable separator\n\nexport const tail = 3;\n',
    );
    f.git('add', 'code.js');
    writeFileSync(
      join(f.cwd, 'code.js'),
      'export const changed=2\n\n// stable separator\n\nexport const tail = 4;\n',
    );
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git('show', ':code.js')).toContain('tail = 3;');
    expect(readFileSync(join(f.cwd, 'code.js'), 'utf8')).toContain('tail = 4;');
  });
  it('blocks remaining errors and restores both index and working bytes', () => {
    const f = fixture();
    writeFileSync(join(f.cwd, 'code.js'), 'const unused=2\n');
    f.git('add', 'code.js');
    const before = f.git('diff', '--cached', '--binary');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(f.git('diff', '--cached', '--binary')).toBe(before);
    expect(readFileSync(join(f.cwd, 'code.js'), 'utf8')).toBe('const unused=2\n');
  });
  it('handles renamed and deleted files with space and non-ASCII paths', () => {
    const f = fixture();
    f.git('mv', 'code.js', 'espaço não-ASCII.js');
    f.git('rm', 'other.txt');
    writeFileSync(join(f.cwd, 'espaço não-ASCII.js'), 'export const renamed=3\n');
    f.git('add', 'espaço não-ASCII.js');
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git('show', ':espaço não-ASCII.js')).toBe('export const renamed = 3;\n');
    expect(f.git('diff', '--cached', '--name-only')).toContain('other.txt');
  });
  it('accepts no staged changes without staging worktree changes', () => {
    const f = fixture();
    writeFileSync(join(f.cwd, 'code.js'), 'export const untouched=3\n');
    expect(f.run().status).toBe(0);
    expect(f.git('diff', '--cached')).toBe('');
    expect(readFileSync(join(f.cwd, 'code.js'), 'utf8')).toBe('export const untouched=3\n');
  });
  it('blocks conflicting restoration and preserves recoverable original bytes', () => {
    const f = fixture();
    const staged =
      'export const changed={a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:10,k:11,l:12,m:13}\n';
    const unstaged = staged.replace('a:1', 'a:100');
    writeFileSync(join(f.cwd, 'code.js'), staged);
    f.git('add', 'code.js');
    writeFileSync(join(f.cwd, 'code.js'), unstaged);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(f.git('show', ':code.js')).toBe(staged);
    expect(readFileSync(join(f.cwd, 'code.js'), 'utf8')).toBe(unstaged);
  });
});
