import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { mutationCheckpointStore } = await import(
  pathToFileURL(resolve('scripts/process/mutation-checkpoints.mjs')).href
);
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai-checkpoint-')));
  directories.push(parent);
  const root = join(parent, 'evidence'),
    candidateRoot = join(parent, 'candidate');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(candidateRoot);
  const binding = Object.fromEntries(
    [
      'candidate_commit',
      'candidate_tree',
      'input_digest',
      'policy_sha256',
      'toolchain_sha256',
      'runner_sha256',
      'test_population_sha256',
      'source_population_sha256',
      'output_contract_sha256',
      'verifier_sha256',
      'trust_sha256',
    ].map((key) => [key, 'a'.repeat(key.startsWith('candidate_') ? 40 : 64)]),
  );
  const artifacts = { report: Buffer.from('verified fixture report') };
  const verify = vi.fn(
    (_binding: unknown, actual: Record<string, Buffer>) =>
      Object.keys(actual).join() === 'report' && actual.report?.equals(artifacts.report) === true,
  );
  const controls = { root, candidateRoot, maximumBytes: 1024, verify };
  return {
    root,
    candidateRoot,
    binding,
    artifacts,
    verify,
    controls,
    store: mutationCheckpointStore(controls),
  };
}
describe('local mutation checkpoints', () => {
  it('rehashes and independently reverifies on every read, without returning callback-mutated bytes', async () => {
    const f = fixture();
    await f.store.write(f.binding, f.artifacts);
    const read = await f.store.read(f.binding);
    expect(read.report).toEqual(f.artifacts.report);
    read.report.fill(0);
    expect((await f.store.read(f.binding)).report).toEqual(f.artifacts.report);
    expect(f.verify).toHaveBeenCalledTimes(3);
  });
  it('invalidates reuse for every changed binding', async () => {
    const f = fixture();
    await f.store.write(f.binding, f.artifacts);
    for (const [key, value] of Object.entries(f.binding))
      expect(await f.store.read({ ...f.binding, [key]: 'b'.repeat(value.length) })).toBeUndefined();
    expect(f.verify).toHaveBeenCalledTimes(1);
  });
  it('retains rejected attempts without making them reusable', async () => {
    const f = fixture();
    f.verify.mockReturnValue(false);
    await expect(f.store.write(f.binding, f.artifacts)).rejects.toThrow('REVERIFICATION_FAILED');
    expect(readdirSync(f.root)).toHaveLength(1);
    expect(readdirSync(f.root)[0]).toMatch(/^attempt-/);
    expect(await f.store.read(f.binding)).toBeUndefined();
  });
  it('allows an identical concurrent write and refuses replacement', async () => {
    const f = fixture();
    await Promise.all([
      f.store.write(f.binding, f.artifacts),
      f.store.write(f.binding, f.artifacts),
    ]);
    expect(readdirSync(f.root)).toHaveLength(1);
    f.verify.mockReturnValue(true);
    await expect(f.store.write(f.binding, { report: Buffer.from('different') })).rejects.toThrow(
      'REPLACEMENT_REFUSED',
    );
    expect((await f.store.read(f.binding)).report).toEqual(f.artifacts.report);
  });
  it('rejects changed content, missing or extra members through the protected verifier', async () => {
    const f = fixture();
    const record = await f.store.write(f.binding, f.artifacts);
    const original = readFileSync(record.path);
    const d = JSON.parse(original.toString());
    d.artifacts.report.base64 = Buffer.from('tamper').toString('base64');
    writeFileSync(record.path, JSON.stringify(d));
    await expect(f.store.read(f.binding)).rejects.toThrow('MEMBER_INVALID');
    writeFileSync(record.path, original);
    f.verify.mockReturnValue(false);
    await expect(f.store.read(f.binding)).rejects.toThrow('REVERIFICATION_FAILED');
    await expect(f.store.write(f.binding, { extra: Buffer.from('x') })).rejects.toThrow(
      'REVERIFICATION_FAILED',
    );
  });
  it('rejects duplicate fields and noncanonical record encodings', async () => {
    const f = fixture();
    const record = await f.store.write(f.binding, f.artifacts);
    const original = readFileSync(record.path, 'utf8');
    for (const invalid of [original + '\n', '{"schemaVersion":"1.0.0",' + original.slice(1)]) {
      writeFileSync(record.path, invalid);
      await expect(f.store.read(f.binding)).rejects.toThrow('NONCANONICAL');
    }
    expect(f.verify).toHaveBeenCalledTimes(1);
  });
  it('rejects symlinked checkpoint files and candidate-local roots', async () => {
    const f = fixture();
    const record = await f.store.write(f.binding, f.artifacts);
    const backup = join(f.root, 'preserved');
    writeFileSync(backup, readFileSync(record.path));
    rmSync(record.path);
    symlinkSync(backup, record.path);
    await expect(f.store.read(f.binding)).rejects.toThrow();
    expect(() => mutationCheckpointStore({ ...f.controls, root: f.candidateRoot })).toThrow(
      'ROOT_INVALID',
    );
  });
  it('requires explicit verification, finite bounds and closed string bindings', async () => {
    const f = fixture();
    expect(() => mutationCheckpointStore({ ...f.controls, verify: undefined })).toThrow(
      'CONTROLS_INVALID',
    );
    expect(() => mutationCheckpointStore({ ...f.controls, maximumBytes: Infinity })).toThrow(
      'CONTROLS_INVALID',
    );
    await expect(f.store.write({ ...f.binding, extra: 'x' }, f.artifacts)).rejects.toThrow(
      'BINDING_INVALID',
    );
    await expect(
      f.store.write({ ...f.binding, input_digest: [f.binding.input_digest] }, f.artifacts),
    ).rejects.toThrow('BINDING_INVALID');
    await expect(f.store.write(f.binding, { report: Buffer.alloc(1025) })).rejects.toThrow(
      'TOO_LARGE',
    );
    expect(readdirSync(f.root)).toEqual([]);
  });
});
