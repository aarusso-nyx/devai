// ADR-SCR-0018: earlier observations cannot lend identity or closure to later bytes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hash,
  populate,
  put,
  workflow,
} from '../../../../tests/helpers/workflow-inventory-fixture.js';
import type { ReviewedWorkflowStep } from '../../src/harness/reviewed-workflow-steps.js';
import { adopterWorkflowClosureFacts } from '../../src/harness/adopter-workflow-closure.js';
import {
  workflowReviewInventory,
  workflowStepInventory,
} from '../../src/harness/workflow-parser.js';

const boundary = vi.hoisted(() => ({
  read: undefined as undefined | ((root: string, path: string, bytes: Buffer) => Buffer),
}));
vi.mock('../../src/audit-projection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audit-projection.js')>();
  return {
    ...actual,
    readCandidateFile(root: string, path: string) {
      const bytes = actual.readCandidateFile(root, path);
      return boundary.read?.(root, path, bytes) ?? bytes;
    },
  };
});
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai workflow observation ç '));
  roots.push(root);
  populate(root);
  return root;
}
afterEach(() => {
  boundary.read = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function bind(root: string, entry: ReviewedWorkflowStep): void {
  const target = '.devai/config/reviewed-workflow-steps.json';
  const source = 'law/adopter-policy.json';
  const document = { schemaVersion: '1.0.0', steps: [entry] };
  const policy = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.workflow',
    policy_version: '1.0.0',
    reviewed_workflow_steps: document,
  };
  put(root, source, JSON.stringify(policy));
  put(root, target, JSON.stringify(document));
  put(
    root,
    '.devai/config/adopter-policy-binding.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      source_path: source,
      source_digest_sha256: hash(readFileSync(join(root, source))),
      materialized: { [target]: hash(readFileSync(join(root, target))) },
    }),
  );
}

describe('workflow inventory observation boundaries', () => {
  it.each(['name', 'run'] as const)(
    'does not lend an earlier verified computed cover to a changed %s at the same occurrence',
    (field) => {
      const root = fixture();
      put(root, 'scripts/main.mjs', "const selected = './leaf.mjs'; await import(selected);\n");
      const original = workflow();
      const digest = workflowStepInventory(original)[0]?.sha256;
      if (digest === undefined) throw new Error('Missing canonical fixture digest');
      bind(root, {
        sha256: digest,
        effect: 'read-only',
        workflow: '.github/workflows/check.yml#verify[0]',
        step: 'Inspect',
        review: 'Only this exact physical occurrence and computed import is reviewed.',
        files: ['package.json', 'scripts/leaf.mjs', 'scripts/main.mjs'].map((path) => ({
          path,
          sha256: hash(readFileSync(join(root, path))),
        })),
        computed_imports: [
          {
            from: 'scripts/main.mjs',
            files: ['scripts/leaf.mjs'],
            reason: 'The one reviewed candidate helper.',
          },
        ],
      });
      expect(workflowReviewInventory(root).status).toBe('complete');
      const changed =
        field === 'name'
          ? original.replace('- name: Inspect', '- name: Changed')
          : original.replace('node scripts/main.mjs', 'node scripts/main.mjs --changed');
      put(root, '.github/workflows/check.yml', changed);
      // The review validator sees the earlier snapshot; the inventory observes newer bytes.
      boundary.read = (_root, path, bytes) =>
        path === '.github/workflows/check.yml' ? Buffer.from(original) : bytes;
      const result = workflowReviewInventory(root);
      expect(result.status).toBe('unknown');
      expect(result.workflows[0]?.sha256).toBe(hash(changed));
      expect(result.workflows[0]?.steps[0]).toMatchObject({
        occurrence: '.github/workflows/check.yml#verify[0]',
        name: field === 'name' ? 'Changed' : 'Inspect',
        sha256: workflowStepInventory(changed)[0]?.sha256,
        closure: {
          status: 'unknown',
          files: null,
          reason: 'WORKFLOW_INVENTORY_REVIEW_BINDING_INVALID',
        },
      });
      expect(result.workflows[0]?.steps[0]?.sha256).not.toBe(digest);
    },
  );

  it('does not hash newer executable bytes as though their import graph had been analyzed', () => {
    const root = fixture();
    const analyzed = readFileSync(join(root, 'scripts/main.mjs'));
    const changed = `${analyzed.toString('utf8')}\nconst hidden = './unproved.mjs'; await import(hidden);\n`;
    put(root, 'scripts/main.mjs', changed);
    boundary.read = (_root, path, bytes) => (path === 'scripts/main.mjs' ? analyzed : bytes);
    const result = workflowReviewInventory(root);
    expect(result.status).toBe('unknown');
    expect(result.workflows[0]?.steps[0]?.closure).toMatchObject({
      status: 'unknown',
      files: null,
    });
    expect(readFileSync(join(root, 'scripts/main.mjs'), 'utf8')).toBe(changed);
  });

  it('refuses a transitive file mutation between analysis and the source recheck', () => {
    const root = fixture();
    let changed = false;
    boundary.read = (_root, path, bytes) => {
      if (!changed && path === 'scripts/leaf.mjs') {
        changed = true;
        put(root, path, 'export const value = 999;\n');
      }
      return bytes;
    };
    expect(() => workflowReviewInventory(root)).toThrow('WORKFLOW_INVENTORY_CHANGED');
    expect(changed).toBe(true);
  });

  it('refuses a workflow population added after the first source census', () => {
    const root = fixture();
    let changed = false;
    boundary.read = (_root, path, bytes) => {
      if (!changed && path === 'scripts/main.mjs') {
        changed = true;
        put(root, '.github/workflows/added.yml', workflow());
      }
      return bytes;
    };
    expect(() => workflowReviewInventory(root)).toThrow('WORKFLOW_INVENTORY_CHANGED');
    expect(changed).toBe(true);
  });

  it('refuses a formerly absent higher-priority resolution file appearing after fallback selection', () => {
    const root = fixture();
    put(root, 'scripts/main.ts', "import './shadow.js';\n");
    put(root, 'scripts/shadow.js', 'export const fallback = true;\n');
    const entry: ReviewedWorkflowStep = {
      sha256: 'a'.repeat(64),
      effect: 'read-only',
      workflow: '.github/workflows/check.yml#verify[0]',
      step: 'Inspect',
      review: 'No computed imports in this resolution fixture.',
      files: [],
    };
    const initial = adopterWorkflowClosureFacts(root, 'tsx scripts/main.ts', entry);
    expect(initial?.map((row) => row.path)).toEqual([
      'package.json',
      'scripts/main.ts',
      'scripts/shadow.js',
    ]);
    let changed = false;
    boundary.read = (_root, path, bytes) => {
      if (!changed && path === 'scripts/shadow.js') {
        changed = true;
        put(root, 'scripts/shadow.ts', 'export const higherPriority = true;\n');
      }
      return bytes;
    };
    expect(adopterWorkflowClosureFacts(root, 'tsx scripts/main.ts', entry)).toBeUndefined();
    expect(changed).toBe(true);
    expect(readFileSync(join(root, 'scripts/shadow.ts'), 'utf8')).toBe(
      'export const higherPriority = true;\n',
    );
  });
});
