import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateAdrs } from '../../src/adr/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai adr input ç '));
  roots.push(root);
  cpSync(join(process.cwd(), 'law/adr'), join(root, 'law/adr'), { recursive: true });
  cpSync(join(process.cwd(), 'law/policy'), join(root, 'law/policy'), { recursive: true });
  return {
    adrsDir: join(root, 'law/adr'),
    policyPath: join(root, 'law/policy/adr-validation.json'),
  };
}

it.each([
  ['policy-directory', 'ADR validation policy is not a regular file'],
  ['policy-symlink', 'symlinked ADR validation policy is forbidden'],
  ['policy-json', 'cannot load validation policy:'],
  ['policy-schema', 'must'],
  ['root-missing', 'ADR root is absent'],
  ['root-file', 'ADR root is not a directory'],
  ['root-symlink', 'symlinked ADR root is forbidden'],
  ['root-mismatch', 'ADR root does not match policy scan root'],
] as const)('does not claim semantic resolution or authority for %s', (kind, message) => {
  const f = fixture();
  const policyBytes = readFileSync(f.policyPath);
  const destination = kind.startsWith('policy') ? f.policyPath : f.adrsDir;
  if (kind === 'policy-json') writeFileSync(f.policyPath, '{broken');
  else if (kind === 'policy-schema') writeFileSync(f.policyPath, '{}');
  else if (kind === 'root-mismatch') f.adrsDir = join(f.adrsDir, 'other');
  else {
    renameSync(destination, `${destination}.retained`);
    if (kind.endsWith('directory')) mkdirSync(destination);
    else if (kind.endsWith('symlink')) symlinkSync(`${destination}.retained`, destination);
    else if (kind === 'root-file') writeFileSync(destination, 'not a directory');
  }
  const result = validateAdrs(f);
  expect(result).toMatchObject({
    ok: false,
    kernel_id: 'devai.kernel.adr-supersession-resolution.v3',
    semantic_resolution_performed: false,
    files_scanned: 0,
    adrs: [],
    effective_authorities: [],
    subject_authorities: [],
  });
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'adr-semantic-resolution-not-performed',
        file: kind.startsWith('policy') ? f.policyPath : f.adrsDir,
        message: expect.stringContaining(message),
      }),
    ]),
  );
  if (!kind.startsWith('policy')) expect(readFileSync(f.policyPath)).toEqual(policyBytes);
  if (kind === 'policy-directory' || kind === 'policy-symlink') {
    expect(readFileSync(`${f.policyPath}.retained`)).toEqual(policyBytes);
  }
});
