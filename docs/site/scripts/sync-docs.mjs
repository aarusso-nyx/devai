#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '../..');
const output = join(siteRoot, 'docs');
const githubBlob = 'https://github.com/aarusso-nyx/devai/blob/main/';
const views = [
  ['docs/start', 'start'],
  ['docs/theory', 'theory'],
  ['docs/roles', 'roles'],
  ['docs/adopters', 'adopters'],
  ['docs/dev', 'dev'],
  ['docs/reference', 'reference'],
];
const publishMap = new Map();

async function collectPublished(source, target) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(target, entry.name === 'README.md' ? 'index.md' : entry.name);
    if (entry.isDirectory()) await collectPublished(src, dst);
    else if (/\.(?:md|mdx)$/u.test(entry.name)) publishMap.set(src, dst);
  }
}

function rewritePublishedLinks(content, source, target) {
  return content.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/gu, (whole, open, raw, close) => {
    if (/^(?:https?:|mailto:|data:|#|\/)/u.test(raw)) return whole;
    const match = raw.match(/^([^#?]+)(.*)$/u);
    if (!match) return whole;
    const [, pathPart, suffix] = match;
    const resolved = resolve(dirname(source), pathPart);
    const mapped =
      publishMap.get(resolved) ??
      publishMap.get(join(resolved, 'README.md')) ??
      publishMap.get(join(resolved, 'index.md'));
    if (mapped !== undefined) {
      let rel = relative(dirname(target), mapped).replaceAll('\\', '/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${open}${rel}${suffix}${close}`;
    }
    if (resolved.startsWith(repoRoot) && !resolved.startsWith(siteRoot)) {
      const repoRel = relative(repoRoot, resolved).replaceAll('\\', '/');
      return `${open}${githubBlob}${repoRel}${suffix}${close}`;
    }
    return whole;
  });
}

async function copyMarkdownTree(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(target, entry.name === 'README.md' ? 'index.md' : entry.name);
    if (entry.isDirectory()) await copyMarkdownTree(src, dst);
    else if (/\.(?:md|mdx)$/u.test(entry.name)) {
      const content = await fs.readFile(src, 'utf8');
      await fs.writeFile(dst, rewritePublishedLinks(content, src, dst));
    } else if (/\.json$/u.test(entry.name)) await fs.copyFile(src, dst);
  }
}

await fs.rm(output, { recursive: true, force: true });
for (const [source, target] of views) {
  await collectPublished(join(repoRoot, source), join(output, target));
}
for (const [source, target] of views) {
  await copyMarkdownTree(join(repoRoot, source), join(output, target));
}
