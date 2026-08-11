import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { walkFiles } from './walker.js';

export interface ContractCheck {
  readonly file: string;
  readonly kind: 'json_schema' | 'openapi';
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface InventoryContractsResult {
  readonly ok: boolean;
  readonly checks: readonly ContractCheck[];
}

export interface ValidateContractsOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
}

/**
 * Validate every `*.schema.json` file against the JSON Schema 2020-12
 * meta-schema (does the schema itself parse and compile?).
 *
 * OpenAPI byte-identity regeneration is outside this validator's scope:
 * it requires running the generator and diffing — viable but heavier than
 * this is a heavier operation. The CLI accepts a `--regen` flag that's a no-op
 * for now, preserving the future surface.
 */
export function validateContracts(opts: ValidateContractsOptions): InventoryContractsResult {
  const dir = opts.dir ?? opts.repoRoot;
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
  addFormats(ajv);

  const schemaFiles = walkFiles(dir, {
    extensions: ['.schema.json'],
    ignoreDirs: opts.ignoreDirs,
  });
  const checks: ContractCheck[] = [];

  for (const file of schemaFiles) {
    const rel = relative(opts.repoRoot, file);
    const errors: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`JSON parse: ${err instanceof Error ? err.message : String(err)}`);
      checks.push({ file: rel, kind: 'json_schema', ok: false, errors });
      continue;
    }
    try {
      // Calling compile() with an already-registered $id throws; clear the
      // cache between files so we can validate the entire set.
      ajv.removeSchema();
      ajv.compile(parsed as object);
    } catch (err) {
      errors.push(`schema compile: ${err instanceof Error ? err.message : String(err)}`);
    }
    checks.push({ file: rel, kind: 'json_schema', ok: errors.length === 0, errors });
  }

  const sorted = checks.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { ok: sorted.every((c) => c.ok), checks: sorted };
}
