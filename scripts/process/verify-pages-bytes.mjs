#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 512 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SITE = new URL('https://aarusso-nyx.github.io/devai/');

export function siteMembers(directory) {
  const members = [];
  let total = 0;
  function visit(root, prefix = '') {
    if (!lstatSync(root).isDirectory()) throw new Error('PAGES_UNSAFE_MEMBER');
    for (const name of readdirSync(root).sort()) {
      if (
        name.includes('\\') ||
        [...name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error('PAGES_UNSAFE_MEMBER');
      const file = join(root, name);
      const path = prefix + name;
      const stat = lstatSync(file);
      // The pinned upload-pages-artifact action excludes every dot-prefixed member.
      // Refuse a population it would silently truncate before creating any effect.
      if (path === '.nojekyll' && stat.isFile() && stat.size === 0) continue;
      if (name.startsWith('.')) throw new Error('PAGES_UPLOAD_EXCLUDED_MEMBER');
      if (stat.isDirectory()) visit(file, `${path}/`);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > MAX_BYTES || stat.size > 64 * 1024 * 1024 || members.length >= 20000)
          throw new Error('PAGES_POPULATION_LIMIT');
        members.push({ path, size: stat.size, sha256: sha256(readFileSync(file)) });
      } else throw new Error('PAGES_UNSAFE_MEMBER');
    }
  }
  visit(directory);
  if (!members.some((member) => member.path === 'index.html'))
    throw new Error('PAGES_INDEX_MISSING');
  return members;
}

export async function verifyPagesBytes(directory, readRemote) {
  const members = siteMembers(directory);
  const failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < members.length) {
        const member = members[next++];
        try {
          const bytes = await readRemote(member.path, member.size);
          if (bytes.length !== member.size || sha256(bytes) !== member.sha256)
            failures.push({ path: member.path, reason: 'BYTES_MISMATCH' });
        } catch {
          failures.push({ path: member.path, reason: 'READ_UNVERIFIED' });
        }
      }
    }),
  );
  if (failures.length)
    throw new Error(
      `PAGES_BYTES_UNVERIFIED:${JSON.stringify(failures.sort((a, b) => a.path.localeCompare(b.path)))}`,
    );
  return { verified: true, publicFiles: members.length, buildInvocations: 0 };
}

export async function readPublicFile(path, maximumBytes, fetchImpl = fetch) {
  let url = new URL(path.split('/').map(encodeURIComponent).join('/'), SITE);
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.origin !== SITE.origin || !url.pathname.startsWith(SITE.pathname))
      throw new Error('PAGES_REDIRECT_OUTSIDE_SITE');
    const response = await fetchImpl(url, { redirect: 'manual', signal, cache: 'no-store' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('PAGES_REDIRECT_INVALID');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('PAGES_READ_UNVERIFIED');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('PAGES_RESPONSE_SIZE_MISMATCH');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('PAGES_REDIRECT_LIMIT');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || process.argv.length !== 4 || !['local', 'live'].includes(mode))
    throw new Error('PAGES_BYTES_USAGE');
  const result =
    mode === 'local'
      ? { publicFiles: siteMembers(directory).length }
      : await verifyPagesBytes(directory, readPublicFile);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
