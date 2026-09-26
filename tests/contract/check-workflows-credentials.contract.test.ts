// ADR-SEC-0001, Inspector Adversarial Acceptance IA-001: a workflow secret
// reference absent from law/policy/credential-requirements.json, or a
// manifest entry no workflow references, fails the workflow check. Only
// workflow consumers ({workflow, job}) count for the bijection; action
// ({action_id}) and command ({command}) consumers are exempt.
//
// Red today: scripts/check-workflows.mjs never reads
// law/policy/credential-requirements.json at all (grep for "credential"
// across the file turns up nothing), so it has no notion of a workflow ->
// manifest secret bijection. Both cases below are red until the checker is
// taught to (a) collect every `secrets.NAME` reference in a workflow job and
// require a manifest entry whose consumer list names that workflow and job,
// and (b) fail when a manifest entry that a workflow consumer names is
// removed while the workflow still references the secret.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const TOOLCHAIN_MANIFEST_PATH = resolve(ROOT, '.devai/config/toolchain.json');
const CREDENTIAL_MANIFEST_PATH = resolve(ROOT, 'law/policy/credential-requirements.json');
const LEDGER_WORKFLOW_FILE = 'devai-ledger-verify.yml';

interface CredentialManifest {
  readonly entries: ReadonlyArray<{ readonly id: string; readonly consumer: readonly unknown[] }>;
}

const credentialManifest = JSON.parse(
  readFileSync(CREDENTIAL_MANIFEST_PATH, 'utf8'),
) as CredentialManifest;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Copies the real workflow tree plus both manifests into a scratch root, so
 * the checker's other rules stay satisfied and only the mutation under test
 * can produce a finding. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-workflow-credential-check-'));
  roots.push(root);
  const workflowsOut = join(root, '.github/workflows');
  mkdirSync(workflowsOut, { recursive: true });
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    writeFileSync(join(workflowsOut, name), readFileSync(join(WORKFLOWS_DIR, name)));
  }
  const configOut = join(root, '.devai/config');
  mkdirSync(configOut, { recursive: true });
  writeFileSync(join(configOut, 'toolchain.json'), readFileSync(TOOLCHAIN_MANIFEST_PATH));
  const policyOut = join(root, 'law/policy');
  mkdirSync(policyOut, { recursive: true });
  writeFileSync(
    join(policyOut, 'credential-requirements.json'),
    readFileSync(CREDENTIAL_MANIFEST_PATH),
  );
  return root;
}

function readWorkflow(root: string, file: string): string {
  return readFileSync(join(root, '.github/workflows', file), 'utf8');
}

function writeWorkflow(root: string, file: string, source: string): void {
  writeFileSync(join(root, '.github/workflows', file), source);
}

it('names UNDECLARED_THING and the file when a workflow references a secret absent from the credential manifest', () => {
  const root = fixture();
  const file = LEDGER_WORKFLOW_FILE;
  const anchor = 'EVIDENCE_READ_TOKEN: ${{ secrets.DEVAI_EVIDENCE_READ_TOKEN }}';
  const source = readWorkflow(root, file);
  expect(source).toContain(anchor);
  writeWorkflow(
    root,
    file,
    source.replace(
      anchor,
      `${anchor}\n          UNDECLARED_SECRET: \${{ secrets.UNDECLARED_THING }}`,
    ),
  );

  const result = checkWorkflowTree(root);

  const named = result.findings.find(
    (item) => item.file === file && item.detail.includes('UNDECLARED_THING'),
  );
  expect(named, JSON.stringify(result.findings)).toBeDefined();
});

it('names the missing entry when a manifest entry a workflow still references is removed from the manifest', () => {
  const root = fixture();
  const removedId = 'DEVAI_LEDGER_RESULTS_TGZ_B64';
  const entry = credentialManifest.entries.find((candidate) => candidate.id === removedId);
  expect(
    entry,
    'fixture assumption: manifest must declare DEVAI_LEDGER_RESULTS_TGZ_B64',
  ).toBeDefined();
  // Sanity: the entry we are about to delete is a genuine workflow consumer
  // (not merely an action or command consumer), so removing it must surface
  // through the workflow-to-manifest bijection this test exercises.
  expect(
    entry?.consumer.some(
      (consumer) => typeof consumer === 'object' && consumer !== null && 'workflow' in consumer,
    ),
  ).toBe(true);
  const manifestPath = join(root, 'law/policy/credential-requirements.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CredentialManifest & {
    entries: Array<{ id: string }>;
  };
  manifest.entries = manifest.entries.filter((candidate) => candidate.id !== removedId);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = checkWorkflowTree(root);

  const named = result.findings.find((item) => item.detail.includes(removedId));
  expect(named, JSON.stringify(result.findings)).toBeDefined();
});
