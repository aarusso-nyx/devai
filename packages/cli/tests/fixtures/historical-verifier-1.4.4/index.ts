import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const FIXTURE_SHA256 = 'e47725d175dde3696994ab845f6dfe028a4c43e1002ec1e8346d1ba7fc6d10f2';
const ARCHIVE_SHA256 = 'c7624514d957f05bfac6d1f83e9dec26e019661cfcb980b0c0deee16d61a507d';
const COMMIT = '3aec624d0c0aecc534e60ee45306a4e5e6a7e94d';
const TREE = '2cad519aba8117a1850eee85d41eae452d51a141';
const TAG_OBJECT = '6677ef3acfeda2b8b393b9ad2c3eb3e2fa169a39';
const INVALID = 'historical verifier fixture invalid';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Exact v1.4.4 annotated tag, release commit, path-ancestor trees and complete
 * packages/cli/vendor/evidence-verification subtree, captured from COMMIT.
 * This is a bounded historical test fixture, not production Git history.
 * Ancestor commits and unrelated tree contents are intentionally absent.
 */
export function createHistoricalVerifierGitFixture(): {
  readonly git: (args: readonly string[]) => Buffer;
  readonly cleanup: () => void;
} {
  const raw = readFileSync(new URL('./objects.json', import.meta.url));
  if (raw.length !== 268114 || hash(raw) !== FIXTURE_SHA256) throw new Error(INVALID);
  const fixture = JSON.parse(raw.toString('utf8')) as {
    schemaVersion: string;
    kind: string;
    tag: string;
    tag_object: string;
    commit: string;
    tree: string;
    subtree: string;
    objects: Array<{ id: string; type: string; base64: string }>;
  };
  if (
    fixture.schemaVersion !== '1.0.0' ||
    fixture.kind !== 'historical-verifier-git-fixture-v1' ||
    fixture.tag !== 'v1.4.4' ||
    fixture.tag_object !== TAG_OBJECT ||
    fixture.commit !== COMMIT ||
    fixture.tree !== TREE ||
    fixture.subtree !== 'packages/cli/vendor/evidence-verification' ||
    fixture.objects.length !== 38
  )
    throw new Error(INVALID);
  const ids = new Set<string>();
  let total = 0;
  // Verify all object bytes before creating any temporary filesystem state.
  const objects = fixture.objects.map((entry) => {
    if (
      !/^[a-f0-9]{40}$/u.test(entry.id) ||
      ids.has(entry.id) ||
      !['tag', 'commit', 'tree', 'blob'].includes(entry.type)
    )
      throw new Error(INVALID);
    const bytes = Buffer.from(entry.base64, 'base64');
    if (bytes.toString('base64') !== entry.base64) throw new Error(INVALID);
    const framed = Buffer.concat([Buffer.from(`${entry.type} ${bytes.length}\0`), bytes]);
    if (createHash('sha1').update(framed).digest('hex') !== entry.id) throw new Error(INVALID);
    ids.add(entry.id);
    total += bytes.length;
    return { id: entry.id, framed };
  });
  if (total !== 197656 || !ids.has(TAG_OBJECT) || !ids.has(COMMIT) || !ids.has(TREE))
    throw new Error(INVALID);

  const root = mkdtempSync(join(tmpdir(), 'devai historical verifier 1.4.4 ç-'));
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    // Only this helper's newly created directory is ever removed.
    rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const object of objects) {
      const directory = join(root, 'objects', object.id.slice(0, 2));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, object.id.slice(2)), deflateSync(object.framed), {
        flag: 'wx',
      });
    }
    mkdirSync(join(root, 'refs/tags'), { recursive: true });
    writeFileSync(join(root, 'refs/tags/v1.4.4'), `${TAG_OBJECT}\n`, { flag: 'wx' });
    writeFileSync(join(root, 'HEAD'), `${COMMIT}\n`, { flag: 'wx' });
    writeFileSync(join(root, 'shallow'), `${COMMIT}\n`, { flag: 'wx' });
    writeFileSync(
      join(root, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = true\nhooksPath = /dev/null\nfsmonitor = false\n',
      { flag: 'wx' },
    );
    return {
      cleanup,
      git(args) {
        if (disposed || !['cat-file', 'rev-parse', 'show', 'archive'].includes(args[0] ?? ''))
          throw new Error(INVALID);
        const bytes = execFileSync('git', ['--no-pager', `--git-dir=${root}`, ...args], {
          cwd: root,
          encoding: 'buffer',
          maxBuffer: 1024 * 1024,
          timeout: 10000,
          // Do not inherit Git directories, alternates, config, hooks or credentials.
          env: {
            PATH: process.env['PATH'],
            HOME: root,
            XDG_CONFIG_HOME: root,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        });
        if (args[0] === 'archive' && hash(bytes) !== ARCHIVE_SHA256) throw new Error(INVALID);
        return bytes;
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
