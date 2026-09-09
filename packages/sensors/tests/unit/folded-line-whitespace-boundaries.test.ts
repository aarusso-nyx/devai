import { describe, expect, it } from 'vitest';
import { foldWorkflowLines } from '../../src/harness/folded-lines.js';

describe('folded workflow line whitespace boundaries', () => {
  it('returns an empty scalar for blank and whitespace-only bodies', () => {
    expect(foldWorkflowLines(['', '   ', '\t', ''])).toBe('');
  });

  it('preserves leading blanks while deriving indentation from the first nonblank line', () => {
    expect(foldWorkflowLines(['', '    echo one', '    echo two'])).toBe('\necho one echo two');
  });

  it('preserves paragraph breaks represented by whitespace-only lines', () => {
    expect(foldWorkflowLines(['  first paragraph', '   ', '  second paragraph'])).toBe(
      'first paragraph\nsecond paragraph',
    );
  });

  it('preserves extra indentation as a hard line break', () => {
    expect(foldWorkflowLines(['  first', '    nested', '  last'])).toBe('first\n  nested\nlast');
  });
});
