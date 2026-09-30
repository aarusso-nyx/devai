import { existsSync, lstatSync, readFileSync, realpathSync } from '@devai-nyx/authority';
import { join, posix, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { validators } from '@devai-nyx/schemas';
import { MATERIALIZED_POLICY_FILES, resolveCanonicalPolicyContent } from '@devai-nyx/skills';
import { resolveCliVersion } from '../version.js';
import {
  ADOPTER_POLICY_TARGETS,
  compileAdopterPolicyAuthority,
  isJsonObject,
  resolveAdopterPolicyMaterialization,
  type JsonObject,
} from '../services/adopter-policy.js';
import {
  parseAdopterPolicyBinding,
  type AdopterAuthorityExtensionProvenance,
} from '../services/adopter-policy-binding.js';
import { repositoryIdFor } from '../authority/policy.js';
import { adopterAuthorityExtensionDigest } from '../authority/policy-adopter-extension.js';
import { classWriteVerbs } from '../authority/policy-support.js';
import { canonicalRegistry } from '../define-command.js';
import {
  type CheckResult,
  F1_PATHS,
  readPathOverrides,
  applyPathOverride,
} from './doctor-support.js';

export function checkF1Paths(repoRoot: string): CheckResult {
  const expected = F1_PATHS;
  const overrides = readPathOverrides(repoRoot);
  const resolvedPaths: string[] = [];
  const missing: string[] = [];
  for (const p of expected) {
    const actual = applyPathOverride(p, overrides);
    resolvedPaths.push(actual);
    if (!existsSync(join(repoRoot, actual))) missing.push(actual);
  }
  return {
    name: 'f1-paths-present',
    ok: missing.length === 0,
    info: {
      paths: resolvedPaths,
      missing,
      ...(Object.keys(overrides).length > 0 && { path_overrides: overrides }),
    },
    ...(missing.length > 0 && { errors: missing.map((p) => `missing F1 path: ${p}`) }),
  };
}

export function checkPolicyMaterializationCurrent(repoRoot: string): CheckResult {
  const bindingRelative = '.devai/config/adopter-policy-binding.json';
  const bindingPath = join(repoRoot, bindingRelative);
  try {
    lstatSync(bindingPath);
    return checkAdopterPolicyMaterialization(repoRoot, bindingPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      return checkAdopterPolicyMaterialization(repoRoot, bindingPath);
    }
  }

  const mismatches: Array<Record<string, string>> = [];
  for (const file of MATERIALIZED_POLICY_FILES) {
    const target = join(repoRoot, '.devai/config', file);
    const installed = Buffer.from(resolveCanonicalPolicyContent(file), 'utf8');
    const actual = existsSync(target) ? readFileSync(target) : undefined;
    if (actual === undefined || !actual.equals(installed)) {
      mismatches.push({
        file,
        target,
        actual_sha256:
          actual === undefined ? 'missing' : createHash('sha256').update(actual).digest('hex'),
        installed_sha256: createHash('sha256').update(installed).digest('hex'),
      });
    }
  }
  const commands = [
    'devai init bind --target . --operational-law --as-role architect --write',
    'devai init bind --target . --subprocess-effects --as-role architect --write',
  ];
  return {
    name: 'policy-materialization-current',
    ok: mismatches.length === 0,
    info: { mismatches, remediation_commands: commands },
    ...(mismatches.length > 0 && {
      errors: [
        ...mismatches.map(
          ({ file }) => `materialized policy differs from installed policy: ${file}`,
        ),
        ...commands.map((command) => `rebind with: ${command}`),
      ],
    }),
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function policyReasonId(words: string): string {
  return words.toUpperCase().replaceAll('-', '_');
}

// The extension finding ids of ADR-AUT-0003, quoted so the error-code reference lists them.
const EXTENSION_REASONS = {
  drift: 'AUTHORITY_EXTENSION_DRIFT',
  unbound: 'AUTHORITY_EXTENSION_UNBOUND',
  sourceMissing: 'AUTHORITY_EXTENSION_SOURCE_MISSING',
} as const;

type ExtensionComparison =
  | { readonly reason?: undefined; readonly fresh?: AdopterAuthorityExtensionProvenance }
  | {
      readonly reason: string;
      readonly message: string;
      readonly fresh?: AdopterAuthorityExtensionProvenance;
    };

/**
 * ADR-AUT-0003: compare the receipt's `authority_extension` with a fresh compilation of the
 * bound source by the installed package. The comparison stands apart from the source digest,
 * so a package that compiles an unchanged block differently reads as drift as well.
 */
function compareAuthorityExtension(
  repoRoot: string,
  policy: unknown,
  bound: AdopterAuthorityExtensionProvenance | undefined,
  sourceLexical: string,
): ExtensionComparison {
  const declares = isJsonObject(policy) && policy['authority'] !== undefined;
  if (!declares) {
    return bound === undefined
      ? {}
      : {
          reason: EXTENSION_REASONS.unbound,
          message: `the binding receipt carries adopter extension ${bound.extension_id} that ${sourceLexical} no longer declares`,
        };
  }
  if (bound === undefined) {
    return {
      reason: EXTENSION_REASONS.unbound,
      message: `${sourceLexical} declares an authority block the binding receipt does not carry`,
    };
  }
  let fresh: AdopterAuthorityExtensionProvenance;
  try {
    const extension = compileAdopterPolicyAuthority(
      { policy, currentProject: {}, frameworkVersion: resolveCliVersion(), targetRoot: repoRoot },
      {
        repositoryId: repositoryIdFor(repoRoot),
        classWriteVerbs: classWriteVerbs(canonicalRegistry()),
      },
    );
    if (extension === undefined) throw new Error('authority block compiled to no extension');
    fresh = {
      extension_id: extension.extension_id,
      extension_version: extension.extension_version,
      digest_sha256: adopterAuthorityExtensionDigest(extension),
      rule_count: extension.rules.length,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      reason: detail.startsWith('ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE')
        ? 'ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE'
        : 'SOURCE_POLICY_INVALID',
      message: `the authority block of ${sourceLexical} does not compile: ${detail}`,
    };
  }
  const drifted = (['extension_id', 'extension_version', 'digest_sha256', 'rule_count'] as const)
    .filter((key) => fresh[key] !== bound[key])
    .map((key) => `${key} ${String(bound[key])} -> ${String(fresh[key])}`);
  return drifted.length === 0
    ? { fresh }
    : {
        reason: EXTENSION_REASONS.drift,
        message: `adopter extension ${bound.extension_id} compiled from ${sourceLexical} differs from the binding receipt: ${drifted.join(', ')}`,
        fresh,
      };
}

function checkAdopterPolicyMaterialization(repoRoot: string, bindingPath: string): CheckResult {
  const reasons: string[] = [];
  const errors: string[] = [];
  const mismatches: Array<Record<string, string>> = [];
  const addReason = (reason: string, message: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
    errors.push(message);
  };
  // Filled once the receipt and the fresh compilation are read; empty on an early finding.
  const extensionState: {
    bound?: AdopterAuthorityExtensionProvenance;
    fresh?: AdopterAuthorityExtensionProvenance;
  } = {};
  const result = (source?: string): CheckResult => {
    const remediationCommands =
      source === undefined
        ? []
        : [`devai init bind --target . --adopter-policy ${source} --as-role architect --write`];
    return {
      name: 'policy-materialization-current',
      ok: reasons.length === 0,
      info: {
        binding: '.devai/config/adopter-policy-binding.json',
        reason_ids: reasons,
        mismatches,
        ...(extensionState.bound !== undefined && { authority_extension: extensionState.bound }),
        ...(extensionState.fresh !== undefined && {
          compiled_authority_extension: extensionState.fresh,
        }),
        remediation_commands: remediationCommands,
      },
      ...(errors.length > 0 && { errors }),
    };
  };

  let parsedBinding: ReturnType<typeof parseAdopterPolicyBinding>;
  try {
    if (lstatSync(bindingPath).isSymbolicLink() || !lstatSync(bindingPath).isFile()) {
      throw new Error('binding must be a regular file');
    }
    parsedBinding = parseAdopterPolicyBinding(readFileSync(bindingPath, 'utf8'));
  } catch {
    addReason('BINDING_MALFORMED', 'adopter-policy binding cannot be read');
    return result();
  }
  if ('reason' in parsedBinding) {
    addReason(parsedBinding.reason, `adopter-policy binding rejected: ${parsedBinding.reason}`);
    return result();
  }
  const binding = parsedBinding.binding;
  const boundExtension = binding.authority_extension;
  if (boundExtension !== undefined) extensionState.bound = boundExtension;

  const receiptTargets = Object.keys(binding.materialized).sort();

  const sourceLexical = binding.source_path;
  const sourceAbsent = (message: string): CheckResult => {
    addReason('SOURCE_MISSING', message);
    if (boundExtension !== undefined) {
      addReason(
        EXTENSION_REASONS.sourceMissing,
        `adopter extension ${boundExtension.extension_id} cannot be compared: its source ${sourceLexical} is absent; restore it, then rebind`,
      );
    }
    return result(sourceLexical);
  };
  const normalizedSource = sourceLexical.split('/').join(sep);
  const sourceCandidate = resolve(repoRoot, normalizedSource);
  const lawPolicyCandidate = resolve(repoRoot, 'law/policy');
  const lexicalRelative = relative(lawPolicyCandidate, sourceCandidate);
  if (
    sourceLexical.startsWith('/') ||
    sourceLexical.includes('\\') ||
    posix.normalize(sourceLexical) !== sourceLexical ||
    lexicalRelative.length === 0 ||
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${sep}`)
  ) {
    addReason(
      'SOURCE_PATH_OUTSIDE_LAW_POLICY',
      'adopter-policy binding source must be a file beneath law/policy',
    );
    return result();
  }

  if (!existsSync(sourceCandidate)) {
    return sourceAbsent(`adopter-policy source is missing: ${sourceLexical}`);
  }
  try {
    const lawPolicyRoot = realpathSync(lawPolicyCandidate);
    const sourcePath = realpathSync(sourceCandidate);
    const sourceRelative = relative(lawPolicyRoot, sourcePath);
    if (
      sourceRelative.length === 0 ||
      sourceRelative === '..' ||
      sourceRelative.startsWith(`..${sep}`)
    ) {
      addReason(
        'SOURCE_PATH_OUTSIDE_LAW_POLICY',
        'adopter-policy binding source resolves outside law/policy',
      );
      return result();
    }
  } catch {
    return sourceAbsent(`adopter-policy source cannot be resolved: ${sourceLexical}`);
  }
  let sourceBytes: string;
  try {
    if (!lstatSync(sourceCandidate).isFile()) throw new Error('source must be a file');
    sourceBytes = readFileSync(sourceCandidate, 'utf8');
  } catch {
    addReason(
      'SOURCE_POLICY_INVALID',
      `adopter-policy source is not a regular file: ${sourceLexical}`,
    );
    return result(sourceLexical);
  }
  const actualSourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceDrifted = actualSourceDigest !== binding.source_digest_sha256;
  if (sourceDrifted) {
    addReason('SOURCE_DIGEST_MISMATCH', `adopter-policy source digest differs: ${sourceLexical}`);
  }

  let policy: unknown;
  try {
    policy = JSON.parse(sourceBytes);
    const validatePolicy = validators.adopterPolicy;
    if (!validatePolicy(policy)) throw new Error('schema');
  } catch {
    addReason('SOURCE_POLICY_INVALID', `adopter-policy source is invalid: ${sourceLexical}`);
    return result(sourceLexical);
  }

  // Every finding is reported as a set: the extension comparison runs whether or not the
  // source bytes still match the receipt.
  const extension = compareAuthorityExtension(repoRoot, policy, boundExtension, sourceLexical);
  if (extension.fresh !== undefined) extensionState.fresh = extension.fresh;
  if (extension.reason !== undefined) addReason(extension.reason, extension.message);
  // A source edited after the bind leaves every receipt digest stale by construction, so
  // the projected targets are compared only against the source the receipt bound.
  if (sourceDrifted) return result(sourceLexical);
  const policyDocument = policy as JsonObject;
  if (
    policyDocument['policy_id'] !== binding.policy_id ||
    policyDocument['policy_version'] !== binding.policy_version
  ) {
    addReason(
      policyReasonId('policy-identity-mismatch'),
      'adopter-policy source identity differs from the binding receipt',
    );
  }

  const projectRelative = '.devai/config/project.json';
  const projectPath = join(repoRoot, projectRelative);
  let currentProject: unknown = {};
  const projectExists = existsSync(projectPath);
  if (projectExists) {
    try {
      currentProject = JSON.parse(readFileSync(projectPath, 'utf8'));
    } catch {
      addReason('TARGET_BYTES_MISMATCH', `materialized target is invalid: ${projectRelative}`);
    }
  } else {
    addReason('TARGET_MISSING', `materialized target is missing: ${projectRelative}`);
    mismatches.push({
      file: projectRelative,
      actual_sha256: 'missing',
      expected_sha256: 'unknown',
    });
  }
  const boundVersion = isJsonObject(currentProject) ? currentProject['devai_version'] : undefined;
  const installedVersion = resolveCliVersion();
  if (boundVersion !== installedVersion) {
    addReason(
      'FRAMEWORK_VERSION_MISMATCH',
      `bound DEVAI version ${String(boundVersion ?? 'missing')} differs from installed DEVAI version ${installedVersion}`,
    );
  }

  let expected: ReadonlyMap<string, string>;
  try {
    expected = resolveAdopterPolicyMaterialization({
      policy,
      currentProject,
      frameworkVersion: installedVersion,
    });
  } catch {
    if (!projectExists) return result(sourceLexical);
    addReason(
      'SOURCE_POLICY_INVALID',
      `adopter-policy source cannot be materialized: ${sourceLexical}`,
    );
    return result(sourceLexical);
  }

  const expectedTargets = [...expected.keys()].sort();
  if (
    receiptTargets.length !== expectedTargets.length ||
    expectedTargets.some((target) => !receiptTargets.includes(target))
  ) {
    addReason(
      'TARGET_SET_MISMATCH',
      'adopter-policy binding must contain the exact policy-selected materialized target set',
    );
  }

  for (const targetRelative of ADOPTER_POLICY_TARGETS) {
    const expectedBytes = expected.get(targetRelative);
    if (expectedBytes === undefined) continue;
    const expectedDigest = createHash('sha256').update(expectedBytes).digest('hex');
    const receiptDigest = binding.materialized[targetRelative];
    if (receiptDigest !== expectedDigest) {
      addReason(
        policyReasonId('receipt-hash-mismatch'),
        `binding receipt hash differs from recomputed materialization: ${targetRelative}`,
      );
    }
    const targetPath = join(repoRoot, targetRelative);
    if (!existsSync(targetPath)) {
      addReason('TARGET_MISSING', `materialized target is missing: ${targetRelative}`);
      mismatches.push({
        file: targetRelative,
        actual_sha256: 'missing',
        expected_sha256: expectedDigest,
      });
      continue;
    }
    let actual: Buffer;
    try {
      if (!lstatSync(targetPath).isFile()) throw new Error('target must be a file');
      actual = readFileSync(targetPath);
    } catch {
      addReason(
        'TARGET_BYTES_MISMATCH',
        `materialized target is not a regular file: ${targetRelative}`,
      );
      mismatches.push({
        file: targetRelative,
        actual_sha256: 'unreadable',
        expected_sha256: expectedDigest,
      });
      continue;
    }
    const actualDigest = createHash('sha256').update(actual).digest('hex');
    if (
      lstatSync(targetPath).isSymbolicLink() ||
      !actual.equals(Buffer.from(expectedBytes, 'utf8'))
    ) {
      addReason('TARGET_BYTES_MISMATCH', `materialized target differs: ${targetRelative}`);
      mismatches.push({
        file: targetRelative,
        actual_sha256: actualDigest,
        expected_sha256: expectedDigest,
      });
    }
  }

  for (const file of ['forbidden-actions.json', 'subprocess-effects.json'] as const) {
    const targetRelative = `.devai/config/${file}`;
    const targetPath = join(repoRoot, targetRelative);
    const installed = Buffer.from(resolveCanonicalPolicyContent(file), 'utf8');
    const actual = existsSync(targetPath) ? readFileSync(targetPath) : undefined;
    if (actual === undefined) {
      addReason('TARGET_MISSING', `materialized target is missing: ${targetRelative}`);
    } else if (lstatSync(targetPath).isSymbolicLink() || !actual.equals(installed)) {
      addReason('TARGET_BYTES_MISMATCH', `materialized target differs: ${targetRelative}`);
      mismatches.push({
        file: targetRelative,
        actual_sha256: createHash('sha256').update(actual).digest('hex'),
        expected_sha256: createHash('sha256').update(installed).digest('hex'),
      });
    }
  }
  return result(sourceLexical);
}
