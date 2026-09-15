import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const gitObject = (value) => typeof value === 'string' && /^(?!0{40}$)[a-f0-9]{40}$/u.test(value);

function regular(path, maximum) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && stat.size <= maximum, 'MUTATION_CONTROL_FILE_INVALID');
  const bytes = readFileSync(path);
  requireValue(bytes.length === stat.size, 'MUTATION_CONTROL_FILE_CHANGED');
  return bytes;
}

/** The approval digest must come from protected operator configuration, never the bundle.
 * This checks an immutable control identity; it does not approve a pending proposal,
 * execute its modules, or establish mutation acceptance. */
function inspectApprovedVerifier({ root, candidateRoot, approvalSha256 }, kernels) {
  requireValue(hash(approvalSha256), 'MUTATION_CONTROL_APPROVAL_REQUIRED');
  const directory = realpathSync(root);
  requireValue(directory === resolve(root), 'MUTATION_CONTROL_LINK');
  const rel = relative(realpathSync(candidateRoot), directory);
  requireValue(
    rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    'MUTATION_CONTROL_INSIDE_CANDIDATE',
  );
  const approvalBytes = regular(join(directory, 'approval-candidate.json'), 1024 * 1024);
  requireValue(sha256(approvalBytes) === approvalSha256, 'MUTATION_CONTROL_APPROVAL_MISMATCH');
  const approval = JSON.parse(approvalBytes.toString('utf8'));
  requireValue(
    approval.schemaVersion === '1.0.0' &&
      gitObject(approval.source_base) &&
      gitObject(approval.source_commit) &&
      gitObject(approval.source_tree) &&
      approval.dependencies &&
      typeof approval.dependencies === 'object' &&
      !Array.isArray(approval.dependencies) &&
      Object.keys(approval.dependencies).length === 0 &&
      Array.isArray(approval.members) &&
      approval.members.length > 0 &&
      approval.members.length <= 512 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(approval.archive?.name ?? '') &&
      hash(approval.archive?.sha256),
    'MUTATION_CONTROL_MANIFEST_INVALID',
  );
  const archiveBytes = regular(join(directory, approval.archive.name), 64 * 1024 * 1024);
  requireValue(
    sha256(archiveBytes) === approval.archive.sha256 &&
      `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}` ===
        approval.archive.integrity,
    'MUTATION_CONTROL_ARCHIVE_MISMATCH',
  );
  const expected = new Map();
  for (const member of approval.members) {
    requireValue(
      typeof member.path === 'string' &&
        member.path.startsWith('package/') &&
        member.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        !member.path.includes('\\') &&
        ![...member.path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
        hash(member.sha256) &&
        Number.isSafeInteger(member.size) &&
        member.size >= 0 &&
        member.size <= 16 * 1024 * 1024 &&
        ['0o644', '0o755'].includes(member.mode) &&
        !expected.has(member.path),
      'MUTATION_CONTROL_MEMBER_INVALID',
    );
    expected.set(member.path, member);
  }
  const unpacked = join(directory, 'unpacked');
  let total = 0;
  const seen = new Set();
  function visit(path) {
    requireValue(lstatSync(path).isDirectory(), 'MUTATION_CONTROL_LINK');
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        const memberPath = relative(unpacked, file).split(sep).join('/');
        const member = expected.get(memberPath);
        requireValue(stat.isFile() && member, 'MUTATION_CONTROL_POPULATION_MISMATCH');
        total += stat.size;
        requireValue(total <= 64 * 1024 * 1024, 'MUTATION_CONTROL_POPULATION_LIMIT');
        const bytes = regular(file, 16 * 1024 * 1024);
        requireValue(
          bytes.length === member.size &&
            sha256(bytes) === member.sha256 &&
            (stat.mode & 0o7777) === Number(member.mode),
          'MUTATION_CONTROL_MEMBER_MISMATCH',
        );
        seen.add(memberPath);
      }
    }
  }
  visit(unpacked);
  requireValue(seen.size === expected.size, 'MUTATION_CONTROL_POPULATION_MISMATCH');
  for (const name of ['package.json', ...kernels, 'src/trust.js', 'src/artifact-safety.js'])
    requireValue(seen.has(`package/${name}`), 'MUTATION_CONTROL_KERNEL_MISSING');
  const manifest = JSON.parse(
    regular(join(unpacked, 'package/package.json'), 1024 * 1024).toString('utf8'),
  );
  requireValue(
    manifest.name === '@devai-nyx/evidence-verifier-reference' &&
      manifest.private === true &&
      [manifest.dependencies, manifest.optionalDependencies].every(
        (value) =>
          value === undefined ||
          (value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0),
      ),
    'MUTATION_CONTROL_PACKAGE_INVALID',
  );
  return Object.freeze({
    packageRoot: join(unpacked, 'package'),
    approvalSha256,
    archiveSha256: approval.archive.sha256,
    sourceCommit: approval.source_commit,
    sourceTree: approval.source_tree,
    files: seen.size,
  });
}

/** Historical mutation controls retain their original required kernels. */
export function inspectApprovedMutationVerifier(options) {
  return inspectApprovedVerifier(options, ['src/mutation-v21.js', 'src/mutation-v22.js']);
}

/** Current delivery verifies release integrity without requiring mutation kernels. */
export function inspectApprovedReleaseVerifier(options) {
  return inspectApprovedVerifier(options, [
    'src/canonical.js',
    'src/safe-path.js',
    'src/verify.js',
  ]);
}
