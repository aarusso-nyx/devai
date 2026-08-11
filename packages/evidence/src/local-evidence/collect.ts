import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { dirname, join, relative } from 'node:path';
import { getValidator } from '@devai-nyx/schemas';
import { computeSourceHash, type SourceHash } from './source-hash.js';
import { resolveLocalEvidencePolicy, type LocalEvidencePolicy } from './config.js';
import { deriveExactSubject, type LocalEvidenceSubject } from './subject.js';

const validateLocalEvidenceManifest = getValidator('local-evidence-manifest.schema.json');

/**
 * `devai evidence local collect` core (D-117): assemble a
 * local-evidence manifest from per-job artifact directories produced
 * by local heavy-tier runs. Each artifact dir must carry a
 * `metadata.txt` (`key=value` lines) declaring at least `job` and
 * `platform`; tool versions (`node`, the package manager, `docker`,
 * `docker_compose`) are picked up when present.
 */
export interface CollectInputs {
  readonly repoRoot: string;
  /** Map of job name → artifact directory (relative to repoRoot or absolute). */
  readonly jobDirs: Readonly<Record<string, string>>;
  /** Override the declared manifest path. */
  readonly outputPath?: string;
  /** Injectable clock for byte-stable tests. */
  readonly now?: Date;
}

export interface CollectResult {
  readonly manifest: LocalEvidenceManifest;
  readonly outputPath: string;
}

export interface ManifestJobEntry {
  readonly result: 'success';
  readonly artifactDir: string;
  readonly metadata: Record<string, string>;
  readonly artifactChecksum: SourceHash;
}

export interface LocalEvidenceManifest {
  readonly $schema: string;
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly subject: LocalEvidenceSubject;
  readonly sourceHash: SourceHash;
  readonly policy: {
    readonly maxAgeHours: number;
    readonly requiredJobs: readonly string[];
    readonly allowedPlatforms: readonly string[];
  };
  readonly tools: Record<string, { expected?: string; observed: string[] }>;
  readonly platforms: readonly string[];
  readonly jobs: Record<string, ManifestJobEntry>;
}

function readMetadata(artifactDir: string): Record<string, string> {
  const metadataPath = join(artifactDir, 'metadata.txt');
  if (!existsSync(metadataPath)) {
    throw new Error(`missing local CI metadata: ${metadataPath}`);
  }
  const metadata: Record<string, string> = {};
  for (const line of readFileSync(metadataPath, 'utf8').split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    metadata[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return metadata;
}

function collectFiles(root: string, current: string, files: string[]): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, files);
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function checksumDirectory(artifactDir: string): SourceHash {
  const files = collectFiles(artifactDir, artifactDir, []).sort((a, b) =>
    relative(artifactDir, a).localeCompare(relative(artifactDir, b)),
  );
  const rootHash = createHash('sha256');
  for (const file of files) {
    const content = readFileSync(file);
    rootHash.update(relative(artifactDir, file));
    rootHash.update('\0');
    rootHash.update(String(content.length));
    rootHash.update('\0');
    rootHash.update(createHash('sha256').update(content).digest('hex'));
    rootHash.update('\0');
  }
  return { algorithm: 'sha256', value: rootHash.digest('hex'), fileCount: files.length };
}

/** Parse `packageManager: "<name>@<version>"` into its parts, if declared. */
function declaredPackageManager(repoRoot: string): { name: string; version: string } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager?: string;
      engines?: { node?: string };
    };
    const pm = pkg.packageManager ?? '';
    const at = pm.indexOf('@');
    if (at > 0) return { name: pm.slice(0, at), version: pm.slice(at + 1) };
    return null;
  } catch {
    return null;
  }
}

function declaredNodeEngine(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? '';
  } catch {
    return '';
  }
}

function jobEntry(job: string, artifactDir: string): ManifestJobEntry {
  if (!existsSync(artifactDir) || !statSync(artifactDir).isDirectory()) {
    throw new Error(`local CI artifact directory does not exist: ${artifactDir}`);
  }
  const metadata = readMetadata(artifactDir);
  if (metadata['job'] !== job) {
    throw new Error(
      `expected ${artifactDir} to contain job=${job}, got job=${metadata['job'] ?? ''}`,
    );
  }
  return {
    result: 'success',
    artifactDir,
    metadata,
    artifactChecksum: checksumDirectory(artifactDir),
  };
}

function observed(
  jobs: Record<string, ManifestJobEntry>,
  requiredJobs: readonly string[],
  key: string,
): string[] {
  return [
    ...new Set(
      requiredJobs.map((job) => jobs[job]?.metadata[key]).filter((v): v is string => Boolean(v)),
    ),
  ];
}

export function collectLocalEvidence(inputs: CollectInputs): CollectResult {
  const policy: LocalEvidencePolicy | null = resolveLocalEvidencePolicy(inputs.repoRoot);
  if (policy === null) {
    throw new Error(
      'no local-evidence policy declared: set ci_economy.local_evidence.required_jobs in .devai/config/project.json',
    );
  }

  for (const job of policy.requiredJobs) {
    if (inputs.jobDirs[job] === undefined) {
      throw new Error(`missing artifact directory for required job: ${job}`);
    }
  }

  const jobs: Record<string, ManifestJobEntry> = {};
  for (const [job, dir] of Object.entries(inputs.jobDirs)) {
    jobs[job] = jobEntry(job, join(inputs.repoRoot, dir));
  }

  const pm = declaredPackageManager(inputs.repoRoot);
  const tools: Record<string, { expected?: string; observed: string[] }> = {
    node: {
      expected: declaredNodeEngine(inputs.repoRoot),
      observed: observed(jobs, policy.requiredJobs, 'node'),
    },
  };
  if (pm !== null) {
    tools[pm.name] = {
      expected: pm.version,
      observed: observed(jobs, policy.requiredJobs, pm.name),
    };
  }
  const dockerObserved = observed(jobs, policy.requiredJobs, 'docker');
  if (dockerObserved.length > 0 || policy.requireDocker) {
    tools['docker'] = { observed: dockerObserved };
  }
  const composeObserved = observed(jobs, policy.requiredJobs, 'docker_compose');
  if (composeObserved.length > 0) {
    tools['dockerCompose'] = { observed: composeObserved };
  }

  const outputPath = inputs.outputPath ?? policy.manifestPath;
  // Exclude wherever the manifest is actually being written, not the
  // declared policy path — they diverge whenever --output overrides
  // the default location, and verify() must exclude the same
  // directory it actually reads from (its --manifest override) for
  // the two hashes to agree.
  const generatedAt = inputs.now ?? new Date();
  const manifest: LocalEvidenceManifest = {
    $schema: 'https://devai.dev/schemas/local-evidence-manifest.schema.json',
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + policy.maxAgeHours * 60 * 60 * 1000).toISOString(),
    subject: deriveExactSubject(inputs.repoRoot),
    sourceHash: computeSourceHash(inputs.repoRoot, [dirname(outputPath)]),
    policy: {
      maxAgeHours: policy.maxAgeHours,
      requiredJobs: [...policy.requiredJobs],
      allowedPlatforms: [...policy.allowedPlatforms],
    },
    tools,
    platforms: [
      ...new Set(
        Object.values(jobs)
          .map((j) => j.metadata['platform'])
          .filter((v): v is string => Boolean(v)),
      ),
    ],
    jobs,
  };

  if (!validateLocalEvidenceManifest(manifest)) {
    const errors = (validateLocalEvidenceManifest.errors ?? [])
      .map((e) => `${e.instancePath} ${e.message ?? ''}`)
      .join('; ');
    throw new Error(`collected manifest fails schema validation: ${errors}`);
  }

  const absOutput = join(inputs.repoRoot, outputPath);
  mkdirSync(dirname(absOutput), { recursive: true });
  writeFileSync(absOutput, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, outputPath };
}
