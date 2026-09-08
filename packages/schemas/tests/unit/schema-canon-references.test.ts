import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { checkSchema } from '../../src/index.js';

function document(base: Record<string, unknown>, reference = '#/$defs/base') {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { item: { $ref: reference, properties: { kind: { const: 'accepted' } } } },
    $defs: { base },
  };
}
const closed = {
  type: 'object',
  additionalProperties: false,
  properties: { kind: { type: 'string' } },
  required: ['kind'],
};

describe('schema canon local reference closure', () => {
  it('recognizes inherited closure while the real validator rejects extra properties', () => {
    const schema = document(closed);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ item: { kind: 'accepted' } })).toBe(true);
    expect(validate({ item: { kind: 'accepted', extra: true } })).toBe(false);
    expect(validate({ item: { kind: 'other' } })).toBe(false);
    expect(checkSchema('fixture.schema.json', schema)).toEqual([]);
  });
  it('still reports a referenced open object', () => {
    const schema = document({ type: 'object', properties: { kind: { type: 'string' } } });
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ item: { kind: 'accepted', extra: true } })).toBe(true);
    expect(checkSchema('fixture.schema.json', schema)).toContainEqual({
      schema: 'fixture.schema.json',
      rule: 'open-world-object',
      path: '$root/properties/item',
    });
  });
  it.each(['#/$defs/missing', 'other.schema.json#/$defs/base', '#/$defs/bad~2key'])(
    'does not claim closure for unresolved reference %s',
    (reference) => {
      expect(checkSchema('fixture.schema.json', document(closed, reference))).toContainEqual({
        schema: 'fixture.schema.json',
        rule: 'open-world-object',
        path: '$root/properties/item',
      });
    },
  );
  it('terminates a reference cycle without treating it as a closure declaration', () => {
    expect(checkSchema('fixture.schema.json', document({ $ref: '#/$defs/base' }))).toContainEqual({
      schema: 'fixture.schema.json',
      rule: 'open-world-object',
      path: '$root/properties/item',
    });
  });
  it('resolves escaped local pointer tokens through chained definitions', () => {
    const schema = {
      ...document({ $ref: '#/$defs/a~1b~0c' }),
      $defs: { base: { $ref: '#/$defs/a~1b~0c' }, 'a/b~c': closed },
    };
    expect(checkSchema('fixture.schema.json', schema)).toEqual([]);
  });
});

it('does not borrow an outer resource definition for an embedded resource', () => {
  const schema = {
    ...document(closed),
    properties: {
      item: {
        $id: 'https://example.invalid/nested',
        type: 'object',
        additionalProperties: false,
        properties: {
          child: { $ref: '#/$defs/base', properties: { kind: { const: 'accepted' } } },
        },
        $defs: { base: { type: 'object', properties: { kind: { type: 'string' } } } },
      },
    },
  };
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate({ item: { child: { kind: 'accepted', extra: true } } })).toBe(true);
  expect(checkSchema('fixture.schema.json', schema)).toContainEqual({
    schema: 'fixture.schema.json',
    rule: 'open-world-object',
    path: '$root/properties/item/properties/child',
  });
});
it('decodes a URI fragment before interpreting its pointer escapes', () => {
  const schema = document(closed, '#/%24defs/base');
  expect(
    new Ajv2020({ strict: false }).compile(schema)({ item: { kind: 'accepted', extra: true } }),
  ).toBe(false);
  expect(checkSchema('fixture.schema.json', schema)).toEqual([]);
});
it('does not infer closure from an invalid URI fragment', () => {
  expect(checkSchema('fixture.schema.json', document(closed, '#/%ZZ'))).toContainEqual({
    schema: 'fixture.schema.json',
    rule: 'open-world-object',
    path: '$root/properties/item',
  });
});
