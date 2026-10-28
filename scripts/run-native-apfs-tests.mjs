#!/usr/bin/env node
// ADR-CHK-0010: positive protected-namespace qualification on its actual native host.
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temporary = realpathSync(tmpdir());
const filesystem = statfsSync(temporary, { bigint: true }).type;
if (
  process.platform !== 'darwin' ||
  filesystem !== 26n ||
  !['24.20.0', '24.22.0'].includes(process.versions.node) ||
  process.versions.uv !== '1.52.1'
) {
  process.stderr.write(
    `${JSON.stringify({ platform: process.platform, node: process.versions.node, uv: process.versions.uv, filesystem_type: String(filesystem) })}\n`,
  );
  throw new Error('NATIVE_APFS_QUALIFICATION_HOST_UNSUPPORTED');
}
const directory = mkdtempSync(join(temporary, 'devai-native-apfs-qualification-'));
const report = join(directory, 'report.json');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `report=${report}\n`);
const files = [
  'packages/authority/tests/unit/reconciliation-host-provision.test.ts',
  'packages/authority/tests/unit/reconciliation-host-owner.test.ts',
];
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'tests/config/local.config.ts',
    '--configLoader',
    'runner',
    '--testTimeout',
    '60000',
    '--no-cache',
    ...files,
    '--reporter',
    'default',
    '--reporter',
    'json',
    '--outputFile',
    report,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error || result.signal || result.status !== 0) process.exit(result.status || 1);
const evidence = JSON.parse(readFileSync(report, 'utf8'));
if (
  !evidence.success ||
  evidence.numFailedTests !== 0 ||
  evidence.numPendingTests !== 0 ||
  evidence.numPassedTests < 1 ||
  evidence.testResults.length !== files.length ||
  files.some((file) => !evidence.testResults.some((item) => item.name === join(root, file)))
) {
  throw new Error('NATIVE_APFS_QUALIFICATION_INCOMPLETE');
}
process.stdout.write(
  `${JSON.stringify({ qualified: true, platform: process.platform, node: process.versions.node, uv: process.versions.uv, filesystem_type: String(filesystem), passed: evidence.numPassedTests, skipped: evidence.numPendingTests, report })}\n`,
);
