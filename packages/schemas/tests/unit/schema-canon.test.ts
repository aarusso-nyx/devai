import { describe, expect, it } from 'vitest';
import { checkSchema } from '../../src/index.js';

describe('schema canon traversal', () => {
  it.each([
    { values: ['pass', 'review', 'fail'] },
    { values: ['fail', 'pass', 'review'] },
    { values: ['review', 'fail', 'pass'] },
    { values: ['PASS', 'REVIEW', 'FAIL'] },
    { values: ['FAIL', 'PASS', 'REVIEW'] },
    { values: ['REVIEW', 'FAIL', 'PASS'] },
  ])('rejects duplicated verdict vocabulary regardless of enum order: $values', ({ values }) => {
    const schema = { properties: { verdict: { enum: values } } };
    const before = structuredClone(schema);
    expect(checkSchema('consumer.schema.json', schema)).toEqual([
      {
        schema: 'consumer.schema.json',
        rule: 'restated-verdict-enum',
        path: '$root/properties/verdict',
      },
    ]);
    expect(schema).toEqual(before);
    expect(checkSchema('common-defs.schema.json', schema)).toEqual([]);
  });

  it.each([
    { values: ['pass', 'fail'] },
    { values: ['pass', 'review', 'fail', 'unknown'] },
    { values: ['pass', 'review', 'FAIL'] },
    { values: ['pass', 'pass', 'fail'] },
  ])('does not misidentify a different enum as the shared vocabulary: $values', ({ values }) => {
    expect(checkSchema('consumer.schema.json', { enum: values })).toEqual([]);
  });

  it('reports every complete nested open object with its array location', () => {
    const fragment = { properties: { value: { type: 'string' } } };
    expect(
      checkSchema('consumer.schema.json', { properties: { choices: [fragment, fragment] } }),
    ).toEqual([
      {
        schema: 'consumer.schema.json',
        rule: 'open-world-object',
        path: '$root/properties/choices[0]',
      },
      {
        schema: 'consumer.schema.json',
        rule: 'open-world-object',
        path: '$root/properties/choices[1]',
      },
    ]);
  });

  it.each(['if', 'then', 'else', 'contains', 'oneOf', 'allOf'])(
    'allows partial object predicates under %s without suppressing independent complete objects',
    (keyword) => {
      const fragment = { properties: { value: { type: 'string' } } };
      expect(
        checkSchema('consumer.schema.json', {
          [keyword]: [fragment],
          properties: { complete: fragment },
        }),
      ).toEqual([
        {
          schema: 'consumer.schema.json',
          rule: 'open-world-object',
          path: '$root/properties/complete',
        },
      ]);
    },
  );

  it.each([false, true, { type: 'string' }])(
    'accepts an explicit additional-properties policy %s',
    (additionalProperties) => {
      expect(
        checkSchema('consumer.schema.json', {
          properties: { nested: { properties: {}, additionalProperties } },
        }),
      ).toEqual([]);
    },
  );
});
