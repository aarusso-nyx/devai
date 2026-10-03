// Trace annotation deferred to Architect TASK-06216: site preparation custody requires exact adjudication.
// ADR-REL-0034 IA-004: actual tar bytes and siteMembers semantics; offline only.
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { siteMembers } = await import(
  new URL('../../scripts/process/verify-pages-bytes.mjs', import.meta.url).href
);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface Entry {
  path: string;
  bytes?: Buffer;
  type?: string;
  link?: string;
  declaredSize?: number;
}
// The exact pinned action 7b1f4a... uses GNU tar -cvf artifact.tar, excluding
// all dot members, then upload-artifact ea165f... (v4.6.2). These offline bytes
// model ordinary GNU tar and the enclosing Actions artifact ZIP, not a live run.
// GNU long-name metadata is approved only when its complete following entry is safe.
function tar(entries: Entry[]) {
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    const bytes = entry.bytes ?? Buffer.alloc(0);
    const size = entry.declaredSize ?? bytes.length;
    header.write(size.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar ', 257);
    header.write(' \0', 263);
    header.write('runner', 265);
    header.write('runner', 297);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...buffers, Buffer.alloc(1024)]);
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(
  archive: Buffer,
  options: {
    stored?: boolean;
    descriptor?: boolean;
    names?: string[];
    flags?: number;
    method?: number;
  } = {},
) {
  const locals: Buffer[] = [];
  const directories: Buffer[] = [];
  let offset = 0;
  for (const path of options.names ?? ['artifact.tar']) {
    const name = Buffer.from(path);
    const method = options.method ?? (options.stored ? 0 : 8);
    const compressed = method === 0 ? archive : deflateRawSync(archive);
    const checksum = crc32(archive);
    const flags = options.flags ?? (options.descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!options.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(archive.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = options.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (options.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(archive.length, 12);
    }
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(archive.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed, descriptor);
    directories.push(directory, name);
    offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const central = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE((options.names ?? ['artifact.tar']).length, 8);
  end.writeUInt16LE((options.names ?? ['artifact.tar']).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
const INDEX = Buffer.from('<!doctype html><title>Offline fixture</title>');
const CSS = Buffer.from('body{color:black}');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-cmp0625-site-'));
  roots.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'assets', 'style.css'), CSS);
  writeFileSync(join(root, '.nojekyll'), '');
  const population = siteMembers(root);
  const archive = tar([
    { path: './', type: '5' },
    { path: './index.html', bytes: INDEX },
    { path: './assets/', type: '5' },
    { path: './assets/style.css', bytes: CSS },
  ]);
  return {
    root,
    archive,
    input: {
      archiveBytes: zip(archive),
      artifact: {
        id: '101',
        runId: '201',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        archiveSha256: hash(zip(archive)),
        siteSha256: hash(Buffer.from(JSON.stringify(population))),
        members: population,
      },
      expected: {
        artifactId: '101',
        runId: '201',
        sourceCommit: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        siteSha256: hash(Buffer.from(JSON.stringify(population))),
        preparationConclusion: 'success',
      },
    },
  };
}
async function validate(input: unknown) {
  const module = (await import(
    new URL('../../packages/sensors/src/ci-invariant-gate.js', import.meta.url).href
  )) as {
    validateSitePreparationArtifact: (input: unknown) => {
      status: string;
      members?: unknown[];
    };
  };
  return module.validateSitePreparationArtifact(input);
}
describe('retained site member population compatibility (offline)', () => {
  it('pins existing empty .nojekyll exclusion and the original JSON.stringify member hash', () => {
    const { root, input } = fixture();
    expect(siteMembers(root)).toEqual(input.artifact.members);
    expect(input.artifact.members.map((m: { path: string }) => m.path)).toEqual([
      'assets/style.css',
      'index.html',
    ]);
    expect(hash(Buffer.from(JSON.stringify(siteMembers(root))))).toBe(input.artifact.siteSha256);
  });
  it('rejects other dot members and symbolic links through the actual current helper', () => {
    const { root } = fixture();
    writeFileSync(join(root, '.hidden'), 'unsafe');
    expect(() => siteMembers(root)).toThrow('PAGES_UPLOAD_EXCLUDED_MEMBER');
    rmSync(join(root, '.hidden'));
    symlinkSync(join(root, 'index.html'), join(root, 'alias'));
    expect(() => siteMembers(root)).toThrow('PAGES_UNSAFE_MEMBER');
  });
});
describe('exact run/artifact/source/archive custody before extraction (offline)', () => {
  it.each([{ stored: true }, { descriptor: true }, {}])(
    'accepts ordinary GNU tar inside complete ZIP metadata %j',
    async (options) => {
      const { input, archive } = fixture();
      input.archiveBytes = zip(archive, options);
      input.artifact.archiveSha256 = hash(input.archiveBytes);
      expect(await validate(input)).toMatchObject({
        status: 'pass',
        members: input.artifact.members,
      });
    },
  );
  it('accepts pinned GNU long-name metadata only with its safe complete following file', async () => {
    const { input, root } = fixture();
    const path = 'assets/' + 'long-'.repeat(24) + '.css';
    writeFileSync(join(root, path), CSS);
    input.artifact.members = siteMembers(root);
    input.artifact.siteSha256 = hash(Buffer.from(JSON.stringify(input.artifact.members)));
    input.expected.siteSha256 = input.artifact.siteSha256;
    input.archiveBytes = zip(
      tar([
        { path: './', type: '5' },
        { path: './index.html', bytes: INDEX },
        { path: './assets/', type: '5' },
        { path: './assets/style.css', bytes: CSS },
        { path: '././@LongLink', type: 'L', bytes: Buffer.from('./' + path + '\0') },
        { path: ('./' + path).slice(0, 100), bytes: CSS },
      ]),
    );
    input.artifact.archiveSha256 = hash(input.archiveBytes);
    expect(await validate(input)).toMatchObject({
      status: 'pass',
      members: input.artifact.members,
    });
  });
  it.each([
    'duplicate',
    'extra',
    'traversal',
    'encrypted',
    'unknown-compression',
    'crc',
    'truncated-central',
  ])('refuses ambiguous or unsafe ZIP %s before extraction', async (fault) => {
    const { input, archive } = fixture();
    const options = {
      names:
        fault === 'duplicate'
          ? ['artifact.tar', 'artifact.tar']
          : fault === 'extra'
            ? ['artifact.tar', 'unlisted']
            : fault === 'traversal'
              ? ['../artifact.tar']
              : undefined,
      flags: fault === 'encrypted' ? 1 : undefined,
      method: fault === 'unknown-compression' ? 99 : undefined,
    };
    input.archiveBytes = zip(archive, options);
    if (fault === 'crc') input.archiveBytes[14] = (input.archiveBytes[14] ?? 0) ^ 1;
    if (fault === 'truncated-central')
      input.archiveBytes = input.archiveBytes.subarray(0, input.archiveBytes.length - 10);
    input.artifact.archiveSha256 = hash(input.archiveBytes);
    expect((await validate(input)).status).not.toBe('pass');
  });
  it.each(['artifactId', 'runId', 'sourceCommit', 'sourceTree', 'siteSha256'] as const)(
    'refuses substituted independently expected %s',
    async (field) => {
      const { input } = fixture();
      input.expected[field] = field.endsWith('Id')
        ? '999'
        : 'c'.repeat(field === 'siteSha256' ? 64 : 40);
      expect((await validate(input)).status).not.toBe('pass');
    },
  );
  it.each(['failed', 'skipped', 'cancelled', 'unknown'])(
    'blocks %s preparation before publication even if bytes match',
    async (conclusion) => {
      const { input } = fixture();
      input.expected.preparationConclusion = conclusion;
      expect((await validate(input)).status).not.toBe('pass');
    },
  );
  it.each([
    '../escape',
    '/absolute',
    'a/../escape',
    'a\\escape',
    '.hidden',
    'index.html\u0000extra',
  ])('refuses unsafe archive path %s before any extraction', async (path) => {
    const { input } = fixture();
    input.archiveBytes = zip(
      tar([
        { path: 'index.html', bytes: INDEX },
        { path, bytes: CSS },
      ]),
    );
    input.artifact.archiveSha256 = hash(input.archiveBytes);
    expect((await validate(input)).status).not.toBe('pass');
  });
  it.each(['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K', '?'])(
    'refuses unsupported link/special/ambiguous extension type %s',
    async (type) => {
      const { input } = fixture();
      input.archiveBytes = zip(
        tar([
          { path: 'index.html', bytes: INDEX },
          { path: 'unsafe', type, link: 'index.html', bytes: CSS },
        ]),
      );
      input.artifact.archiveSha256 = hash(input.archiveBytes);
      expect((await validate(input)).status).not.toBe('pass');
    },
  );
  it.each([
    'duplicate',
    'missing-index',
    'truncated',
    'checksum',
    'archive-digest',
    'population',
    'over-limit',
  ])('refuses %s even when preparation metadata declares success', async (fault) => {
    const { input, archive } = fixture();
    if (fault === 'duplicate')
      input.archiveBytes = zip(
        tar([
          { path: 'index.html', bytes: INDEX },
          { path: './index.html', bytes: INDEX },
        ]),
      );
    if (fault === 'missing-index')
      input.archiveBytes = zip(tar([{ path: 'assets/style.css', bytes: CSS }]));
    if (fault === 'truncated') input.archiveBytes = zip(archive.subarray(0, 600));
    if (fault === 'checksum') {
      const changed = Buffer.from(archive);
      changed[1] = required(changed[1]) ^ 1;
      input.archiveBytes = zip(changed);
    }
    if (fault === 'population') input.artifact.members = input.artifact.members.slice(1);
    if (fault === 'over-limit')
      input.archiveBytes = zip(
        tar([{ path: 'index.html', bytes: INDEX, declaredSize: 65 * 1024 * 1024 }]),
      );
    input.artifact.archiveSha256 =
      fault === 'archive-digest' ? '0'.repeat(64) : hash(input.archiveBytes);
    expect((await validate(input)).status).not.toBe('pass');
  });
  it('I/O wrapper performs no extraction callback for invalid entries', async () => {
    const { input } = fixture();
    input.archiveBytes = zip(tar([{ path: '../escape', bytes: INDEX }]));
    input.artifact.archiveSha256 = hash(input.archiveBytes);
    const extract = vi.fn();
    const module = (await import(
      new URL('../../scripts/process/verify-site-preparation-artifact.mjs', import.meta.url).href
    )) as {
      verifySitePreparationArtifact: (input: unknown) => Promise<unknown>;
    };
    await expect(module.verifySitePreparationArtifact({ ...input, extract })).rejects.toThrow();
    expect(extract).not.toHaveBeenCalled();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('OFFLINE_FIXTURE_REQUIRED_VALUE_MISSING');
  return value;
}
