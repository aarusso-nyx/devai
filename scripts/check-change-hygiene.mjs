#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import lintStaged from 'lint-staged';

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
if (!passed) process.exit(1);
const whitespace = spawnSync('git', ['diff', '--cached', '--check'], { stdio: 'inherit' });
process.exitCode = whitespace.status ?? 1;
