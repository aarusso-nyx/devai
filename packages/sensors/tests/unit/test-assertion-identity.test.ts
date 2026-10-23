// ADR-GOV-0026 (issue #412): detecting an edit to an assertion of an existing test needs
// per-assertion identity, not the per-file `expect` count the weakening sensor kept. An
// assertion is identified by the describe/it chain that holds it, the skip/only/todo markers on
// that chain, and its canonical text; a base assertion that no longer appears in the head with
// the same identity is changed. Formatting, comments, reordering and additions change nothing.
import { describe, expect, it } from 'vitest';
import {
  assertionIdentities,
  changedAssertions,
  changedTestRegistrations,
} from '../../src/test-assertions.js';

const BASE = `
import { describe, expect, it } from 'vitest';

describe('parser', () => {
  it('reads one value', () => {
    expect(parse('1')).toBe(1);
    expect(parse('2')).toEqual(2);
  });

  it('rejects garbage', async () => {
    await expect(parseAsync('x')).rejects.toThrow('PARSE_INVALID');
    expect.soft(errors()).toHaveLength(1);
  });
});
`;

describe('assertion identities', () => {
  it('names every expect assertion of a file once, in source order', () => {
    const identities = assertionIdentities(BASE);
    expect(identities).toHaveLength(4);
    expect(identities[0]).toContain('parser > reads one value');
    expect(identities[0]).toContain("expect(parse('1')).toBe(1)");
    expect(identities[2]).toContain('parser > rejects garbage');
    expect(identities[2]).toContain('rejects.toThrow');
    expect(identities[3]).toContain('expect.soft');
  });

  it('identifies an assertion outside any test by the file alone', () => {
    const [identity] = assertionIdentities('expect(globalThis).toBeDefined();\n');
    expect(identity).toContain('expect(globalThis).toBeDefined()');
  });
});

describe('changed assertions between a base and a head', () => {
  it('finds nothing when the file is unchanged', () => {
    expect(changedAssertions(BASE, BASE)).toEqual([]);
  });

  it('ignores formatting and comments', () => {
    const head = BASE.replace(
      "expect(parse('1')).toBe(1);",
      "// the first value\n    expect(\n      parse( '1' ),\n    ).toBe( 1 );",
    );
    expect(changedAssertions(BASE, head)).toEqual([]);
  });

  it('ignores assertions reordered inside their test', () => {
    const head = BASE.replace(
      "expect(parse('1')).toBe(1);\n    expect(parse('2')).toEqual(2);",
      "expect(parse('2')).toEqual(2);\n    expect(parse('1')).toBe(1);",
    );
    expect(changedAssertions(BASE, head)).toEqual([]);
  });

  it('ignores a new test and a new assertion in an existing test', () => {
    const head = BASE.replace(
      "expect(parse('2')).toEqual(2);",
      "expect(parse('2')).toEqual(2);\n    expect(parse('3')).toBe(3);",
    ).replace(
      "describe('parser', () => {",
      "describe('parser', () => {\n  it('reads zero', () => expect(parse('0')).toBe(0));",
    );
    expect(changedAssertions(BASE, head)).toEqual([]);
  });

  it('names an assertion whose matcher argument changed', () => {
    const changed = changedAssertions(BASE, BASE.replace('toBe(1)', 'toBe(10)'));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('parser > reads one value');
    expect(changed[0]).toContain('toBe(1)');
  });

  it('names an assertion whose matcher changed', () => {
    expect(changedAssertions(BASE, BASE.replace('toEqual(2)', 'toBeTruthy()'))).toHaveLength(1);
  });

  it('names a removed assertion', () => {
    const changed = changedAssertions(
      BASE,
      BASE.replace('expect.soft(errors()).toHaveLength(1);', ''),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('expect.soft');
  });

  it('names one of two identical assertions when only one is removed', () => {
    const base = "it('twice', () => {\n  expect(a).toBe(1);\n  expect(a).toBe(1);\n});\n";
    const head = "it('twice', () => {\n  expect(a).toBe(1);\n});\n";
    expect(changedAssertions(base, head)).toHaveLength(1);
  });

  it('names an assertion moved to another test', () => {
    const head = BASE.replace("    expect(parse('2')).toEqual(2);\n", '').replace(
      'expect.soft(errors()).toHaveLength(1);',
      "expect.soft(errors()).toHaveLength(1);\n    expect(parse('2')).toEqual(2);",
    );
    const changed = changedAssertions(BASE, head);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('parser > reads one value');
  });

  it('names every assertion of a renamed test', () => {
    expect(
      changedAssertions(BASE, BASE.replace("'reads one value'", "'reads a value'")),
    ).toHaveLength(2);
  });

  it.each([
    ['skipping the test', "it('reads one value'", "it.skip('reads one value'"],
    ['skipping the suite', "describe('parser'", "describe.skip('parser'"],
    ['marking the test todo', "it('reads one value'", "it.todo('reads one value'"],
    ['focusing the test', "it('reads one value'", "it.only('reads one value'"],
    ['skipping the test conditionally', "it('reads one value'", "it.skipIf(ci)('reads one value'"],
  ])('names the assertions of a test changed by %s', (_label, from, to) => {
    expect(changedAssertions(BASE, BASE.replace(from, to)).length).toBeGreaterThan(0);
  });

  it('treats an absent head as removing every assertion', () => {
    expect(changedAssertions(BASE, '')).toHaveLength(4);
  });
});

// Codex review on #426: a test registered with a referenced callback (`it('x', body)`) keeps its
// assertions in the callback's own scope, so its run markers never reach their identity. The
// registrations themselves therefore carry an identity too: the describe/it chain and its run
// markers. A base registration the head no longer holds is a removed, renamed or re-marked test.
describe('changed test registrations', () => {
  const REFERENCED = [
    "import { expect, it } from 'vitest';",
    'function body() {',
    '  expect(value()).toBe(1);',
    '}',
    "it('reads the value', body);",
    "it('runs without assertions', () => { run(); });",
    '',
  ].join('\n');

  it('finds nothing when the registrations are unchanged', () => {
    expect(changedTestRegistrations(REFERENCED, REFERENCED)).toEqual([]);
  });

  it.each([
    ['skipped', "it.skip('reads the value', body)"],
    ['marked todo', "it.todo('reads the value', body)"],
    ['skipped conditionally', "it.skipIf(ci)('reads the value', body)"],
    ['focused', "it.only('reads the value', body)"],
  ])('names a referenced-callback test that is %s', (_label, registration) => {
    const head = REFERENCED.replace("it('reads the value', body)", registration);
    const changed = changedTestRegistrations(REFERENCED, head);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('reads the value');
  });

  it('names a skipped test that has no assertions', () => {
    const head = REFERENCED.replace(
      "it('runs without assertions'",
      "it.skip('runs without assertions'",
    );
    expect(changedTestRegistrations(REFERENCED, head)).toHaveLength(1);
  });

  it('names a removed or renamed test', () => {
    expect(
      changedTestRegistrations(
        REFERENCED,
        REFERENCED.replace("it('reads the value', body);\n", ''),
      ),
    ).toHaveLength(1);
    expect(
      changedTestRegistrations(REFERENCED, REFERENCED.replace("'reads the value'", "'reads it'")),
    ).toHaveLength(1);
  });

  it('ignores added tests, including referenced-callback ones', () => {
    const head = `${REFERENCED}it('reads it again', body);\ntest('with options', { timeout: 10 }, body);\n`;
    expect(changedTestRegistrations(REFERENCED, head)).toEqual([]);
  });

  it('does not take the inner call of a curried registration for a test', () => {
    const base = "it.each([1, 2])('reads %i', (n) => expect(n).toBeGreaterThan(0));\n";
    expect(changedTestRegistrations(base, base)).toEqual([]);
    expect(changedTestRegistrations(base, base.replace('it.each', 'it.skip.each'))).toHaveLength(1);
  });
});
