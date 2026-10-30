import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('reviewed createRequire native loader closure', () => {
  for (const declaration of ['const', 'let', 'var']) {
    for (const call of ['localRequire(proofEntry)', "localRequire('@devai-nyx/authority')"]) {
      it(`requires explicit reviewed closure for ${declaration} alias and ${call}`, () => {
        const tree = mkdtempSync(join(tmpdir(), 'devai-native-loader-cover-'));
        const put = (file: string, text: string): void => {
          mkdirSync(dirname(join(tree, file)), { recursive: true });
          writeFileSync(join(tree, file), text);
        };
        const workflow = 'jobs:\n  build:\n    steps:\n      - run: node scripts/load.mjs\n';
        const inventory = (covers?: readonly string[]) =>
          workflowStepInventory(workflow, tree, covers === undefined ? undefined : () => covers)[0]
            ?.files;
        try {
          put(
            'scripts/load.mjs',
            `import { createRequire } from 'node:module';\n${declaration} localRequire = createRequire(import.meta.url);\nconst proofEntry = process.env.PROOF;\n${call};\n`,
          );
          put('src/index.ts', 'export const native = 1;\n');
          put('src/proof.ts', 'export const proof = 2;\n');
          expect(inventory()).toBeUndefined();
          expect(inventory(['src/index.ts', 'src/proof.ts'])).toEqual([
            'scripts/load.mjs',
            'src/index.ts',
            'src/proof.ts',
          ]);
          expect(inventory(['src/index.ts', 'src/missing.ts'])).toBeUndefined();
          // A changed alias is still a loader; names do not confer authority.
          put(
            'scripts/load.mjs',
            `import { createRequire } from 'node:module';\n${declaration} unreviewedLoader = createRequire(import.meta.url);\nunreviewedLoader(process.env.PROOF);\n`,
          );
          expect(inventory()).toBeUndefined();
        } finally {
          rmSync(tree, { recursive: true, force: true });
        }
      });
    }
  }

  it('binds the actual native authority and private proof source in the committed gate closure', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/pull-request-checks.yml'), 'utf8');
    const inventory = workflowStepInventory(workflow, ROOT);
    const bound = [
      ...new Set(
        inventory.filter((step) => step.job === 'gate-rest').flatMap((step) => step.files ?? []),
      ),
    ];
    for (const path of [
      'scripts/commit-documentation-authority.mjs',
      'packages/authority/src/index.ts',
      'packages/authority/src/runtime/documentation-context.ts',
    ])
      expect(bound).toContain(path);
    const tree = mkdtempSync(join(tmpdir(), 'devai-native-proof-pin-'));
    try {
      for (const path of [
        ...new Set([...inventory.flatMap((step) => step.files ?? []), 'pnpm-workspace.yaml']),
      ]) {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        cpSync(join(ROOT, path), join(tree, path));
      }
      expect(jobEffectFacts(workflow, tree, 'gate-rest').effect).toBe('read-only');
      const proof = join(tree, 'packages/authority/src/runtime/documentation-context.ts');
      const original = readFileSync(proof);
      writeFileSync(proof, Buffer.concat([original, Buffer.from('\n// altered proof\n')]));
      expect(jobEffectFacts(workflow, tree, 'gate-rest').effect).toBe('unknown');
      expect(jobEffectFacts(workflow, tree, 'gate-cli').effect).toBe('read-only');
      writeFileSync(proof, original);
      expect(jobEffectFacts(workflow, tree, 'gate-rest').effect).toBe('read-only');
      rmSync(proof);
      expect(jobEffectFacts(workflow, tree, 'gate-rest').effect).toBe('unknown');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
