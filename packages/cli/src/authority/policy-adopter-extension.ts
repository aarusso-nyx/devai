import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';
import {
  prepareBoundAdopterAuthoritySource,
  parseBoundAdopterAuthoritySource,
  prepareBoundAdopterAuthorityCompilation,
  boundAdopterAuthorityCompilePrefix,
  completeBoundAdopterAuthorityCompilation,
  boundAdopterAuthorityCompilationFailure,
  type BoundAdopterAuthorityExtension,
  type ClassWriteVerbs,
} from '@devai-nyx/authority';
export {
  compileAdopterAuthorityExtension,
  adopterAuthorityExtensionDigest,
  DEFAULT_ADOPTER_TEST_SELECTORS,
  ADOPTER_AUTHORITY_MIN_CONSTITUTION,
  type AdopterAuthorityBlock,
  type AdopterAuthorityRule,
  type AdopterAuthorityExtension,
  type BoundAdopterAuthorityExtension,
} from '@devai-nyx/authority';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const CODES = { defaultsUnavailable: 'ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE' };
function refuse(code: string, detail: string): never {
  throw new Error(`${code}:${detail}`);
}

const DEFAULTS_RELATIVE = 'law/policy/adopter-defaults/path-authority-classes.json';

/**
 * Read the package default test selectors from the defaults law source, validated against
 * `path-authority-classes.schema.json`. The source resolves from the assembled package
 * (`dist/law/...`) or the source checkout only, never from the adopter repository.
 */
export function loadAdopterAuthorityDefaultTestSelectors(
  validator: typeof getValidator = getValidator,
): readonly string[] {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, '../..', DEFAULTS_RELATIVE),
    resolve(moduleRoot, '../../../..', DEFAULTS_RELATIVE),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) refuse(CODES.defaultsUnavailable, `${DEFAULTS_RELATIVE} is absent`);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    refuse(CODES.defaultsUnavailable, `${DEFAULTS_RELATIVE} is not JSON`);
  }
  const validate = validator('path-authority-classes.schema.json');
  if (validate(document) !== true || !isRecord(document)) {
    refuse(CODES.defaultsUnavailable, `${DEFAULTS_RELATIVE} failed schema validation`);
  }
  const classes = document['classes'] as { test: { selectors: string[] } };
  return Object.freeze([...classes.test.selectors]);
}

const BINDING_RECEIPT = '.devai/config/adopter-policy-binding.json';

/** Native acquisition retains legacy read/error order; pure staged resolution never mints context. */
export function resolveBoundAdopterAuthorityExtension(input: {
  readonly root: string;
  readonly repositoryId: string;
  readonly constitutionVersion: string;
  readonly classWriteVerbs: ClassWriteVerbs;
  readonly validator?: typeof getValidator;
}): BoundAdopterAuthorityExtension {
  const receiptPath = join(resolve(input.root), BINDING_RECEIPT);
  if (!existsSync(receiptPath)) return { status: 'none' };
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return { status: 'none' };
  }
  const request = prepareBoundAdopterAuthoritySource(receipt);
  if (request.status !== 'source') return request;
  const absolute = join(resolve(input.root), request.sourcePath);
  const text = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
  const parsed = parseBoundAdopterAuthoritySource(request, text);
  if (parsed.status !== 'validate') return parsed;
  const validator = input.validator ?? getValidator;
  const prepared = prepareBoundAdopterAuthorityCompilation(parsed, validator);
  if (prepared.status !== 'compile') return prepared;
  try {
    const prefix = boundAdopterAuthorityCompilePrefix(prepared, input);
    const defaultTestSelectors = loadAdopterAuthorityDefaultTestSelectors(validator);
    return completeBoundAdopterAuthorityCompilation({
      prepared,
      prefix,
      defaultTestSelectors,
      repositoryId: input.repositoryId,
      classWriteVerbs: input.classWriteVerbs,
    });
  } catch (error) {
    return boundAdopterAuthorityCompilationFailure(prepared, error);
  }
}
