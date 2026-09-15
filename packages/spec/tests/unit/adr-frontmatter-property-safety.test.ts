import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validators } from '@devai-nyx/schemas';
import { parseAdrFrontMatter } from '../../src/adr/index.js';

it.each([
  ['scalar', '__proto__: retained', 'retained'],
  ['inline list', '__proto__: [retained]', ['retained']],
  ['block list', '__proto__:\n  - retained', ['retained']],
] as const)('retains a prototype-named %s as an ordinary own field', (_name, text, value) => {
  const parsed = parseAdrFrontMatter(text);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(parsed['__proto__']).toEqual(value);
  expect(Object.keys(parsed)).toEqual(['__proto__']);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(
    JSON.parse(JSON.stringify({ ['__proto__']: value })),
  );
});

it('rejects duplicate prototype-named fields using the same rule as other fields', () => {
  expect(() => parseAdrFrontMatter('__proto__: []\n__proto__: second')).toThrow(
    "duplicate frontmatter key '__proto__'",
  );
});

it('cannot hide an undeclared field from the real ADR schema through the object prototype setter', () => {
  const bytes = readFileSync(
    join(process.cwd(), 'law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md'),
    'utf8',
  );
  const text = /^---\n([\s\S]*?)\n---/u.exec(bytes)?.[1];
  if (text === undefined) throw new Error('approved fixture has no frontmatter');
  expect(validators.adrV2(parseAdrFrontMatter(text))).toBe(true);
  const parsed = parseAdrFrontMatter(`${text}\n__proto__: []`);
  expect(validators.adrV2(parsed)).toBe(false);
  expect(validators.adrV2.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        keyword: 'additionalProperties',
        params: { additionalProperty: '__proto__' },
      }),
    ]),
  );
});
