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

it('identifies the exact invalid frontmatter field without granting authority', () => {
  const f = fixture();
  const file = join(f.adrsDir, 'ADR-MUT-0006-measured-aggregation-and-activation-closure.md');
  const invalid = readFileSync(file, 'utf8').replace(/^status: accepted$/mu, 'status: impossible');
  writeFileSync(file, invalid);
  const result = validateAdrs(f);
  expect(result.ok).toBe(false);
  expect(result.effective_authorities).toEqual([]);
  expect(result.subject_authorities).toEqual([]);
  expect(result.errors).toContainEqual({
    code: 'adr-semantic-resolution-not-performed',
    file,
    pointer: '/status',
    message: 'must be equal to one of the allowed values (enum)',
  });
  expect(readFileSync(file, 'utf8')).toBe(invalid);
});

it('identifies the exact invalid protected policy field before semantic resolution', () => {
  const f = fixture();
  const policy = JSON.parse(readFileSync(f.policyPath, 'utf8')) as {
    semantic_resolver: { mandatory: boolean };
  };
  policy.semantic_resolver.mandatory = false;
  const invalid = JSON.stringify(policy);
  writeFileSync(f.policyPath, invalid);
  const result = validateAdrs(f);
  expect(result.ok).toBe(false);
  expect(result.semantic_resolution_performed).toBe(false);
  expect(result.effective_authorities).toEqual([]);
  expect(result.errors).toContainEqual({
    code: 'adr-semantic-resolution-not-performed',
    file: f.policyPath,
    pointer: '/semantic_resolver/mandatory',
    message: 'must be equal to constant (const)',
  });
  expect(readFileSync(f.policyPath, 'utf8')).toBe(invalid);
});

it('refuses valid ADR bytes stored under a different declared identity', () => {
  const f = fixture();
  const original = join(f.adrsDir, 'ADR-MUT-0006-measured-aggregation-and-activation-closure.md');
  const bytes = readFileSync(original);
  const file = join(f.adrsDir, 'ADR-MUT-9999-wrong-identity.md');
  renameSync(original, file);
  const result = validateAdrs(f);
  expect(result.ok).toBe(false);
  expect(result.effective_authorities).toEqual([]);
  expect(result.subject_authorities).toEqual([]);
  expect(result.errors).toContainEqual({
    code: 'adr-semantic-resolution-not-performed',
    file,
    message: 'filename does not bind declared id',
  });
  expect(readFileSync(file)).toEqual(bytes);
});

it('scans nested Markdown ADRs while ignoring similarly named backup files', () => {
  const f = fixture();
  const original = join(f.adrsDir, 'ADR-MUT-0006-measured-aggregation-and-activation-closure.md');
  const bytes = readFileSync(original);
  const directory = join(f.adrsDir, 'nested ç', 'decisions');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'ADR-MUT-0006-relocated.MD');
  renameSync(original, file);
  const ignored = join(directory, 'broken.md.backup');
  writeFileSync(ignored, 'this is not an ADR');
  const result = validateAdrs(f);
  expect(result.ok).toBe(true);
  expect(result.adrs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file, adr_id: 'ADR-MUT-0006', effective: true }),
    ]),
  );
  expect(result.adrs.some((record) => record.file === ignored)).toBe(false);
  expect(readFileSync(file)).toEqual(bytes);
  expect(readFileSync(ignored, 'utf8')).toBe('this is not an ADR');
});

it('refuses a symlinked ADR while retaining diagnostics for regular records', () => {
  const f = fixture();
  const original = join(f.adrsDir, 'ADR-MUT-0006-measured-aggregation-and-activation-closure.md');
  const bytes = readFileSync(original);
  const file = join(f.adrsDir, 'ADR-MUT-9999-link.md');
  symlinkSync(original, file);
  const result = validateAdrs(f);
  expect(result.ok).toBe(false);
  expect(result.effective_authorities).toEqual([]);
  expect(result.subject_authorities).toEqual([]);
  expect(result.errors.filter((error) => error.file === file)).toEqual([
    {
      code: 'adr-semantic-resolution-not-performed',
      file,
      message: 'symlinked ADR is forbidden',
    },
  ]);
  expect(result.adrs.some((record) => record.file === file)).toBe(false);
  expect(result.adrs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: original, adr_id: 'ADR-MUT-0006', effective: false }),
    ]),
  );
  expect(readFileSync(original)).toEqual(bytes);
});
