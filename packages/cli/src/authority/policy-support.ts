import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseConstitutionVersion,
  resolveCanonicalConstitution,
  reconcileProjectConfig,
} from '@devai-nyx/skills';

type JsonRecord = Record<string, unknown>;

export {
  POLICY_VERSION,
  canonicalBytes,
  policyCanonicalSha256 as canonicalSha256,
  sha256Bytes,
  actionIds,
  fsSelector,
  gitSelector,
  dbSelector,
  rule,
  defined,
  subjectGroups,
  classWriteVerbs,
  machineSubject,
  harnessSubject,
  type ClassWriteVerbs,
} from '@devai-nyx/authority';

function normalizedRepositoryId(value: string): string | undefined {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  return normalized === '' ? undefined : normalized;
}

export function repositoryIdFor(root: string): string {
  const absolute = resolve(root);
  const projectConfigPath = join(absolute, '.devai/config/project.json');
  if (existsSync(projectConfigPath)) {
    try {
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8')) as JsonRecord;
      if (typeof projectConfig.name === 'string') {
        const declaredRepositoryId = normalizedRepositoryId(projectConfig.name);
        if (declaredRepositoryId !== undefined) return declaredRepositoryId;
      }
    } catch {
      // Project-config validation reports malformed adopter configuration separately.
    }
  }
  let repositoryRoot = absolute;
  try {
    const commonGitDirectory = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: absolute,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (commonGitDirectory !== '') repositoryRoot = dirname(commonGitDirectory);
  } catch {
    // Fresh adopters may bind before Git exists; retain the established directory fallback.
  }
  return normalizedRepositoryId(basename(repositoryRoot)) ?? 'adopter-repository';
}

export function authorityBindings(
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  const pinnedConstitution = join(resolve(root), '.devai/pin/constitution.md');
  const constitutionText = existsSync(pinnedConstitution)
    ? readFileSync(pinnedConstitution, 'utf8')
    : installedConstitutionText;
  if (constitutionText === undefined) {
    throw new Error(`authority policy: bound Constitution not found at ${pinnedConstitution}`);
  }
  const constitutionVersion = parseConstitutionVersion(constitutionText);
  if (constitutionVersion === null) {
    throw new Error(
      `authority policy: Constitution version marker is missing in ${pinnedConstitution}`,
    );
  }
  return {
    repository_id: repositoryIdFor(root),
    package_binding: { name: '@aarusso-nyx/devai', version: packageVersion },
    constitution_binding: {
      version: constitutionVersion,
      digest_sha256: createHash('sha256').update(constitutionText).digest('hex'),
    },
  };
}

/** Closed projection: only the running installed candidate supplies Constitution bytes. */
export function prospectiveAuthorityBindings(root: string, packageVersion: string) {
  const canonical = resolveCanonicalConstitution();
  if (canonical === null || canonical.version === null || canonical.source !== 'bundled')
    throw new Error('AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED');
  const project = JSON.parse(
    readFileSync(join(root, '.devai/config/project.json'), 'utf8'),
  ) as JsonRecord;
  const pin = { version: canonical.version, sha256: canonical.sha256 };
  const projectBytes = `${JSON.stringify(
    reconcileProjectConfig(project, {
      version: packageVersion,
      constitution: pin,
    }),
    null,
    2,
  )}\n`;
  return {
    canonical,
    projectBytes,
    bindings: {
      repository_id: repositoryIdFor(root),
      package_binding: { name: '@aarusso-nyx/devai', version: packageVersion },
      constitution_binding: { version: canonical.version, digest_sha256: canonical.sha256 },
    },
  };
}
