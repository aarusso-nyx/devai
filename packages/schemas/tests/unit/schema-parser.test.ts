import { describe, expect, it } from 'vitest';
import { getValidator, parsers, SchemaParseError } from '../../src/index.js';

const valid = () => ({
  schemaVersion: '1.0.0',
  code: 'INVALID_INPUT',
  class: 'invalid-input',
  exit: 4,
  message: 'Provide a value.',
});

describe('schema parser result and error contracts', () => {
  it('returns the original valid object and parses the same JSON value', () => {
    const input = valid();
    expect(parsers.error.schema).toBe('error');
    expect(parsers.error.parse(input)).toBe(input);
    const result = parsers.error.safeParse(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) expect(result.value).toBe(input);
    expect(parsers.error.parseJson(JSON.stringify(input))).toEqual(input);
    expect(parsers.error.safeParseJson(JSON.stringify(input))).toEqual({ ok: true, value: input });
  });

  it.each(['', '{', '{"code":}', '[1,]', 'undefined'])(
    'classifies malformed JSON separately from schema failures: %s',
    (source) => {
      const result = parsers.error.safeParseJson(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected syntax failure');
      expect(result.error).toBeInstanceOf(SchemaParseError);
      expect(result.error).toMatchObject({
        name: 'SchemaParseError',
        code: 'DEVAI_SCHEMA_PARSE_ERROR',
        schema: 'error',
        kind: 'json-syntax',
        issues: [],
      });
      expect(result.error.sourceError).toBeInstanceOf(SyntaxError);
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(() => parsers.error.parseJson(source)).toThrow(SchemaParseError);
    },
  );

  it.each(['null', 'false', '42', '[]', '{}', '"text"'])(
    'classifies valid JSON with the wrong shape as a schema failure: %s',
    (source) => {
      const result = parsers.error.safeParseJson(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected schema failure');
      expect(result.error).toMatchObject({
        code: 'DEVAI_SCHEMA_PARSE_ERROR',
        schema: 'error',
        kind: 'schema-validation',
        message: 'error failed schema validation',
      });
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.sourceError).toBeUndefined();
    },
  );

  it('retains precise issue paths and independent params after subsequent validation', () => {
    const input = { ...valid(), message: '' };
    const result = parsers.error.safeParse(input);
    if (result.ok) throw new Error('empty message must fail');
    expect(result.error.issues).toContainEqual({
      instancePath: '/message',
      schemaPath: '#/properties/message/minLength',
      keyword: 'minLength',
      params: { limit: 1 },
      message: 'must NOT have fewer than 1 characters',
    });
    const before = structuredClone(result.error.issues);
    const validator = getValidator('error.schema.json');
    const issue = validator.errors?.find((error) => error.keyword === 'minLength');
    if (issue === undefined) throw new Error('missing minimum-length issue');
    issue.params['limit'] = 999;
    expect(result.error.issues).toEqual(before);
    expect(parsers.error.safeParse(valid()).ok).toBe(true);
    expect(parsers.error.safeParse({}).ok).toBe(false);
    expect(result.error.issues).toEqual(before);
    expect(input.message).toBe('');
  });

  it('throws the structured schema error for direct parsing', () => {
    let error: unknown;
    try {
      parsers.error.parse({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SchemaParseError);
    expect(error).toMatchObject({
      schema: 'error',
      kind: 'schema-validation',
      code: 'DEVAI_SCHEMA_PARSE_ERROR',
      message: 'error failed schema validation',
    });
  });

  it.each([{ thrown: new Error('getter failed') }, { thrown: 'non-error failure' }])(
    'safe parsing preserves an unexpected validator failure: $thrown',
    ({ thrown }) => {
      const input = new Proxy(valid(), {
        get() {
          throw thrown;
        },
      });
      const result = parsers.error.safeParse(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected getter failure');
      expect(result.error).toBeInstanceOf(SchemaParseError);
      expect(result.error).toMatchObject({
        schema: 'error',
        kind: 'schema-validation',
        issues: [],
        message: String(thrown),
      });
      expect(result.error.sourceError).toBe(thrown);
    },
  );
});
