import { describe, expect, it } from 'vitest';
import {
  buildTokens,
  renderTemplate,
  toKebab,
  toSnake,
  type TokenMap,
} from '../../src/templates/index.js';

function fixedTokens(overrides: Partial<TokenMap> = {}): TokenMap {
  return buildTokens({
    namespace: 'demo',
    module: 'Greeter',
    entity: 'Greeting',
    specVersion: '0.1.0',
    specSha256: 'a'.repeat(64),
    ...(overrides.__NAMESPACE__ !== undefined
      ? {} // never override via this path; build from input
      : {}),
  });
}

describe('toKebab / toSnake', () => {
  it('PascalCase → kebab-case', () => {
    expect(toKebab('Greeter')).toBe('greeter');
    expect(toKebab('OrderItem')).toBe('order-item');
    expect(toKebab('NsOrders')).toBe('ns-orders');
  });

  it('PascalCase → snake_case', () => {
    expect(toSnake('Greeter')).toBe('greeter');
    expect(toSnake('OrderItem')).toBe('order_item');
    expect(toSnake('NsOrders')).toBe('ns_orders');
  });

  it('collapses repeated separators and whitespace rather than multiplying separators', () => {
    expect(toKebab('Order__  Item2Value')).toBe('order-item2-value');
    expect(toSnake('Order--  Item2Value')).toBe('order_item2_value');
  });

  it('round-trip stability: kebab→snake→kebab is idempotent', () => {
    const original = 'order-line-item';
    const snake = toSnake(original);
    const kebab = toKebab(snake);
    expect(kebab).toBe(original);
  });
});

describe('buildTokens', () => {
  it('derives the 12 canonical tokens from a 5-field input', () => {
    const t = buildTokens({
      namespace: 'demo',
      module: 'Greeter',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'b'.repeat(64),
    });
    expect(t.__NAMESPACE__).toBe('demo');
    expect(t.__MODULE__).toBe('Greeter');
    expect(t.__kebabModule__).toBe('greeter');
    expect(t.__snake_module__).toBe('greeter');
    expect(t.__moduleSlug__).toBe('demo-greeter');
    expect(t.__ENTITY__).toBe('Greeting');
    expect(t.__classEntity__).toBe('Greeting');
    expect(t.__kebabEntity__).toBe('greeting');
    expect(t.__snake_entity__).toBe('greeting');
    expect(t.__snake_table__).toBe('demo__greeter_greeting');
    expect(t.__SPEC_VERSION__).toBe('0.1.0');
    expect(t.__SPEC_SHA__).toBe('bbbbbbbb');
  });

  it('trims every blueprint field before deriving token names and identities', () => {
    const tokens = buildTokens({
      namespace: ' demo ',
      module: ' OrderItem ',
      entity: ' LineItem ',
      specVersion: ' 1.2.3 ',
      specSha256: ' abcdef012345 ',
    });
    expect(tokens).toEqual({
      __NAMESPACE__: 'demo',
      __MODULE__: 'OrderItem',
      __kebabModule__: 'order-item',
      __snake_module__: 'order_item',
      __moduleSlug__: 'demo-order-item',
      __ENTITY__: 'LineItem',
      __classEntity__: 'LineItem',
      __kebabEntity__: 'line-item',
      __snake_entity__: 'line_item',
      __snake_table__: 'demo__order_item_line_item',
      __SPEC_VERSION__: '1.2.3',
      __SPEC_SHA__: 'abcdef01',
    });
  });

  it.each(['prefix__TOKEN__', '__TOKEN__suffix', '__1TOKEN__', '__BAD-TOKEN__'])(
    'rejects an extra token that only partially matches the naming contract: %s',
    (key) => {
      expect(() =>
        buildTokens({
          namespace: 'demo',
          module: 'M',
          entity: 'E',
          specVersion: '1',
          specSha256: 'abc',
          extra: { [key]: 'value' },
        }),
      ).toThrow(/canonical __NAME__ pattern/);
    },
  );

  it('handles multi-word modules', () => {
    const t = buildTokens({
      namespace: 'acct',
      module: 'OrderItem',
      entity: 'OrderLine',
      specVersion: '1.2.3',
      specSha256: 'c'.repeat(64),
    });
    expect(t.__kebabModule__).toBe('order-item');
    expect(t.__snake_module__).toBe('order_item');
    expect(t.__moduleSlug__).toBe('acct-order-item');
    expect(t.__snake_table__).toBe('acct__order_item_order_line');
  });

  it('accepts caller-supplied extra tokens', () => {
    const t = buildTokens({
      namespace: 'demo',
      module: 'Greeter',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'd'.repeat(64),
      extra: { __FOO__: 'bar' },
    });
    expect(t.__FOO__).toBe('bar');
  });

  it('rejects malformed extra token names', () => {
    expect(() =>
      buildTokens({
        namespace: 'demo',
        module: 'Greeter',
        entity: 'Greeting',
        specVersion: '0.1.0',
        specSha256: 'd'.repeat(64),
        extra: { notAToken: 'bar' },
      }),
    ).toThrow(/canonical __NAME__ pattern/);
  });
});

describe('renderTemplate', () => {
  it('substitutes all 12 canonical tokens', () => {
    const t = fixedTokens();
    const body = '__NAMESPACE__/__MODULE__/__ENTITY__ at __SPEC_VERSION__ (__SPEC_SHA__)';
    const { output } = renderTemplate({ body, tokens: t });
    expect(output).toBe('demo/Greeter/Greeting at 0.1.0 (aaaaaaaa)');
  });

  it('leaves unknown __NAME__ tokens in place (visible breakage, not silent)', () => {
    const t = fixedTokens();
    const body = '__MODULE__ and __UNKNOWN_TOKEN__';
    const { output } = renderTemplate({ body, tokens: t });
    expect(output).toBe('Greeter and __UNKNOWN_TOKEN__');
  });

  it('evaluates conditional blocks against the flag map', () => {
    const t = fixedTokens();
    const body = 'before <!-- IF:withEvents -->events here <!-- ENDIF:withEvents -->after';
    const withFlag = renderTemplate({ body, tokens: t, flags: { withEvents: true } });
    expect(withFlag.output).toBe('before events here after');
    const noFlag = renderTemplate({ body, tokens: t, flags: { withEvents: false } });
    expect(noFlag.output).toBe('before after');
  });

  it('supports nested conditionals (same flag)', () => {
    const t = fixedTokens();
    const body =
      '<!-- IF:outer --><!-- IF:outer -->inner <!-- ENDIF:outer -->done<!-- ENDIF:outer -->';
    const r = renderTemplate({ body, tokens: t, flags: { outer: true } });
    expect(r.output).toBe('inner done');
  });

  it('supports different-flag blocks (independent)', () => {
    const t = fixedTokens();
    const body = '<!-- IF:a -->A<!-- ENDIF:a --><!-- IF:b -->B<!-- ENDIF:b -->';
    const r = renderTemplate({ body, tokens: t, flags: { a: true, b: false } });
    expect(r.output).toBe('A');
  });

  it('treats absent flags as false (default)', () => {
    const t = fixedTokens();
    const body = '<!-- IF:missing -->X<!-- ENDIF:missing -->';
    const r = renderTemplate({ body, tokens: t });
    expect(r.output).toBe('');
  });

  it.each([
    '<!-- ENDIF:orphan -->',
    'prefix<!-- ENDIF:orphan --><!-- IF:a -->A<!-- ENDIF:a -->',
    '<!-- IF:a -->A<!-- ENDIF:a --><!-- ENDIF:orphan -->',
    '<!-- IF:a -->A<!-- ENDIF:b --><!-- ENDIF:a -->',
  ])('rejects an unmatched closing conditional: %s', (body) => {
    expect(() =>
      renderTemplate({ body, tokens: fixedTokens(), flags: { a: true, b: true } }),
    ).toThrow(/unmatched/);
  });

  it('handles nested distinct flags and whitespace around exact closing markers', () => {
    const body =
      'before<!-- IF:outer -->A<!-- IF:inner -->B<!--   ENDIF:inner   -->C<!-- ENDIF:outer -->after';
    expect(
      renderTemplate({ body, tokens: fixedTokens(), flags: { outer: true, inner: true } }).output,
    ).toBe('beforeABCafter');
    expect(
      renderTemplate({ body, tokens: fixedTokens(), flags: { outer: true, inner: false } }).output,
    ).toBe('beforeACafter');
    expect(
      renderTemplate({ body, tokens: fixedTokens(), flags: { outer: false, inner: true } }).output,
    ).toBe('beforeafter');
  });

  it('throws on unmatched IF', () => {
    const t = fixedTokens();
    const body = '<!-- IF:foo -->no close';
    expect(() => renderTemplate({ body, tokens: t })).toThrow(/unmatched/);
  });

  it.each([
    { body: '<!--IF:a-->A<!--ENDIF:a-->' },
    { body: '<!--  IF:a  -->A<!--  ENDIF:a  -->' },
    { body: '<!--\tIF:a\t-->A<!--\tENDIF:a\t-->' },
  ])('consumes the actual whitespace-bearing marker lengths: $body', ({ body }) => {
    expect(
      renderTemplate({ body: body + 'tail', tokens: fixedTokens(), flags: { a: true } }).output,
    ).toBe('Atail');
    expect(
      renderTemplate({ body: body + 'tail', tokens: fixedTokens(), flags: { a: false } }).output,
    ).toBe('tail');
  });

  it('ignores malformed direct token keys and leaves unrelated text intact', () => {
    const tokens = { ...fixedTokens(), Greeter: 'corruption' };
    expect(renderTemplate({ body: '__MODULE__ Greeter', tokens }).output).toBe('Greeter Greeter');
  });

  it.each([
    { body: '', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    { body: 'abc', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  ])('matches the standard SHA256 vector for $body', ({ body, sha256 }) => {
    expect(renderTemplate({ body, tokens: fixedTokens() })).toEqual({ output: body, sha256 });
  });

  it('emits deterministic sha256 for identical input', () => {
    const t = fixedTokens();
    const body = '__MODULE__ __ENTITY__';
    const a = renderTemplate({ body, tokens: t });
    const b = renderTemplate({ body, tokens: t });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different inputs produce different sha256', () => {
    const ta = fixedTokens();
    const tb = buildTokens({
      namespace: 'demo',
      module: 'Different',
      entity: 'Greeting',
      specVersion: '0.1.0',
      specSha256: 'a'.repeat(64),
    });
    const body = '__MODULE__';
    expect(renderTemplate({ body, tokens: ta }).sha256).not.toBe(
      renderTemplate({ body, tokens: tb }).sha256,
    );
  });
});
// Invariants: INV-DEVAI-001
// Invariants: INV-SCAFFOLD-001
