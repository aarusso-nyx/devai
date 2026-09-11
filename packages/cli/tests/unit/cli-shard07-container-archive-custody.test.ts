import { describe, expect, it } from 'vitest';
import {
  canonicalContainerPath,
  decodeContainerArchive,
  decodeContainerDependencyArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
  type ContainerArchiveEntry,
} from '../../src/services/container-archive.js';

const INVALID = 'release-certification-archive-invalid';
const UNSUPPORTED = 'release-certification-archive-attribute-unsupported';

function file(path: string, bytes = Buffer.from(path)): ContainerArchiveEntry {
  return { path, mode: '100644', bytes };
}

function checksum(block: Buffer): void {
  block.fill(0x20, 148, 156);
  block.write(
    block
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(7, '0'),
    148,
    7,
    'ascii',
  );
  block[155] = 0;
}

function sizeField(block: Buffer, size: number): void {
  block.fill(0, 124, 136);
  block.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii');
  block[135] = 0;
  checksum(block);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

/** Rebuild only the first entry's PAX payload and header checksum. */
function replaceFirstPax(archive: Buffer, payload: Buffer): Buffer {
  const result = Buffer.from(archive);
  const paxHeader = result.subarray(512, 1024);
  const oldSize = Number.parseInt(paxHeader.subarray(124, 136).toString('ascii').trim(), 8);
  const oldPadded = Math.ceil(oldSize / 512) * 512;
  const payloadStart = 1024;
  const entryHeaderStart = payloadStart + oldPadded;
  const rest = result.subarray(entryHeaderStart);
  sizeField(paxHeader, payload.length);
  return Buffer.concat([
    result.subarray(0, 512),
    paxHeader,
    payload,
    Buffer.alloc((512 - (payload.length % 512)) % 512),
    rest,
  ]);
}

/** Increase a real entry's declared size while retaining its original payload. */
function overdeclareFirstEntry(archive: Buffer): Buffer {
  const result = Buffer.from(archive);
  let offset = 512;
  while (offset + 512 <= result.length) {
    const block = result.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) throw new Error('entry header not found');
    const type = block[156];
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').trim(), 8);
    const padded = Math.ceil(size / 512) * 512;
    if (type === 0x30) {
      // Deliberately overstate beyond the entire owned archive, retaining a valid checksum.
      sizeField(block, result.length);
      return result;
    }
    offset += 512 + padded;
  }
  throw new Error('entry header not found');
}

function headerOfType(archive: Buffer, type: number, occurrence = 0): Buffer {
  let offset = 0;
  let observed = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block[156] === type && observed++ === occurrence) return block;
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').trim() || '0', 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`header type ${type} not found`);
}

function singleHeaderArchive(header: Buffer, payload = Buffer.alloc(0)): Buffer {
  const selected = Buffer.from(header);
  sizeField(selected, payload.length);
  return Buffer.concat([
    selected,
    payload,
    Buffer.alloc((512 - (payload.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

function bareEntryArchive(source: Buffer): Buffer {
  const entry = Buffer.from(headerOfType(source, 0x30));
  const size = Number.parseInt(entry.subarray(124, 136).toString('ascii').trim(), 8);
  const payloadStart = source.indexOf(headerOfType(source, 0x30)) + 512;
  const payload = source.subarray(payloadStart, payloadStart + size);
  entry.fill(0, 345, 500);
  checksum(entry);
  return Buffer.concat([
    entry,
    payload,
    Buffer.alloc((512 - (size % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

describe('container archive security boundaries', () => {
  it.each(['/absolute', 'a\\b', 'a/../b', 'a/./b', 'a//b', ''])(
    'rejects unsafe path %j',
    (path) => {
      expect(canonicalContainerPath(path)).toBe(false);
      expect(() => encodeContainerArchive([file(path)])).toThrow(INVALID);
    },
  );

  it.each(['a/', 'a/\u001fb'])('rejects the canonical edge path %j', (path) => {
    expect(canonicalContainerPath(path)).toBe(false);
    expect(() => encodeContainerArchive([file(path)])).toThrow(INVALID);
  });

  it('accepts a nested UTF-8 path and round-trips a long PAX path', () => {
    const path = `dir/${'segment-'.repeat(18)}file.txt`;
    expect(canonicalContainerPath(path)).toBe(true);
    expect(decodeContainerArchive(encodeContainerArchive([file(path)]), 256 * 1024)).toEqual([
      file(path),
    ]);
  });

  it('rejects duplicate paths and file/implied-directory collisions', () => {
    expect(() => encodeContainerArchive([file('a.txt'), file('a.txt')])).toThrow(INVALID);
    expect(() => encodeContainerArchive([file('a'), file('a/b.txt')])).toThrow(INVALID);
    expect(encodeContainerArchive([file('a.txt'), file('b.txt')])).toBeInstanceOf(Buffer);
  });

  it('keeps dependency links separate from ordinary archive entries', () => {
    const archive = encodeContainerDependencyArchive([
      { path: 'node_modules/tool', mode: '120000', target: '../tool-real' },
    ]);
    expect(decodeContainerDependencyArchive(archive, 256 * 1024)).toEqual([
      { path: 'node_modules/tool', mode: '120000', target: '../tool-real' },
    ]);
    // The ordinary decoder rejects the dependency PAX linkpath before its later mode projection.
    expect(() => decodeContainerArchive(archive, 256 * 1024)).toThrow(UNSUPPORTED);
  });

  it('rejects Unicode control bytes while accepting valid UTF-8 paths', () => {
    const valid = 'café/naïve.txt';
    expect(canonicalContainerPath(valid)).toBe(true);
    expect(decodeContainerArchive(encodeContainerArchive([file(valid)]), 256 * 1024)).toEqual([
      file(valid),
    ]);
    for (const invalid of ['a/\u0001b', 'a/\u007fb', `a/${String.fromCharCode(0xd800)}b`]) {
      expect(canonicalContainerPath(invalid)).toBe(false);
      expect(() => encodeContainerArchive([file(invalid)])).toThrow(INVALID);
    }
  });

  it('round-trips the executable file mode without widening accepted modes', () => {
    const executable: ContainerArchiveEntry = {
      path: 'bin/tool',
      mode: '100755',
      bytes: Buffer.from('#!/bin/sh\n'),
    };
    expect(decodeContainerArchive(encodeContainerArchive([executable]), 256 * 1024)).toEqual([
      executable,
    ]);
  });

  it('emits deterministic ustar headers, sorted directory records, and terminal blocks', () => {
    const archive = encodeContainerArchive([file('z/nested/file.txt'), file('a/file.txt')]);
    const root = archive.subarray(0, 512);
    expect(root.subarray(0, 2).toString('utf8')).toBe('.\0');
    expect(root.subarray(100, 108).toString('ascii')).toBe('0000755\0');
    expect(root.subarray(257, 265).toString('hex')).toBe('7573746172003030');
    expect(archive.subarray(-1024).equals(Buffer.alloc(1024))).toBe(true);
    const text = archive.toString('utf8');
    expect(text.indexOf(' path=a\n')).toBeLessThan(text.indexOf(' path=z\n'));
    expect(text).toContain('PaxDirectory/0');
    expect(text).toContain(' path=z/nested\n');
    expect(text).toContain('directory-1');
    expect(text).toContain('PaxHeader/0');
    expect(text).toContain('entry-1');
  });

  it('retains an exact dependency link in PAX while keeping the ustar link field empty', () => {
    const target = 't'.repeat(100);
    const archive = encodeContainerDependencyArchive([
      { path: 'node_modules/tool', mode: '120000', target },
    ]);
    const link = headerOfType(archive, 0x32);
    expect(link.subarray(157, 257).equals(Buffer.alloc(100))).toBe(true);
    expect(archive.toString('utf8')).toContain(` linkpath=${target}\n`);
  });

  it('uses a self-consistent PAX length at the decimal digit boundary', () => {
    const path = 'x'.repeat(90);
    const archive = encodeContainerArchive([file(path)]);
    const pax = headerOfType(archive, 0x78);
    const size = Number.parseInt(pax.subarray(124, 136).toString('ascii').trim(), 8);
    const offset = archive.indexOf(pax) + 512;
    const record = archive.subarray(offset, offset + size).toString('utf8');
    expect(record).toBe(`${record.length} path=${path}\n`);
  });

  it('rejects an unsupported PAX attribute while accepting supported timestamps', () => {
    const valid = encodeContainerArchive([file('readme.txt')]);
    const supported = replaceFirstPax(
      valid,
      Buffer.concat([paxRecord('path', 'readme.txt'), paxRecord('mtime', '1')]),
    );
    expect(decodeContainerArchive(supported, 256 * 1024)).toEqual([file('readme.txt')]);
    const unsupported = replaceFirstPax(valid, paxRecord('comment', 'not-supported'));
    expect(() => decodeContainerArchive(unsupported, 256 * 1024)).toThrow(UNSUPPORTED);
  });

  it('rejects malformed PAX fields instead of treating them as paths', () => {
    const valid = encodeContainerArchive([file('readme.txt')]);
    const malformed = replaceFirstPax(valid, Buffer.from('4 path=bad\n'));
    expect(() => decodeContainerArchive(malformed, 256 * 1024)).toThrow(INVALID);
  });

  it('rejects a payload whose header claims bytes beyond the archive', () => {
    const valid = encodeContainerArchive([file('payload.bin', Buffer.from('payload'))]);
    expect(() => decodeContainerArchive(overdeclareFirstEntry(valid), 256 * 1024)).toThrow(INVALID);
    expect(decodeContainerArchive(valid, 256 * 1024)).toEqual([
      file('payload.bin', Buffer.from('payload')),
    ]);
  });

  it('decodes a bare ustar entry and rejects malformed text, numbers, modes, and links', () => {
    const bare = bareEntryArchive(encodeContainerArchive([file('payload', Buffer.from('x'))]));
    expect(decodeContainerArchive(bare, bare.length)).toEqual([
      { path: 'entry-0', mode: '100644', bytes: Buffer.from('x') },
    ]);

    const malformed: Buffer[] = [];
    const utf8 = Buffer.from(bare);
    utf8[0] = 0xff;
    checksum(utf8.subarray(0, 512));
    malformed.push(utf8);
    const size = Buffer.from(bare);
    size.fill(0, 124, 136);
    size.write('not-octal', 124, 'ascii');
    checksum(size.subarray(0, 512));
    malformed.push(size);
    const privileged = Buffer.from(bare);
    privileged.fill(0, 100, 108);
    privileged.write('0007000', 100, 'ascii');
    checksum(privileged.subarray(0, 512));
    malformed.push(privileged);
    const linked = Buffer.from(bare);
    linked.write('target', 157, 'utf8');
    checksum(linked.subarray(0, 512));
    malformed.push(linked);
    for (const archive of malformed)
      expect(() => decodeContainerArchive(archive, archive.length)).toThrow(INVALID);
  });

  it('retains a full-width ustar name when the field has no NUL terminator', () => {
    const bare = bareEntryArchive(encodeContainerArchive([file('payload', Buffer.from('x'))]));
    const name = 'n'.repeat(100);
    bare.write(name, 0, 100, 'ascii');
    checksum(bare.subarray(0, 512));
    expect(decodeContainerArchive(bare, bare.length)).toEqual([
      { path: name, mode: '100644', bytes: Buffer.from('x') },
    ]);
  });

  it('rejects malformed transport framing and dangling PAX state with the exact refusal', () => {
    const valid = encodeContainerArchive([file('payload')]);
    expect(() => decodeContainerArchive(valid, valid.length - 1)).toThrow(INVALID);
    expect(() => decodeContainerArchive(valid.subarray(0, -1), valid.length)).toThrow(INVALID);
    const dangling = valid.subarray(0, 1024 + 512);
    expect(() => decodeContainerArchive(dangling, dangling.length)).toThrow(INVALID);
  });

  it('covers distinct PAX, checksum, header, directory, and symlink refusal states', () => {
    const ordinary = encodeContainerArchive([file('dir/payload', Buffer.from('x'))]);
    const pax = headerOfType(ordinary, 0x78);
    const paxOffset = ordinary.indexOf(pax);
    const paxSize = Number.parseInt(pax.subarray(124, 136).toString('ascii').trim(), 8);
    const paxEnd = paxOffset + 512 + Math.ceil(paxSize / 512) * 512;

    const malformedPax = replaceFirstPax(ordinary, Buffer.from('missing-space'));
    expect(() => decodeContainerArchive(malformedPax, malformedPax.length)).toThrow(INVALID);

    const duplicatePax = Buffer.concat([
      ordinary.subarray(0, paxEnd),
      ordinary.subarray(paxOffset, paxEnd),
      ordinary.subarray(paxEnd),
    ]);
    expect(() => decodeContainerArchive(duplicatePax, duplicatePax.length)).toThrow(INVALID);

    const danglingPax = Buffer.concat([ordinary.subarray(0, paxEnd), Buffer.alloc(1024)]);
    expect(() => decodeContainerArchive(danglingPax, danglingPax.length)).toThrow(INVALID);

    const badChecksum = Buffer.from(ordinary);
    badChecksum[0] = (badChecksum[0] ?? 0) ^ 1;
    expect(() => decodeContainerArchive(badChecksum, badChecksum.length)).toThrow(INVALID);

    const prefixed = Buffer.from(headerOfType(ordinary, 0x30));
    prefixed.fill(0, 0, 100);
    prefixed.write('payload', 0, 'ascii');
    prefixed.fill(0, 345, 500);
    prefixed.write('dir', 345, 'ascii');
    checksum(prefixed);
    expect(decodeContainerArchive(singleHeaderArchive(prefixed, Buffer.from('x')), 2048)).toEqual([
      file('dir/payload', Buffer.from('x')),
    ]);

    const dotted = Buffer.from(prefixed);
    dotted.fill(0, 0, 100);
    dotted.fill(0, 345, 500);
    dotted.write('./payload', 0, 'ascii');
    checksum(dotted);
    expect(decodeContainerArchive(singleHeaderArchive(dotted, Buffer.from('x')), 2048)).toEqual([
      file('payload', Buffer.from('x')),
    ]);

    const invalidDirectory = Buffer.from(headerOfType(ordinary, 0x35, 1));
    expect(() =>
      decodeContainerArchive(singleHeaderArchive(invalidDirectory, Buffer.from('x')), 2048),
    ).toThrow(INVALID);

    const invalidType = Buffer.from(prefixed);
    invalidType[156] = 0x31;
    checksum(invalidType);
    expect(() => decodeContainerArchive(singleHeaderArchive(invalidType), 2048)).toThrow(INVALID);

    const dependency = encodeContainerDependencyArchive([
      { path: 'node_modules/tool', mode: '120000', target: '../tool-real' },
    ]);
    const invalidLink = Buffer.from(headerOfType(dependency, 0x32));
    invalidLink.fill(0, 157, 257);
    checksum(invalidLink);
    expect(() => decodeContainerDependencyArchive(singleHeaderArchive(invalidLink), 2048)).toThrow(
      INVALID,
    );

    const duplicateLink = replaceFirstPax(
      dependency,
      Buffer.concat([
        paxRecord('path', 'node_modules/tool'),
        paxRecord('linkpath', '../tool-real'),
        paxRecord('linkpath', '../tool-other'),
      ]),
    );
    expect(() => decodeContainerDependencyArchive(duplicateLink, duplicateLink.length)).toThrow(
      INVALID,
    );
  });

  it.each([
    Buffer.from('0 path=x\n'),
    Buffer.from('9 path=x'),
    Buffer.from('99 path=x\n'),
    Buffer.concat([paxRecord('path', 'a'), paxRecord('path', 'b')]),
  ])('rejects malformed PAX bytes %# with the exact refusal', (payload) => {
    const valid = encodeContainerArchive([file('readme.txt')]);
    expect(() => decodeContainerArchive(replaceFirstPax(valid, payload), 256 * 1024)).toThrow(
      INVALID,
    );
  });

  it('rejects an invalid ordinary archive mode at the public encoder boundary', () => {
    const malformed = {
      path: 'link',
      mode: '120000',
      bytes: Buffer.alloc(0),
    } as unknown as ContainerArchiveEntry;
    expect(() => encodeContainerArchive([malformed])).toThrow(INVALID);
    expect(() => encodeContainerArchive([file('valid'), malformed])).toThrow(INVALID);
  });
});
