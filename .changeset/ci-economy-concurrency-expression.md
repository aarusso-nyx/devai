---
'@aarusso-nyx/devai': patch
---

Repairs `check --only ci-economy` rule 1, which rejected the ordinary
`cancel-in-progress: ${{ github.event_name == 'pull_request' }}` form while accepting the
more privileged `pull_request_target` one. A workflow that also runs on push to a protected
branch must condition cancellation on the event so a branch-gating run is never cancelled;
that shape satisfies the posture and is now recognized, in either quote style. Literal
`true` and workflows without a pull-request trigger are unaffected, and `false` or an
expression that never cancels a pull request still fails. The rule's own verdict for a
checked-in workflow tree is now asserted, which is the coverage whose absence let the
mismatch stand.
