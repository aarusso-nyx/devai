#!/usr/bin/env node
// Build an exact committed snapshot outside the candidate. No generated docs,
// npm dependencies or Docusaurus caches enter repository-scanning test inputs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = (argv, cwd) =>
  execFileSync(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
export function candidateIdentity(repo) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=all') !== '')
    throw new Error('RELEASE_CANDIDATE_DIRTY');
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}
export function externalDirectory(repo, directory) {
  const parent = realpathSync(directory);
  const rel = relative(realpathSync(repo), parent);
  if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    throw new Error('DOCS_BUILD_INSIDE_CANDIDATE');
  return parent;
}
export function buildDocs({ repo, parent = tmpdir(), mode = 'build' }) {
  if (!['preflight', 'stage', 'build'].includes(mode)) throw new Error('DOCS_BUILD_MODE_INVALID');
  repo = realpathSync(repo);
  const identity = candidateIdentity(repo);
  const modes = execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--format=%(objectmode) %(objecttype)', identity.commit, '--', 'docs'],
    { cwd: repo, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  if (modes.some((mode) => !['100644 blob', '100755 blob'].includes(mode)))
    throw new Error('DOCS_BUILD_SPECIAL_SOURCE');
  const directory = mkdtempSync(join(externalDirectory(repo, parent), 'devai-docs-'));
  try {
    const archive = join(directory, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, identity.commit, 'docs'], {
      cwd: repo,
    });
    const snapshot = join(directory, 'source');
    mkdirSync(snapshot);
    run(['tar', '-xf', archive, '-C', snapshot], repo);
    rmSync(archive);
    const site = join(snapshot, 'docs/site');
    // Audit the lock and reviewed vendor patch before installing/building.
    if (mode !== 'stage') run(['npm', '--prefix', site, 'run', 'security:check'], snapshot);
    if (mode === 'build') {
      run(['npm', '--prefix', site, 'ci'], snapshot);
      run(['npm', '--prefix', site, 'run', 'security:check'], snapshot);
      run(['npm', '--prefix', site, 'run', 'typecheck'], snapshot);
      run(['npm', '--prefix', site, 'run', 'build'], snapshot);
      run(
        [
          process.execPath,
          join(repo, 'scripts/process/verify-pages-bytes.mjs'),
          'local',
          join(site, 'build'),
        ],
        repo,
      );
    }
    if (JSON.stringify(candidateIdentity(repo)) !== JSON.stringify(identity))
      throw new Error('DOCS_BUILD_CANDIDATE_CHANGED');
    const result = { ...identity, mode, directory, source: snapshot, site: join(site, 'build') };
    writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    if (mode === 'preflight') rmSync(directory, { recursive: true });
    return result;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, repo = '.', parent = tmpdir(), receipt] = process.argv.slice(2);
  const result = buildDocs({ mode, repo, parent });
  if (receipt) writeFileSync(receipt, `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 });
  // Last line is machine-readable; security/type/build diagnostics stay visible.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
