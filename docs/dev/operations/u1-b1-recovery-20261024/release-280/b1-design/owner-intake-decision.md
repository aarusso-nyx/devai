# B1 trusted Owner intake decision

The four-action proposal cannot establish Owner origin from a source-manifest hash,
an `approved` property or a self-consistent caller-supplied ledger. Under the direct
authorization in `../authorization.json`, add a fifth registered action,
`evidence reconcile approve`, initiated directly by a human Owner with explicit
write consent and a real terminal. This is a necessary internal amendment to the
historical proposal. It grants no DETRAN or downstream execution authority here.

The action must show the complete exact plan/source/parents/index/selection and
bounded output/effect inventory before receiving a case-exact confirmation. A
printed plan is data. The action records approval only after fresh actual bound
authority and exact inputs have been reverified. It performs no canonical chain,
index, recovery or diagnostic publication itself.

Cross-process approval custody must use a declared trusted host issuer, with a
private key and attestation outside ordinary caller-controlled plan/state inputs.
Use the existing host-attestation model as a design precedent, without repurposing
post-merge keys or weakening its verifier. Provision the new issuer through a
closed registered `init bind --reconciliation-host` selector. No arbitrary key,
receipt, output or administration path may be supplied by a caller. The logical
host targets resolve to this exact repository/worktree's Git administration area;
they do not grant general Git directory writes.

The signed or MAC-authenticated approval binds repository/worktree, full original
parents/base/HEAD, semantic index, exact source manifest and immutable plan digest,
selected published parent/prefix, package/constitution/policy identity, permitted
phases, outputs/effects, expiry and a unique approval identity. Inspector writers
must verify actual protected issuer origin and current ordinary authority, then
consume approval through an atomic phase-limited transition. A receipt is an
eligibility input, never a substitute for that actual authority decision.

Replay, caller-forged labels/hashes/ledgers, foreign issuer, stale source/index,
expiry, revocation, double consumption and altered output bounds must refuse.
Crash recovery must preserve original approval/phase identities and cannot issue
a fresh grant or take over a foreign/live lease. Exact retry returns the original
verified transition. Unknown partial outputs remain held for inspection.

This closes the choice of intake design; it does not freeze its implementation.
Before runtime edits, the implementation packet must name the precise issuer,
attestation, approval/consumption/lease paths and temporary recipes, initialization
and recovery semantics, closed schema fields, host capability/adapter ownership
and adversarial tests. These details remain required work, not an implied broad
metadata permission. Independent authentic RED precedes implementation.
