// Genuine registered binding fixture. No positive receipt or authority context is fabricated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI_PACKAGE = join(ROOT, 'packages/cli');
const SOURCE = 'law/policy/inspector-documentation.json';
const POLICY = '.devai/config/authority-policy.json';
// New adopter fixture's own initial tracking contract, not this maintainer checkout's private baseline.
const FIXTURE_IGNORE = 'node_modules/\n.devai/state/\n';
export const SELECTED = ['docs/site/version.ts', 'docs/site/api.ts'];
export interface Identity {
  readonly name: string;
  readonly email: string;
}
export function identity(name: string): Identity {
  return { name: `DEVAI ${name}`, email: `${name.toLowerCase()}@devai.local` };
}
export const ARCHITECT = identity('Architect');
export const ENGINEER = identity('Engineer');
export const MACHINE = identity('Machine');
export const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}
export function jsonFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  record(value);
  return value;
}

// Includes actual Git administration, tracked/untracked fixture bytes and symlink identity.
// Native checker reads may not mutate any part of this disposable repository.
function inventory(root: string) {
  const result: Record<string, { mode: number; kind: string; identity: string }> = {};
  function visit(directory: string, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix + name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, relative + '/');
      else
        result[relative] = {
          mode: stat.mode & 0o777,
          kind: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other',
          identity: stat.isSymbolicLink()
            ? readlinkSync(path)
            : stat.isFile()
              ? sha(readFileSync(path))
              : String(stat.mode),
        };
    }
  }
  visit(root);
  return result;
}

export function registeredDocumentationRepository() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai-commit-docs-')));
  // Stable basename below a disposable parent exercises genuine no-name fallback.
  const cwd = join(parent, 'native-documentation-repository');
  mkdirSync(cwd);
  const transcript: unknown[] = [];
  const manifest = jsonFile(join(CLI_PACKAGE, 'package.json'));
  assert.equal(manifest.name, '@aarusso-nyx/devai');
  assert(typeof manifest.version === 'string');
  record(manifest.bin);
  assert(typeof manifest.bin.devai === 'string');
  const bin = realpathSync(resolve(CLI_PACKAGE, manifest.bin.devai));
  assert(bin.startsWith(realpathSync(CLI_PACKAGE) + '/'));
  const proof = join(ROOT, 'packages/authority/dist/runtime/documentation-context.js');
  const executableBinding = {
    packageVersion: manifest.version,
    packageSha256: sha(readFileSync(join(CLI_PACKAGE, 'package.json'))),
    bin,
    binSha256: sha(readFileSync(bin)),
    privateProofSha256: sha(readFileSync(proof)),
    lawSha256: sha(readFileSync(join(ROOT, 'law/constitution.md'))),
  };
  function run(program: string, args: readonly string[], env = process.env) {
    const result = spawnSync(program, args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, null);
    const row = {
      args: [...args],
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    transcript.push(row);
    return row;
  }
  function git(args: readonly string[], author = ARCHITECT, committer = author) {
    const result = run('git', args, {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  }
  function put(path: string, bytes: string | Buffer) {
    assert(!path.startsWith('/') && !path.split('/').includes('..'));
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), bytes);
  }
  function registered(args: readonly string[]) {
    const result = run(process.execPath, [bin, ...args, '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const envelope: unknown = JSON.parse(result.stdout);
    record(envelope);
    assert.equal(envelope.schemaVersion, '1.0.0');
    assert.equal(envelope.action_id, 'init bind');
    assert.equal(envelope.ok, true);
    record(envelope.result);
    assert.equal(envelope.result.verdict, 'pass');
    assert.equal(envelope.result.media_type, 'application/json');
    return envelope.result.value;
  }
  function commit(message: string, author = ARCHITECT, committer = author) {
    git(['add', '-A']);
    git(['commit', '-qm', message], author, committer);
    return git(['rev-parse', 'HEAD']);
  }
  git(['init', '--quiet', '--initial-branch=main']);
  // Same minimal ignore convention as existing genuine installed/adopter fixtures.
  // The registered writer creates all authority bytes; ordinary Git records them.
  put('.gitignore', FIXTURE_IGNORE);
  registered([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    cwd,
    '--as-role',
    'architect',
    '--write',
  ]);
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), FIXTURE_IGNORE);
  for (const path of [
    'law/policy/commit-grammar.json',
    'law/policy/change-taxonomy.json',
    '.devai/config/change-taxonomy-binding.json',
  ])
    put(path, readFileSync(join(ROOT, path)));
  put('law/constitution.md', readFileSync(join(ROOT, 'law/constitution.md')));
  for (const path of SELECTED) put(path, 'export const version = 1;\n');
  put('docs/site/sidebars.ts', 'export {};\n');
  put('docs/site/probe.spec.ts', 'export {};\n');
  put('docs/site/schema.js', 'export {};\n');
  const seed = commit('docs: seed genuine registered binding fixture');

  function bind(
    files: readonly string[] | null = SELECTED,
    commitBinding = true,
    policyFields: Readonly<Record<string, unknown>> = {},
  ) {
    put(
      SOURCE,
      JSON.stringify(
        {
          ...policyFields,
          schemaVersion: '1.0.0',
          policy_id: 'inspector.commit-documentation',
          policy_version: '1.0.0',
          ...(files === null ? {} : { documentation_implementation: { files } }),
        },
        null,
        2,
      ) + '\n',
    );
    registered([
      'init',
      'bind',
      '--adopter-policy',
      SOURCE,
      '--target',
      cwd,
      '--as-role',
      'architect',
      '--write',
    ]);
    assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), FIXTURE_IGNORE);
    // Do not disable ambient/global excludes or force-add. A host exclusion is a setup failure.
    const ignored = run('git', ['check-ignore', '--no-index', '--verbose', POLICY]);
    assert.equal(
      ignored.status,
      1,
      'Generated authority must be normally trackable: ' + ignored.stdout + ignored.stderr,
    );
    assert.equal(ignored.stdout, '');
    assert.equal(ignored.stderr, '');
    const receipt = jsonFile(join(cwd, '.devai/config/adopter-policy-binding.json'));
    const project = jsonFile(join(cwd, '.devai/config/project.json'));
    const policy = jsonFile(join(cwd, POLICY));
    assert.equal(
      Object.hasOwn(project, 'name'),
      false,
      'genuine minimal source must exercise repository fallback',
    );
    record(policy.enforcement);
    assert.equal(policy.enforcement.mode, 'binding');
    record(policy.host_enforcement);
    assert.equal(policy.host_enforcement.mode, 'cli-only');
    assert(typeof policy.materialized_at === 'string');
    assert(
      Number.isFinite(Date.parse(policy.materialized_at)) &&
        Date.parse(policy.materialized_at) <= Date.now(),
    );
    if (files !== null) {
      record(receipt.documentation_implementation);
      assert.equal(
        receipt.documentation_implementation.repository_id,
        'native-documentation-repository',
      );
      assert.equal(
        receipt.documentation_implementation.source_digest_sha256,
        sha(readFileSync(join(cwd, SOURCE))),
      );
      record(receipt.documentation_implementation.framework_package);
      assert.equal(
        receipt.documentation_implementation.framework_package.version,
        manifest.version,
      );
    }
    if (!commitBinding) return undefined;
    const checkpoint = commit('law: bind exact documentation implementation source');
    git(['ls-files', '--error-unmatch', POLICY]);
    assert.equal(
      git(['show', `${checkpoint}:${POLICY}`]),
      readFileSync(join(cwd, POLICY), 'utf8').trim(),
    );
    return checkpoint;
  }
  function check(base: string, head: string, from = cwd) {
    const before = inventory(parent);
    const argv = [join(ROOT, 'scripts/check-commit-range.mjs'), base, head];
    const result = spawnSync(process.execPath, argv, {
      cwd: from,
      env: process.env,
      encoding: 'utf8',
    });
    try {
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, null);
      const row = {
        args: argv,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      transcript.push(row);
      return row;
    } finally {
      assert.deepEqual(
        inventory(parent),
        before,
        'historical checker must preserve repository and Git bytes/modes',
      );
      assert.equal(sha(readFileSync(proof)), executableBinding.privateProofSha256);
      assert.equal(sha(readFileSync(bin)), executableBinding.binSha256);
      assert.equal(
        sha(readFileSync(join(CLI_PACKAGE, 'package.json'))),
        executableBinding.packageSha256,
      );
      assert.equal(
        sha(readFileSync(join(ROOT, 'law/constitution.md'))),
        executableBinding.lawSha256,
      );
    }
  }
  function inspectNativeIssuers() {
    // Do not inherit Vitest's development condition into native require: the complete
    // freshly built package dependency graph must use its compiled public modules.
    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    const before = inventory(parent);
    const result = run(
      process.execPath,
      [
        '--input-type=commonjs',
        '-e',
        `
      const assert = require('node:assert/strict');
      const internal = require(process.argv[1]);
      const publicApi = require(process.argv[2]);
      assert.equal(typeof internal.verifyBoundAuthorityPolicy, 'function');
      assert.equal(typeof publicApi.loadBoundDocumentationImplementation, 'function');
      const proof = internal.verifyBoundAuthorityPolicy(process.argv[3]);
      let publicError = null;
      try { publicApi.loadBoundDocumentationImplementation(process.argv[3]); }
      catch (error) { publicError = error instanceof Error ? error.message : String(error); }
      process.stdout.write(JSON.stringify({ proof, frozen: Object.isFrozen(proof), publicError }));
    `,
        proof,
        join(ROOT, 'packages/authority/dist/index.js'),
        cwd,
      ],
      env,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(inventory(parent), before);
    assert.equal(sha(readFileSync(proof)), executableBinding.privateProofSha256);
    const observation: unknown = JSON.parse(result.stdout);
    record(observation);
    return observation;
  }
  function rejectedSelection(path: string) {
    const source = readFileSync(join(cwd, SOURCE));
    const before = inventory(join(cwd, '.devai'));
    const value = jsonFile(join(cwd, SOURCE));
    put(SOURCE, JSON.stringify({ ...value, documentation_implementation: { files: [path] } }));
    try {
      return run(process.execPath, [
        bin,
        'init',
        'bind',
        '--adopter-policy',
        SOURCE,
        '--target',
        cwd,
        '--as-role',
        'architect',
        '--write',
        '--format',
        'json',
      ]);
    } finally {
      assert.deepEqual(
        inventory(join(cwd, '.devai')),
        before,
        'protected selection must produce no partial binding',
      );
      put(SOURCE, source);
    }
  }
  return {
    cwd,
    parent,
    seed,
    put,
    git,
    commit,
    bind,
    check,
    rejectedSelection,
    inspectNativeIssuers,
    transcript,
    executableBinding,
    sourcePath: SOURCE,
    policyPath: POLICY,
    remove: (path: string) => rmSync(join(cwd, path)),
    rename: (from: string, to: string) => renameSync(join(cwd, from), join(cwd, to)),
    close: () => rmSync(parent, { recursive: true, force: true }),
  };
}
