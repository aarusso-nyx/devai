#!/usr/bin/env node
/**
 * Materialize law/constitution.md into dist/ at build time.
 *
 * `constitution-binding` mechanics compare an adopter's vendored copy
 * against the canonical text the installed @devai-nyx/skills package
 * carries. Versioned-package consumption (D-117/D-118's canonical
 * model) means that text has to ship IN the package, the way
 * @devai-nyx/schemas dereferences law/schemas into dist/schemas — the
 * repo root is not on disk for a package installed from GitHub
 * Packages.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PKG_ROOT));
const src = join(REPO_ROOT, 'law/constitution.md');
const dest = join(PKG_ROOT, 'dist/law/constitution.md');

if (!existsSync(src)) {
  console.error(`copy-constitution: source missing: ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied law/constitution.md → ${dest}`);
