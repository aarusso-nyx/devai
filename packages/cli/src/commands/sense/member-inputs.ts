import type { ResolvedSenseSelection } from './facade.js';
import {
  declaredInputKeys,
  resolveDeclaredSensorInputs,
  SenseInputsError,
  type SensorInputs,
} from './shared.js';

/**
 * Effective inputs per member (ADR-SCR-0005), resolved completely before any adapter
 * runs so a refused declaration executes nothing. A single kind receives every
 * explicit key; a preset member receives only the explicit keys its schema entry
 * lists, and a key no member lists is refused.
 */
export function resolveMemberInputs(
  resolved: ResolvedSenseSelection,
  options: { readonly repoRoot: string; readonly explicit?: SensorInputs },
): ReadonlyMap<string, SensorInputs> {
  const preset = resolved.selection.type === 'preset';
  const explicit = options.explicit;
  if (preset && explicit !== undefined) {
    for (const key of Object.keys(explicit)) {
      if (!resolved.members.some((member) => declaredInputKeys(member.kind).includes(key))) {
        throw new SenseInputsError(
          'SENSE_INPUTS_UNDECLARED_KEY',
          `explicit input '${key}' is not a declared input of any member of preset '${resolved.selection.value}'`,
        );
      }
    }
  }
  const byKind = new Map<string, SensorInputs>();
  for (const member of resolved.members) {
    const accepted = preset ? declaredInputKeys(member.kind) : undefined;
    const memberExplicit =
      explicit === undefined
        ? undefined
        : accepted === undefined
          ? explicit
          : Object.fromEntries(Object.entries(explicit).filter(([key]) => accepted.includes(key)));
    byKind.set(
      member.kind,
      resolveDeclaredSensorInputs({
        repoRoot: options.repoRoot,
        sensorKind: member.kind,
        ...(memberExplicit === undefined ? {} : { explicit: memberExplicit }),
      }),
    );
  }
  return byKind;
}
