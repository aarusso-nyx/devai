# Disposable installed-package qualification

`reconciliation_public_workflow.py` runs the public DEVAI binary through the
complete U1/B1 workflow. It imports no DEVAI implementation modules and supplies
no authority mocks. Use a fresh disposable recovery fixture, an installed exact
package, Python 3, Git, and the qualified Node executable on `PATH`.

```sh
PATH=/absolute/node/bin:$PATH python3 packages/cli/tests/installed/reconciliation_public_workflow.py \
  --fixture /absolute/disposable-fixture/fixture.json \
  --package /absolute/install/node_modules/@aarusso-nyx/devai \
  --evidence /absolute/external-receipts
```

The fixture receipt must identify a newly allocated `devai-detran-*` parent and
its `repository` child. Historical and reviewed current-main fixtures are
qualified separately. The current-main fixture must preserve its reviewed source
resolutions; preparing a different merge is not an equivalent fixture.

The driver records the exact executable bytes, Node/libuv versions, package-bin
bytes, expanded argv, public output envelopes, exit codes and protected
before/after witnesses. Evidence stays outside the fixture. Its only setup
changes are a separate local bare origin, public constitution/policy/host setup,
explicit staging of the three setup paths, and exclusion of the saved client plan
from executable source inputs.

The public sequence is saved-plan preview, direct TTY Owner confirmation,
materialization with a completed retry, separate exact-head U1 and newest-line
recoveries, Owner renewal, proof-index publication with a retry, another renewal,
and seven-body staged inventory publication with a retry. The final result checks
unchanged parents and epoch bytes. A completed materialization retry is tested
before index publication; this driver makes no restart-after-index claim.

Machine commands have a 14-minute driver deadline inside the existing 15-minute
native grant. Owner confirmation keeps its existing five-minute deadline. A
failed attempt is retained, never rolled back, reset or treated as completion.
`--resume` requires the exact recorded fixture, installed package-bin digest and
runtime; it preserves prior failed receipts and reuses only completed matching
steps. A dead native lease still requires the explicit public Owner recovery
operation with its then-current expected digest before dependent work can resume.

These are disposable qualification effects. Successful receipts grant no live
DETRAN installation, recovery, integration, release, C6 or S3 authority.
