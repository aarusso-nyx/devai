#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  allowedTypesLine,
  classifyPaths,
  describeClasses,
  gitIn,
  judgeCommit,
  loadGrammar,
  loadTaxonomy,
  repositoryRoot,
  subjectOf,
  suggestSplit,
} from './check-commit-range.mjs';

// Two modes (ADR-GOV-0018):
// - no argument (pre-commit): lint-staged, whitespace check, then reject a
//   staged set whose classes span more than one family.
// - --commit-msg <file> (commit-msg): validate the subject against the commit
//   grammar and reject a type whose allowed classes do not cover the classes
//   of the staged paths; pre-commit cannot do this because it has no message.
// Classification reads the taxonomy and binding JSON directly (see
// check-commit-range.mjs), so it works before any package is built. A
// repository without those files skips classification.

const root = repositoryRoot();
const stagedPaths = () =>
  gitIn(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
    .split('\0')
    .filter(Boolean);

function commitMsg(messageFile) {
  const grammar = loadGrammar(root);
  if (grammar === null) return 0;
  const message = readFileSync(messageFile, 'utf8');
  const subject = subjectOf(message);
  // Merges, reverts, and autosquash markers are judged by the range check.
  const mergeInProgress =
    spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root }).status === 0;
  const revertPrefix = grammar.exemptions?.reverts?.subject_prefix ?? 'Revert ';
  if (
    mergeInProgress ||
    subject.startsWith(revertPrefix) ||
    /^(fixup|squash|amend)! /u.test(subject)
  ) {
    return 0;
  }
  const taxonomy = loadTaxonomy(root);
  const classification = taxonomy === null ? null : classifyPaths(taxonomy, stagedPaths());
  const findings = judgeCommit({ grammar, classification, subject });
  if (findings.length === 0) return 0;
  process.stderr.write(
    `commit-msg: REJECTED\n${findings.map((line) => `  ${line}`).join('\n')}\n  ${allowedTypesLine(grammar)}\n`,
  );
  return 1;
}

async function preCommit() {
  const { default: lintStaged } = await import('lint-staged');
  // Keep lint-staged's backup, partial staging and rollback defaults. A single
  // sequential task list avoids ESLint/Prettier racing over the same index entry.
  const passed = await lintStaged({
    concurrent: false,
    config: {
      '*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}': [
        'eslint --fix --max-warnings=0 --no-warn-ignored',
        'prettier --write --ignore-unknown',
      ],
      '!(*.{js,cjs,mjs,jsx,ts,cts,mts,tsx})': 'prettier --write --ignore-unknown',
    },
  });
  if (!passed) return 1;
  const whitespace = spawnSync('git', ['diff', '--cached', '--check'], { stdio: 'inherit' });
  if (whitespace.status !== 0) return whitespace.status ?? 1;
  const taxonomy = loadTaxonomy(root);
  if (taxonomy === null) return 0;
  const classification = classifyPaths(taxonomy, stagedPaths());
  if (!classification.mixed) return 0;
  const lines = [
    `pre-commit: REJECTED staged paths span ${String(classification.families.length)} families (${classification.families.join(', ')})`,
    ...describeClasses(classification),
    ...suggestSplit(classification),
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
  return 1;
}

const flag = process.argv.indexOf('--commit-msg');
process.exitCode = flag === -1 ? await preCommit() : commitMsg(process.argv[flag + 1]);
