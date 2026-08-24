#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  'domains.json',
  'forbidden-actions.json',
  'glob-guards.json',
  'scorecard-na.json',
  'thresholds.json',
  'subprocess-effects.json',
];

for (const file of files) {
  const source = readFileSync(resolve(root, 'law/policy', file));
  const materialized = readFileSync(resolve(root, '.devai/config', file));
  if (!source.equals(materialized)) {
    throw new Error(`DEVAI_POLICY_MATERIALIZATION_DRIFT:${file}`);
  }
}

process.stdout.write(`policy materialization: PASS (${String(files.length)} files)\n`);
