// ADR-CHK-0002, Inspector Adversarial Acceptance: a workflow that pins a node
// version or action digest differing from .devai/config/toolchain.json must
// fail the workflow check by name and value (IA-001), and the release
// workflow's EXPECTED_ACTION_COUNT constant must be checked against the
// manifest the same way. Today scripts/check-workflows.mjs never reads the
// manifest at all (it compares against constants hardcoded at the top of the
// file), so these cases are red until the checker is rewired to consume it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const MANIFEST_PATH = resolve(ROOT, '.devai/config/toolchain.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  runtimes: { node: string };
  actions: Record<string, { digest: string }>;
  constants: { expected_action_count: number };
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Copies the real workflow tree plus the manifest into a scratch root, so the
 * checker's other rules (required file set, trust boundary, etc.) stay
 * satisfied and only the mutation under test can produce a finding. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-toolchain-manifest-check-'));
  roots.push(root);
  const workflowsOut = join(root, '.github/workflows');
  mkdirSync(workflowsOut, { recursive: true });
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    writeFileSync(join(workflowsOut, name), readFileSync(join(WORKFLOWS_DIR, name)));
  }
  const configOut = join(root, '.devai/config');
  mkdirSync(configOut, { recursive: true });
  writeFileSync(join(configOut, 'toolchain.json'), readFileSync(MANIFEST_PATH));
  return root;
}

function mutate(root: string, file: string, from: string, to: string): void {
  const path = join(root, '.github/workflows', file);
  const source = readFileSync(path, 'utf8');
  expect(source).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

it('names the file, the manifest action key, the observed digest, and the required digest when a pinned action digest diverges from the manifest', () => {
  const root = fixture();
  const file = 'pull-request-checks.yml';
  const checkout = manifest.actions['actions/checkout'];
  if (checkout === undefined) throw new Error('manifest lacks actions/checkout');
  const requiredDigest = checkout.digest;
  const observedDigest = 'f'.repeat(40);
  mutate(root, file, `actions/checkout@${requiredDigest}`, `actions/checkout@${observedDigest}`);

  const result = checkWorkflowTree(root);

  const named = result.findings.find(
    (item: { file: string; detail: string }) =>
      item.file === file &&
      item.detail.includes('actions/checkout') &&
      item.detail.includes(observedDigest) &&
      item.detail.includes(requiredDigest),
  );
  expect(named, JSON.stringify(result.findings)).toBeDefined();
});

it('names the file, the node key, the observed major, and the required major when a workflow node-version diverges from the manifest', () => {
  const root = fixture();
  const file = 'devai-ledger-verify.yml';
  const requiredMajor = manifest.runtimes.node.split('.')[0] ?? '';
  const observedMajor = '99';
  mutate(root, file, `node-version: ${requiredMajor}`, `node-version: ${observedMajor}`);

  const result = checkWorkflowTree(root);

  const named = result.findings.find(
    (item: { file: string; detail: string }) =>
      item.file === file &&
      /node/iu.test(item.detail) &&
      item.detail.includes(observedMajor) &&
      item.detail.includes(requiredMajor),
  );
  expect(named, JSON.stringify(result.findings)).toBeDefined();
});

it('names the file, the constants key, the observed count, and the required count when EXPECTED_ACTION_COUNT diverges from the manifest', () => {
  const root = fixture();
  const file = 'release.yml';
  const requiredCount = String(manifest.constants.expected_action_count);
  const observedCount = '999';
  mutate(
    root,
    file,
    `EXPECTED_ACTION_COUNT: ${requiredCount}`,
    `EXPECTED_ACTION_COUNT: ${observedCount}`,
  );

  const result = checkWorkflowTree(root);

  const named = result.findings.find(
    (item: { file: string; detail: string }) =>
      item.file === file &&
      /expected_action_count/iu.test(item.detail) &&
      item.detail.includes(observedCount) &&
      item.detail.includes(requiredCount),
  );
  expect(named, JSON.stringify(result.findings)).toBeDefined();
});

it('exits with DEVAI_TOOLCHAIN_MANIFEST_REQUIRED when the controls file names an absent manifest path', () => {
  // scripts/release-host/provision-toolchain.mjs today never mentions a
  // manifest at all: it validates docker_binary / docker_config_directory /
  // output_directory / engine_socket and then calls docker directly. This
  // fixture supplies a syntactically valid controls file (so control
  // validation itself is not what fails) that additionally names an absent
  // manifest_path, per the naming convention of the other controls fields.
  // Until the script is taught to require and read the manifest before
  // touching docker, this spawns real docker and fails earlier, at
  // DEVAI_TOOLCHAIN_COMMAND_FAILED (no docker binary is available here) —
  // never at DEVAI_TOOLCHAIN_MANIFEST_REQUIRED.
  // realpathSync matters here: on macOS os.tmpdir() lives under /var, which is
  // itself a symlink to /private/var, and the control validation rejects any
  // path whose realpath differs from the literal path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-provision-toolchain-')));
  roots.push(root);
  const dockerConfigDirectory = join(root, 'docker-config');
  mkdirSync(dockerConfigDirectory, { recursive: true });
  writeFileSync(join(dockerConfigDirectory, 'config.json'), '{"auths":{}}\n');
  const outputDirectory = join(root, 'output');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const dockerBinary = join(root, 'docker-binary');
  writeFileSync(dockerBinary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const dockerBinarySha256 = createHash('sha256').update(readFileSync(dockerBinary)).digest('hex');
  const manifestPath = join(root, 'absent-toolchain-manifest.json');
  const controls = {
    docker_binary: dockerBinary,
    docker_binary_sha256: dockerBinarySha256,
    docker_config_directory: dockerConfigDirectory,
    output_directory: outputDirectory,
    engine_socket: 'unix:///run/docker.sock',
    engine_version: '0.0.0-fixture',
    manifest_path: manifestPath,
  };
  const controlsPath = join(root, 'controls.json');
  writeFileSync(controlsPath, `${JSON.stringify(controls)}\n`);

  const script = resolve(ROOT, 'scripts/release-host/provision-toolchain.mjs');
  const result = spawnSync(process.execPath, [script, controlsPath], { encoding: 'utf8' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('DEVAI_TOOLCHAIN_MANIFEST_REQUIRED');
});
