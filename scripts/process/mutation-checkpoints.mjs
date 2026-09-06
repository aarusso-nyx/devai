import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const keys = [
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
];
function binding(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !== [...keys].sort().join() ||
    keys.some(
      (key) =>
        typeof value[key] !== 'string' ||
        !new RegExp(key.startsWith('candidate_') ? '^[a-f0-9]{40}$' : '^[a-f0-9]{64}$', 'u').test(
          value[key],
        ),
    )
  )
    throw Error('MUTATION_CHECKPOINT_BINDING_INVALID');
  return JSON.parse(canonical(value));
}
function directory(root, candidateRoot) {
  const path = realpathSync(root),
    candidate = realpathSync(candidateRoot),
    stat = lstatSync(root);
  const rel = relative(candidate, path);
  if (
    resolve(root) !== path ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    !(rel === '..' || rel.startsWith('../') || isAbsolute(rel))
  )
    throw Error('MUTATION_CHECKPOINT_ROOT_INVALID');
  return path;
}
function bytes(path, maximum) {
  if (!constants.O_NOFOLLOW) throw Error('MUTATION_CHECKPOINT_PLATFORM_UNSUPPORTED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum || before.size < 1)
      throw Error('MUTATION_CHECKPOINT_FILE_INVALID');
    const result = readFileSync(fd),
      after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      result.length !== before.size
    )
      throw Error('MUTATION_CHECKPOINT_CHANGED');
    return result;
  } finally {
    closeSync(fd);
  }
}
function capture(artifacts, maximum) {
  if (!artifacts || Object.keys(artifacts).length === 0)
    throw Error('MUTATION_CHECKPOINT_POPULATION_INVALID');
  let total = 0;
  return Object.fromEntries(
    Object.entries(artifacts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name) || !Buffer.isBuffer(value))
          throw Error('MUTATION_CHECKPOINT_POPULATION_INVALID');
        total += value.length;
        if (total > maximum) throw Error('MUTATION_CHECKPOINT_TOO_LARGE');
        return [name, { sha256: sha(value), size: value.length, base64: value.toString('base64') }];
      }),
  );
}
function decode(document, expected, maximum) {
  if (
    !document ||
    Object.keys(document).sort().join() !== 'artifacts,binding,schemaVersion' ||
    document.schemaVersion !== '1.0.0' ||
    canonical(document.binding) !== canonical(expected)
  )
    throw Error('MUTATION_CHECKPOINT_MISMATCH');
  const decoded = Object.create(null);
  for (const [name, value] of Object.entries(document.artifacts ?? {})) {
    if (
      !value ||
      Object.keys(value).sort().join() !== 'base64,sha256,size' ||
      typeof value.base64 !== 'string'
    )
      throw Error('MUTATION_CHECKPOINT_MEMBER_INVALID');
    const data = Buffer.from(value.base64, 'base64');
    if (
      data.toString('base64') !== value.base64 ||
      data.length !== value.size ||
      sha(data) !== value.sha256
    )
      throw Error('MUTATION_CHECKPOINT_MEMBER_INVALID');
    decoded[name] = data;
  }
  capture(decoded, maximum);
  return decoded;
}
/** Local transport only. The approved control must reverify custody, semantics and limits.
 * A checkpoint grants no execution authority, certification, or candidate readiness. */
export function mutationCheckpointStore({ root, candidateRoot, maximumBytes, verify }) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 512 * 1024 * 1024 ||
    typeof verify !== 'function'
  )
    throw Error('MUTATION_CHECKPOINT_CONTROLS_INVALID');
  const path = directory(root, candidateRoot);
  const locate = (value) => {
    directory(path, candidateRoot);
    const expected = binding(value);
    return { expected, file: join(path, sha(canonical(expected)) + '.json') };
  };
  const reverify = async (expected, artifacts) => {
    if (
      (await verify(
        JSON.parse(canonical(expected)),
        Object.fromEntries(
          Object.entries(artifacts).map(([name, data]) => [name, Buffer.from(data)]),
        ),
      )) !== true
    )
      throw Error('MUTATION_CHECKPOINT_REVERIFICATION_FAILED');
  };
  return Object.freeze({
    async read(value) {
      const { expected, file } = locate(value);
      let raw;
      try {
        raw = bytes(file, Math.ceil(maximumBytes * 1.4) + 65536);
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
      const document = JSON.parse(raw.toString('utf8'));
      const artifacts = decode(document, expected, maximumBytes);
      if (!Buffer.from(canonical(document)).equals(raw))
        throw Error('MUTATION_CHECKPOINT_NONCANONICAL');
      await reverify(expected, artifacts);
      return artifacts;
    },
    async write(value, artifacts) {
      const { expected, file } = locate(value);
      const document = {
        schemaVersion: '1.0.0',
        binding: expected,
        artifacts: capture(artifacts, maximumBytes),
      };
      const raw = Buffer.from(canonical(document));
      const staged = join(path, 'attempt-' + randomUUID() + '.json');
      const fd = openSync(staged, 'wx', 0o600);
      try {
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await reverify(expected, decode(document, expected, maximumBytes));
      directory(path, candidateRoot);
      // Atomic no-replacement publication; interrupted staging remains recoverable.
      try {
        linkSync(staged, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = bytes(file, Math.ceil(maximumBytes * 1.4) + 65536);
        if (!existing.equals(raw)) throw Error('MUTATION_CHECKPOINT_REPLACEMENT_REFUSED');
        await reverify(
          expected,
          decode(JSON.parse(existing.toString('utf8')), expected, maximumBytes),
        );
      }
      unlinkSync(staged);
      const dir = openSync(path, constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      return { path: file, sha256: sha(raw) };
    },
  });
}
