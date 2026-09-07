import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const { verifyMutationSemantics } = await import(
  pathToFileURL(resolve('scripts/process/verify-mutation-semantics.mjs')).href
);
const { mutationSemanticFixture, mutationSemanticFixtureV22 } = await import(
  pathToFileURL(resolve('tests/fixtures/mutation-semantic-fixture.mjs')).href
);
const { canonicalBytes } = await import(
  pathToFileURL(resolve('packages/cli/vendor/evidence-verification/src/canonical.js')).href
);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(statuses = ['Killed']) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai semantics ação-')));
  roots.push(parent);
  const candidateRoot = join(parent, 'candidate'),
    root = join(parent, 'control'),
    unpacked = join(root, 'unpacked'),
    packageRoot = join(unpacked, 'package'),
    artifactRoot = join(parent, 'artifacts');
  mkdirSync(candidateRoot);
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(artifactRoot);
  cpSync(resolve('packages/cli/vendor/evidence-verification/src'), join(packageRoot, 'src'), {
    recursive: true,
  });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@devai-nyx/evidence-verifier-reference',
      version: '0.1.0',
      private: true,
      type: 'module',
    }),
  );
  const names: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        chmodSync(path, 0o644);
        names.push(relative(unpacked, path));
      }
    }
  }
  walk(packageRoot);
  const archive = join(root, 'control.tgz');
  execFileSync('tar', ['-czf', archive, '-C', unpacked, 'package']);
  const archiveBytes = readFileSync(archive);
  const approval = Buffer.from(
    JSON.stringify({
      schemaVersion: '1.0.0',
      source_base: 'a'.repeat(40),
      source_commit: 'b'.repeat(40),
      source_tree: 'c'.repeat(40),
      dependencies: {},
      archive: {
        name: 'control.tgz',
        sha256: sha(archiveBytes),
        integrity: `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
      },
      members: names.map((path) => ({
        path,
        sha256: sha(readFileSync(join(unpacked, path))),
        size: readFileSync(join(unpacked, path)).length,
        mode: '0o644',
      })),
    }),
  );
  writeFileSync(join(root, 'approval-candidate.json'), approval);
  const data = mutationSemanticFixture(statuses);
  for (const [path, bytes] of Object.entries(data.files)) {
    const dest = join(artifactRoot, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes as Uint8Array);
  }
  const planBytes = Buffer.from(JSON.stringify(data.plan));
  const args = {
    control: { root, candidateRoot, approvalSha256: sha(approval) },
    planBytes,
    planExpected: { sha256: sha(planBytes), commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    artifactRoot,
    contractBytes: canonicalBytes(data.contract),
    expected: { schemaVersion: '2.1.0', semanticReceiptProvenance: data.provenance },
  };
  return { args, data };
}
it('independently verifies all ten synthetic package results through real installed control kernels', async () => {
  const f = fixture();
  const result = await verifyMutationSemantics(f.args);
  expect(result.verification).toMatchObject({
    complete: true,
    passed: true,
    packageCount: 10,
    notRequiredPackageCount: 0,
    score: 100,
  });
  expect(Object.keys(result.artifacts)).toHaveLength(22);
});
it.each(['missing', 'extra', 'link', 'noncanonical', 'provenance', 'candidate', 'version'])(
  'refuses mutation evidence substitution: %s',
  async (change) => {
    const f = fixture();
    const file = join(f.args.artifactRoot, 'mutation/summary.json');
    if (change === 'missing') rmSync(file);
    if (change === 'extra') writeFileSync(join(f.args.artifactRoot, 'extra.json'), '{}');
    if (change === 'link') {
      rmSync(file);
      symlinkSync(join(f.args.artifactRoot, 'mutation/semantic-receipt.json'), file);
    }
    if (change === 'noncanonical')
      writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n')]));
    if (change === 'provenance')
      f.args.expected.semanticReceiptProvenance.source.byteSetDigest = 'f'.repeat(64);
    if (change === 'candidate') f.args.planExpected.commit = 'f'.repeat(40);
    if (change === 'version') f.args.expected.schemaVersion = '2.2.0';
    await expect(verifyMutationSemantics(f.args)).rejects.toThrow();
  },
);
it('rejects score below 60 using the real verifier rather than trusting a pass field', async () => {
  const f = fixture(['Killed', 'Survived']);
  await expect(verifyMutationSemantics(f.args)).rejects.toThrow(/threshold/i);
});
it('rejects 51 survivors even when score exceeds 60', async () => {
  const f = fixture([...Array<string>(100).fill('Killed'), ...Array<string>(51).fill('Survived')]);
  await expect(verifyMutationSemantics(f.args)).rejects.toThrow(/threshold/i);
});

it('rejects changed report contents even when the replacement JSON is canonical', async () => {
  const f = fixture();
  const entry = f.data.contract.packages[0];
  const path = join(f.args.artifactRoot, entry.reportPath);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  report.framework.name = 'different runner';
  writeFileSync(path, canonicalBytes(report));
  await expect(verifyMutationSemantics(f.args)).rejects.toThrow();
});

async function v22Fixture() {
  const f = fixture();
  const data = await mutationSemanticFixtureV22();
  for (const [path, bytes] of Object.entries(data.files))
    writeFileSync(join(f.args.artifactRoot, path), bytes as Uint8Array);
  return {
    ...f.args,
    contractBytes: canonicalBytes(data.contract),
    expected: {
      schemaVersion: '2.2.0',
      semanticReceiptProvenance: data.provenance,
      v22: data.v22,
    },
  };
}
it('verifies a complete v2.2 closure with independently supplied execution bindings', async () => {
  const result = await verifyMutationSemantics(await v22Fixture());
  expect(result.verification).toMatchObject({
    schemaVersion: '2.2.0',
    packageCount: 10,
    memberCount: 22,
    complete: true,
    passed: true,
  });
});
it.each([
  'missing-controls',
  'contract-hash',
  'member-hash',
  'member-size',
  'extra-member',
  'task-binding',
  'candidate',
])('rejects changed v2.2 protected closure: %s', async (change) => {
  const args = await v22Fixture();
  const controls = args.expected.v22;
  if (change === 'missing-controls') args.expected.v22 = {};
  if (change === 'contract-hash') controls.expectedOutputContract.sha256 = 'f'.repeat(64);
  if (change === 'member-hash') controls.finalUnitReferent.members[0].sha256 = 'f'.repeat(64);
  if (change === 'member-size') controls.finalUnitReferent.members[0].sizeBytes += 1;
  if (change === 'extra-member')
    controls.finalUnitReferent.members.push({
      path: 'extra.json',
      sha256: 'f'.repeat(64),
      sizeBytes: 2,
    });
  if (change === 'task-binding')
    controls.expectedExecutionBindings[0].taskPolicyDigest = 'f'.repeat(64);
  if (change === 'candidate') controls.finalUnitReferent.candidate.commit = 'f'.repeat(40);
  await expect(verifyMutationSemantics(args)).rejects.toThrow();
});
