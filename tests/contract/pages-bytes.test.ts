import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { siteMembers, verifyPagesBytes, readPublicFile } = await import(
  pathToFileURL(resolve('scripts/process/verify-pages-bytes.mjs')).href
);
const roots: string[] = [];
const files = {
  'index.html': '<html>v1.5.0</html>',
  'assets/app.js': 'sealed-script',
  'docs/ação.html': 'sealed-doc',
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-pages-'));
  roots.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(resolve(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  writeFileSync(join(root, '.nojekyll'), '');
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('encodes member names and follows only redirects inside the fixed site', async () => {
  const urls: string[] = [];
  const bytes = await readPublicFile('docs/ação.html', 4, async (url: URL) => {
    urls.push(String(url));
    return urls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/devai/docs/acao/' } })
      : new Response('same');
  });
  expect(bytes.toString()).toBe('same');
  expect(urls).toEqual([
    'https://aarusso-nyx.github.io/devai/docs/a%C3%A7%C3%A3o.html',
    'https://aarusso-nyx.github.io/devai/docs/acao/',
  ]);
});

it.each(['https://other.invalid/file', '/other-project/file'])(
  'refuses redirect outside the site: %s',
  async (location) => {
    let reads = 0;
    await expect(
      readPublicFile('index.html', 4, async () => {
        reads++;
        return new Response(null, { status: 302, headers: { location } });
      }),
    ).rejects.toThrow('PAGES_REDIRECT_OUTSIDE_SITE');
    expect(reads).toBe(1);
  },
);

it('bounds response bytes and refuses non-success HTTP responses', async () => {
  await expect(
    readPublicFile('index.html', 1, async () => new Response('too large')),
  ).rejects.toThrow('PAGES_RESPONSE_SIZE_MISMATCH');
  await expect(
    readPublicFile('index.html', 1, async () => new Response('missing', { status: 404 })),
  ).rejects.toThrow('PAGES_READ_UNVERIFIED');
});

it('verifies every rehearsed public member without building or rewriting files', async () => {
  const root = fixture();
  const seen: string[] = [];
  const before = siteMembers(root);
  const result = await verifyPagesBytes(root, async (path: keyof typeof files) => {
    seen.push(path);
    return Buffer.from(files[path]);
  });
  expect(seen.sort()).toEqual(Object.keys(files).sort());
  expect(result).toEqual({ verified: true, publicFiles: 3, buildInvocations: 0 });
  expect(siteMembers(root)).toEqual(before);
});

it('rejects changed bytes even when the expected version text is present', async () => {
  const root = fixture();
  await expect(
    verifyPagesBytes(root, async (path: keyof typeof files) =>
      Buffer.from(path === 'index.html' ? '<html>v1.5.0 wrong</html>' : files[path]),
    ),
  ).rejects.toThrow('BYTES_MISMATCH');
});

it('aggregates independent read failures and mismatches without calling either passing', async () => {
  const root = fixture();
  const seen: string[] = [];
  const result = verifyPagesBytes(root, async (path: keyof typeof files) => {
    seen.push(path);
    if (path === 'assets/app.js') throw new Error('network unavailable');
    return Buffer.from(path === 'index.html' ? 'wrong' : files[path]);
  });
  await expect(result).rejects.toThrow(/BYTES_MISMATCH|READ_UNVERIFIED/);
  expect(seen.sort()).toEqual(Object.keys(files).sort());
  await expect(result).rejects.toThrow('READ_UNVERIFIED');
  await expect(result).rejects.toThrow('BYTES_MISMATCH');
});

it('rejects symbolic links before issuing any remote read', async () => {
  const root = fixture();
  symlinkSync(join(root, 'index.html'), join(root, 'alias.html'));
  let reads = 0;
  await expect(
    verifyPagesBytes(root, async () => {
      reads++;
      return Buffer.alloc(0);
    }),
  ).rejects.toThrow('PAGES_UNSAFE_MEMBER');
  expect(reads).toBe(0);
});

it.each(['.hidden', '.well-known/identity.json', 'assets/.metadata', '.nojekyll'])(
  'refuses content the pinned Pages uploader excludes before any remote effect: %s',
  async (path) => {
    const root = fixture();
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'must not be silently dropped');
    let reads = 0;
    await expect(
      verifyPagesBytes(root, async () => {
        reads++;
        return Buffer.alloc(0);
      }),
    ).rejects.toThrow('PAGES_UPLOAD_EXCLUDED_MEMBER');
    expect(reads).toBe(0);
  },
);
