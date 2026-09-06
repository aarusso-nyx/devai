import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { loadSchema } from '../../src/index.js';
import { canonicalJson } from './governance-v15.js';

export type AdrStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';
export type AdrFormat = 'v2' | 'legacy-catalog';

export interface AdrRecordFixture {
  readonly file: string;
  readonly adr_id: string;
  readonly title: string;
  readonly status: AdrStatus;
  readonly date: string | null;
  readonly format: AdrFormat;
  readonly supersedes: readonly string[];
  readonly affected_rules: readonly string[];
}

export interface AdrResultRow extends AdrRecordFixture {
  readonly effective: boolean;
  readonly effective_affected_rules: readonly string[];
}

export interface SubjectAuthorityFixture {
  readonly subject: string;
  readonly lineage_members: readonly string[];
  readonly effective_head: string;
}

export interface AdrValidationResultFixture {
  readonly ok: boolean;
  readonly kernel_id: 'devai.kernel.adr-supersession-resolution.v3';
  readonly semantic_resolution_performed: boolean;
  readonly files_scanned: number;
  readonly errors: ReadonlyArray<{
    readonly file: string;
    readonly message: string;
    readonly code?: string;
    readonly pointer?: string;
  }>;
  readonly adrs: readonly AdrResultRow[];
  readonly effective_authorities: readonly string[];
  readonly subject_authorities: readonly SubjectAuthorityFixture[];
}

function compareJcs(left: unknown, right: unknown): number {
  return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right)));
}

function compileDefinition(schemaName: string, pointer: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(loadSchema('common-defs.schema.json'), 'common-defs.schema.json');
  const schema = loadSchema(schemaName);
  ajv.addSchema(schema);
  const id = schema.$id;
  if (typeof id !== 'string') throw new Error(`${schemaName} has no $id`);
  return ajv.compile({ $ref: `${id}#/${pointer}` });
}

export const validateAdrResult = compileDefinition(
  'adr-validation-policy.schema.json',
  '$defs/adrValidationResult',
);

const validateAffectedRuleSubject = compileDefinition(
  'adr-v2.schema.json',
  '$defs/affected_rule_subject',
);

export function isCanonicalAffectedRuleSubject(subject: string): boolean {
  return validateAffectedRuleSubject(subject) && subject.normalize('NFC') === subject;
}

function assertRecordSet(
  records: readonly AdrRecordFixture[],
): ReadonlyMap<string, AdrRecordFixture> {
  const byId = new Map(records.map((record) => [record.adr_id, record]));
  if (byId.size !== records.length) throw new Error('adr-duplicate-id');

  for (const record of records) {
    if (
      record.status === 'accepted' &&
      (record.affected_rules.length === 0 ||
        new Set(record.affected_rules).size !== record.affected_rules.length ||
        record.affected_rules.some((subject) => !isCanonicalAffectedRuleSubject(subject)))
    ) {
      throw new Error('adr-affected-rule-subject-invalid');
    }
    for (const target of record.supersedes) {
      if (target === record.adr_id) throw new Error('adr-self-supersedes-reference');
      if (!byId.has(target)) throw new Error('adr-unresolved-supersedes-reference');
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('adr-supersession-cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of byId.get(id)?.supersedes ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const record of records) visit(record.adr_id);

  return byId;
}

/**
 * Test-only reference implementation of the frozen v3 semantic contract.
 * Runtime tests must exercise the production kernel once its public API lands.
 */
export function resolveAdrFixture(
  records: readonly AdrRecordFixture[],
  filesScanned = records.length,
): AdrValidationResultFixture {
  const byId = assertRecordSet(records);
  const accepted = records.filter((record) => record.status === 'accepted');
  const subjects = [...new Set(accepted.flatMap((record) => record.affected_rules))].sort(
    compareJcs,
  );
  const subjectAuthorities: SubjectAuthorityFixture[] = [];

  for (const subject of subjects) {
    const members = accepted
      .filter((record) => record.affected_rules.includes(subject))
      .map((record) => record.adr_id);
    const memberSet = new Set(members);
    const edges = members.flatMap((id) =>
      (byId.get(id)?.supersedes ?? [])
        .filter((target) => memberSet.has(target))
        .map((target) => [id, target] as const),
    );
    const undirected = new Map(members.map((id) => [id, new Set<string>()]));
    for (const [source, target] of edges) {
      undirected.get(source)?.add(target);
      undirected.get(target)?.add(source);
    }

    const visited = new Set<string>();
    for (const start of [...members].sort(compareJcs)) {
      if (visited.has(start)) continue;
      const pending = [start];
      const component: string[] = [];
      visited.add(start);
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined) continue;
        component.push(id);
        for (const neighbor of [...(undirected.get(id) ?? [])].sort(compareJcs)) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
      component.sort(compareJcs);
      const componentSet = new Set(component);
      const superseded = new Set(
        edges
          .filter(([source, target]) => componentSet.has(source) && componentSet.has(target))
          .map(([, target]) => target),
      );
      const heads = component.filter((id) => !superseded.has(id));
      if (heads.length !== 1) throw new Error('adr-multiple-effective-accepted-heads');
      subjectAuthorities.push({
        subject,
        lineage_members: component,
        effective_head: heads[0] ?? '',
      });
    }
  }

  subjectAuthorities.sort(
    (left, right) =>
      compareJcs(left.subject, right.subject) ||
      compareJcs(left.lineage_members, right.lineage_members),
  );
  const effectiveById = new Map(records.map((record) => [record.adr_id, [] as string[]]));
  for (const authority of subjectAuthorities) {
    effectiveById.get(authority.effective_head)?.push(authority.subject);
  }
  for (const subjectsForRecord of effectiveById.values()) subjectsForRecord.sort(compareJcs);

  const adrs = [...records]
    .sort((left, right) => compareJcs(left.adr_id, right.adr_id))
    .map((record): AdrResultRow => {
      const effectiveAffectedRules = effectiveById.get(record.adr_id) ?? [];
      return {
        ...record,
        effective: effectiveAffectedRules.length > 0,
        effective_affected_rules: effectiveAffectedRules,
      };
    });
  const effectiveAuthorities = [
    ...new Set(subjectAuthorities.map((entry) => entry.effective_head)),
  ].sort(compareJcs);

  return {
    ok: true,
    kernel_id: 'devai.kernel.adr-supersession-resolution.v3',
    semantic_resolution_performed: true,
    files_scanned: filesScanned,
    errors: [],
    adrs,
    effective_authorities: effectiveAuthorities,
    subject_authorities: subjectAuthorities,
  };
}

export function matchesAdrSemantics(
  records: readonly AdrRecordFixture[],
  result: AdrValidationResultFixture,
  filesScanned = records.length,
): boolean {
  try {
    return canonicalJson(result) === canonicalJson(resolveAdrFixture(records, filesScanned));
  } catch {
    return false;
  }
}
