import type { ResolvedSenseSelection } from './facade.js';
import type { SensorInputs } from './shared.js';
import { resolveSensorTaskBinding } from './task-binding.js';

/** Task references resolve their complete authority before consent or any measurement. */
export function resolveTaskBoundSenseSelection(
  selection: ResolvedSenseSelection,
  root: string,
  inputs: ReadonlyMap<string, SensorInputs>,
): ResolvedSenseSelection {
  let bound = false;
  const members = selection.members.map((member) => {
    const binding = resolveSensorTaskBinding(root, member.kind, inputs.get(member.kind));
    if (binding === undefined) return member;
    if (selection.selection.type === 'preset') throw new Error('SENSE_TASK_PRESET_REFUSED');
    bound = true;
    return Object.freeze({
      ...member,
      effect: 'local-write' as const,
      capabilities: Object.freeze([
        ...new Set([
          ...member.capabilities,
          'fs:workspace',
          'proc:declared-sensor-task',
          ...(member.kind === 'migration_check' ? ['db:write'] : []),
        ]),
      ]),
      consent: Object.freeze({ write: true, publish: false }),
    });
  });
  if (!bound) return selection;
  return Object.freeze({
    ...selection,
    members: Object.freeze(members),
    aggregate_effect: 'local-write' as const,
  });
}
