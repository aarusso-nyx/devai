import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** A filesystem snapshot, never a claim about an absent caller Git index. */
export function createSelfContainedRepositoryFixture(
  source: string,
  options: { readonly paths?: readonly string[] } = {},
): {
  readonly root: string;
  readonly commit: string;
  readonly tree: string;
  readonly paths: readonly string[];
  readonly git: (args: readonly string[]) => string;
  readonly cleanup: () => void;
} {
  const sourceRoot = realpathSync(source);
  const parent = mkdtempSync(join(tmpdir(), 'devai isolated repository ç-'));
  const root = join(parent, 'repository');
  mkdirSync(root);
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    // This helper removes only its own newly created temporary parent.
    rmSync(parent, { recursive: true, force: true });
  };
  const environment = {
    PATH: process.env['PATH'],
    HOME: parent,
    XDG_CONFIG_HOME: parent,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  function invoke(args: readonly string[], input?: string) {
    if (disposed) throw new Error('repository fixture disposed');
    const result = spawnSync('git', [...args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      ...(input === undefined ? {} : { input }),
    });
    if (result.error !== undefined) throw result.error;
    return result;
  }
  const git = (args: readonly string[]): string => {
    const result = invoke(args);
    if (result.status !== 0) throw new Error(`repository fixture Git: ${result.stderr}`);
    return result.stdout.trim();
  };
  function excluded(path: string): boolean {
    // Check these before lstat/readdir, including when the source has no .git.
    return (
      path === 'tmp' ||
      path.startsWith('tmp/') ||
      path === '.devai/worktrees' ||
      path.startsWith('.devai/worktrees/') ||
      path.split('/').some((part) => ['.git', 'node_modules', '.stryker-tmp'].includes(part))
    );
  }
  try {
    git(['init', '--quiet', '--template=', '--initial-branch=fixture', '--object-format=sha1']);
    for (const [name, value] of [
      ['user.name', 'Repository Fixture'],
      ['user.email', 'fixture@example.invalid'],
      ['core.hooksPath', '/dev/null'],
      ['core.attributesFile', '/dev/null'],
      ['core.autocrlf', 'false'],
      ['core.fsmonitor', 'false'],
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
    ])
      git(['config', name as string, value as string]);

    const paths: string[] = [];
    const walk = (directory: string) => {
      const entries = readdirSync(join(sourceRoot, directory), { withFileTypes: true })
        .map((entry) => ({
          entry,
          path: directory === '' ? entry.name : `${directory}/${entry.name}`,
        }))
        .filter(({ path }) => !excluded(path));
      if (entries.length === 0) return;
      // Only the fresh index is used. Candidate-owned nested ignore rules are
      // evaluated before descending into ignored generated directories.
      const result = invoke(
        [
          `--git-dir=${join(root, '.git')}`,
          `--work-tree=${sourceRoot}`,
          'check-ignore',
          '--no-index',
          '-z',
          '--stdin',
        ],
        entries.map(({ path }) => `${path}\0`).join(''),
      );
      if (result.status !== 0 && result.status !== 1)
        throw new Error(`repository fixture ignores: ${result.stderr}`);
      const ignored = new Set(result.stdout.split('\0'));
      for (const { entry, path } of entries) {
        if (ignored.has(path)) continue;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
        else throw new Error(`repository fixture unsupported file: ${path}`);
      }
    };
    const worktreePlaceholder = '.devai/worktrees/.gitkeep';
    if (options.paths === undefined) {
      walk('');
      // Preserve this known tracked placeholder by exact direct read only.
      // Never enumerate its parent or any historical worktree; absence refuses.
      if (!lstatSync(join(sourceRoot, worktreePlaceholder)).isFile())
        throw new Error('repository fixture worktree placeholder invalid');
      paths.push(worktreePlaceholder);
    } else paths.push(...options.paths);
    paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (paths.length === 0 || paths.length > 20000 || new Set(paths).size !== paths.length)
      throw new Error('repository fixture file census invalid');
    let totalBytes = 0;
    for (const path of paths) {
      if (
        (excluded(path) && path !== worktreePlaceholder) ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((part) => ['', '.', '..'].includes(part))
      )
        throw new Error(`repository fixture path invalid: ${path}`);
      const parts = path.split('/');
      for (let count = 1; count < parts.length; count += 1) {
        if (!lstatSync(join(sourceRoot, ...parts.slice(0, count))).isDirectory())
          throw new Error(`repository fixture directory invalid: ${path}`);
      }
      const original = join(sourceRoot, path);
      const destination = resolve(root, path);
      const stat = lstatSync(original);
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`repository fixture file invalid: ${path}`);
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(original))
        : readFileSync(original);
      totalBytes += bytes.length;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('repository fixture bytes exceeded');
      mkdirSync(dirname(destination), { recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(bytes.toString(), destination);
      else {
        writeFileSync(destination, bytes, { flag: 'wx' });
        chmodSync(destination, stat.mode & 0o111 ? 0o755 : 0o644);
      }
    }
    // The population was selected above; force-add retains explicitly requested
    // real controls even when an adopter ignore rule would otherwise omit them.
    git(['add', '--force', '--', '.']);
    git(['commit', '--quiet', '-m', 'self-contained candidate filesystem fixture']);
    return {
      root: realpathSync(root),
      commit: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
      paths: Object.freeze([...paths]),
      git,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
