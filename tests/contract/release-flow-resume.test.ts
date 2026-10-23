// Exercise the host state machine with simulated installed RC/export adapters.
// The real verifier/exporter cryptographic contracts remain covered by their suites.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const adapters = vi.hoisted(() => ({ inspect: vi.fn(), certify: vi.fn(), export: vi.fn() }));
vi.mock('../../scripts/process/release-prerequisites.mjs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inspectPrerequisites: adapters.inspect,
  certifyCandidate: adapters.certify,
  exportCandidate: adapters.export,
  certificationEnvironment: () => ({}),
}));
const flowUrl = pathToFileURL(resolve('scripts/process/release-flow.mjs')).href;
const { resumeRelease } = await import(flowUrl);
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.clearAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-release-resume-'));
  roots.push(root);
  const repo = join(root, 'repo'),
    pkg = join(root, 'package');
  mkdirSync(join(repo, 'scripts/process'), { recursive: true });
  mkdirSync(join(repo, 'docs/site'), { recursive: true });
  for (const name of [
    'release-flow',
    'release-prerequisites',
    'docs-build',
    'validation-runner',
    'rehearsal',
  ])
    writeFileSync(
      join(repo, `scripts/process/${name}.mjs`),
      readFileSync(resolve(`scripts/process/${name}.mjs`)),
    );
  for (const name of ['check-workflows', 'check-release-static-integrity'])
    writeFileSync(join(repo, `scripts/${name}.mjs`), '');
  writeFileSync(
    join(repo, 'docs/site/package.json'),
    JSON.stringify({ scripts: { 'security:check': 'node -e "process.exit(0)"' } }),
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD'),
    tree = git('rev-parse', 'HEAD^{tree}');
  const verifier = join(pkg, 'dist/runtime/evidence-verification/src');
  mkdirSync(verifier, { recursive: true });
  // These executables simulate refusal/success only; they cannot certify a real release.
  writeFileSync(
    join(verifier, 'export-cli.js'),
    `const fs=require('node:fs'); const a=process.argv; const receipt=a[a.indexOf('--receipt')+1]; if(JSON.parse(fs.readFileSync(receipt)).pass!==true)process.exit(42);`,
  );
  writeFileSync(
    join(verifier, 'cli.js'),
    `const fs=require('node:fs'); const a=process.argv; const envelope=a[a.indexOf('--envelope')+1]; if(fs.readFileSync(envelope,'utf8')!=='verified fixture')process.exit(43);`,
  );
  const config = {
    repo,
    packageRoot: pkg,
    outputDir: join(root, 'export'),
    trustStore: join(root, 'trust.json'),
    policyDigest: 'a'.repeat(64),
    toolchain: join(root, 'toolchain.json'),
    environment: join(root, 'environment.json'),
    publicKey: join(root, 'public.pem'),
    signerId: 'fixture',
  };
  const path = join(root, 'config.json'),
    journal = join(root, 'journal.json'),
    receipt = join(root, 'rc.json');
  writeFileSync(path, JSON.stringify(config));
  adapters.inspect.mockImplementation(() => ({
    schemaVersion: '1.0.0',
    phase: 'prerequisites',
    ok: true,
    checks: [],
    descriptor: {},
    bindings: {
      commit,
      tree,
      config: createHash('sha256').update(readFileSync(path)).digest('hex'),
    },
  }));
  adapters.certify.mockImplementation(() => {
    writeFileSync(receipt, '{"pass":true}');
    return receipt;
  });
  const exportEvidence = () => {
    mkdirSync(config.outputDir);
    writeFileSync(join(config.outputDir, 'envelope.json'), 'verified fixture');
    writeFileSync(join(config.outputDir, 'task-policy.json'), '{}');
  };
  adapters.export.mockImplementation(exportEvidence);
  return { path, journal, receipt, config, exportEvidence };
}

it('preflight alone never runs RC or exports evidence', () => {
  const f = fixture();
  expect(resumeRelease(f.path, f.journal, 'preflight').phase).toBe('preflight');
  expect(adapters.certify).not.toHaveBeenCalled();
  expect(adapters.export).not.toHaveBeenCalled();
});
it('resumes after an interrupted export without repeating successful RC', () => {
  const f = fixture();
  adapters.export.mockImplementationOnce(() => {
    throw new Error('interrupted');
  });
  expect(() => resumeRelease(f.path, f.journal)).toThrow('interrupted');
  expect(JSON.parse(readFileSync(f.journal, 'utf8')).phases.rc.status).toBe('complete');
  expect(resumeRelease(f.path, f.journal).phase).toBe('evidence');
  expect(adapters.certify).toHaveBeenCalledTimes(1);
  expect(adapters.export).toHaveBeenCalledTimes(2);
  expect(resumeRelease(f.path, f.journal).phase).toBe('evidence');
  expect(adapters.certify).toHaveBeenCalledTimes(1);
  expect(adapters.export).toHaveBeenCalledTimes(2);
});
it('reconciles an export completed just before the process stopped', () => {
  const f = fixture();
  adapters.export.mockImplementationOnce(() => {
    f.exportEvidence();
    throw new Error('lost acknowledgement');
  });
  expect(() => resumeRelease(f.path, f.journal)).toThrow('lost acknowledgement');
  expect(resumeRelease(f.path, f.journal).phase).toBe('evidence');
  expect(adapters.certify).toHaveBeenCalledTimes(1);
  expect(adapters.export).toHaveBeenCalledTimes(1);
});
it('refuses changed RC results before retrying export', () => {
  const f = fixture();
  adapters.export.mockImplementationOnce(() => {
    throw new Error('interrupted');
  });
  expect(() => resumeRelease(f.path, f.journal)).toThrow('interrupted');
  writeFileSync(f.receipt, '{"pass":false}');
  expect(() => resumeRelease(f.path, f.journal)).toThrow();
  expect(adapters.certify).toHaveBeenCalledTimes(1);
  expect(adapters.export).toHaveBeenCalledTimes(1);
});
it('refuses changed configuration and corrupt sealed evidence on resume', () => {
  const f = fixture();
  resumeRelease(f.path, f.journal);
  const bytes = readFileSync(f.path);
  writeFileSync(f.path, JSON.stringify({ ...f.config, policyDigest: 'b'.repeat(64) }));
  expect(() => resumeRelease(f.path, f.journal)).toThrow('RELEASE_FLOW_INPUTS_CHANGED');
  writeFileSync(f.path, bytes);
  writeFileSync(join(f.config.outputDir, 'envelope.json'), 'corrupt');
  expect(() => resumeRelease(f.path, f.journal)).toThrow();
  expect(adapters.certify).toHaveBeenCalledTimes(1);
  expect(adapters.export).toHaveBeenCalledTimes(1);
});
