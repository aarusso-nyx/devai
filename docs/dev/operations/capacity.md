# Capacity

Capacity is selected per task node and external dependency, not inferred from an old global
matrix.

- Use the affected/local DAG for routine work; unchanged PASS nodes consume cache lookup cost.
- Give each database-dependent node an isolated database and explicit connection budget.
- Real-provider sensors require an explicit provider/model and operator budget.
- Evidence verification is linear in the selected chain; retain exact diagnostics for large
  chains instead of retrying blindly.
- The one-pass RC coverage node is intentionally expensive and includes the DB, E2E, performance,
  and containment populations. Use their narrower scripts only as diagnostic slices.

Record measured wall time, CPU, memory, and external calls in the node output contract when they
matter. Tune a limit from observed data and update the task descriptor, test, and documentation
together.
