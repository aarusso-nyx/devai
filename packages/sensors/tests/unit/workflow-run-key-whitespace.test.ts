import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/harness/workflow-parser.js';

describe('workflow run-key whitespace boundaries', () => {
  it('captures a run step with spacing before the key colon and after the list marker', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/ci.yml',
      `jobs:
  build:
    steps:
      -   run : echo spaced
`,
      '/repo',
    );

    expect(ast.runScripts).toEqual(['echo spaced']);
    expect(ast.runStepCount).toBe(1);
    expect(ast.jobs).toEqual([
      { name: 'build', stepCount: 1, matrixDimensions: 0, matrixCombinations: 0 },
    ]);
  });
});
