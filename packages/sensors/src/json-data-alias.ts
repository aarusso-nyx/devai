import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Observation-only admission bounds, not scorecard verdict thresholds.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 256;
const MAX_DEPTH = 16;
const REFUSED_SEGMENTS = new Set([
  '.git',
  '.devai',
  'record',
  'node_modules',
  'coverage',
  '.aws',
  '.ssh',
  '.gnupg',
  '.npm',
  '.env',
]);
const identity = (stat: Stats): string =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const contained = (root: string, path: string): boolean => {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

/**
 * A nested data alias contributes no executable or source files. Admit it only
 * after two equal, bounded observations of an internal, non-followed JSON-only
 * directory. No file bytes or paths reached through the alias enter a census.
 * This is not native candidate/read provenance and grants no execution authority.
 */
export function isStableJsonDataDirectoryAlias(repoRoot: string, link: string): boolean {
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') return false;
    const lexicalRoot = resolve(repoRoot),
      root = realpathSync(lexicalRoot);
    if (!contained(lexicalRoot, link)) return false;
    const physicalLink = resolve(root, relative(lexicalRoot, link));
    const regularPrefixes = (path: string): boolean => {
      if (!contained(root, path)) return false;
      let current = root;
      for (const part of relative(root, path).split(sep)) {
        current = join(current, part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      }
      return true;
    };
    const observe = (): string => {
      if (!regularPrefixes(dirname(physicalLink))) throw new Error('alias parent');
      const before = lstatSync(physicalLink);
      if (!before.isSymbolicLink()) throw new Error('not an alias');
      const literalBytes = readlinkSync(physicalLink, { encoding: 'buffer' });
      const literal = new TextDecoder('utf-8', { fatal: true }).decode(literalBytes);
      if (isAbsolute(literal) || literal !== literal.normalize('NFC'))
        throw new Error('nonportable alias');
      const target = resolve(dirname(physicalLink), literal);
      if (
        relative(root, target)
          .split(sep)
          .some((part) => REFUSED_SEGMENTS.has(part))
      )
        throw new Error('refused target namespace');
      if (!regularPrefixes(target) || realpathSync(target) !== target)
        throw new Error('noncanonical alias target');
      let bytes = 0,
        files = 0,
        entries = 0;
      const manifest: string[] = [];
      const walk = (path: string, depth: number): void => {
        if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) throw new Error('alias bounds');
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error('nested alias');
        const key = relative(target, path);
        if (key.split(sep).some((part) => REFUSED_SEGMENTS.has(part)))
          throw new Error('refused descendant namespace');
        if (stat.isDirectory()) {
          const children = readdirSync(path).sort();
          manifest.push(`${key}:directory:${identity(stat)}:${JSON.stringify(children)}`);
          for (const child of children) walk(join(path, child), depth + 1);
        } else {
          if (!stat.isFile() || (stat.mode & 0o111) !== 0 || !path.endsWith('.json'))
            throw new Error('non-JSON entry');
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (identity(fstatSync(fd)) !== identity(stat)) throw new Error('changed entry');
            const limit = MAX_BYTES - bytes;
            if (stat.size > limit) throw new Error('alias byte bound');
            const buffer = Buffer.alloc(limit + 1);
            let length = 0,
              count: number;
            do {
              count = readSync(fd, buffer, length, buffer.length - length, length);
              length += count;
            } while (count > 0 && length < buffer.length);
            if (length > limit || identity(fstatSync(fd)) !== identity(stat))
              throw new Error('changed data');
            const data = buffer.subarray(0, length);
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
            bytes += length;
            files += 1;
            manifest.push(
              `${key}:json:${identity(stat)}:${createHash('sha256').update(data).digest('hex')}`,
            );
          } finally {
            closeSync(fd);
          }
        }
        if (identity(lstatSync(path)) !== identity(stat)) throw new Error('changed population');
      };
      walk(target, 0);
      if (
        files === 0 ||
        identity(lstatSync(physicalLink)) !== identity(before) ||
        !readlinkSync(physicalLink, { encoding: 'buffer' }).equals(literalBytes) ||
        !regularPrefixes(target)
      )
        throw new Error('changed alias');
      return JSON.stringify({ literal, target, identity: identity(before), manifest });
    };
    return observe() === observe();
  } catch {
    return false;
  }
}
