import { expect, it } from 'vitest';

const { npmPackOutput } = (await import(
  new URL('../../../../scripts/npm-pack-output.mjs', import.meta.url).href
)) as { npmPackOutput: (value: unknown, expected: { name: string; version: string }) => unknown };

const expected = { name: '@aarusso-nyx/devai', version: '1.5.0' };
const entry = {
  ...expected,
  filename: 'aarusso-nyx-devai-1.5.0.tgz',
  files: [{ path: 'package.json' }, { path: 'dist/runtime/index/bin.js' }],
};

it('accepts the legacy array and npm 12 keyed result without changing the package record', () => {
  expect(npmPackOutput([entry], expected)).toBe(entry);
  expect(npmPackOutput({ [expected.name]: entry }, expected)).toBe(entry);
});

it.each([
  null,
  undefined,
  'invalid',
  [],
  [entry, entry],
  {},
  { other: entry },
  { [expected.name]: entry, other: entry },
  [{ ...entry, name: 'other' }],
  [{ ...entry, version: '1.4.5' }],
  { [expected.name]: { ...entry, name: 'other' } },
  [null],
  [[]],
  [{ ...entry, filename: '' }],
  [{ ...entry, filename: '../package.tgz' }],
  [{ ...entry, filename: 'folder\\package.tgz' }],
  [{ ...entry, filename: 'package\0.tgz' }],
  [{ ...entry, files: undefined }],
  [{ ...entry, files: [] }],
  [{ ...entry, files: [null] }],
  [{ ...entry, files: [{ path: 42 }] }],
  [{ ...entry, files: [{ path: '' }] }],
  [{ ...entry, files: [{ path: 'package.json' }, { path: 'package.json' }] }],
])('refuses ambiguous, mismatched or malformed pack output %#', (value) => {
  expect(() => npmPackOutput(value, expected)).toThrow('RELEASE_PACK_OUTPUT_INVALID');
});
