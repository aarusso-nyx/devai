// AUT0009: provenance consumes the same native issuer as runtime authority. Historical
// trees supply data only; the current trusted workspace package supplies executable code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT = '.devai/config/adopter-policy-binding.json';
export const COMPILED_AUTHORITY_POLICY = '.devai/config/authority-policy.json';
const PROJECT = '.devai/config/project.json';
const PIN = '.devai/pin/constitution.md';
const JOURNAL = '.devai/config/adopter-policy-binding.journal.json';
const TRUSTED_WORKSPACE = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const CURRENT_CLI = join(TRUSTED_WORKSPACE, 'packages/cli/package.json');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refusal = (code, commit) => new Error(`${code}:${commit}`);
const git = (root, args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const safePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !posix.isAbsolute(path) &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

function nativeVerifier(commit) {
  try {
    const expectedEntry = join(TRUSTED_WORKSPACE, 'packages/authority/dist/index.js');
    const localRequire = createRequire(CURRENT_CLI);
    if (
      realpathSync(CURRENT_CLI) !== CURRENT_CLI ||
      realpathSync(expectedEntry) !== expectedEntry ||
      realpathSync(localRequire.resolve('@devai-nyx/authority')) !== expectedEntry
    )
      throw new Error('foreign native verifier installation');
    const authorityManifest = JSON.parse(
      readFileSync(join(TRUSTED_WORKSPACE, 'packages/authority/package.json'), 'utf8'),
    );
    if (authorityManifest.name !== '@devai-nyx/authority')
      throw new Error('wrong authority package');
    const native = localRequire('@devai-nyx/authority');
    const proofEntry = join(
      TRUSTED_WORKSPACE,
      'packages/authority/dist/runtime/documentation-context.js',
    );
    if (realpathSync(proofEntry) !== proofEntry)
      throw new Error('foreign native proof implementation');
    const { verifyBoundAuthorityPolicy } = localRequire(proofEntry);
    if (typeof verifyBoundAuthorityPolicy !== 'function')
      throw new Error('native proof unavailable');
    if (
      typeof native.loadBoundDocumentationImplementation !== 'function' ||
      typeof native.documentationImplementationOwnsPath !== 'function' ||
      typeof native.documentationImplementationFiles !== 'function'
    )
      throw new Error('native verifier exports missing');
    const manifest = JSON.parse(readFileSync(CURRENT_CLI, 'utf8'));
    if (manifest.name !== '@aarusso-nyx/devai') throw new Error('wrong owning CLI package');
    return { native, verifyBoundAuthorityPolicy, manifest };
  } catch {
    throw refusal('DOCUMENTATION_COMMIT_VERIFIER_UNAVAILABLE', commit);
  }
}

function treeReader(root, commit) {
  const entries = new Map();
  for (const row of git(root, ['ls-tree', '-r', '-t', '-z', commit]).toString('utf8').split('\0')) {
    if (row === '') continue;
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    // Only extraction targets are subject to safePath; unrelated Git filenames
    // cannot widen this documentation check into repository-wide path policy.
    if (tab < 0 || entries.has(path)) throw refusal('DOCUMENTATION_COMMIT_TREE_INVALID', commit);
    entries.set(path, { mode, type, oid });
  }
  const bytes = new Map();
  const read = (path, optional = false) => {
    if (!safePath(path)) throw refusal('DOCUMENTATION_COMMIT_PATH_INVALID', commit);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = entries.get(parts.slice(0, index).join('/'));
      if (ancestor !== undefined && (ancestor.mode !== '040000' || ancestor.type !== 'tree'))
        throw refusal('DOCUMENTATION_COMMIT_PATH_KIND_INVALID', commit);
    }
    const entry = entries.get(path);
    if (entry === undefined) {
      if (optional) return undefined;
      throw refusal('DOCUMENTATION_COMMIT_BINDING_INCOMPLETE', commit);
    }
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob')
      throw refusal('DOCUMENTATION_COMMIT_PATH_KIND_INVALID', commit);
    if (!bytes.has(path)) bytes.set(path, git(root, ['cat-file', 'blob', entry.oid]));
    return bytes.get(path);
  };
  return { entries, read };
}

function parse(bytes, commit) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!record(value)) throw new Error('not a record');
    return value;
  } catch {
    throw refusal('DOCUMENTATION_COMMIT_BINDING_INVALID', commit);
  }
}

/** This object never accepts caller-supplied verified contexts, package paths or callbacks. */
export function documentationCommitJudge(root, commit) {
  const states = new Map();
  const snapshots = [];
  const state = (revision, requirePolicyProof = false) => {
    const key = `${revision}:${requirePolicyProof ? 'policy' : 'docs'}`;
    if (states.has(key)) return states.get(key);
    const reader = treeReader(root, revision);
    const receiptBytes = reader.read(RECEIPT, true);
    const policyBytes = reader.read(COMPILED_AUTHORITY_POLICY, true);
    const receipt = receiptBytes === undefined ? undefined : parse(receiptBytes, revision);
    const policy = policyBytes === undefined ? undefined : parse(policyBytes, revision);
    let source;
    let sourceBytes;
    const sourcePath = receipt?.source_path;
    if (
      typeof sourcePath === 'string' &&
      /^law\/policy\/.+\.json$/u.test(sourcePath) &&
      safePath(sourcePath)
    ) {
      sourceBytes = reader.read(sourcePath, true);
      if (sourceBytes !== undefined) source = parse(sourceBytes, revision);
    }
    const claimed =
      (receipt !== undefined && Object.hasOwn(receipt, 'documentation_implementation')) ||
      (source !== undefined && Object.hasOwn(source, 'documentation_implementation')) ||
      (Array.isArray(policy?.rules) &&
        policy.rules.some(
          (rule) =>
            record(rule) &&
            typeof rule.rule_id === 'string' &&
            rule.rule_id.startsWith('core-documentation-implementation-'),
        ));
    if (!claimed && !requirePolicyProof) {
      const result = { selected: () => false, specialized: false };
      states.set(key, result);
      return result;
    }
    if (
      receipt === undefined ||
      policy === undefined ||
      source === undefined ||
      sourceBytes === undefined
    )
      throw refusal('DOCUMENTATION_COMMIT_BINDING_INCOMPLETE', revision);
    const { native, verifyBoundAuthorityPolicy, manifest } = nativeVerifier(revision);
    const packageBinding = policy.framework_package;
    if (
      !record(packageBinding) ||
      packageBinding.name !== manifest.name ||
      packageBinding.version !== manifest.version
    )
      throw refusal('DOCUMENTATION_COMMIT_VERIFIER_IDENTITY_MISMATCH', revision);
    // The native classifier validates the finite list, including test/spec exclusions.
    const selected = Object.hasOwn(source, 'documentation_implementation')
      ? native.documentationImplementationFiles(source.documentation_implementation)
      : [];
    if (!record(receipt.materialized))
      throw refusal('DOCUMENTATION_COMMIT_BINDING_INVALID', revision);
    const dependencies = new Set([RECEIPT, COMPILED_AUTHORITY_POLICY, PROJECT, PIN, sourcePath]);
    for (const path of Object.keys(receipt.materialized)) {
      if (!/^\.devai\/config\/[A-Za-z0-9_-]+\.json$/u.test(path))
        throw refusal('DOCUMENTATION_COMMIT_PATH_INVALID', revision);
      dependencies.add(path);
    }
    const journal = reader.read(JOURNAL, true);
    if (journal !== undefined) dependencies.add(JOURNAL);
    const files = new Map();
    for (const path of dependencies) files.set(path, reader.read(path));
    for (const path of selected) {
      const bytes = reader.read(path, true);
      if (bytes !== undefined) files.set(path, bytes);
    }
    // Match the issuer's genuine Git-common-directory fallback without inserting a
    // project name or a .git pointer into the historical tree.
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .toString('utf8')
      .trim();
    const repositoryName = basename(dirname(common));
    if (repositoryName === '' || repositoryName === '.' || repositoryName === '..')
      throw refusal('DOCUMENTATION_COMMIT_REPOSITORY_ID_UNAVAILABLE', revision);
    const temporary = mkdtempSync(join(tmpdir(), 'devai-docs-commit-'));
    snapshots.push(temporary);
    const snapshot = join(temporary, repositoryName);
    mkdirSync(snapshot);
    for (const [path, bytes] of files) {
      const destination = join(snapshot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: 'wx' });
      chmodSync(destination, reader.entries.get(path).mode === '100755' ? 0o755 : 0o644);
    }
    let context;
    let verified;
    const prove = () => {
      try {
        const proof = verifyBoundAuthorityPolicy(snapshot);
        if (
          proof.hasDocumentation !== claimed ||
          (verified !== undefined && proof.fingerprint !== verified.fingerprint)
        )
          throw refusal('DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED', revision);
        return proof;
      } catch (error) {
        throw refusal(
          `DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED:${error instanceof Error ? error.message : 'unknown'}`,
          revision,
        );
      }
    };
    verified = prove();
    if (claimed) {
      try {
        context = native.loadBoundDocumentationImplementation(snapshot);
      } catch (error) {
        throw refusal(
          `DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED:${error instanceof Error ? error.message : 'unknown'}`,
          revision,
        );
      }
    }
    const identity = JSON.stringify(
      [...dependencies].sort().map((path) => [path, reader.entries.get(path)]),
    );
    const result = {
      specialized: claimed,
      sourcePath: verified.sourcePath,
      verifyPolicy: prove,
      pin: files.get(PIN),
      identity,
      selected: (path) => native.documentationImplementationOwnsPath(context, path),
      verifyCustody: () => {
        const actual = [];
        const visit = (directory, prefix = '') => {
          for (const name of readdirSync(directory)) {
            const relative = prefix + name;
            const target = join(directory, name);
            const metadata = lstatSync(target);
            if (metadata.isSymbolicLink())
              throw refusal('DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED', revision);
            if (metadata.isDirectory()) visit(target, relative + '/');
            else if (metadata.isFile()) actual.push(relative);
            else throw refusal('DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED', revision);
          }
        };
        visit(snapshot);
        if (JSON.stringify(actual.sort()) !== JSON.stringify([...files.keys()].sort()))
          throw refusal('DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED', revision);
        for (const [path, bytes] of files) {
          const mode = reader.entries.get(path).mode === '100755' ? 0o755 : 0o644;
          if (
            (lstatSync(join(snapshot, path)).mode & 0o777) !== mode ||
            sha256(readFileSync(join(snapshot, path))) !== sha256(bytes)
          )
            throw refusal('DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED', revision);
        }
      },
    };
    states.set(key, result);
    return result;
  };
  const parent = () => {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', commit])
      .toString('utf8')
      .trim()
      .split(' ')
      .slice(1);
    return parents.length === 1 ? state(parents[0]) : undefined;
  };
  return {
    verifyCurrent() {
      state(commit);
    },
    authorsFor(path) {
      const current = state(commit);
      const previous = parent();
      const now = current.selected(path);
      const before = previous?.selected(path) === true;
      if (!now && !before) return undefined;
      return now && before && current.identity === previous.identity
        ? new Set(['Engineer'])
        : new Set();
    },
    policyAuthors(commitPaths) {
      const current = state(commit, true);
      // A coherent generic policy after removal is proven through the same complete
      // native closure. Parsed absence alone never authorizes retaining the output.
      const proof = current.verifyPolicy();
      return commitPaths.includes(proof.sourcePath) ? new Set(['Architect']) : new Set();
    },
    dispose() {
      let failure;
      try {
        for (const value of states.values()) value.verifyCustody?.();
      } catch (error) {
        failure = error;
      } finally {
        for (const directory of snapshots) rmSync(directory, { recursive: true, force: true });
      }
      if (failure !== undefined) throw failure;
    },
  };
}
