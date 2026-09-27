import { canonicalJson } from '@devai-nyx/utils';
import {
  issue,
  type AdrValidationError,
  type AdrValidationPolicy,
  type ParsedAdr,
} from './documents.js';

export interface AdrValidationSubjectAuthority {
  readonly subject: string;
  readonly lineage_members: readonly string[];
  readonly effective_head: string;
}
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//u;
const GLOB_CHARACTERS = ['*', '?', '[', ']', '{', '}'] as const;

export function jcsCompare(left: unknown, right: unknown): number {
  return Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right)));
}

export function jcsSorted(values: Iterable<string>): string[] {
  return [...values].sort(jcsCompare);
}

function validAffectedRuleSubject(subject: string): boolean {
  const segments = subject.split('/');
  const codePoints = [...subject].length;
  return (
    codePoints >= 1 &&
    codePoints <= 200 &&
    subject.normalize('NFC') === subject &&
    !subject.startsWith('/') &&
    !WINDOWS_DRIVE_ABSOLUTE.test(subject) &&
    !subject.includes('\\') &&
    !subject.includes('\u0000') &&
    !GLOB_CHARACTERS.some((character) => subject.includes(character)) &&
    !segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

interface AdrSemanticResolution {
  readonly effectiveSubjectsById: ReadonlyMap<string, ReadonlySet<string>>;
  readonly subjectAuthorities: readonly AdrValidationSubjectAuthority[];
}

function noAdrAuthority(): AdrSemanticResolution {
  return { effectiveSubjectsById: new Map(), subjectAuthorities: [] };
}

export function semanticResolution(
  records: readonly ParsedAdr[],
  resolvableLegacyReferences: ReadonlyMap<
    string,
    AdrValidationPolicy['semantic_resolver']['resolvable_legacy_references'][number]
  >,
  errors: AdrValidationError[],
): AdrSemanticResolution {
  if (errors.length > 0) return noAdrAuthority();

  for (const record of records) {
    if (record.status === 'accepted' && record.affectedRules.length === 0) {
      issue(
        errors,
        'adr-affected-rule-subject-invalid',
        record.file,
        `${record.id} has no affected-rule subject`,
      );
    }
    if (new Set(record.affectedRules).size !== record.affectedRules.length) {
      issue(
        errors,
        'adr-affected-rule-subject-invalid',
        record.file,
        `${record.id} has duplicate affected-rule subjects`,
      );
    }
    for (const subject of record.affectedRules) {
      if (!validAffectedRuleSubject(subject)) {
        issue(
          errors,
          'adr-affected-rule-subject-invalid',
          record.file,
          `${record.id} has invalid affected-rule subject '${subject}'`,
        );
      }
    }
  }
  if (errors.length > 0) return noAdrAuthority();

  const byId = new Map<string, ParsedAdr>();
  for (const record of records) {
    if (byId.has(record.id)) {
      issue(errors, 'adr-duplicate-id', record.file, `duplicate ADR identity '${record.id}'`);
    } else byId.set(record.id, record);
  }
  if (errors.length > 0) return noAdrAuthority();

  const globalTargets = new Map<string, Set<string>>();
  for (const record of records) {
    globalTargets.set(record.id, new Set());
    for (const target of record.supersedes) {
      if (target === record.id) {
        issue(
          errors,
          'adr-self-supersedes-reference',
          record.file,
          `${record.id} supersedes itself`,
        );
        continue;
      }
      const targetRecord = byId.get(target);
      if (targetRecord === undefined) {
        issue(
          errors,
          /^(?:ADR-[0-9]{3,}|LEGACY:)/u.test(target)
            ? 'adr-uncatalogued-legacy-reference'
            : 'adr-unresolved-supersedes-reference',
          record.file,
          `${record.id} supersedes unresolved identity '${target}'`,
        );
        continue;
      }
      if (targetRecord.format === 'legacy-catalog') {
        const allowed = resolvableLegacyReferences.get(target);
        if (
          allowed === undefined ||
          targetRecord.catalogPath !== allowed.path ||
          (allowed.disposition !== 'preserved-pre-v2-record' &&
            allowed.disposition !== 'preserved-invalid-accepted-record')
        ) {
          issue(
            errors,
            'adr-uncatalogued-legacy-reference',
            record.file,
            `${record.id} supersedes uncatalogued legacy identity '${target}'`,
          );
          continue;
        }
      }
      globalTargets.get(record.id)?.add(target);
    }
  }
  if (errors.length > 0) return noAdrAuthority();

  // Supersession history must be acyclic before authority is projected by subject.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const detectCycle = (id: string): boolean => {
    if (visiting.has(id)) {
      issue(errors, 'adr-supersession-cycle', byId.get(id)?.file ?? id, `cycle includes '${id}'`);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of jcsSorted(globalTargets.get(id) ?? [])) {
      if (detectCycle(target)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of jcsSorted(byId.keys())) {
    if (detectCycle(id)) return noAdrAuthority();
  }

  interface SubjectGraph {
    readonly nodes: Set<string>;
    readonly targetsBySuccessor: Map<string, Set<string>>;
    readonly adjacency: Map<string, Set<string>>;
  }
  const graphBySubject = new Map<string, SubjectGraph>();
  const ensureSubjectGraph = (subject: string): SubjectGraph => {
    const existing = graphBySubject.get(subject);
    if (existing !== undefined) return existing;
    const graph: SubjectGraph = {
      nodes: new Set(),
      targetsBySuccessor: new Map(),
      adjacency: new Map(),
    };
    graphBySubject.set(subject, graph);
    return graph;
  };
  for (const record of records) {
    if (record.status !== 'accepted') continue;
    for (const subject of record.affectedRules) {
      const graph = ensureSubjectGraph(subject);
      graph.nodes.add(record.id);
      graph.adjacency.set(record.id, graph.adjacency.get(record.id) ?? new Set());
    }
  }
  for (const successor of records) {
    if (successor.status !== 'accepted') continue;
    const successorSubjects = new Set(successor.affectedRules);
    for (const targetId of globalTargets.get(successor.id) ?? []) {
      const target = byId.get(targetId);
      if (target?.status !== 'accepted') continue;
      for (const subject of target.affectedRules) {
        if (!successorSubjects.has(subject)) continue;
        const graph = ensureSubjectGraph(subject);
        const targets = graph.targetsBySuccessor.get(successor.id) ?? new Set<string>();
        targets.add(target.id);
        graph.targetsBySuccessor.set(successor.id, targets);
        graph.adjacency.get(successor.id)?.add(target.id);
        graph.adjacency.get(target.id)?.add(successor.id);
      }
    }
  }

  const effectiveSubjectsById = new Map<string, Set<string>>();
  const subjectAuthorities: AdrValidationSubjectAuthority[] = [];
  for (const subject of jcsSorted(graphBySubject.keys())) {
    const graph = graphBySubject.get(subject);
    if (graph === undefined) continue;
    const componentVisited = new Set<string>();
    for (const seed of jcsSorted(graph.nodes)) {
      if (componentVisited.has(seed)) continue;
      const component = new Set<string>();
      const pending = [seed];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || component.has(current)) continue;
        component.add(current);
        componentVisited.add(current);
        pending.push(...jcsSorted(graph.adjacency.get(current) ?? []));
      }
      const members = jcsSorted(component);
      const superseded = new Set<string>();
      const directSuccessors = new Map<string, Set<string>>();
      for (const successorId of members) {
        for (const targetId of graph.targetsBySuccessor.get(successorId) ?? []) {
          if (!component.has(targetId)) continue;
          superseded.add(targetId);
          const successors = directSuccessors.get(targetId) ?? new Set<string>();
          successors.add(successorId);
          directSuccessors.set(targetId, successors);
        }
      }
      const heads = members.filter((member) => !superseded.has(member));
      for (const targetId of jcsSorted(directSuccessors.keys())) {
        const effectiveDirectSuccessors = jcsSorted(
          [...(directSuccessors.get(targetId) ?? [])].filter((id) => heads.includes(id)),
        );
        if (effectiveDirectSuccessors.length > 1) {
          issue(
            errors,
            'adr-multiple-accepted-direct-successors',
            byId.get(targetId)?.file ?? targetId,
            `${targetId} has conflicting effective accepted successors for '${subject}': ${effectiveDirectSuccessors.join(', ')}`,
          );
          return noAdrAuthority();
        }
      }
      if (heads.length !== 1) {
        issue(
          errors,
          'adr-multiple-effective-accepted-heads',
          byId.get(seed)?.file ?? seed,
          `subject lineage '${subject}' has ${String(heads.length)} effective accepted heads: ${heads.join(', ')}`,
        );
        return noAdrAuthority();
      }
      const head = heads[0];
      if (head === undefined) return noAdrAuthority();
      const effectiveSubjects = effectiveSubjectsById.get(head) ?? new Set<string>();
      effectiveSubjects.add(subject);
      effectiveSubjectsById.set(head, effectiveSubjects);
      subjectAuthorities.push({
        subject,
        lineage_members: members,
        effective_head: head,
      });
    }
  }
  subjectAuthorities.sort((left, right) => {
    const bySubject = jcsCompare(left.subject, right.subject);
    return bySubject === 0 ? jcsCompare(left.lineage_members, right.lineage_members) : bySubject;
  });
  return { effectiveSubjectsById, subjectAuthorities };
}
