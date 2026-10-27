import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseProofIndex, planProofIndexUpdate } from '../../src/boundaries/proof-index-codec.js';

type Format = 'sha1' | 'sha256';
const proof = 'record/proofs/chain.json';
function extension(payload: Buffer, signature = 'REUC'): Buffer {
  const header = Buffer.alloc(8);
  header.write(signature);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function row(format: Format, path = 'ordinary.txt', modes = ['100644', '0', '100755']): Buffer {
  return Buffer.concat([
    Buffer.from(`${path}\0${modes.join('\0')}\0`),
    ...modes.filter((mode) => mode !== '0').map(() => Buffer.alloc(format === 'sha1' ? 20 : 32, 7)),
  ]);
}
function index(format: Format, extensions: Buffer[] = []): Buffer {
  const size = format === 'sha1' ? 20 : 32;
  const entries = ['ordinary.txt', proof].map((path, i) => {
    const bytes = Buffer.alloc(Math.ceil((42 + size + Buffer.byteLength(path) + 1) / 8) * 8);
    bytes.writeUInt32BE(0o100644, 24);
    Buffer.alloc(size, i + 1).copy(bytes, 40);
    bytes.writeUInt16BE(Buffer.byteLength(path) | (i === 0 ? 0x8000 : 0), 40 + size);
    bytes.write(path, 42 + size);
    return bytes;
  });
  const header = Buffer.alloc(12);
  header.write('DIRC');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries, ...extensions]);
  return Buffer.concat([body, createHash(format).update(body).digest()]);
}

describe.each(['sha1', 'sha256'] as const)('resolve-undo custody with %s', (format) => {
  it('preserves exact extension bytes, other entries and checksum while replacing the proof', () => {
    const reuc = extension(row(format));
    const before = index(format, [reuc]);
    const snapshot = parseProofIndex(before, format);
    expect(snapshot.semantic_sha256).toBe(parseProofIndex(index(format), format).semantic_sha256);
    const update = planProofIndexUpdate(before, format, {
      path: proof,
      mode: '100644',
      oid: 'a'.repeat(format === 'sha1' ? 40 : 64),
    });
    const after = Buffer.from(update.bytes_base64, 'base64');
    const checksumLength = format === 'sha1' ? 20 : 32;
    expect(after.subarray(-checksumLength - reuc.length, -checksumLength)).toEqual(reuc);
    expect(after.subarray(-checksumLength)).toEqual(
      createHash(format).update(after.subarray(0, -checksumLength)).digest(),
    );
    expect(update.after.other_entries_sha256).toBe(update.before.other_entries_sha256);
    expect(update.after.entries[0]?.assume_valid).toBe(true);
  });
  it('rejects malformed, protected, aliased, unsupported and unknown extension data', () => {
    const payload = row(format);
    const cases = [
      [extension(payload), extension(payload)],
      [extension(Buffer.concat([payload, payload]))],
      [extension(Buffer.from('abc'))],
      [extension(row(format, '../x'))],
      [extension(Buffer.from([255, 0]))],
      [extension(row(format, 'a', ['40000', '0', '100644']))],
      [extension(row(format, 'a', ['0100644', '0', '100644']))],
      [extension(payload.subarray(0, -1))],
      [
        extension(
          Buffer.concat([
            Buffer.from('a\0' + '100644\0' + '0\0' + '0\0'),
            Buffer.alloc(format === 'sha1' ? 20 : 32),
          ]),
        ),
      ],
      [extension(row(format, 'a', ['0', '0', '0']))],
      ...[
        proof,
        'law/security/authorization.json',
        'RECORD/proofs/chain.json',
        'LAW/security/authorization.json',
        'record/proofſ/chain.json',
        'law/ſecurity/authorization.json',
        'ordinary-é.txt',
        'ordinary\x1f.txt',
        'ordinary\x7f.txt',
        'a'.repeat(4097),
      ].map((path) => [extension(row(format, path))]),
      [extension(payload, 'ABCD')],
    ];
    for (const extensions of cases)
      expect(() => parseProofIndex(index(format, extensions), format)).toThrow();
    const corrupted = index(format, [extension(payload)]);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => parseProofIndex(corrupted, format)).toThrow();
    expect(() =>
      planProofIndexUpdate(index(format, [extension(payload)]), format, {
        path: 'ordinary.txt' as typeof proof,
        mode: '100644',
        oid: 'a'.repeat(format === 'sha1' ? 40 : 64),
      }),
    ).toThrow();
  });
});
