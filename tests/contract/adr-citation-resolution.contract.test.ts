import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function filesUnder(path: string, pattern: RegExp): readonly string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('named ADR citation resolution', () => {
  it('binds every named source or schema citation to law or adopter documentation', () => {
    const sourceFiles = [
      ...filesUnder(join(root, 'packages'), /\.[cm]?[jt]sx?$/u),
      ...filesUnder(join(root, 'law/schemas'), /\.json$/u),
    ].filter((path) => path.includes('/src/') || path.includes('/law/schemas/'));
    const docs = filesUnder(join(root, 'docs'), /\.md$/u)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const lawFiles = readdirSync(join(root, 'law/adr'));
    const unresolved: string[] = [];
    for (const path of sourceFiles) {
      const text = readFileSync(path, 'utf8');
      const ids = text.match(/\bADR-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/gu) ?? [];
      for (const id of new Set(ids)) {
        if (id === 'ADR-NNN') continue;
        const lawRecord = lawFiles.some((name) => name === `${id}.md` || name.startsWith(`${id}-`));
        if (!lawRecord && !docs.includes(id)) unresolved.push(`${relative(root, path)}: ${id}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});
