#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const sourceRoot = join(repositoryRoot, 'law/policy');
const targetRoot = join(packageRoot, 'dist/law/policy');
const files = [
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'scorecard-na.json',
  'thresholds.json',
];

mkdirSync(targetRoot, { recursive: true });
for (const file of files) {
  const source = join(sourceRoot, file);
  if (!existsSync(source)) {
    console.error(`copy-policy: source missing: ${source}`);
    process.exit(1);
  }
  copyFileSync(source, join(targetRoot, file));
}
console.log(`copied ${String(files.length)} canonical policy files → ${targetRoot}`);
