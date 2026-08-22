import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CAC } from 'cac';
import { ROSTER, checkSchemas, getValidator, listSchemaFiles, metaGate } from '@devai-nyx/schemas';
import { EXIT_FAIL, EXIT_PASS } from '@devai-nyx/utils';
import { defineCommand } from '../../define-command.js';

interface Options {
  readonly repoRoot?: string;
  readonly human?: boolean;
}

export interface SchemaCanonFinding {
  readonly rule: string;
  readonly path: string;
  readonly message: string;
}

export interface SchemaCanonReport {
  readonly ok: boolean;
  readonly canonical_total: number;
  readonly rules: readonly string[];
  readonly findings: readonly SchemaCanonFinding[];
}

export interface AdopterSchemaReport {
  readonly ok: boolean;
  readonly mode: 'adopter-binding';
  readonly checked: readonly string[];
  readonly findings: readonly SchemaCanonFinding[];
}

const RULES = [
  'recursive-closed-complete-objects',
  'predicate-fragments-valid',
  'shared-vocabulary',
  'generated-marker-integrity',
  'dereferenced-publish-byte-identity',
] as const;

export function checkSchemaCanon(repoRoot: string): SchemaCanonReport {
  const root = resolve(repoRoot);
  const findings: SchemaCanonFinding[] = [];
  const canonical = listSchemaFiles();
  const roster = [...ROSTER].sort();
  if (JSON.stringify(canonical) !== JSON.stringify(roster)) {
    findings.push({
      rule: 'recursive-closed-complete-objects',
      path: 'law/schemas',
      message: 'Canonical directory and explicit schema roster differ.',
    });
  }
  for (const name of ROSTER) {
    try {
      getValidator(name);
    } catch (error) {
      findings.push({
        rule: 'predicate-fragments-valid',
        path: 'law/schemas/' + name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const meta = metaGate();
  for (const item of meta.noncompliant) {
    findings.push({
      rule: 'shared-vocabulary',
      path: 'law/schemas/' + item.name,
      message: item.errors.join('; '),
    });
  }
  for (const item of checkSchemas()) {
    findings.push({
      rule:
        item.rule === 'restated-verdict-enum'
          ? 'shared-vocabulary'
          : 'recursive-closed-complete-objects',
      path: 'law/schemas/' + item.schema + ':' + item.path,
      message: item.rule,
    });
  }
  for (const relative of [
    'packages/cli/src/generated/action-registry.ts',
    'packages/effects-check/src/generated/action-catalog.ts',
    'packages/sensors/src/generated/action-kinds.ts',
  ]) {
    const target = join(root, relative);
    if (
      !existsSync(target) ||
      !readFileSync(target, 'utf8').includes('@generated from law/policy/action-registry.json')
    ) {
      findings.push({
        rule: 'generated-marker-integrity',
        path: relative,
        message: 'Generated action view is absent or lacks its canonical marker.',
      });
    }
  }
  for (const name of ROSTER) {
    const canonicalPath = join(root, 'law/schemas', name);
    const bundledPath = join(root, 'packages/schemas/dist/schemas', name);
    if (
      !existsSync(bundledPath) ||
      readFileSync(canonicalPath).compare(readFileSync(bundledPath)) !== 0
    ) {
      findings.push({
        rule: 'dereferenced-publish-byte-identity',
        path: name,
        message: 'Bundled publish bytes differ from canonical law bytes.',
      });
    }
  }
  return {
    ok: findings.length === 0,
    canonical_total: canonical.length,
    rules: RULES,
    findings,
  };
}

function isDevaiSourceRepository(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      readonly name?: unknown;
      readonly private?: unknown;
    };
    return (
      manifest.name === 'devai' &&
      manifest.private === true &&
      existsSync(join(root, 'law/schemas')) &&
      existsSync(join(root, 'packages/schemas/src/roster.ts'))
    );
  } catch {
    return false;
  }
}

const ADOPTER_SCHEMA_BINDINGS = [
  ['.devai/config/project.json', 'project-config.schema.json'],
  ['.devai/config/scorecard-na.json', 'scorecard-na-config.schema.json'],
  ['.devai/config/glob-guards.json', 'glob-guards.schema.json'],
  ['.devai/config/forbidden-actions.json', 'forbidden-actions.schema.json'],
  ['.devai/config/authority-policy.json', 'authority-policy.schema.json'],
  ['law/policy/adopter-policy.json', 'adopter-policy.schema.json'],
] as const;

export function checkAdopterSchemas(repoRoot: string): AdopterSchemaReport {
  const root = resolve(repoRoot);
  const checked: string[] = [];
  const findings: SchemaCanonFinding[] = [];
  for (const [relative, schema] of ADOPTER_SCHEMA_BINDINGS) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    checked.push(relative);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const validate = getValidator(schema);
      if (!validate(value)) {
        findings.push({
          rule: 'adopter-binding-schema',
          path: relative,
          message: JSON.stringify(validate.errors ?? []),
        });
      }
    } catch (error) {
      findings.push({
        rule: 'adopter-binding-schema',
        path: relative,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!checked.includes('.devai/config/project.json')) {
    findings.push({
      rule: 'adopter-binding-schema',
      path: '.devai/config/project.json',
      message: 'Bound adopter project configuration is absent.',
    });
  }
  return { ok: findings.length === 0, mode: 'adopter-binding', checked, findings };
}

export function checkSchemasForRepository(repoRoot: string): SchemaCanonReport | AdopterSchemaReport {
  const root = resolve(repoRoot);
  return isDevaiSourceRepository(root) ? checkSchemaCanon(root) : checkAdopterSchemas(root);
}

export const checkSchemasCmd = defineCommand({
  name: 'check schemas',
  description: 'Validate the complete recursive schema canon and every governed schema rule.',
  authority: 'policy_firewall',
  register(cli: CAC): void {
    cli
      .command(
        'check-schemas',
        'Validate the complete recursive schema canon and every governed schema rule.',
      )
      .option('--repo-root <path>', 'Repository root (default: .)')
      .option('--format <format>', 'Output format: json or human')
      .option('--human', 'Human-readable output')
      .action((options: Options) => {
        const report = checkSchemaCanon(options.repoRoot ?? '.');
        if (options.human === true) {
          process.stdout.write(
            'policy check schemas: ' +
              (report.ok ? 'OK' : 'FAIL') +
              ' (' +
              String(report.canonical_total) +
              ' canonical schemas, ' +
              String(report.findings.length) +
              ' findings)\n',
          );
          for (const finding of report.findings) {
            process.stdout.write(
              '  [' + finding.rule + '] ' + finding.path + ': ' + finding.message + '\n',
            );
          }
        } else {
          process.stdout.write(JSON.stringify(report) + '\n');
        }
        process.exitCode = report.ok ? EXIT_PASS : EXIT_FAIL;
      });
  },
});

export function registerCheckSchemas(cli: CAC): void {
  checkSchemasCmd.register(cli);
}
