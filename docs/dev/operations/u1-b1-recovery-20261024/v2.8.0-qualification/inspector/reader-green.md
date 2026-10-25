# Independent pure-reader GREEN

The final six-file run is **188PASS/0FAIL**, including all57 reader cases and131
unchanged ordinary/configuration cases. Raw output is
`staged-readers-final-independent-green.txt`; lint and formatting pass. The
original43 reader assertions were retained, with14 edge cases added. No timeout,
threshold or assertion was relaxed.

Independent review first confirmed the frozen43 plus ordinary regression tests,
then found three genuine malformed-registry counterexamples. Required staged
entries `{}`, numeric `action_id` and empty `action_id` were silently dropped
rather than blocking. That54PASS/3FAIL evidence is retained in
`staged-readers-edge-counterexamples.txt`. The narrow fix validates entries only
when an explicit reader is supplied; ordinary behavior is unchanged. Only
`declared-surfaces.ts` changed after that RED; the other16 source hashes are exact.

The GREEN covers actual seven-producer source/body/configuration reader semantics,
not trusted host snapshot admission or any mutation authority. The production
stage0 namespace and private same-run overlay still need an independently admitted
host issuer. Owner approval, canonical proof, index CAS, lease/phase custody and
diagnostic bootstrap writers await their separate exact checkpoint. No release or
DETRAN effect is implied. Final declarations/build and full candidate qualification
remain root-owned. Exact manifests and validation argv are in
`reader-green-receipt.json`; the pre-fix Engineer manifest is preserved separately.
