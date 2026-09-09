import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/harness/workflow-parser.js';

const file = '/repo/.github/workflows/cache.yml';

describe('workflow cache and run boundaries', () => {
  it('does not treat a cache key more than ten lines after setup-node as built-in caching', () => {
    const filler = Array.from({ length: 9 }, (_, index) => `          # filler-${index}`);
    const content = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      ...filler,
      '          cache: pnpm',
    ].join('\n');

    expect(parseWorkflow(file, content, '/repo').hasCache).toBe(false);
  });

  it('requires a real cache key and accepts additional spacing after the colon', () => {
    const spaced = parseWorkflow(
      file,
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          cache:  pnpm',
      ].join('\n'),
      '/repo',
    );
    expect(spaced.hasCache).toBe(true);

    const wrongKey = parseWorkflow(
      file,
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          cache-mode: pnpm',
      ].join('\n'),
      '/repo',
    );
    expect(wrongKey.hasCache).toBe(false);

    const empty = parseWorkflow(
      file,
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          cache: ',
      ].join('\n'),
      '/repo',
    );
    expect(empty.hasCache).toBe(false);
  });

  it('only records actual run keys, not text containing run followed by a colon', () => {
    const content = [
      'jobs:',
      '  build:',
      '    name: "run: echo fake"',
      '    steps:',
      '      - name: actual',
      '        run: echo real',
    ].join('\n');

    const ast = parseWorkflow(file, content, '/repo');
    expect(ast.runScripts).toEqual(['echo real']);
    expect(ast.runStepCount).toBe(1);
  });
});
