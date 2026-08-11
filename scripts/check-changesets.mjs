#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = process.cwd();
const changesetDir = join(root, '.changeset');
const config = JSON.parse(readFileSync(join(changesetDir, 'config.json'), 'utf8'));
const allowedTypes = new Set(['major', 'minor', 'patch']);
const packageNames = new Set(
  readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, 'packages', entry.name, 'package.json')))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8'),
      );
      return manifest.name;
    })
    .filter((name) => typeof name === 'string'),
);
const files = readdirSync(changesetDir)
  .filter((name) => name.endsWith('.md'))
  .sort();
const findings = [];

if (!Array.isArray(config.fixed) || !Array.isArray(config.ignore)) {
  findings.push('.changeset/config.json must declare fixed and ignore arrays');
}

for (const file of files) {
  const text = readFileSync(join(changesetDir, file), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (match === null) {
    findings.push(`${file}: missing YAML front matter and body`);
    continue;
  }

  let releases;
  try {
    releases = parse(match[1]);
  } catch (error) {
    findings.push(
      `${file}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }

  if (releases === null || typeof releases !== 'object' || Array.isArray(releases)) {
    findings.push(`${file}: front matter must map package names to release types`);
    continue;
  }

  const entries = Object.entries(releases);
  if (entries.length === 0) findings.push(`${file}: no package release classification`);
  for (const [packageName, releaseType] of entries) {
    if (!packageNames.has(packageName)) {
      findings.push(`${file}: unknown workspace package ${packageName}`);
    }
    if (typeof releaseType !== 'string' || !allowedTypes.has(releaseType)) {
      findings.push(`${file}: ${packageName} has invalid release type ${String(releaseType)}`);
    }
  }
  if (match[2].trim().length === 0) findings.push(`${file}: release intent body is empty`);
}

if (findings.length > 0) {
  process.stderr.write(
    `changeset classification: FAIL\n${findings.map((f) => `- ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `changeset classification: PASS (${String(files.length)} pending changeset${files.length === 1 ? '' : 's'})\n`,
);
