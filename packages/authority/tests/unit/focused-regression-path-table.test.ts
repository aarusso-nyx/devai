// ADR-GOV-0026 and the Owner's #412 ruling (a): the Engineer's test-class verb is enforced
// through the static path table plus a diff-time adjacency check, without widening the action
// registry. The table names the verb, the role holding it, the class it reaches and the
// constitution that grants it, and Article 6 ownership of every core prefix is unchanged.
import { describe, expect, it } from 'vitest';
import {
  ENGINEER_TEST_CLASS_VERB,
  STATIC_AUTHORITY_PREFIXES,
  TEST_FILE_PATTERN,
} from '../../src/paths.js';

describe('the static path table names the focused-regression verb', () => {
  it('binds the add-or-modify-focused verb to the Engineer on the test class from 1.1.0', () => {
    expect(ENGINEER_TEST_CLASS_VERB).toEqual({
      verb: 'add-or-modify-focused',
      role: 'engineer',
      path_class: 'test',
      min_constitution: '1.1.0',
    });
    expect(Object.isFrozen(ENGINEER_TEST_CLASS_VERB)).toBe(true);
  });

  it('keeps tests/ an Inspector prefix and packages/ an Engineer prefix', () => {
    expect(STATIC_AUTHORITY_PREFIXES.find((entry) => entry.prefix === 'tests/')?.authority).toEqual(
      ['inspector'],
    );
    expect(
      STATIC_AUTHORITY_PREFIXES.find((entry) => entry.prefix === 'packages/')?.authority,
    ).toEqual(['engineer']);
  });

  it.each([
    ['packages/x/tests/unit/a.test.ts', true],
    ['tests/contract/a.contract.test.ts', true],
    ['tests/e2e/flow.spec.mts', true],
    ['packages/x/tests/unit/a.test.tsx', true],
    ['tests/config/local.config.ts', false],
    ['packages/x/tests/helpers/fixture.ts', false],
    ['packages/x/tests/fixtures/data.json', false],
  ])('reads %s as a test file: %s', (path, test) => {
    expect(TEST_FILE_PATTERN.test(path)).toBe(test);
  });
});
