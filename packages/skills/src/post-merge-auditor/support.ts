import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from '@devai-nyx/authority';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function installedConstitution(root: string): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const path = [
    join(root, '.devai/pin/constitution.md'),
    join(root, 'law/constitution.md'),
    join(root, '.devai/constitution.md'),
    join(packageRoot, 'dist/law/constitution.md'),
  ].find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('HOST_RECEIPT_CONSTITUTION_UNAVAILABLE');
  return readFileSync(path, 'utf8');
}

export function canonicalSha256(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (isRecord(input)) {
      return `{${Object.keys(input)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(input);
  };
  return sha256(canonical(value));
}

export function readJson(
  path: string,
  code: string,
): { readonly value: JsonRecord; readonly raw: Buffer } {
  try {
    const raw = readFileSync(path);
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(value)) throw new Error('not an object');
    return { value, raw };
  } catch {
    throw new Error(code);
  }
}

export function git(repoRoot: string, args: readonly string[]) {
  const environment = { ...process.env };
  delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_DIR;
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_OBJECT_DIRECTORY;
  delete environment.GIT_PREFIX;
  delete environment.GIT_WORK_TREE;
  return spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...environment,
      GIT_AUTHOR_NAME: 'DEVAI Auditor',
      GIT_AUTHOR_EMAIL: 'aarusso@nyxk.com.br',
      GIT_COMMITTER_NAME: 'DEVAI Auditor',
      GIT_COMMITTER_EMAIL: 'aarusso@nyxk.com.br',
    },
  });
}

export function gitText(repoRoot: string, args: readonly string[], code: string): string {
  const result = git(repoRoot, args);
  if (result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

export function exactRepository(value: unknown, repoRoot: string): boolean {
  return typeof value === 'string' && resolve(value) === realpathSync(repoRoot);
}

export function gitAdministrationRoot(repoRoot: string): string {
  const marker = join(repoRoot, '.git');
  if (!existsSync(marker)) throw new Error('HOST_RECEIPT_UNVERIFIED');
  if (lstatSync(marker).isDirectory()) return realpathSync(marker);
  if (!lstatSync(marker).isFile()) throw new Error('HOST_RECEIPT_UNVERIFIED');
  const pointer = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim())?.[1];
  if (pointer === undefined) throw new Error('HOST_RECEIPT_UNVERIFIED');
  return realpathSync(resolve(repoRoot, pointer));
}
