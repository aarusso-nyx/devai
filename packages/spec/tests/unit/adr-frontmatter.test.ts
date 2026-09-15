import { describe, expect, it } from 'vitest';
import { parseAdrFrontMatter } from '../../src/adr/index.js';

describe('ADR frontmatter subset', () => {
  it.each(['\n', '\r\n'])('parses records with newline %j without coercing scalars', (newline) => {
    const text = [
      '   ',
      '  # Inspector comment',
      'id  :  ADR-GOV-0042  ',
      'title: "Owner\'s decision"',
      "status: 'accepted'",
      'date: 2026-09-07',
      'enabled: false',
      'count: 42',
      '_private2: value',
      '',
    ].join(newline);
    expect(parseAdrFrontMatter(text)).toEqual({
      id: 'ADR-GOV-0042',
      title: "Owner's decision",
      status: 'accepted',
      date: '2026-09-07',
      enabled: 'false',
      count: '42',
      _private2: 'value',
    });
  });

  it('trims inline list members and strips only their enclosing quotes', () => {
    expect(
      parseAdrFrontMatter(`supersedes: [ 'ADR-GOV-0001', "ADR-GOV-0002" ]
provenance: [Owner's approval, a"b]
affected_rules: [   ]`),
    ).toEqual({
      supersedes: ['ADR-GOV-0001', 'ADR-GOV-0002'],
      provenance: ["Owner's approval", 'a"b'],
      affected_rules: [],
    });
  });

  it('terminates block lists at the next field and trims member whitespace', () => {
    expect(
      parseAdrFrontMatter(`supersedes:
  -   ADR-GOV-0001${'   '}
  - ADR-GOV-0002
status: accepted
provenance:
affected_rules:
  - law/policy/example.json`),
    ).toEqual({
      supersedes: ['ADR-GOV-0001', 'ADR-GOV-0002'],
      status: 'accepted',
      provenance: [],
      affected_rules: ['law/policy/example.json'],
    });
  });

  it.each(['prefix [value]', '[value] suffix'])(
    'preserves a scalar that merely contains list brackets: %s',
    (value) => expect(parseAdrFrontMatter(`title: ${value}`)).toEqual({ title: value }),
  );

  it.each(['id: first\nid: second', 'supersedes: []\nsupersedes:\n  - other'])(
    'rejects duplicate fields without overwriting the first value',
    (text) => expect(() => parseAdrFrontMatter(text)).toThrow(/duplicate frontmatter key/u),
  );

  it.each(['!id: value', '1id: value', 'missing separator', 'id: value\n  nested: forbidden'])(
    'rejects unsupported syntax with its exact line number: %j',
    (text) =>
      expect(() => parseAdrFrontMatter(text)).toThrow(
        `unparseable frontmatter line ${text.split('\n').length}`,
      ),
  );

  it('accepts an empty document and blank or comment-only content', () => {
    expect(parseAdrFrontMatter('')).toEqual({});
    expect(parseAdrFrontMatter('\n  \n # comment\n')).toEqual({});
  });
});
