import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { inspectApprovedMutationVerifier } = await import(
  pathToFileURL(resolve('scripts/process/approved-mutation-verifier.mjs')).href
);
const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai verifier ação-')));
  roots.push(parent);
  const root = join(parent, 'control'),
    candidateRoot = join(parent, 'candidate');
  mkdirSync(candidateRoot);
  const unpacked = join(root, 'unpacked');
  mkdirSync(join(unpacked, 'package/src'), { recursive: true });
  const files = [
    'package/package.json',
    'package/src/mutation-v21.js',
    'package/src/mutation-v22.js',
    'package/src/trust.js',
    'package/src/artifact-safety.js',
  ];
  const packageFile = join(unpacked, files[0] ?? '');
  writeFileSync(
    packageFile,
    JSON.stringify({
      name: '@devai-nyx/evidence-verifier-reference',
      version: '0.1.0',
      private: true,
      type: 'module',
    }),
  );
  for (const name of files.slice(1))
    writeFileSync(
      join(unpacked, name),
      'throw new Error("must not execute during identity inspection");\n',
    );
  for (const name of files) chmodSync(join(unpacked, name), 0o644);
  const archive = join(root, 'control.tgz');
  const refresh = () => {
    execFileSync('tar', ['-czf', archive, '-C', unpacked, 'package']);
    const bytes = readFileSync(archive);
    const approval = {
      schemaVersion: '1.0.0',
      approval: 'pending-independent-review-and-owner-approval',
      source_base: 'a'.repeat(40),
      source_commit: 'b'.repeat(40),
      source_tree: 'c'.repeat(40),
      dependencies: {},
      archive: {
        name: 'control.tgz',
        sha256: sha(bytes),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
      members: files.map((path) => ({
        path,
        sha256: sha(readFileSync(join(unpacked, path))),
        size: readFileSync(join(unpacked, path)).length,
        mode: '0o644',
      })),
    };
    const encoded = Buffer.from(JSON.stringify(approval));
    writeFileSync(join(root, 'approval-candidate.json'), encoded);
    return { root, candidateRoot, approvalSha256: sha(encoded) };
  };
  return { root, candidateRoot, unpacked, archive, packageFile, refresh, controls: refresh() };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('checks a complete external control without executing its kernels or approving its proposal', () => {
  const f = fixture();
  expect(inspectApprovedMutationVerifier(f.controls)).toMatchObject({
    packageRoot: join(f.unpacked, 'package'),
    approvalSha256: f.controls.approvalSha256,
    sourceCommit: 'b'.repeat(40),
    files: 5,
  });
});

it.each([undefined, '', 'g'.repeat(64)])(
  'requires an external valid approval digest: %s',
  (approvalSha256) => {
    expect(() =>
      inspectApprovedMutationVerifier({
        root: '/absent',
        candidateRoot: '/absent',
        approvalSha256,
      }),
    ).toThrow('MUTATION_CONTROL_APPROVAL_REQUIRED');
  },
);

it('rejects a different approval before inspecting or executing any payload', () => {
  const f = fixture();
  rmSync(f.unpacked, { recursive: true });
  expect(() =>
    inspectApprovedMutationVerifier({ ...f.controls, approvalSha256: 'f'.repeat(64) }),
  ).toThrow('MUTATION_CONTROL_APPROVAL_MISMATCH');
});

it('rejects controls inside the candidate and symbolic installation aliases', () => {
  const f = fixture();
  expect(() => inspectApprovedMutationVerifier({ ...f.controls, candidateRoot: f.root })).toThrow(
    'MUTATION_CONTROL_INSIDE_CANDIDATE',
  );
  const alias = join(f.candidateRoot, 'alias');
  symlinkSync(f.root, alias);
  expect(() => inspectApprovedMutationVerifier({ ...f.controls, root: alias })).toThrow(
    'MUTATION_CONTROL_LINK',
  );
});

it('rejects changed approved archive bytes', () => {
  const f = fixture();
  writeFileSync(f.archive, 'replacement');
  expect(() => inspectApprovedMutationVerifier(f.controls)).toThrow(
    'MUTATION_CONTROL_ARCHIVE_MISMATCH',
  );
});

it.each(['extra', 'missing', 'link', 'changed', 'mode', 'special-mode'])(
  'rejects unpacked population drift: %s',
  (change) => {
    const f = fixture();
    const file = join(f.unpacked, 'package/src/trust.js');
    if (change === 'extra') writeFileSync(join(f.unpacked, 'extra.js'), 'extra');
    if (change === 'missing') rmSync(file);
    if (change === 'link') {
      rmSync(file);
      symlinkSync(f.packageFile, file);
    }
    if (change === 'changed') writeFileSync(file, 'changed');
    if (change === 'mode') chmodSync(file, 0o755);
    if (change === 'special-mode') chmodSync(file, 0o4644);
    expect(() => inspectApprovedMutationVerifier(f.controls)).toThrow(
      /MUTATION_CONTROL_(POPULATION|MEMBER)_MISMATCH/,
    );
  },
);

it('refuses dependency expansion even when its changed manifest is externally selected', () => {
  const f = fixture();
  const manifest = JSON.parse(readFileSync(f.packageFile, 'utf8'));
  writeFileSync(
    f.packageFile,
    JSON.stringify({ ...manifest, dependencies: { unexpected: '1.0.0' } }),
  );
  expect(() => inspectApprovedMutationVerifier(f.refresh())).toThrow(
    'MUTATION_CONTROL_PACKAGE_INVALID',
  );
});

it('rejects unsafe paths and duplicate members in an externally selected manifest', () => {
  const f = fixture();
  const path = join(f.root, 'approval-candidate.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const memberPath of ['package/../escape', 'package/src/trust.js']) {
    const approval = structuredClone(original);
    approval.members.push({ ...approval.members[0], path: memberPath });
    const bytes = Buffer.from(JSON.stringify(approval));
    writeFileSync(path, bytes);
    expect(() =>
      inspectApprovedMutationVerifier({ ...f.controls, approvalSha256: sha(bytes) }),
    ).toThrow('MUTATION_CONTROL_MEMBER_INVALID');
  }
});

it('binds the independent mutation control even when unrelated prerequisites fail', async () => {
  const f = fixture();
  const { inspectPrerequisites, assertFresh } = await import(
    pathToFileURL(resolve('scripts/process/release-prerequisites.mjs')).href
  );
  const git = (args: string[]) => execFileSync('git', args, { cwd: f.candidateRoot });
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', 'https://github.com/aarusso-nyx/devai.git']);
  writeFileSync(join(f.candidateRoot, 'test-tasks.json'), '{}');
  git(['add', 'test-tasks.json']);
  git([
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const config = {
    repo: f.candidateRoot,
    outputDir: join(f.root, 'new-export'),
    mutationVerifierRoot: f.root,
    mutationVerifierApprovalSha256: f.controls.approvalSha256,
  };
  const configPath = join(f.root, 'operator-config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const before = inspectPrerequisites(config, configPath);
  expect(before.ok).toBe(false);
  expect(before.checks.find((check: { id: string }) => check.id === 'mutation-control')).toEqual({
    id: 'mutation-control',
    status: 'pass',
  });
  expect(before.bindings.mutationVerifierApproval).toBe(f.controls.approvalSha256);
  expect(before.bindings.mutationVerifierCommit).toBe('b'.repeat(40));
  const changed = inspectPrerequisites(
    { ...config, mutationVerifierApprovalSha256: 'f'.repeat(64) },
    configPath,
  );
  expect(
    changed.checks.find((check: { id: string }) => check.id === 'mutation-control')?.status,
  ).toBe('fail');
  expect(() => assertFresh({ ...before, ok: true }, changed)).toThrow();
});
