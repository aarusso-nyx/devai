"""Keep historical tests intact while restoring their declared adopter starting state.

Only the disposable copy receives old pin/config/version metadata. Candidate source,
test bytes and compiled dependencies are copied or linked without modification.
This is a source regression fixture, never installed-package qualification.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path.cwd()
destination = Path(tempfile.mkdtemp(prefix="devai-p1-historical-candidate-"))
paths = subprocess.check_output([
    "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"
], cwd=source).split(b"\0")
copied = {}
for raw in paths:
    if not raw:
        continue
    relative = os.fsdecode(raw)
    if relative.startswith("docs/dev/operations/"):
        continue
    original = source / relative
    if not original.is_file():
        continue
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(original, target)
    copied[relative] = hashlib.sha256(target.read_bytes()).hexdigest()

for original in [source / "node_modules", *source.glob("packages/*/node_modules")]:
    target = destination / original.relative_to(source)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(original, target_is_directory=True)

baseline = {}
for relative in [".devai/pin/constitution.md", ".devai/config/project.json", ".devai/config/adopter-policy-binding.json"]:
    data = subprocess.check_output(["git", "show", f"HEAD:{relative}"], cwd=source)
    (destination / relative).write_bytes(data)
    baseline[relative] = hashlib.sha256(data).hexdigest()
for relative in ["package.json", "packages/cli/package.json"]:
    target = destination / relative
    metadata = json.loads(target.read_text())
    metadata["version"] = "2.7.1"
    target.write_text(json.dumps(metadata, indent=2) + "\n")
    baseline[relative] = hashlib.sha256(target.read_bytes()).hexdigest()

manifest = {
    "standing": "DISPOSABLE_HISTORICAL_ADOPTER_SOURCE_REGRESSION_ONLY",
    "source": str(source), "fixture": str(destination),
    "baseline_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip(),
    "baseline_metadata_sha256": baseline,
    "candidate_copy_sha256": copied,
    "dependency_origin": "Current candidate workspace node_modules links; not installed attestation",
}
evidence = source / "docs/dev/operations/u1-b1-recovery-20261024/release-280/host-operation/historical-fixture-manifest.json"
evidence.write_text(json.dumps(manifest, indent=2) + "\n")
print(destination)
