# Lock operations

The v1.0rc public CLI has no general lock manager. Use the locking mechanism of the underlying
tool or service, keep lock scope narrow, and make ownership and expiry observable. Never delete
an unknown lock merely because it is old. First establish the owner, protected resource, and
recovery procedure.

DEVAI round/task execution manages only the locks declared by that current execution contract.
Inspect them through the corresponding `round status` or internal `task status` surface; do not
invent a separate `work lock` workflow.
