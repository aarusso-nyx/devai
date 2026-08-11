// @generated from law/policy/action-registry.json
// Do not edit; run node scripts/generate-action-registry.mjs.

export const SENSOR_ACTION_KINDS = [
  {
    action_id: 'sense inventory',
    status: 'stable',
    effect: 'read',
  },
  {
    action_id: 'sense migrate',
    status: 'stable',
    effect: 'local-write',
  },
  {
    action_id: 'sense record',
    status: 'stable',
    effect: 'harness-write',
  },
  {
    action_id: 'sense run',
    status: 'stable',
    effect: 'remote-write',
  },
] as const;
