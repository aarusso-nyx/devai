import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { auditDocumentationLinks } from '../../src/commands/docs/links.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave53-docs-links-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe('documentation link walker protocol and link boundaries', () => {
  it('skips external protocols while reporting normal, nested, and root links', () => {
    const root = fixtureRoot();
    write(
      root,
      'docs/index.md',
      [
        '[normal](missing.md)',
        '[http](http://example.invalid/missing)',
        '[https](https://example.invalid/missing)',
        '[mail](mailto:docs@example.invalid)',
        '[data](data:text/plain,missing)',
        '[anchor](#missing-section)',
      ].join('\n'),
    );
    write(root, 'docs/guide/guide.md', '[nested](../missing-nested.md)\n');
    write(root, 'README.md', '[root](missing-root.md)\n');

    const broken = auditDocumentationLinks(root, join(root, 'docs'));
    expect(broken).toHaveLength(3);
    expect(broken).toEqual(
      expect.arrayContaining([
        {
          source: 'docs/index.md',
          target: 'missing.md',
          resolved: 'docs/missing.md',
          reason: 'target not found',
        },
        {
          source: 'docs/guide/guide.md',
          target: '../missing-nested.md',
          resolved: 'docs/missing-nested.md',
          reason: 'target not found',
        },
        {
          source: 'README.md',
          target: 'missing-root.md',
          resolved: 'missing-root.md',
          reason: 'target not found',
        },
      ]),
    );
  });
});

describe('documentation link walker directory exclusions', () => {
  it('skips exact generated directory names but scans similarly named directories', () => {
    const root = fixtureRoot();
    for (const directory of ['node_modules', '.git', 'dist', 'coverage']) {
      write(root, `docs/${directory}/broken.md`, `[broken](missing-${directory}.md)\n`);
    }
    write(root, 'docs/node_modules-copy/broken.md', '[broken](missing-similar.md)\n');

    const broken = auditDocumentationLinks(root, join(root, 'docs'));
    expect(broken).toEqual([
      {
        source: 'docs/node_modules-copy/broken.md',
        target: 'missing-similar.md',
        resolved: 'docs/node_modules-copy/missing-similar.md',
        reason: 'target not found',
      },
    ]);
  });
});

describe('documentation link walker scoped generated paths', () => {
  it('skips direct and nested docs/theory/papers/out paths', () => {
    const root = fixtureRoot();
    write(root, 'docs/theory/papers/out/direct.md', '[broken](missing-direct.md)\n');
    write(root, 'docs/generated/docs/theory/papers/out/nested.md', '[broken](missing-nested.md)\n');

    expect(auditDocumentationLinks(root, join(root, 'docs'))).toEqual([]);
  });
});
