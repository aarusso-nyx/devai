// ADR-GOV-0026 Inspector Adversarial Acceptance IA-001..IA-004 (issue #412) at the write-scope
// judge every governed task diff passes through. Article 6 binds each changed path to its role
// by the static path table; under constitution 1.1.0 the Engineer also holds the
// focused-regression verb on the test class: it may add a test file, or change one without
// touching an existing assertion, when the test imports a source the same task changed. It may
// never delete a test, edit an assertion of a test it did not add, or reach a threshold, and an
// independent-assurance task withholds the verb entirely.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import type { TaskRecord } from '@devai-nyx/loop';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  article6Role,
  focusedRegressionAvailable,
  judgeWriteScope,
  type WriteChange,
} from '../../src/services/write-scope/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function permissive<T>(run: () => T | Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'write-scope' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'write-scope',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, async () => run());
  } finally {
    issuer.dispose();
  }
}

const EXISTING_TEST = [
  "import { describe, expect, it } from 'vitest';",
  "import { a } from '../../src/a.js';",
  '',
  "describe('a', () => {",
  "  it('is one', () => {",
  '    expect(a).toBe(1);',
  '  });',
  '});',
  '',
].join('\n');

/** The base tree of the task, before any change. */
const BASE: Readonly<Record<string, string>> = {
  'packages/x/package.json': `${JSON.stringify({
    name: '@fixture/x',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        development: './src/index.ts',
        default: './dist/index.js',
      },
    },
  })}\n`,
  'packages/x/src/index.ts': "export { a } from './a.js';\n",
  'packages/x/src/a.ts': 'export const a = 1;\n',
  'packages/x/src/b.ts': 'export const b = 1;\n',
  'packages/x/tests/unit/a.test.ts': EXISTING_TEST,
  'tests/config/local.config.ts': 'export default { coverage: { thresholds: { lines: 90 } } };\n',
};

/**
 * A head tree on disk: the base with `edits` applied (a null edit deletes), and the changes the
 * judge sees, in the shape a task diff reports them.
 */
interface TaskOptions {
  /** Further base files, present before the task. */
  readonly base?: Readonly<Record<string, string>>;
  /** Symbolic links the task adds, by path and target. */
  readonly links?: Readonly<Record<string, string>>;
}

function task(edits: Readonly<Record<string, string | null>>, options: TaskOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devai-write-scope-'));
  roots.push(root);
  const base: Readonly<Record<string, string>> = { ...BASE, ...options.base };
  const head = { ...base, ...edits };
  for (const [path, content] of Object.entries(head)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const [path, target] of Object.entries(options.links ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  const changes: WriteChange[] = [
    ...Object.entries(edits).map(([path, content]): WriteChange => ({
      path,
      kind: content === null ? 'deleted' : Object.hasOwn(base, path) ? 'modified' : 'added',
    })),
    ...Object.keys(options.links ?? {}).map((path): WriteChange => ({ path, kind: 'added' })),
  ];
  return { root, changes, readBase: (path: string) => base[path] };
}

const CHANGED_A = { 'packages/x/src/a.ts': 'export const a = 2;\n' };

const regression = (specifier: string) =>
  [
    "import { expect, it } from 'vitest';",
    `import { a } from '${specifier}';`,
    '',
    "it('is two', () => expect(a).toBe(2));",
    '',
  ].join('\n');

async function judge(
  edits: Readonly<Record<string, string | null>>,
  options: TaskOptions & {
    readonly discipline?: string;
    readonly focusedRegression?: boolean;
  } = {},
) {
  const { root, changes, readBase } = task(edits, options);
  return permissive(() =>
    judgeWriteScope({
      discipline: options.discipline ?? 'engineer',
      changes,
      focusedRegression: options.focusedRegression ?? true,
      headRoot: root,
      readBase,
    }),
  );
}

describe('Article 6 static path table', () => {
  it.each([
    ['packages/x/src/a.ts', 'engineer'],
    ['packages/x/tests/unit/a.test.ts', 'inspector'],
    ['tests/contract/a.contract.test.ts', 'inspector'],
    ['package.json', 'engineer'],
    ['docs/notes.md', 'architect'],
    ['law/policy/x.json', 'architect'],
    ['unlisted.txt', undefined],
  ])('binds %s to %s', (path, role) => {
    expect(article6Role(path)).toBe(role);
  });
});

describe('IA-001: an Engineer test adjacent to the task change is admitted', () => {
  it('admits a new test importing the changed source relatively', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a-regression.test.ts': regression('../../src/a.js'),
    });
    expect(verdict.outOfScope).toEqual([]);
  });

  it('admits a root tests/ file importing the changed package source', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'tests/unit/a-regression.test.ts': regression('../../packages/x/src/a.js'),
    });
    expect(verdict.outOfScope).toEqual([]);
  });

  it('admits a test whose workspace import resolves to the changed package entry', async () => {
    const verdict = await judge({
      'packages/x/src/index.ts': "export { a } from './a.js';\nexport const extra = 1;\n",
      'packages/x/tests/unit/entry.test.ts': regression('@fixture/x'),
    });
    expect(verdict.outOfScope).toEqual([]);
  });

  it('admits an existing test that gains a new test and keeps every assertion', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a.test.ts': `${EXISTING_TEST}it('is a number', () => expect(typeof a).toBe('number'));\n`,
    });
    expect(verdict.outOfScope).toEqual([]);
  });

  it('refuses a test that imports no source the task changed', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/b.test.ts': regression('../../src/b.js'),
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/b.test.ts']);
  });

  it('refuses a test written without any source change in the task', async () => {
    const verdict = await judge({
      'packages/x/tests/unit/a-alone.test.ts': regression('../../src/a.js'),
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/a-alone.test.ts']);
  });

  it('refuses a test that names the changed source only in a comment', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/mention.test.ts':
        "// see '../../src/a.js'\nimport { it } from 'vitest';\nit('runs', () => {});\n",
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/mention.test.ts']);
  });

  it('refuses a non-test file under the test class even when it imports the change', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/helpers/a-fixture.ts': regression('../../src/a.js'),
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/helpers/a-fixture.ts']);
  });

  it('names why each refused test-class write was refused', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/b.test.ts': regression('../../src/b.js'),
    });
    expect(verdict.violations).toEqual([
      expect.stringContaining('packages/x/tests/unit/b.test.ts') as unknown,
    ]);
    expect(verdict.violations[0]).not.toBe('packages/x/tests/unit/b.test.ts');
  });
});

describe('IA-002: deletion, assertion edits and thresholds stay Inspector verbs', () => {
  it('refuses deleting a test, whatever else the task changes', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a.test.ts': null,
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/a.test.ts']);
  });

  it('refuses editing an assertion of a test the task did not add', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a.test.ts': EXISTING_TEST.replace('toBe(1)', 'toBe(2)'),
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/a.test.ts']);
  });

  it('refuses skipping a test the task did not add', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a.test.ts': EXISTING_TEST.replace("it('is one'", "it.skip('is one'"),
    });
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/a.test.ts']);
  });

  it('refuses skipping an existing test registered with a referenced callback', async () => {
    const referenced = [
      "import { expect, it } from 'vitest';",
      "import { a } from '../../src/a.js';",
      'function isTwo() {',
      '  expect(a).toBe(2);',
      '}',
      "it('is two', isTwo);",
      '',
    ].join('\n');
    const verdict = await judge(
      {
        ...CHANGED_A,
        'packages/x/tests/unit/ref.test.ts': referenced.replace("it('is two'", "it.skip('is two'"),
      },
      { base: { 'packages/x/tests/unit/ref.test.ts': referenced } },
    );
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/ref.test.ts']);
  });

  it('refuses a test-class path that is a symbolic link, even to an adjacent test', async () => {
    const verdict = await judge(
      {
        ...CHANGED_A,
        'packages/x/tests/unit/a-regression.test.ts': regression('../../src/a.js'),
      },
      { links: { 'packages/x/tests/unit/linked.test.ts': 'a-regression.test.ts' } },
    );
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/linked.test.ts']);
  });

  it('refuses lowering a coverage threshold', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'tests/config/local.config.ts':
        'export default { coverage: { thresholds: { lines: 10 } } };\n',
    });
    expect(verdict.outOfScope).toEqual(['tests/config/local.config.ts']);
  });

  it('admits any assertion in a test file the task itself added', async () => {
    const verdict = await judge({
      ...CHANGED_A,
      'packages/x/tests/unit/a-new.test.ts': regression('../../src/a.js').replace(
        'toBe(2)',
        'toBeGreaterThan(1)',
      ),
    });
    expect(verdict.outOfScope).toEqual([]);
  });
});

// Codex review on #426 (second pass): assertion identity only sees `expect`, so a test written
// with node:assert, Chai or an aliased expect could be edited unseen. An Engineer edit to an
// existing test file must therefore only add to it: every existing statement, nested test bodies
// included, stays byte-for-byte equivalent, whatever assertion API it uses.
describe('IA-002: an Engineer may only add to an existing test file', () => {
  const NODE_ASSERT = [
    "import assert from 'node:assert/strict';",
    "import { describe, it } from 'vitest';",
    "import { a } from '../../src/a.js';",
    '',
    "describe('a', () => {",
    "  it('is one', () => {",
    '    assert.equal(a, 1);',
    '  });',
    '});',
    '',
  ].join('\n');

  const modify = (from: string, to: string) =>
    judge(
      { ...CHANGED_A, 'packages/x/tests/unit/assert.test.ts': NODE_ASSERT.replace(from, to) },
      { base: { 'packages/x/tests/unit/assert.test.ts': NODE_ASSERT } },
    );

  it('refuses changing a node:assert assertion', async () => {
    expect((await modify('assert.equal(a, 1)', 'assert.equal(a, 2)')).outOfScope).toEqual([
      'packages/x/tests/unit/assert.test.ts',
    ]);
  });

  it('refuses removing a node:assert assertion', async () => {
    expect((await modify('    assert.equal(a, 1);\n', '')).outOfScope).toEqual([
      'packages/x/tests/unit/assert.test.ts',
    ]);
  });

  it('refuses changing a Chai-style or aliased assertion', async () => {
    const chai = NODE_ASSERT.replace('assert.equal(a, 1);', 'chai.assert.strictEqual(a, 1);');
    const aliased = NODE_ASSERT.replace(
      'assert.equal(a, 1);',
      'const check = expect;\n    check(a).toBe(1);',
    );
    for (const base of [chai, aliased]) {
      const head = base.replace('a, 1)', 'a, 2)').replace('toBe(1)', 'toBe(2)');
      const verdict = await judge(
        { ...CHANGED_A, 'packages/x/tests/unit/assert.test.ts': head },
        { base: { 'packages/x/tests/unit/assert.test.ts': base } },
      );
      expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/assert.test.ts']);
    }
  });

  it('refuses changing an existing import of the test', async () => {
    expect(
      (await modify("from 'node:assert/strict'", "from '../helpers/lenient-assert.js'")).outOfScope,
    ).toEqual(['packages/x/tests/unit/assert.test.ts']);
  });

  it('admits a new test inside an existing suite and a new import statement', async () => {
    const verdict = await modify(
      "import { a } from '../../src/a.js';",
      "import { a } from '../../src/a.js';\nimport { b } from '../../src/b.js';",
    );
    expect(verdict.outOfScope).toEqual([]);
    expect(
      (
        await modify(
          '  });\n});',
          "  });\n\n  it('is two', () => {\n    assert.equal(a, 2);\n  });\n});",
        )
      ).outOfScope,
    ).toEqual([]);
  });

  it('admits reformatting an existing statement without changing it', async () => {
    expect(
      (await modify('assert.equal(a, 1);', 'assert.equal(\n      a,\n      1,\n    );')).outOfScope,
    ).toEqual([]);
  });

  // Codex review on #426 (third pass): preserving every base statement is not enough when new
  // code may run before it. Only import declarations that bind names and new test or suite
  // registrations may be inserted into an existing test file.
  it.each([
    [
      'a return before an existing assertion',
      '    assert.equal(a, 1);',
      '    return;\n    assert.equal(a, 1);',
    ],
    [
      'a guard that skips an existing assertion',
      '    assert.equal(a, 1);',
      '    if (a !== 1) return;\n    assert.equal(a, 1);',
    ],
    [
      'a hook inside an existing suite',
      "describe('a', () => {",
      "describe('a', () => {\n  beforeEach(() => { globalThis.lenient = true; });",
    ],
    [
      'a module mock at the top of the file',
      "import { a } from '../../src/a.js';",
      "import { a } from '../../src/a.js';\nvi.mock('node:assert/strict');",
    ],
    [
      'a side-effect import',
      "import { a } from '../../src/a.js';",
      "import { a } from '../../src/a.js';\nimport '../helpers/patch-assert.js';",
    ],
  ])('refuses inserting %s', async (_label, from, to) => {
    expect((await modify(from, to)).outOfScope).toEqual(['packages/x/tests/unit/assert.test.ts']);
  });
});

describe('IA-003 and IA-004: without the verb Article 6 binds the test class to the Inspector', () => {
  it('refuses the adjacent test of IA-001 when the verb is withheld', async () => {
    const verdict = await judge(
      { ...CHANGED_A, 'packages/x/tests/unit/a-regression.test.ts': regression('../../src/a.js') },
      { focusedRegression: false },
    );
    expect(verdict.outOfScope).toEqual(['packages/x/tests/unit/a-regression.test.ts']);
  });

  it('still admits the source change itself', async () => {
    const verdict = await judge(CHANGED_A, { focusedRegression: false });
    expect(verdict.outOfScope).toEqual([]);
  });
});

describe('the Inspector is judged as before', () => {
  it('admits deletions and assertion edits on the test class', async () => {
    const verdict = await judge(
      {
        'packages/x/tests/unit/a.test.ts': EXISTING_TEST.replace('toBe(1)', 'toBe(3)'),
        'tests/config/local.config.ts': null,
      },
      { discipline: 'inspector' },
    );
    expect(verdict.outOfScope).toEqual([]);
  });

  it('refuses an Inspector source write', async () => {
    const verdict = await judge(CHANGED_A, { discipline: 'inspector' });
    expect(verdict.outOfScope).toEqual(['packages/x/src/a.ts']);
  });
});

describe('when the focused-regression verb is available', () => {
  const engineerTask = (extra: Record<string, unknown> = {}) =>
    ({ id: 'TASK-0001', discipline: 'engineer', ...extra }) as unknown as TaskRecord;

  function repository(version: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'devai-write-scope-pin-'));
    roots.push(root);
    if (version !== undefined) {
      mkdirSync(join(root, '.devai/pin'), { recursive: true });
      writeFileSync(
        join(root, '.devai/pin/constitution.md'),
        `# DEVAI Constitution — ${version}\n\n**Version:** ${version}\n`,
      );
    }
    return root;
  }

  it.each([
    ['1.0.2', false],
    ['1.1.0', true],
    ['1.2.3', true],
    ['2.0.0', true],
  ])('reads constitution %s as granting the verb: %s', async (version, granted) => {
    const root = repository(version);
    expect(await permissive(() => focusedRegressionAvailable(root, engineerTask()))).toBe(granted);
  });

  it('withholds the verb without a pinned constitution', async () => {
    const root = repository(undefined);
    expect(await permissive(() => focusedRegressionAvailable(root, engineerTask()))).toBe(false);
  });

  it('withholds the verb from an independent-assurance task (IA-003)', async () => {
    const root = repository('1.1.0');
    expect(
      await permissive(() =>
        focusedRegressionAvailable(root, engineerTask({ independent_assurance: true })),
      ),
    ).toBe(false);
  });

  it('never grants the verb to another discipline', async () => {
    const root = repository('1.1.0');
    expect(
      await permissive(() =>
        focusedRegressionAvailable(root, engineerTask({ discipline: 'inspector' })),
      ),
    ).toBe(false);
  });
});
