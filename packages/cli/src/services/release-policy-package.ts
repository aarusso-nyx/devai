import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '@devai-nyx/utils';
import {
  resolveAdopterPolicyMaterialization,
  type AdopterPolicyMaterializationSources,
} from './adopter-policy.js';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';

export interface ReleasePolicyPackageTools {
  readonly readJson: (path: string) => unknown;
  readonly parse: <T = unknown>(schema: string, document: unknown) => T;
  readonly materialize: (input: {
    readonly policy: unknown;
    readonly currentProject: unknown;
    readonly frameworkVersion: string;
  }) => ReadonlyMap<string, string>;
}

const SCHEMAS = 'dist/runtime/index/schemas/';
const INVALID = 'rpl-package-identity-mismatch';

/** Use only checked in-memory package bytes; no source search, ambient read or remote refs. */
export function createReleasePolicyPackageTools(
  snapshot: ReleasePackageSnapshot,
): ReleasePolicyPackageTools {
  if (!isVerifiedReleasePackageSnapshot(snapshot)) throw new Error(INVALID);
  try {
    const readJson = (path: string): unknown => {
      try {
        const bytes = snapshot.read(path);
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(INVALID);
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(INVALID);
      }
    };
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const names = new Set<string>();
    for (const entry of snapshot.manifest) {
      if (!entry.path.startsWith(SCHEMAS)) continue;
      const name = entry.path.slice(SCHEMAS.length);
      if (!/^[a-z0-9][a-z0-9-]*\.schema\.json$/u.test(name)) throw new Error(INVALID);
      const document = readJson(entry.path);
      if (document === null || typeof document !== 'object' || Array.isArray(document))
        throw new Error(INVALID);
      if ('$async' in document && document.$async !== false) throw new Error(INVALID);
      ajv.addSchema(document, name);
      names.add(name);
    }
    if (names.size === 0) throw new Error(INVALID);
    const getValidator: AdopterPolicyMaterializationSources['getValidator'] = (name) => {
      if (!names.has(name)) throw new Error(INVALID);
      const validator = ajv.getSchema(name);
      if (validator === undefined || ('$async' in validator && validator.$async === true))
        throw new Error(INVALID);
      return validator;
    };
    return Object.freeze({
      readJson,
      parse: <T = unknown>(schema: string, document: unknown): T => {
        try {
          if (!names.has(schema.split('#')[0] ?? '')) throw new Error(INVALID);
          const copied: unknown = JSON.parse(canonicalJson(document));
          const validator = ajv.getSchema(schema);
          if (
            validator === undefined ||
            ('$async' in validator && validator.$async === true) ||
            validator(copied) !== true
          )
            throw new Error(INVALID);
          return copied as T;
        } catch {
          throw new Error(INVALID);
        }
      },
      materialize: (input: Parameters<typeof resolveAdopterPolicyMaterialization>[0]) => {
        try {
          return resolveAdopterPolicyMaterialization(input, {
            getValidator,
            readPolicy: (file) => snapshot.read(`dist/law/policy/${file}`).toString('utf8'),
          });
        } catch {
          throw new Error('rpl-adopter-binding-mismatch');
        }
      },
    });
  } catch {
    throw new Error(INVALID);
  }
}
