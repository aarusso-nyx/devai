import { isAbsolute } from 'node:path';
import { RECIPE_NAMES, type RecipeManifest, type RecipeWritePolicy } from './types.js';

const VARIANT_NAME = /^[a-z][a-z0-9-]*$/u;
const OPERATION_NAME = /^[a-z][a-z0-9.-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateScope(scope: unknown, path: string, errors: string[]): scope is string {
  if (typeof scope !== 'string' || scope.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  if (
    isAbsolute(scope) ||
    scope.includes('\\') ||
    scope.split('/').includes('..') ||
    scope === '.' ||
    scope === '**' ||
    scope.startsWith('/')
  ) {
    errors.push(`${path} is not a bounded repository-relative scope`);
    return false;
  }
  return true;
}

function validateWritePolicy(
  value: unknown,
  effect: unknown,
  path: string,
  errors: string[],
): value is RecipeWritePolicy {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const mode = value['mode'];
  if (!['none', 'explicit-files', 'bounded-patterns'].includes(String(mode))) {
    errors.push(`${path}.mode is invalid`);
    return false;
  }
  const scopes = value['scopes'];
  if (mode === 'none') {
    if (scopes !== undefined) errors.push(`${path}.scopes is forbidden when mode=none`);
    if (effect !== 'read') errors.push(`${path}.mode=none requires effect=read`);
    return true;
  }
  if (effect === 'read') errors.push(`${path}.${String(mode)} is forbidden for effect=read`);
  if (!Array.isArray(scopes) || scopes.length === 0) {
    errors.push(`${path}.scopes must contain at least one bounded scope`);
    return false;
  }
  scopes.forEach((scope, index) =>
    validateScope(scope, `${path}.scopes[${String(index)}]`, errors),
  );
  if (new Set(scopes).size !== scopes.length) errors.push(`${path}.scopes contains duplicates`);
  if (
    effect === 'runtime-write' &&
    scopes.some((scope) => typeof scope === 'string' && !scope.startsWith('.devai/state/'))
  ) {
    errors.push(`${path} runtime-write scopes must stay under .devai/state/`);
  }
  if (
    effect === 'local-write' &&
    scopes.some((scope) => typeof scope === 'string' && scope.startsWith('.devai/state/'))
  ) {
    errors.push(`${path} local-write scopes cannot target runtime state`);
  }
  return true;
}

export function validateRecipeManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['recipe manifest must be an object'];
  const allowedRoot = new Set(['schemaVersion', 'name', 'status', 'description', 'variants']);
  for (const key of Object.keys(value)) {
    if (!allowedRoot.has(key)) errors.push(`unsupported top-level field: ${key}`);
  }
  if (value['schemaVersion'] !== '1') errors.push('schemaVersion must equal "1"');
  if (!RECIPE_NAMES.includes(value['name'] as (typeof RECIPE_NAMES)[number])) {
    errors.push('name is not one of the seven RC recipes');
  }
  if (!['stable', 'preview'].includes(String(value['status']))) {
    errors.push('status must be stable or preview');
  }
  if (typeof value['description'] !== 'string' || value['description'].trim().length === 0) {
    errors.push('description must be a non-empty string');
  }
  const variants = value['variants'];
  if (!isRecord(variants) || Object.keys(variants).length === 0) {
    errors.push('variants must be a non-empty object');
    return errors;
  }
  for (const [variantName, variant] of Object.entries(variants)) {
    const path = `variants.${variantName}`;
    if (!VARIANT_NAME.test(variantName)) errors.push(`${path} has an invalid name`);
    if (!isRecord(variant)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const allowedVariant = new Set(['description', 'effect', 'write_policy', 'operations']);
    for (const key of Object.keys(variant)) {
      if (!allowedVariant.has(key)) errors.push(`${path} has unsupported field: ${key}`);
    }
    if (typeof variant['description'] !== 'string' || variant['description'].trim().length === 0) {
      errors.push(`${path}.description must be a non-empty string`);
    }
    const effect = variant['effect'];
    if (!['read', 'local-write', 'runtime-write'].includes(String(effect))) {
      errors.push(`${path}.effect is invalid`);
    }
    validateWritePolicy(variant['write_policy'], effect, `${path}.write_policy`, errors);
    const operations = variant['operations'];
    if (!Array.isArray(operations) || operations.length === 0) {
      errors.push(`${path}.operations must be a non-empty array`);
    } else {
      operations.forEach((operation, index) => {
        if (typeof operation !== 'string' || !OPERATION_NAME.test(operation)) {
          errors.push(`${path}.operations[${String(index)}] is invalid`);
        } else if (/(?:^|\.)(?:publish|push)(?:\.|$)/u.test(operation)) {
          errors.push(`${path}.operations[${String(index)}] is a forbidden remote operation`);
        }
      });
      if (new Set(operations).size !== operations.length) {
        errors.push(`${path}.operations contains duplicates`);
      }
    }
  }
  if (value['name'] === 'devai-round' && value['status'] !== 'preview') {
    errors.push('devai-round must remain preview');
  }
  if (value['name'] !== 'devai-round' && value['status'] !== 'stable') {
    errors.push(`${String(value['name'])} must remain stable`);
  }
  return errors;
}

export function assertRecipeManifest(value: unknown): asserts value is RecipeManifest {
  const errors = validateRecipeManifest(value);
  if (errors.length > 0) throw new Error(`INVALID_RECIPE_MANIFEST:\n${errors.join('\n')}`);
}
