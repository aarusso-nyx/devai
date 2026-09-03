export { resolveAuthorityDeclaration } from './declaration.js';
export { deriveMachineAuthorityContext } from './machine-context.js';
export { loadAuthorityPolicy } from './policy-loader.js';
export {
  authorizePolicyMaterialization,
  materializeAuthorityPolicy,
} from './policy-materializer.js';
export { resolveAuthorityPolicy } from './policy-resolver.js';
export { createAuthorityDecisionIssuer } from './decision-issuer.js';
export { validateAuthorityEvidence } from './evidence-validator.js';
export {
  appendEffectAuthorizationEvent,
  buildEffectAuthorizationTerminalEvent,
  computeEffectAuthorizationEventDigest,
  computeEffectAuthorizationPayloadDigest,
  deriveEffectAuthorizationEventId,
  executeAuthorizedEffect,
  resolveEffectAuthorization,
  verifyEffectAuthorizationLedger,
} from './effect-authorization-ledger.js';

export type {
  AuthorityFailure,
  AuthorityResult,
  AuthoritySuccess,
  FailureCategory,
} from './contracts.js';

export type {
  AuthorizedEffectExecutionResult,
  EffectAuthorizationCandidate,
  EffectAuthorizationConsent,
  EffectAuthorizationEvent,
  EffectAuthorizationGrantRequest,
  EffectAuthorizationLedger,
  EffectAuthorizationLedgerEntry,
  EffectAuthorizationLedgerVerification,
  EffectAuthorizationRepository,
  EffectAuthorizationResolution,
  EffectAuthorizationResource,
  EffectAuthorizationRole,
  EffectAuthorizationTerminalKind,
  VerifiedEffectAuthorizationLedger,
} from './effect-authorization-ledger.js';
