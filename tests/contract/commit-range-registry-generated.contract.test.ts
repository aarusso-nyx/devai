import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const checker = join(root, 'scripts/check-commit-range.mjs');
const generator = join(root, 'scripts/generate-action-registry.mjs');
const source = 'law/policy/action-registry.json';
const outputs = [
  'packages/cli/src/generated/action-registry.ts',
  'packages/effects-check/src/generated/action-catalog.ts',
  'packages/sensors/src/generated/action-kinds.ts',
] as const;
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(baseGenerator = readFileSync(generator)) {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-registry-range-'));
  roots.push(cwd);
  const git = (args: string[], role = 'Architect') =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: `DEVAI ${role}`,
        GIT_AUTHOR_EMAIL: `${role.toLowerCase()}@devai.local`,
        GIT_COMMITTER_NAME: `DEVAI ${role}`,
        GIT_COMMITTER_EMAIL: `${role.toLowerCase()}@devai.local`,
      },
    }).trim();
  const put = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), bytes);
  };
  git(['init', '--quiet', '--initial-branch=main']);
  for (const path of [
    'law/policy/commit-grammar.json',
    'law/policy/change-taxonomy.json',
    '.devai/config/change-taxonomy-binding.json',
    'scripts/generate-action-registry.mjs',
    source,
    ...outputs,
  ])
    put(
      path,
      path === 'scripts/generate-action-registry.mjs'
        ? baseGenerator
        : readFileSync(join(root, path)),
    );
  git(['add', '-A']);
  git(['commit', '--no-verify', '-qm', 'law: seed fixture']);
  const base = git(['rev-parse', 'HEAD']);
  const generate = () =>
    execFileSync(process.execPath, [generator, cwd], { cwd: root, stdio: 'pipe' });
  const changeRegistry = () => {
    const data = JSON.parse(readFileSync(join(cwd, source), 'utf8'));
    data.entries[0].description += ' Reviewed fixture change.';
    put(source, `${JSON.stringify(data, null, 2)}\n`);
    generate();
  };
  const commit = (role = 'Architect') => {
    git(['add', '-A']);
    git(['commit', '--no-verify', '-qm', 'law: change registry'], role);
    return git(['rev-parse', 'HEAD']);
  };
  const check = (sha: string, program = checker, extraEnv: NodeJS.ProcessEnv = {}) => {
    try {
      const out = execFileSync(process.execPath, [program, base, sha], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...extraEnv },
      });
      return { status: 0, output: out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  return { cwd, git, put, base, generate, changeRegistry, commit, check };
}

describe('registry generated provenance in actual commit ranges', () => {
  it('admits Architect only for real generator bytes with the registry in the same commit, even when a view is unchanged', () => {
    const r = fixture();
    r.changeRegistry();
    const sha = r.commit();
    expect(r.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])).not.toContain(
      outputs[2],
    );
    const result = r.check(sha);
    expect(result.status, result.output).toBe(0);
  });
  it.each(outputs)('refuses a stale or substituted committed view: %s', (path) => {
    const r = fixture();
    r.changeRegistry();
    r.put(path, `${readFileSync(join(r.cwd, path), 'utf8')}\n// forged\n`);
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(sha);
  });
  it('refuses an Architect output without a same-commit registry change', () => {
    const r = fixture();
    r.put(outputs[0], `${readFileSync(join(r.cwd, outputs[0]), 'utf8')}\n// changed\n`);
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(outputs[0]);
  });
  it('refuses a missing or symlinked third view instead of trusting the two changed views', () => {
    const r = fixture();
    r.changeRegistry();
    rmSync(join(r.cwd, outputs[2]));
    symlinkSync('not-a-regular-blob', join(r.cwd, outputs[2]));
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it('refuses a missing third view', () => {
    const r = fixture();
    r.changeRegistry();
    r.git(['rm', '-q', outputs[2]]);
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it('refuses a malformed registry blob even when generated views are present', () => {
    const r = fixture();
    r.changeRegistry();
    r.put(source, '{invalid json\n');
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it('refuses invalid UTF-8 bytes that decode like a generated replacement character', () => {
    const r = fixture();
    const data = JSON.parse(readFileSync(join(r.cwd, source), 'utf8'));
    data.entries[0].description += ' \ufffd';
    r.put(source, `${JSON.stringify(data, null, 2)}\n`);
    r.generate();
    const bytes = readFileSync(join(r.cwd, outputs[0]));
    const replacement = Buffer.from('\ufffd');
    const offset = bytes.indexOf(replacement);
    expect(offset).toBeGreaterThanOrEqual(0);
    r.put(
      outputs[0],
      Buffer.concat([
        bytes.subarray(0, offset),
        Buffer.from([0xff]),
        bytes.subarray(offset + replacement.length),
      ]),
    );
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it.each([source, ...outputs])('refuses executable committed mode on %s', (path) => {
    const r = fixture();
    r.changeRegistry();
    r.git(['add', '-A']);
    r.git(['update-index', '--chmod=+x', path]);
    r.git(['commit', '--no-verify', '-qm', 'law: change registry']);
    const sha = r.git(['rev-parse', 'HEAD']);
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it('does not grant Architect an unrelated package path or Engineer the registry', () => {
    const r = fixture();
    r.changeRegistry();
    r.put('packages/cli/src/foreign.ts', 'export {};\n');
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('packages/cli/src/foreign.ts');
    const e = fixture();
    e.changeRegistry();
    const engineer = e.commit('Engineer');
    const denied = e.check(engineer);
    expect(denied.status, denied.output).not.toBe(0);
    expect(denied.output).toContain(source);
  });
  it('uses committed bytes, not a dirty worktree to repair stale committed bytes', () => {
    const r = fixture();
    r.changeRegistry();
    r.put(outputs[0], 'forged\n');
    const sha = r.commit();
    r.generate();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it('does not trust a substituted executing-checkout generator that accepts forged output', () => {
    const r = fixture();
    r.changeRegistry();
    r.put(outputs[0], 'forged\n');
    const sha = r.commit();
    const fake = mkdtempSync(join(tmpdir(), 'devai-checker-substitute-'));
    roots.push(fake);
    mkdirSync(join(fake, 'scripts'));
    copyFileSync(checker, join(fake, 'scripts/check-commit-range.mjs'));
    writeFileSync(join(fake, 'scripts/generate-action-registry.mjs'), 'process.exit(0);\n');
    symlinkSync(join(root, 'node_modules'), join(fake, 'node_modules'), 'dir');
    const result = r.check(sha, join(fake, 'scripts/check-commit-range.mjs'));
    expect(result.status, result.output).not.toBe(0);
  });
  it('refuses a substituted generator blob in the base', () => {
    const r = fixture(Buffer.from('process.exit(0);\n'));
    r.changeRegistry();
    const sha = r.commit();
    const result = r.check(sha);
    expect(result.status, result.output).not.toBe(0);
  });
  it.each(['modified', 'missing'] as const)(
    'refuses %s formatter bytes even when committed outputs are valid',
    (mode) => {
      const r = fixture();
      r.changeRegistry();
      const sha = r.commit();
      const fake = mkdtempSync(join(tmpdir(), 'devai-checker-formatter-'));
      roots.push(fake);
      mkdirSync(join(fake, 'scripts'));
      copyFileSync(checker, join(fake, 'scripts/check-commit-range.mjs'));
      const formatter = realpathSync(
        dirname(createRequire(import.meta.url).resolve('prettier/package.json')),
      );
      const dest = join(fake, 'node_modules/prettier');
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(formatter, dest, { recursive: true });
      if (mode === 'modified') writeFileSync(join(dest, 'package.json'), '{}\n');
      else rmSync(dest, { recursive: true });
      const result = r.check(sha, join(fake, 'scripts/check-commit-range.mjs'));
      expect(result.status, result.output).not.toBe(0);
    },
  );
  it('refuses corruption of the copied formatter before its isolated execution', () => {
    const r = fixture();
    r.changeRegistry();
    const sha = r.commit();
    const fault = mkdtempSync(join(tmpdir(), 'devai-copy-fault-'));
    roots.push(fault);
    const preload = join(fault, 'fault.cjs');
    writeFileSync(
      preload,
      `const fs = require('node:fs'); const original = fs.writeFileSync; fs.writeFileSync = function(path, data, ...args) { if (String(path).includes('/node_modules/prettier/') && String(path).endsWith('/package.json')) return original.call(this, path, Buffer.from('corrupted'), ...args); return original.call(this, path, data, ...args); }; require('node:module').syncBuiltinESMExports();\n`,
    );
    const result = r.check(sha, checker, { NODE_OPTIONS: `--require=${preload}` });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(outputs[0]);
  });
});
