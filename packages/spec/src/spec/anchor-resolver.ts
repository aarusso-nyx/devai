import { readFileSync } from 'node:fs';

/**
 * Extract GitHub-flavored heading slugs from a markdown source.
 *
 * Heading line → text → lowercase → strip non-alnum-space-dash →
 * collapse whitespace to single dash. Matches GitHub's approximation
 * closely enough for authority-anchor resolution. Headings of any
 * level (`#` through `######`) are included.
 */
export function extractHeadingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const lines = markdown.split('\n');
  for (const line of lines) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[1] ?? '';
    const slug = slugify(text);
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Returns true if the anchor resolves either as a heading slug or by
 * literal match against any heading text (lowercased). Defensive: if the
 * doc file cannot be read, returns false so callers report an error.
 */
export function anchorExists(docPath: string, anchor: string): boolean {
  let text: string;
  try {
    text = readFileSync(docPath, 'utf8');
  } catch {
    return false;
  }
  const slugs = extractHeadingSlugs(text);
  return slugs.has(anchor) || slugs.has(slugify(anchor));
}
