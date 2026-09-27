import { minimatch } from 'minimatch';
import type {
  MutationBatch,
  MutationPlan,
  ResourceTarget,
  ResourceTargetSelector,
} from './types.js';

function safeRepoRelative(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('//')
  ) {
    return false;
  }
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function malformedTarget(target: ResourceTarget): string[] {
  const errors: string[] = [];
  if (target.id.trim().length === 0) errors.push('resource target id must not be empty');
  switch (target.kind) {
    case 'fs':
      if (target.repository_id.trim().length === 0)
        errors.push('fs repository_id must not be empty');
      if (!safeRepoRelative(target.canonical_relative_path)) {
        errors.push('fs target path must be canonical and repository-relative');
      }
      if (
        target.rename_from_canonical_relative_path !== undefined &&
        !safeRepoRelative(target.rename_from_canonical_relative_path)
      ) {
        errors.push('fs rename source must be canonical and repository-relative');
      }
      break;
    case 'git-ref':
      if (target.repository_id.trim().length === 0)
        errors.push('git repository_id must not be empty');
      if (target.ref.trim().length === 0) errors.push('git ref must not be empty');
      break;
    case 'db':
      if (
        [target.connection_id, target.database_id, target.object_id].some(
          (value) => value.trim().length === 0,
        )
      ) {
        errors.push('db resource identifiers must not be empty');
      }
      break;
    case 'remote':
      if (
        [target.system_id, target.endpoint_id, target.operation_id].some(
          (value) => value.trim().length === 0,
        )
      ) {
        errors.push('remote semantic identifiers must not be empty');
      }
      if (target.endpoint_id.includes('://')) {
        errors.push('remote endpoint_id must be semantic, not a URL');
      }
      break;
  }
  return errors;
}

function malformedSelector(selector: ResourceTargetSelector): string[] {
  switch (selector.kind) {
    case 'fs':
      return safeRepoRelative(selector.canonical_relative_path_glob) &&
        selector.operations.length > 0
        ? []
        : ['fs selector must have a canonical relative glob and permitted operations'];
    case 'git-ref':
      return selector.repository_id.trim().length > 0 &&
        selector.ref_glob.trim().length > 0 &&
        selector.operations.length > 0
        ? []
        : ['git-ref selector identifiers and operations must not be empty'];
    case 'db':
      return [selector.connection_id, selector.database_id_glob, selector.object_id_glob].every(
        (value) => value.trim().length > 0,
      ) && selector.operations.length > 0
        ? []
        : ['db selector identifiers and operations must not be empty'];
    case 'remote':
      return selector.system_id.trim().length > 0 &&
        selector.endpoint_ids.length > 0 &&
        selector.endpoint_ids.every((value) => value.trim().length > 0 && !value.includes('://')) &&
        selector.operation_ids.length > 0
        ? []
        : ['remote selector must use non-empty semantic identifiers'];
  }
}

function resourceIdentity(target: ResourceTarget): string {
  switch (target.kind) {
    case 'fs':
      return `fs|${target.repository_id}|${target.canonical_relative_path}`;
    case 'git-ref':
      return `git-ref|${target.repository_id}|${target.ref}`;
    case 'db':
      return `db|${target.connection_id}|${target.database_id}|${target.object_id}`;
    case 'remote':
      return `remote|${target.system_id}|${target.endpoint_id}|${target.operation_id}`;
  }
}

function duplicateTargetErrors(targets: readonly ResourceTarget[]): string[] {
  const ids = targets.map((target) => target.id);
  const identities = targets.map(resourceIdentity);
  const errors: string[] = [];
  if (new Set(ids).size !== ids.length) errors.push('resource target IDs must be unique');
  if (new Set(identities).size !== identities.length) {
    errors.push('resource target identities must be unique');
  }
  return errors;
}

function matchesSelector(target: ResourceTarget, selector: ResourceTargetSelector): boolean {
  if (target.kind !== selector.kind) return false;
  switch (target.kind) {
    case 'fs':
      return (
        selector.kind === 'fs' &&
        target.repository_id === selector.repository_id &&
        selector.operations.includes(target.operation) &&
        minimatch(target.canonical_relative_path, selector.canonical_relative_path_glob, {
          dot: true,
        })
      );
    case 'git-ref':
      return (
        selector.kind === 'git-ref' &&
        target.repository_id === selector.repository_id &&
        selector.operations.includes(target.operation) &&
        minimatch(target.ref, selector.ref_glob, { dot: true })
      );
    case 'db':
      return (
        selector.kind === 'db' &&
        target.connection_id === selector.connection_id &&
        selector.operations.includes(target.operation) &&
        minimatch(target.database_id, selector.database_id_glob, { dot: true }) &&
        minimatch(target.object_id, selector.object_id_glob, { dot: true })
      );
    case 'remote':
      return (
        selector.kind === 'remote' &&
        target.system_id === selector.system_id &&
        selector.endpoint_ids.includes(target.endpoint_id) &&
        selector.operation_ids.includes(target.operation_id) &&
        (!target.publication || selector.publication)
      );
  }
}

export function malformedPlan(plan: MutationPlan, batch: MutationBatch | undefined): string[] {
  const errors: string[] = [];
  if (plan.plan_id.trim().length === 0) errors.push('plan_id must not be empty');
  if (plan.envelope.action_effect === 'read') {
    if (plan.strategy !== 'exact-plan' || plan.targets.length > 0) {
      errors.push('read actions cannot carry mutation targets or bounds');
    }
  } else if (!plan.envelope.request.dry_run && !plan.envelope.request.consent.write) {
    errors.push('mutating actions require explicit write consent');
  }

  if (plan.strategy === 'exact-plan') {
    if (batch !== undefined) errors.push('exact plans cannot carry a dynamic batch');
    if (plan.envelope.action_effect !== 'read' && plan.targets.length === 0) {
      errors.push('exact mutating plans must declare at least one target');
    }
    errors.push(...plan.targets.flatMap(malformedTarget), ...duplicateTargetErrors(plan.targets));
  } else {
    if (plan.selectors.length === 0) errors.push('bounded plans must declare target selectors');
    errors.push(...plan.selectors.flatMap(malformedSelector));
    const limits = [
      plan.bounds.max_batches,
      plan.bounds.max_targets_per_batch,
      plan.bounds.max_total_targets,
    ];
    if (!limits.every((value) => Number.isSafeInteger(value) && value > 0)) {
      errors.push('bounded plan limits must be positive safe integers');
    }
    if (batch !== undefined) {
      if (
        !Number.isSafeInteger(batch.ordinal) ||
        batch.ordinal < 1 ||
        batch.ordinal > plan.bounds.max_batches
      ) {
        errors.push('batch ordinal exceeds the authorized bound');
      }
      if (batch.targets.length < 1 || batch.targets.length > plan.bounds.max_targets_per_batch) {
        errors.push('batch target count exceeds the authorized bound');
      }
      errors.push(
        ...batch.targets.flatMap(malformedTarget),
        ...duplicateTargetErrors(batch.targets),
      );
      for (const target of batch.targets) {
        if (!plan.selectors.some((selector) => matchesSelector(target, selector))) {
          errors.push(`batch target '${target.id}' is outside the pre-authorized selectors`);
        }
      }
    }
  }

  const targets = plan.strategy === 'exact-plan' ? plan.targets : (batch?.targets ?? []);
  if (
    targets.some((target) => target.kind === 'remote' && target.publication) &&
    !plan.envelope.request.consent.allow_publish
  ) {
    errors.push('publication targets require explicit publish consent');
  }
  return errors;
}
