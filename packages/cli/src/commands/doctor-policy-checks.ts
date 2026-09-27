import { existsSync, lstatSync, readFileSync, realpathSync } from '@devai-nyx/authority';
import { join, posix, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { validators } from '@devai-nyx/schemas';
import { MATERIALIZED_POLICY_FILES, resolveCanonicalPolicyContent } from '@devai-nyx/skills';
import { resolveCliVersion } from '../version.js';
import {
  ADOPTER_POLICY_TARGETS,
  isJsonObject,
  resolveAdopterPolicyMaterialization,
  type JsonObject,
} from '../services/adopter-policy.js';
import { parseAdopterPolicyBinding } from '../services/adopter-policy-binding.js';
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

function checkAdopterPolicyMaterialization(repoRoot: string, bindingPath: string): CheckResult {
  const reasons: string[] = [];
  const errors: string[] = [];
  const mismatches: Array<Record<string, string>> = [];
  const addReason = (reason: string, message: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
    errors.push(message);
  };
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

  const receiptTargets = Object.keys(binding.materialized).sort();

  const sourceLexical = binding.source_path;
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
    addReason('SOURCE_MISSING', `adopter-policy source is missing: ${sourceLexical}`);
    return result(sourceLexical);
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
    addReason('SOURCE_MISSING', `adopter-policy source cannot be resolved: ${sourceLexical}`);
    return result(sourceLexical);
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
  if (actualSourceDigest !== binding.source_digest_sha256) {
    addReason('SOURCE_DIGEST_MISMATCH', `adopter-policy source digest differs: ${sourceLexical}`);
    return result(sourceLexical);
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
