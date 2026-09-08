import { describe, expect, it } from 'vitest';
import { containsForbiddenContent, renderPublicSafe } from '../../src/tracking/redact.js';

const render = (value: string) => renderPublicSafe(value, { maxChars: 1000 });

// Synthetic credentials exercise disclosure boundaries without using live secrets.
describe('public tracking disclosure boundaries', () => {
  it.each([
    '-----BEGIN PRIVATE KEY-----\nfixture material\n-----END PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----\nfixture material\n-----END RSA PRIVATE KEY-----',
    ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((prefix) => `${prefix}_Aa12Bb34Cc56Dd78`),
    'github_pat_Aa12_Bb34_Cc56_Dd78_Ee90',
    'AKIA0123456789ABCDEF',
    'ASIA0123456789ABCDEF',
    ...['xoxa', 'xoxb', 'xoxp', 'xoxr', 'xoxs'].map((prefix) => `${prefix}-Aa12Bb34-Cc56Dd78`),
    'eyJAa12Bb34Cc56.Dd78Ee90Ff12.Gg34Hh56Ii78',
    'Bearer Aa12Bb34Cc56Dd78==',
    'bearer Aa12Bb34Cc56Dd78',
    'APP_ACCESS_TOKEN=fixture-value',
    'APP_PASSWORD: fixture-value',
    'SERVICE_CREDENTIALS = fixture-value',
    'a'.repeat(40),
  ])('withholds credential-shaped input %j and retains surrounding prose', (credential) => {
    expect(containsForbiddenContent(credential)).toBe(true);
    const output = render(`Before ${credential} after.`);
    expect(output).toBe('Before [REDACTED] after.');
    expect(containsForbiddenContent(output)).toBe(false);
  });

  it.each([
    '/Users/operator/private/file.txt',
    '/home/operator/private/file.txt',
    '/root/private/file.txt',
    '/var/folders/temporary/file.txt',
    'C:\\Users\\operator\\private.txt',
    '.ssh/id_ed25519',
    '.npmrc',
  ])('withholds host path %j without discarding surrounding prose', (path) => {
    expect(containsForbiddenContent(path)).toBe(true);
    expect(render(`Before "${path}" after.`)).toBe('Before "[PATH]" after.');
  });

  it('redacts every occurrence and keeps separate key blocks separate', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----';
    expect(render(`${key} middle ${key}`)).toBe('[REDACTED] middle [REDACTED]');
    expect(render('APP_TOKEN=first APP_TOKEN=second')).toBe('[REDACTED] [REDACTED]');
  });

  it('renders markup and notification syntax inert while retaining readable content', () => {
    expect(render('<b>Hello</b> @team #123 `literal` ![image](target)')).toBe(
      "Hello @\u200Bteam #\u200B123 'literal' image target)",
    );
    expect(render('@team #123 @_name #-name')).toBe(
      '@\u200Bteam #\u200B123 @\u200B_name #\u200B-name',
    );
  });

  it('normalizes control characters and blanks, and preserves ordinary prose', () => {
    expect(render('  one\u0000\t two\u007f\nthree  ')).toBe('one two three');
    expect(render(' \t\n ')).toBe('[REDACTED]');
    expect(render('Build passed: 24 checks.')).toBe('Build passed: 24 checks.');
    expect(containsForbiddenContent('Build passed: 24 checks.')).toBe(false);
  });

  it('marks clipping explicitly and leaves an exact-length summary complete', () => {
    expect(renderPublicSafe('12345678901234567890', { maxChars: 20 })).toBe('12345678901234567890');
    expect(renderPublicSafe('123456789012345678901', { maxChars: 20 })).toBe(
      '12345678 [TRUNCATED]',
    );
  });
});

it.each(['TOKEN', 'SECRET', 'PASSWORD', 'KEY', 'CREDENTIAL', 'CREDENTIALS'])(
  'withholds an unprefixed environment credential named %s',
  (name) => {
    for (const separator of ['=', ': ']) {
      const credential = `${name}${separator}synthetic-private-value`;
      expect(containsForbiddenContent(credential)).toBe(true);
      expect(render(`Before ${credential} after.`)).toBe('Before [REDACTED] after.');
    }
  },
);

it('keeps adjacent words separate when removing markup and link directives', () => {
  expect(render('alpha<b></b>beta')).toBe('alpha beta');
  expect(render('before![title](target)after')).toBe('before title target)after');
  expect(render('before][reference]after')).toBe('before reference]after');
});

it('neutralizes repeated fences without manufacturing runs of quote characters', () => {
  expect(render('```command``` and ``value``')).toBe("'command' and 'value'");
  expect(render('Bearer   Aa12Bb34Cc56Dd78')).toBe('[REDACTED]');
});
