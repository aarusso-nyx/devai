import { describe, expect, it } from 'vitest';
import { parseConstitutionVersion } from '../../src/constitution-version.js';

describe('constitution version headers', () => {
  it.each(['Version', 'Candidate version'])(
    'reads a %s header inside a complete document',
    (label) => {
      expect(parseConstitutionVersion(`# Constitution\n**${label}:** 12.34.56\n\nArticles`)).toBe(
        '12.34.56',
      );
    },
  );
  it('accepts horizontal whitespace and CRLF', () => {
    expect(parseConstitutionVersion('**Version:**\t1.2.3  \r\nArticle')).toBe('1.2.3');
  });
  it.each([
    '',
    '**version:** 1.2.3',
    'Version: 1.2.3',
    '**Version:** 1.2',
    '**Version:** 1x2x3',
    '**Version:** v1.2.3',
    '**Version:** 1.2.3-rc.1',
    '**Version:** 1.2.3 extra',
    'Example **Version:** 1.2.3',
  ])('does not invent a version from malformed input %j', (text) => {
    expect(parseConstitutionVersion(text)).toBeNull();
  });
});
