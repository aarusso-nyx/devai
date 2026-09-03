import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeReadOnlySync, fstatSync, openReadOnlyNoFollowSync } from '../../src/index.js';

describe('read-only no-follow host seam', () => {
  it('opens the exact regular-file inode without an authority mutation scope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-readonly-host-'));
    const path = join(directory, 'record.json');
    writeFileSync(path, '{}\n');
    const descriptor = openReadOnlyNoFollowSync(path);
    try {
      expect(fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      closeReadOnlySync(descriptor);
    }
  });

  it('refuses a symlink at the opened leaf', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devai-readonly-host-'));
    const target = join(directory, 'record.json');
    const link = join(directory, 'record-link.json');
    writeFileSync(target, '{}\n');
    symlinkSync(target, link);
    expect(() => openReadOnlyNoFollowSync(link)).toThrow();
  });
});
