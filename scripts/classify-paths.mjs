#!/usr/bin/env node

// Classifies repository paths read from stdin against a change-taxonomy
// binding (ADR-GOV-0017). Prints every unclassified path. Exits 1 when two
// bindings match one path (overlap is a load error, never a precedence rule),
// when a binding names a class outside the law vocabulary, or, with
// --require-all, when any path remains unclassified.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const bindingPath = args[args.indexOf('--binding') + 1];
if (!args.includes('--binding') || bindingPath === undefined) {
  process.stderr.write('usage: classify-paths.mjs --binding <file> [--require-all] < paths\n');
  process.exit(64);
}
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const binding = readJson(bindingPath);
const taxonomy = readJson(binding.taxonomy ?? 'law/policy/change-taxonomy.json');
const classes = Object.keys(taxonomy.classes);
const entries = binding.bindings;
const label = (entry) => `${entry.selector.kind}:${entry.selector.pattern}`;
const fail = (code, detail) => {
  process.stderr.write(`${code}:${detail}\n`);
  process.exit(1);
};
// Mirrors globExpression in packages/cli/src/services/check-runner/policy.ts.
function globExpression(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      expression += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}
const matches = ({ kind, pattern }, path) =>
  kind === 'exact'
    ? path === pattern
    : kind === 'prefix'
      ? path.startsWith(pattern)
      : globExpression(pattern).test(path);

for (const entry of entries) {
  if (!classes.includes(entry.class)) fail('DEVAI_CHANGE_TAXONOMY_CLASS_UNKNOWN', entry.class);
}
// Static overlap between exact and prefix selectors; globs are checked against the input paths.
for (const [index, left] of entries.entries()) {
  for (const right of entries.slice(index + 1)) {
    const [l, r] = [left.selector, right.selector];
    if (l.kind === 'glob' || r.kind === 'glob') continue;
    const overlap =
      (l.kind === 'prefix' && r.pattern.startsWith(l.pattern)) ||
      (r.kind === 'prefix' && l.pattern.startsWith(r.pattern)) ||
      l.pattern === r.pattern;
    if (overlap) fail('DEVAI_CHANGE_TAXONOMY_OVERLAP', `${label(left)} ${label(right)}`);
  }
}
const paths = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');
const unclassified = [];
for (const path of paths) {
  const hits = entries.filter((entry) => matches(entry.selector, path));
  if (hits.length > 1) fail('DEVAI_CHANGE_TAXONOMY_OVERLAP', [path, ...hits.map(label)].join(' '));
  if (hits.length === 0) unclassified.push(path);
}
for (const path of unclassified) process.stdout.write(`${path}\n`);
const verdict = unclassified.length === 0 ? 'PASS' : 'FAIL';
const counts = `${String(paths.length)} paths, ${String(unclassified.length)} unclassified`;
process.stdout.write(`change taxonomy: ${verdict} (${counts})\n`);
if (args.includes('--require-all') && unclassified.length > 0) process.exit(1);
