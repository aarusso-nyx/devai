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

describe('container archive security boundaries', () => {
  it.each(['/absolute', 'a\\b', 'a/../b', 'a/./b', 'a//b', ''])(
    'rejects unsafe path %j',
    (path) => {
      expect(canonicalContainerPath(path)).toBe(false);
      expect(() => encodeContainerArchive([file(path)])).toThrow(INVALID);
    },
  );

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

  it('rejects an invalid ordinary archive mode at the public encoder boundary', () => {
    const malformed = {
      path: 'link',
      mode: '120000',
      bytes: Buffer.alloc(0),
    } as unknown as ContainerArchiveEntry;
    expect(() => encodeContainerArchive([malformed])).toThrow(INVALID);
  });
});
