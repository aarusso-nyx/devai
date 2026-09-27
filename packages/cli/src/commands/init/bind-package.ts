import {
  existsSync,
  mkdirSync,
  readFileSync,
  runAuthorityHostEffectsWithRollback,
  writeFileSync,
} from '@devai-nyx/authority';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  buildConstitutionBindingPlan,
  reconcileProjectConfig,
  resolveCanonicalPolicyContent,
  resolveCanonicalConstitution,
  verifyConstitutionBinding,
} from '@devai-nyx/skills';
import { validators } from '@devai-nyx/schemas';
import { isAdoptionProfile, EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { executeAuthorityPolicyMaterialization } from '../../authority/command-capabilities.js';
import { resolveCliVersion } from '../../version.js';
import { DEFAULT_REPO_ROOT, emit, type InitBindOptions } from './shared.js';

/** Bind the Constitution, operational law, subprocess effects, and authority policy in order (--full). */
export function bindFullPackage(options: InitBindOptions): void {
  const targetRoot = resolve(options.target ?? DEFAULT_REPO_ROOT);
  const canonical = resolveCanonicalConstitution();
  if (canonical === null) {
    process.stderr.write(
      'devai init bind --full: no installed Constitution text could be resolved\n',
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  const operationalFiles = [
    'domains.json',
    'forbidden-actions.json',
    'glob-guards.json',
    'scorecard-na.json',
    'thresholds.json',
  ] as const;
  const operational = operationalFiles.map((file) => {
    const bytes = Buffer.from(resolveCanonicalPolicyContent(file), 'utf8');
    return {
      source: `installed:law/policy/${file}`,
      target: `.devai/config/${file}`,
      digest_sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_identity_required: true as const,
      bytes,
    };
  });
  const subprocessBytes = Buffer.from(
    resolveCanonicalPolicyContent('subprocess-effects.json'),
    'utf8',
  );
  let subprocessDocument: unknown;
  try {
    subprocessDocument = JSON.parse(subprocessBytes.toString('utf8')) as unknown;
  } catch {
    process.stderr.write(
      'devai init bind --full: canonical subprocess-effects source is not valid JSON\n',
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  if (!validators.subprocessEffects(subprocessDocument)) {
    process.stderr.write(
      `devai init bind --full: canonical subprocess-effects source fails schema validation: ${JSON.stringify(validators.subprocessEffects.errors)}\n`,
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  const subprocessPlan = {
    source: 'installed:law/policy/subprocess-effects.json',
    target: '.devai/config/subprocess-effects.json',
    digest_sha256: createHash('sha256').update(subprocessBytes).digest('hex'),
    byte_identity_required: true,
  };
  const plans = [
    {
      segment: 'constitution',
      plan: {
        from: verifyConstitutionBinding(targetRoot).pin?.version ?? 'none',
        to: canonical.version ?? 'unknown',
        source: canonical.source,
        sha256: canonical.sha256,
      },
    },
    {
      segment: 'operational-law',
      plan: operational.map(({ bytes: _bytes, ...entry }) => entry),
    },
    { segment: 'subprocess-effects', plan: subprocessPlan },
    {
      segment: 'authority-policy',
      plan: { target: '.devai/config/authority-policy.json' },
    },
  ];
  if (options.write !== true) {
    emit(
      { plan: plans },
      options.human === true,
      'init bind --full (plan only): constitution → operational-law → subprocess-effects → authority-policy',
    );
    process.exitCode = EXIT_PASS;
    return;
  }
  try {
    const targets = [
      join(targetRoot, '.devai/pin/constitution.md'),
      join(targetRoot, '.devai/constitution.md'),
      join(targetRoot, '.devai/config/project.json'),
      ...operational.map((entry) => join(targetRoot, entry.target)),
      join(targetRoot, subprocessPlan.target),
      join(targetRoot, '.devai/config/authority-policy.json'),
    ];
    const result = runAuthorityHostEffectsWithRollback(targets, () => {
      const vendoredPath = join(targetRoot, '.devai/pin/constitution.md');
      mkdirSync(dirname(vendoredPath), { recursive: true });
      writeFileSync(vendoredPath, canonical.text);
      const pointerPath = join(targetRoot, '.devai/constitution.md');
      if (!existsSync(pointerPath)) {
        const binding = buildConstitutionBindingPlan(targetRoot, resolveCliVersion());
        writeFileSync(pointerPath, binding.pointerFile.content);
      }
      const configPath = join(targetRoot, '.devai/config/project.json');
      const config = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
        : {};
      const pin =
        canonical.version === null
          ? null
          : { version: canonical.version, sha256: canonical.sha256 };
      if (pin !== null) {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
          configPath,
          JSON.stringify(
            reconcileProjectConfig(config, {
              version: resolveCliVersion(),
              ...(options.tier !== undefined && isAdoptionProfile(options.tier)
                ? { profile: options.tier }
                : {}),
              constitution: pin,
            }),
            null,
            2,
          ) + '\n',
        );
      }
      for (const entry of operational) {
        const targetPath = join(targetRoot, entry.target);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, entry.bytes);
      }
      const subprocessTarget = join(targetRoot, subprocessPlan.target);
      mkdirSync(dirname(subprocessTarget), { recursive: true });
      writeFileSync(subprocessTarget, subprocessBytes);
      const authorityPolicy = executeAuthorityPolicyMaterialization();
      return { authorityPolicy };
    });
    const segmentResults = [
      { segment: 'constitution', result: plans[0]?.plan },
      { segment: 'operational-law', result: plans[1]?.plan },
      { segment: 'subprocess-effects', result: plans[2]?.plan },
      { segment: 'authority-policy', result: result.authorityPolicy },
    ];
    emit(
      { segments: segmentResults },
      options.human === true,
      'init bind --full: constitution → operational-law → subprocess-effects → authority-policy',
    );
    process.exitCode = EXIT_PASS;
  } catch (error) {
    process.stderr.write(
      `devai init bind --full: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = EXIT_FAIL;
  }
}

/** Bind the current operational policies into .devai/config with byte identity (--operational-law). */
export function bindOperationalLaw(options: InitBindOptions): void {
  const targetRoot = resolve(options.target ?? DEFAULT_REPO_ROOT);
  const files = [
    'domains.json',
    'forbidden-actions.json',
    'glob-guards.json',
    'scorecard-na.json',
    'thresholds.json',
  ] as const;
  const materializations = files.map((file) => {
    const content = resolveCanonicalPolicyContent(file);
    const bytes = Buffer.from(content, 'utf8');
    return {
      source: `installed:law/policy/${file}`,
      target: `.devai/config/${file}`,
      digest_sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_identity_required: true as const,
      bytes,
    };
  });
  const plan = materializations.map(({ bytes: _bytes, ...entry }) => entry);
  if (options.write !== true) {
    emit(
      { plan },
      options.human === true,
      `init bind --operational-law (plan only): ${String(plan.length)} exact materializations`,
    );
    process.exitCode = EXIT_PASS;
    return;
  }
  for (const entry of materializations) {
    const targetPath = join(targetRoot, entry.target);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, entry.bytes);
  }
  emit(
    { materialized: plan },
    options.human === true,
    `init bind --operational-law: ${String(plan.length)} exact materializations`,
  );
  process.exitCode = EXIT_PASS;
}

/** Bind the subprocess-effects policy into .devai/config with byte identity (--subprocess-effects). */
export function bindSubprocessEffects(options: InitBindOptions): void {
  const targetRoot = resolve(options.target ?? DEFAULT_REPO_ROOT);
  const targetPath = join(targetRoot, '.devai/config/subprocess-effects.json');
  const bytes = Buffer.from(resolveCanonicalPolicyContent('subprocess-effects.json'), 'utf8');
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    process.stderr.write(
      'devai init bind --subprocess-effects: canonical source is not valid JSON\n',
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  if (!validators.subprocessEffects(document)) {
    process.stderr.write(
      `devai init bind --subprocess-effects: canonical source fails schema validation: ${JSON.stringify(validators.subprocessEffects.errors)}\n`,
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  const digestSha256 = createHash('sha256').update(bytes).digest('hex');
  const plan = {
    source: 'installed:law/policy/subprocess-effects.json',
    target: '.devai/config/subprocess-effects.json',
    digest_sha256: digestSha256,
    byte_identity_required: true,
  };
  if (options.write !== true) {
    emit(
      { plan },
      options.human === true,
      `init bind --subprocess-effects (plan only): ${plan.source} → ${plan.target} (${digestSha256})`,
    );
    process.exitCode = EXIT_PASS;
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, bytes);
  emit(
    { materialized: plan },
    options.human === true,
    `init bind --subprocess-effects: ${plan.target} (${digestSha256})`,
  );
  process.exitCode = EXIT_PASS;
}

/** Bind the installed Constitution text and its project.json pin (--constitution). */
export function bindConstitution(options: InitBindOptions): void {
  const targetRoot = options.target ?? DEFAULT_REPO_ROOT;
  const canonical = resolveCanonicalConstitution();
  if (canonical === null) {
    process.stderr.write(
      'devai init bind --constitution: no installed Constitution text could be resolved\n',
    );
    process.exit(EXIT_FAIL);
  }
  const before = verifyConstitutionBinding(targetRoot);
  const toVersion = canonical.version ?? 'unknown';
  const fromVersion = before.pin?.version ?? 'none';

  if (options.write !== true) {
    emit(
      {
        from: fromVersion,
        to: toVersion,
        source: canonical.source,
        sha256: canonical.sha256,
      },
      options.human === true,
      `init bind --constitution (plan only): ${fromVersion} → ${toVersion} (source: ${canonical.source})\n` +
        '  re-run with --write to refresh .devai/pin/constitution.md + the project.json pin',
    );
    process.exitCode = EXIT_PASS;
    return;
  }

  const vendoredPath = join(targetRoot, '.devai/pin/constitution.md');
  mkdirSync(dirname(vendoredPath), { recursive: true });
  writeFileSync(vendoredPath, canonical.text);
  const pointerPath = join(targetRoot, '.devai/constitution.md');
  if (!existsSync(pointerPath)) {
    const binding = buildConstitutionBindingPlan(targetRoot, resolveCliVersion());
    writeFileSync(pointerPath, binding.pointerFile.content);
  }

  const configPath = join(targetRoot, '.devai/config/project.json');
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {};
  const pin =
    canonical.version !== null ? { version: canonical.version, sha256: canonical.sha256 } : null;
  if (pin !== null) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        reconcileProjectConfig(config, {
          version: resolveCliVersion(),
          ...(options.tier !== undefined && isAdoptionProfile(options.tier)
            ? { profile: options.tier }
            : {}),
          constitution: pin,
        }),
        null,
        2,
      ) + '\n',
    );
  }

  emit(
    { from: fromVersion, to: toVersion, source: canonical.source },
    options.human === true,
    `init bind --constitution: ${fromVersion} → ${toVersion} (source: ${canonical.source})`,
  );
  process.exitCode = EXIT_PASS;
}
