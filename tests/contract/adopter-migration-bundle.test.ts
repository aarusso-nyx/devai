import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const root = resolve('.');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (bytes: Buffer | string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
it('authenticates and renders deterministic local migration files without editing the adopter', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'devai-migration espaço-'));
  roots.push(cwd);
  const provider = join(cwd, 'provider');
  const installed = join(cwd, 'installed');
  const adopter = join(cwd, 'adopter');
  const bin = join(cwd, 'bin');
  for (const path of [
    join(provider, 'dist/runtime/evidence-verification'),
    join(installed, 'dist/runtime/index'),
    join(installed, 'dist/law/policy'),
    join(adopter, '.devai/config'),
    join(adopter, '.github/workflows'),
    bin,
  ])
    mkdirSync(path, { recursive: true });
  const provenance = JSON.stringify({
    schemaVersion: '1.0.0',
    sourceCommit: 'a'.repeat(40),
    files: [],
  });
  writeFileSync(join(provider, 'dist/runtime/evidence-verification/provenance.json'), provenance);
  const makeArchive = (source: string, output: string) =>
    execFileSync('python3', [
      '-c',
      "import pathlib,sys; sys.path.insert(0,sys.argv[1]); from evidence_transport import archive,directory_files; pathlib.Path(sys.argv[3]).write_bytes(archive({'package/'+k:v for k,v in directory_files(sys.argv[2]).items()}))",
      join(root, 'scripts/process'),
      source,
      output,
    ]);
  const providerTarball = join(cwd, 'provider.tgz');
  makeArchive(provider, providerTarball);
  const metadata = (version: string, path: string) => ({
    name: '@aarusso-nyx/devai',
    version,
    dist: {
      tarball: `https://npm.pkg.github.com/devai-${version}.tgz`,
      shasum: digest(readFileSync(path), 'sha1'),
      integrity: `sha512-${digest(readFileSync(path), 'sha512', 'base64')}`,
    },
  });
  const providerMetadata = metadata('1.4.4', providerTarball);
  const policy = {
    package: {
      name: providerMetadata.name,
      version: providerMetadata.version,
      tarball: providerMetadata.dist.tarball,
      shasum_sha1: providerMetadata.dist.shasum,
      integrity_sri: providerMetadata.dist.integrity,
      release_source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    },
    verifier: { provenance_sha256: digest(provenance) },
    external_duplicate: { name: 'DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256' },
  };
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.4.5', type: 'module' }),
  );
  writeFileSync(
    join(installed, 'dist/law/policy/trusted-local-rc-verifier-package.json'),
    JSON.stringify(policy),
  );
  writeFileSync(
    join(installed, 'dist/runtime/index/bin.js'),
    `import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const target=process.argv[process.argv.indexOf('--target')+1];
if(JSON.parse(readFileSync(target+'/.devai/config/project.json')).unrelated!==true)process.exit(3);
mkdirSync(target+'/.github/workflows',{recursive:true});
writeFileSync(target+'/.github/workflows/devai-local-rc-verify.yml','name: fixture verified workflow\\n');
`,
  );
  const packageTarball = join(cwd, 'package.tgz');
  makeArchive(installed, packageTarball);
  writeFileSync(join(cwd, '1.4.4.json'), JSON.stringify(providerMetadata));
  writeFileSync(join(cwd, '1.4.5.json'), JSON.stringify(metadata('1.4.5', packageTarball)));
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const fs=require('node:fs'); const version=process.argv[3].split('@').at(-1);process.stdout.write(fs.readFileSync(process.env.FAKE_METADATA+'/'+version+'.json'));
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const configBefore = '{"unrelated":true}\n';
  writeFileSync(join(adopter, '.devai/config/project.json'), configBefore);
  writeFileSync(join(adopter, '.github/workflows/devai-local-rc-verify.yml'), 'name: prior\n');
  for (const suffix of ['one', 'two']) {
    const config = {
      adopterRoot: adopter,
      packageRoot: installed,
      packageTarball,
      providerTarball,
      outputDir: join(cwd, suffix),
    };
    const configPath = join(cwd, suffix + '.json');
    writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/process/generate-adopter-migration.mjs'), configPath],
      {
        encoding: 'utf8',
        env: { ...process.env, FAKE_METADATA: cwd, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  expect(readFileSync(join(cwd, 'one/migration.json'))).toEqual(
    readFileSync(join(cwd, 'two/migration.json')),
  );
  expect(readFileSync(join(adopter, '.devai/config/project.json'), 'utf8')).toBe(configBefore);
  expect(readFileSync(join(adopter, '.github/workflows/devai-local-rc-verify.yml'), 'utf8')).toBe(
    'name: prior\n',
  );
  expect(existsSync(join(cwd, 'one/REVIEW.md'))).toBe(true);
  const originalConfig = join(cwd, 'original-project.json');
  writeFileSync(originalConfig, configBefore);
  rmSync(join(adopter, '.devai/config/project.json'));
  symlinkSync(originalConfig, join(adopter, '.devai/config/project.json'));
  const linkedConfig = join(cwd, 'linked.json');
  writeFileSync(
    linkedConfig,
    JSON.stringify({
      adopterRoot: adopter,
      packageRoot: installed,
      packageTarball,
      providerTarball,
      outputDir: join(cwd, 'linked'),
    }),
  );
  const linked = spawnSync(
    process.execPath,
    [join(root, 'scripts/process/generate-adopter-migration.mjs'), linkedConfig],
    {
      encoding: 'utf8',
      env: { ...process.env, FAKE_METADATA: cwd, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  expect(linked.status).not.toBe(0);
  expect(readFileSync(originalConfig, 'utf8')).toBe(configBefore);
  expect(existsSync(join(cwd, 'linked'))).toBe(false);
  rmSync(join(adopter, '.devai/config/project.json'));
  writeFileSync(join(adopter, '.devai/config/project.json'), configBefore);
  // Changed installed executable is rejected before renderer invocation.
  writeFileSync(join(installed, 'dist/runtime/index/bin.js'), 'throw new Error("changed")');
  const configPath = join(cwd, 'bad.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      adopterRoot: adopter,
      packageRoot: installed,
      packageTarball,
      providerTarball,
      outputDir: join(cwd, 'bad'),
    }),
  );
  const invalid = spawnSync(
    process.execPath,
    [join(root, 'scripts/process/generate-adopter-migration.mjs'), configPath],
    {
      encoding: 'utf8',
      env: { ...process.env, FAKE_METADATA: cwd, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  expect(invalid.status).not.toBe(0);
  expect(existsSync(join(cwd, 'bad'))).toBe(false);
});
