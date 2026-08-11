import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CAC } from 'cac';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

const DEFAULT_REPO_ROOT = process.cwd();
const DEFAULT_DIR = 'docs';

interface Options {
  readonly repoRoot?: string;
  readonly dir?: string;
  readonly human?: boolean;
}

export interface BrokenLink {
  readonly source: string;
  readonly target: string;
  readonly resolved: string | null;
  readonly reason: string;
}

const SKIP_PROTOCOLS = ['http://', 'https://', 'mailto:', 'data:', '#'];

function isExternal(target: string): boolean {
  return SKIP_PROTOCOLS.some((p) => target.startsWith(p));
}

// Path suffixes the walker MUST skip. Pre-empts false-positives from
// gitignored generated trees whose intra-file refs are produced by
// upstream pipelines (e.g. pandoc preprocessing) that flatten relative
// paths in ways the docs-links checker has no business adjudicating.
// Path-suffix match (not bare name) so the skip is scoped — `out/` is
// too generic to flat-name-match.
const SKIP_PATH_SUFFIXES = [
  'docs/theory/papers/out',
  // R13 W05: docs/site/ is the Docusaurus site root. docs/site/docs/ is
  // a build-time copy of the canonical docs/ tree, populated by
  // docs/site/scripts/sync-docs.mjs as a `prebuild` step. Scanning it
  // re-reports every link from the canonical sources at a translated
  // resolution that won't survive the copy (e.g. links to ../schemas/
  // resolve outside the site root). Ignore the site's docs/ tree;
  // canonical docs/ is still scanned.
  'docs/site/docs',
  'docs/site/build',
  'docs/site/.docusaurus',
  'docs/site/node_modules',
  // R14 W05: Docusaurus versioned-docs introduces docs/site/versioned_docs/
  // (per-version snapshots) and docs/site/versioned_sidebars/ (per-version
  // sidebar configs). The snapshots reference paths at their version's
  // historical filesystem state — those don't resolve against the live
  // post-amendment tree. Snapshot integrity is a different gate (the
  // versioned-docs init is one-shot; subsequent changes don't drift).
  'docs/site/versioned_docs',
  'docs/site/versioned_sidebars',
  // R30: byte-frozen pre-v1 monoliths retain links relative to their
  // original root location. Their bytes are governed by archive-immutability.
  'law/adr/archive',
];

function walk(dir: string, repoRoot: string, found: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'coverage')
      continue;
    const full = join(dir, name);
    const rel = relative(repoRoot, full);
    if (SKIP_PATH_SUFFIXES.some((s) => rel === s || rel.endsWith(`/${s}`))) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, repoRoot, found);
    } else if (st.isFile() && full.endsWith('.md')) {
      found.push(full);
    }
  }
}

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function auditDocumentationLinks(repoRoot: string, scanDir: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const files: string[] = [];
  walk(scanDir, repoRoot, files);
  // R17.C.6 (D-131): root-level markdown (README.md, CONTRIBUTING.md,
  // CLAUDE.md, AGENTS.md) is part of the published reference surface, but
  // the walker only descended into the scan dir — README's dead links to
  // docs/adopters/* reported OK for weeks. Scan repo-root *.md files
  // non-recursively in addition to the subtree.
  if (resolve(scanDir) !== resolve(repoRoot)) {
    let rootEntries: string[] = [];
    try {
      rootEntries = readdirSync(repoRoot);
    } catch {
      rootEntries = [];
    }
    for (const name of rootEntries) {
      if (!name.endsWith('.md')) continue;
      const full = join(repoRoot, name);
      try {
        if (statSync(full).isFile()) files.push(full);
      } catch {
        continue;
      }
    }
  }
  for (const file of files) {
    const source = relative(repoRoot, file);
    if (source === 'law/register/DECISIONS.md') continue;
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(text)) !== null) {
      const target = m[2];
      if (target === undefined || target.length === 0) continue;
      if (isExternal(target)) continue;
      // Strip in-page anchors and querystrings.
      const pathPart = target.split('#')[0]?.split('?')[0] ?? '';
      if (pathPart.length === 0) continue;
      let resolved = isAbsolute(pathPart) ? pathPart : resolve(dirname(file), pathPart);
      if (
        !existsSync(resolved) &&
        /^docs\/meta\/adr\/D-[0-9]+\.md$/u.test(source) &&
        /^(?:docs|packages|scripts)\//u.test(pathPart)
      ) {
        resolved = resolve(repoRoot, pathPart);
      }
      if (!existsSync(resolved)) {
        broken.push({
          source,
          target,
          resolved: relative(repoRoot, resolved),
          reason: 'target not found',
        });
      }
    }
  }
  return broken;
}

export const docsLinks = defineCommand({
  name: 'docs links',
  description:
    'Audit markdown cross-references across docs/** plus root-level markdown (README.md, CONTRIBUTING.md, ...). Reports broken file links; in-page anchors are not checked.',
  authority: 'mesh_controller',
  register(cli: CAC): void {
    cli
      .command('docs-links', 'Audit markdown cross-references for broken links')
      .option('--repo-root <path>', `Repo root (default: ${DEFAULT_REPO_ROOT})`)
      .option('--dir <path>', `Subtree to audit (default: ${DEFAULT_DIR})`)
      .option('--human', 'Human-readable output')
      .action((options: Options) => {
        const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
        const scanDir = resolve(repoRoot, options.dir ?? DEFAULT_DIR);
        if (!existsSync(scanDir)) {
          process.stderr.write(`devai docs links: ${scanDir} not found\n`);
          process.exit(EXIT_FAIL);
        }
        const broken = auditDocumentationLinks(repoRoot, scanDir);
        if (options.human === true) {
          if (broken.length === 0) {
            process.stdout.write(`docs links: OK (${scanDir})\n`);
          } else {
            process.stdout.write(`docs links: ${String(broken.length)} broken link(s)\n`);
            for (const b of broken) {
              process.stdout.write(`  ${b.source} → ${b.target}  (${b.reason})\n`);
            }
          }
        } else {
          process.stdout.write(
            JSON.stringify({ ok: broken.length === 0, broken_count: broken.length, broken }) + '\n',
          );
        }
        process.exit(broken.length === 0 ? EXIT_PASS : EXIT_FAIL);
      });
  },
});
