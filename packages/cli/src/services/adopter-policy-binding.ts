import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
import { ADOPTER_POLICY_TARGETS, isJsonObject } from './adopter-policy.js';

export interface AdopterPolicyBinding {
  readonly schemaVersion: '1.0.0';
  readonly policy_id: string;
  readonly policy_version: string;
  readonly source_path: string;
  readonly source_digest_sha256: string;
  readonly materialized: Readonly<Record<string, string>>;
}

/** Parse the existing closed v1 receipt without selecting files or repairing inputs. */
export function parseAdopterPolicyBinding(
  bytes: string,
):
  | { readonly binding: AdopterPolicyBinding }
  | { readonly reason: 'BINDING_MALFORMED' | 'BINDING_VERSION_UNSUPPORTED' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { reason: 'BINDING_MALFORMED' };
  }
  if (!isJsonObject(parsed)) return { reason: 'BINDING_MALFORMED' };
  if (parsed['schemaVersion'] !== '1.0.0') return { reason: 'BINDING_VERSION_UNSUPPORTED' };
  const bindingKeys = [
    'materialized',
    'policy_id',
    'policy_version',
    'schemaVersion',
    'source_digest_sha256',
    'source_path',
  ];
  if (
    Object.keys(parsed).length !== bindingKeys.length ||
    bindingKeys.some((key) => !Object.hasOwn(parsed, key))
  ) {
    return { reason: 'BINDING_MALFORMED' };
  }
  const materialized = parsed['materialized'];
  const digest = /^[a-f0-9]{64}$/u;
  if (
    typeof parsed['policy_id'] !== 'string' ||
    parsed['policy_id'].length === 0 ||
    typeof parsed['policy_version'] !== 'string' ||
    parsed['policy_version'].length === 0 ||
    typeof parsed['source_path'] !== 'string' ||
    parsed['source_path'].length === 0 ||
    typeof parsed['source_digest_sha256'] !== 'string' ||
    !digest.test(parsed['source_digest_sha256']) ||
    !isJsonObject(materialized) ||
    !Object.values(materialized).every((value) => typeof value === 'string' && digest.test(value))
  ) {
    return { reason: 'BINDING_MALFORMED' };
  }
  return { binding: parsed as unknown as AdopterPolicyBinding };
}

export interface AdopterPolicyBindingSnapshot {
  readonly policy: Readonly<Record<string, unknown>>;
  readonly project: Readonly<Record<string, unknown>>;
  readonly release_verification: Readonly<Record<string, unknown>>;
  readonly adopter_policy: { readonly path: string; readonly sha256: string };
  readonly binding_receipt: { readonly path: string; readonly sha256: string };
  readonly materialized: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * Pure raw-byte verification shared by release source resolution and offline replay.
 * The caller supplies an already verified package's validators/materializer and an
 * immutable candidate population. This check alone establishes neither Git membership
 * nor installed-package identity, and grants no execution authority.
 */
export function verifyAdopterPolicyBindingSnapshot(input: {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly frameworkVersion: string;
  readonly validatePolicy: (document: unknown) => boolean;
  readonly validateProject: (document: unknown) => boolean;
  readonly materialize: (input: {
    readonly policy: unknown;
    readonly currentProject: unknown;
    readonly frameworkVersion: string;
  }) => ReadonlyMap<string, string>;
}): AdopterPolicyBindingSnapshot {
  const fail = (): never => {
    throw new Error('rpl-adopter-binding-mismatch');
  };
  try {
    const files = new Map([...input.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
    const read = (path: string): Buffer => files.get(path) ?? fail();
    const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    const bindingPath = '.devai/config/adopter-policy-binding.json';
    const parsed = parseAdopterPolicyBinding(read(bindingPath).toString('utf8'));
    if ('reason' in parsed) return fail();
    const { binding } = parsed;
    const sourcePath = binding.source_path;
    if (
      !sourcePath.startsWith('law/policy/') ||
      !sourcePath.endsWith('.json') ||
      /[\\:*?]/u.test(sourcePath) ||
      [...sourcePath].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      return fail();
    const source = read(sourcePath);
    if (sha256(source) !== binding.source_digest_sha256) return fail();
    const policy: unknown = JSON.parse(source.toString('utf8'));
    const project: unknown = JSON.parse(read('.devai/config/project.json').toString('utf8'));
    if (
      !isJsonObject(policy) ||
      !isJsonObject(project) ||
      input.validatePolicy(policy) !== true ||
      input.validateProject(project) !== true ||
      policy['policy_id'] !== binding.policy_id ||
      policy['policy_version'] !== binding.policy_version ||
      !Object.hasOwn(policy, 'release_verification') ||
      !isJsonObject(policy['release_verification']) ||
      project['devai_version'] !== input.frameworkVersion
    )
      return fail();
    const expected = input.materialize({
      policy,
      currentProject: project,
      frameworkVersion: input.frameworkVersion,
    });
    const paths = [...expected.keys()].sort();
    if (
      canonicalJson(paths) !== canonicalJson(Object.keys(binding.materialized).sort()) ||
      !paths.includes('.devai/config/project.json') ||
      !paths.includes('.devai/config/release-verification.json') ||
      paths.some((path) => !(ADOPTER_POLICY_TARGETS as readonly string[]).includes(path))
    )
      return fail();
    const materialized = paths.map((path) => {
      const actual = read(path);
      const expectedBytes = Buffer.from(expected.get(path) ?? fail(), 'utf8');
      const hash = sha256(actual);
      if (!actual.equals(expectedBytes) || binding.materialized[path] !== hash) return fail();
      return { path, sha256: hash };
    });
    const profile: unknown = JSON.parse(
      read('.devai/config/release-verification.json').toString('utf8'),
    );
    if (
      !isJsonObject(profile) ||
      canonicalJson(profile) !== canonicalJson(policy['release_verification'])
    )
      return fail();
    return {
      policy,
      project,
      release_verification: profile,
      adopter_policy: { path: sourcePath, sha256: sha256(source) },
      binding_receipt: { path: bindingPath, sha256: sha256(read(bindingPath)) },
      materialized,
    };
  } catch {
    return fail();
  }
}
