import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAuthorityPathCapability,
  classifyAuthorityPath,
  type AuthorityFsCapability,
} from '../../src/capabilities/path-domains.js';

const root = join(process.cwd(), 'fixture workspace ç');
const domains: readonly [string, AuthorityFsCapability][] = [
  ['.devai/state/current.json', 'fs:f5-state'],
  ['.devai/pin/provider.json', 'fs:f5-config'],
  ['.devai/config/toolchain.json', 'fs:f5-config'],
  ['.devai/constitution.md', 'fs:f5-config'],
  ['record/derived/inventory/current.json', 'fs:f4-inventory'],
  ['record/proofs/release/receipt.json', 'fs:proofs'],
  ['scratch/worktrees/candidate', 'fs:worktree-admin'],
  ['packages/product/source.ts', 'fs:workspace'],
];
const capabilities: readonly AuthorityFsCapability[] = [
  'fs:f5-state',
  'fs:f5-config',
  'fs:f4-inventory',
  'fs:proofs',
  'fs:worktree-admin',
  'fs:workspace',
];

describe('filesystem authority capability separation', () => {
  it.each(domains)('binds relative and absolute %s to %s', (target, capability) => {
    expect(classifyAuthorityPath(root, target)).toBe(capability);
    expect(classifyAuthorityPath(root, join(root, target))).toBe(capability);
    expect(classifyAuthorityPath(root, `temporary/../${target}`)).toBe(capability);
    expect(() => assertAuthorityPathCapability([capability], root, target)).not.toThrow();
    expect(() => assertAuthorityPathCapability(capabilities, root, target)).not.toThrow();
  });

  it.each(domains)('refuses %s without its exact capability', (target, capability) => {
    for (const allowed of [
      [],
      ...capabilities.filter((item) => item !== capability).map((item) => [item]),
    ]) {
      expect(() => assertAuthorityPathCapability(allowed, root, target)).toThrow(
        new Error(`AUTHORITY_PATH_DOMAIN_VIOLATION:${capability}`),
      );
    }
  });

  it.each([
    'state/current.json',
    'other/state/current.json',
    '.devai/state-backup/current.json',
    '.devai/configuration/toolchain.json',
    '.devai/pins/provider.json',
    '.devai/constitution.md.backup',
    '.devai/other.md',
    'other/derived/inventory/current.json',
    'record/other/inventory/current.json',
    'record/derived/other/current.json',
    'other/proofs/receipt.json',
    'record/proofs-backup/receipt.json',
    'other/worktrees/candidate',
    'scratch/other/candidate',
    'scratch/worktrees-backup/candidate',
    'nested/.devai/state/current.json',
    '',
    '.',
    '..',
    '../.devai/state/current.json',
    '../record/proofs/receipt.json',
    '../scratch/worktrees/candidate',
    '.devai/state/../../packages/source.ts',
  ])('keeps the non-domain path %s in the workspace capability', (target) => {
    expect(classifyAuthorityPath(root, target)).toBe('fs:workspace');
    expect(classifyAuthorityPath(root, join(root, target))).toBe('fs:workspace');
    expect(() => assertAuthorityPathCapability(['fs:workspace'], root, target)).not.toThrow();
    expect(() =>
      assertAuthorityPathCapability(['fs:proofs', 'fs:f5-config', 'fs:f5-state'], root, target),
    ).toThrow(new Error('AUTHORITY_PATH_DOMAIN_VIOLATION:fs:workspace'));
  });
});
