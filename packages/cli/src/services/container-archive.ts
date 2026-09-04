/** Bounded archive transport for protected containers, never a filesystem extractor. */
export interface ContainerArchiveEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly bytes: Buffer;
}

/** Accepted only for separately validated, read-only dependency transport. */
export type ContainerDependencyArchiveEntry =
  | ContainerArchiveEntry
  | { readonly path: string; readonly mode: '120000'; readonly target: string };

export function canonicalContainerPath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.from(value, 'utf8').toString('utf8') === value &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function octal(header: Buffer, offset: number, width: number, value: number): void {
  const encoded = value.toString(8).padStart(width - 1, '0');
  if (!Number.isSafeInteger(value) || value < 0 || encoded.length >= width) {
    throw new Error('release-certification-archive-invalid');
  }
  header.write(encoded, offset, width - 1, 'ascii');
}

function header(
  path: string,
  mode: number,
  size: number,
  directory: boolean,
  link?: string,
  pax = false,
): Buffer {
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const splits = [...path.matchAll(/\//gu)].map((match) => match.index);
    const split = splits.findLast(
      (index) =>
        Buffer.byteLength(path.slice(0, index)) <= 155 &&
        Buffer.byteLength(path.slice(index + 1)) <= 100,
    );
    if (split === undefined) throw new Error('release-certification-archive-path-unsupported');
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  const value = Buffer.alloc(512);
  value.write(name, 0, 100, 'utf8');
  octal(value, 100, 8, mode);
  octal(value, 108, 8, 10001);
  octal(value, 116, 8, 10001);
  octal(value, 124, 12, size);
  octal(value, 136, 12, 0);
  value.fill(0x20, 148, 156);
  value[156] = pax ? 0x78 : directory ? 0x35 : link === undefined ? 0x30 : 0x32;
  if (link !== undefined) {
    if (Buffer.byteLength(link) > 100) throw new Error('release-certification-archive-invalid');
    value.write(link, 157, 100, 'utf8');
  }
  value.write('ustar\0', 257, 6, 'ascii');
  value.write('00', 263, 2, 'ascii');
  value.write(prefix, 345, 155, 'utf8');
  octal(
    value,
    148,
    8,
    value.reduce((sum, byte) => sum + byte, 0),
  );
  return value;
}

export function encodeContainerArchive(entries: readonly ContainerArchiveEntry[]): Buffer {
  if (entries.some((entry) => entry.mode !== '100644' && entry.mode !== '100755'))
    throw new Error('release-certification-archive-invalid');
  return encodeTransport(entries);
}

export function encodeContainerDependencyArchive(
  entries: readonly ContainerDependencyArchiveEntry[],
): Buffer {
  return encodeTransport(entries);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

function encodeTransport(entries: readonly ContainerDependencyArchiveEntry[]): Buffer {
  const seen = new Set<string>();
  const directories = new Set<string>();
  for (const entry of entries) {
    if (!canonicalContainerPath(entry.path) || seen.has(entry.path)) {
      throw new Error('release-certification-archive-invalid');
    }
    seen.add(entry.path);
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  if ([...directories].some((path) => seen.has(path))) {
    throw new Error('release-certification-archive-invalid');
  }
  const chunks = [header('.', 0o755, 0, true)];
  for (const [index, path] of [...directories].sort().entries()) {
    const pax = paxRecord('path', path);
    chunks.push(
      header(`PaxDirectory/${index}`, 0o644, pax.length, false, undefined, true),
      pax,
      Buffer.alloc((512 - (pax.length % 512)) % 512),
      header(`directory-${index}`, 0o755, 0, true),
    );
  }
  for (const [index, entry] of entries.entries()) {
    const payload = entry.mode === '120000' ? Buffer.alloc(0) : entry.bytes;
    const link = entry.mode === '120000' ? entry.target : undefined;
    const pax = Buffer.concat([
      paxRecord('path', entry.path),
      ...(link === undefined ? [] : [paxRecord('linkpath', link)]),
    ]);
    chunks.push(
      header(`PaxHeader/${index}`, 0o644, pax.length, false, undefined, true),
      pax,
      Buffer.alloc((512 - (pax.length % 512)) % 512),
      header(
        `entry-${index}`,
        entry.mode === '100755' ? 0o755 : 0o644,
        payload.length,
        false,
        link === undefined ? undefined : '',
      ),
      payload,
      Buffer.alloc((512 - (payload.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function text(header: Buffer, offset: number, width: number): string {
  const field = header.subarray(offset, offset + width);
  const terminator = field.indexOf(0);
  const bytes = terminator < 0 ? field : field.subarray(0, terminator);
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    throw new Error('release-certification-archive-invalid');
  }
  return value;
}

function number(header: Buffer, offset: number, width: number): number {
  const value = text(header, offset, width).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error('release-certification-archive-invalid');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error('release-certification-archive-invalid');
  return parsed;
}

function paxFields(bytes: Buffer, links: boolean): { path?: string; link?: string } {
  let offset = 0;
  let path: string | undefined;
  let link: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < offset) throw new Error('release-certification-archive-invalid');
    const rawLength = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/u.test(rawLength)) throw new Error('release-certification-archive-invalid');
    const length = Number(rawLength);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > bytes.length
    ) {
      throw new Error('release-certification-archive-invalid');
    }
    const fieldBytes = bytes.subarray(space + 1, offset + length);
    const field = fieldBytes.toString('utf8');
    if (!field.endsWith('\n') || !Buffer.from(field).equals(fieldBytes))
      throw new Error('release-certification-archive-invalid');
    const equals = field.indexOf('=');
    const key = field.slice(0, equals);
    if (key === 'path') {
      if (path !== undefined) throw new Error('release-certification-archive-invalid');
      path = field.slice(equals + 1, -1);
    } else if (key === 'linkpath' && links) {
      if (link !== undefined) throw new Error('release-certification-archive-invalid');
      link = field.slice(equals + 1, -1);
    } else if (!['atime', 'ctime', 'mtime'].includes(key)) {
      throw new Error('release-certification-archive-attribute-unsupported');
    }
    offset += length;
  }
  return { ...(path === undefined ? {} : { path }), ...(link === undefined ? {} : { link }) };
}

export function decodeContainerArchive(
  bytes: Buffer,
  maximumBytes: number,
): readonly ContainerArchiveEntry[] {
  return decodeTransport(bytes, maximumBytes, false).map((entry) => {
    if (entry.mode === '120000') throw new Error('release-certification-archive-invalid');
    return entry;
  });
}

export function decodeContainerDependencyArchive(
  bytes: Buffer,
  maximumBytes: number,
): readonly ContainerDependencyArchiveEntry[] {
  return decodeTransport(bytes, maximumBytes, true);
}

function decodeTransport(
  bytes: Buffer,
  maximumBytes: number,
  links: boolean,
): readonly ContainerDependencyArchiveEntry[] {
  if (bytes.length > maximumBytes || bytes.length % 512 !== 0) {
    throw new Error('release-certification-archive-invalid');
  }
  const entries: ContainerDependencyArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let extendedPath: string | undefined;
  let extendedLink: string | undefined;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (
        extendedPath !== undefined ||
        extendedLink !== undefined ||
        bytes.subarray(offset).some((byte) => byte !== 0)
      ) {
        throw new Error('release-certification-archive-invalid');
      }
      return entries.sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      );
    }
    const checksum = number(block, 148, 8);
    const expected = block.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    if (checksum !== expected) throw new Error('release-certification-archive-invalid');
    const size = number(block, 124, 12);
    const end = offset + 512 + size;
    if (end > bytes.length) throw new Error('release-certification-archive-invalid');
    const payload = bytes.subarray(offset + 512, end);
    offset = end + ((512 - (size % 512)) % 512);
    const type = block[156];
    if (type === 0x78) {
      if (extendedPath !== undefined || extendedLink !== undefined)
        throw new Error('release-certification-archive-invalid');
      const fields = paxFields(payload, links);
      extendedPath = fields.path;
      extendedLink = fields.link;
      continue;
    }
    const prefix = text(block, 345, 155);
    let path = extendedPath ?? `${prefix === '' ? '' : `${prefix}/`}${text(block, 0, 100)}`;
    const link = extendedLink ?? text(block, 157, 100);
    extendedPath = undefined;
    extendedLink = undefined;
    if (path.startsWith('./')) path = path.slice(2);
    if (type === 0x35) {
      path = path.replace(/\/$/u, '');
      if (path === '' || path === '.') continue;
      if (!canonicalContainerPath(path) || size !== 0)
        throw new Error('release-certification-archive-invalid');
      continue;
    }
    if (
      (type !== 0 && type !== 0x30 && !(links && type === 0x32)) ||
      !canonicalContainerPath(path) ||
      seen.has(path)
    ) {
      throw new Error('release-certification-archive-invalid');
    }
    seen.add(path);
    const mode = number(block, 100, 8);
    if ((mode & 0o7000) !== 0) throw new Error('release-certification-archive-invalid');
    if (type === 0x32) {
      if (size !== 0 || link === '' || /[\0\r\n]/u.test(link))
        throw new Error('release-certification-archive-invalid');
      entries.push({ path, mode: '120000', target: link });
    } else {
      if (link !== '') throw new Error('release-certification-archive-invalid');
      entries.push({
        path,
        mode: (mode & 0o111) === 0 ? '100644' : '100755',
        bytes: Buffer.from(payload),
      });
    }
  }
  throw new Error('release-certification-archive-invalid');
}
