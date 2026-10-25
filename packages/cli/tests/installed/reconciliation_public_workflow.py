"""Explicit disposable public-bin workflow. No private imports or authority mocks.

Prepare with reconciliation-detran-driver.mjs, then supply --fixture, --package,
--evidence. Only the newly allocated fixture is mutated. Receipts stay outside it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import termios
import time


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    fixture = json.loads(Path(args.fixture).read_text())
    root = Path(fixture["root"]).resolve(strict=True)
    package = Path(args.package).resolve(strict=True)
    evidence = Path(args.evidence).resolve()
    assert evidence != root and root not in evidence.parents
    assert root.name == "repository" and root.parent.name.startswith("devai-detran-")
    evidence.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((package / "package.json").read_text())
    assert manifest["name"] == "@aarusso-nyx/devai" and manifest["version"] == "2.8.0"
    node = str(Path(shutil.which("node")).resolve(strict=True))
    runtime = json.loads(subprocess.check_output([node, "-p", "JSON.stringify({executable:process.execPath,node:process.versions.node,uv:process.versions.uv,platform:process.platform,arch:process.arch})"]))
    runtime["executable_sha256"] = digest(Path(node).read_bytes())
    executable = [node, str(package / manifest["bin"]["devai"])]
    env = {**os.environ, "NO_COLOR": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    receipts = []
    def save(name, value):
        (evidence / name).write_bytes(canonical(value))
    def git(*argv):
        return subprocess.check_output(["/usr/bin/git", "--no-optional-locks", *argv], cwd=root, env=env)
    def snap():
        result = {}
        for name in [".git/index", "record/proofs/chain.json", "record/proofs/work/generic/R-0025.jsonl"]:
            path = root / name
            stat = path.lstat()
            result[name] = {"sha256": digest(path.read_bytes()), "dev": str(stat.st_dev), "ino": str(stat.st_ino),
                            "bytes": stat.st_size, "mode": oct(stat.st_mode & 0o777)}
        result["head"] = git("rev-parse", "HEAD").decode().strip()
        result["merge_head"] = (root / ".git/MERGE_HEAD").read_text().strip()
        return result
    def envelopes(raw):
        return [json.loads(line) for line in raw.replace(b"\r", b"").split(b"\n")[:-1] if line.startswith(b'{"schemaVersion"')]
    def invoke(label, argv, token=None):
        previous = evidence / (label + ".json")
        if args.resume and previous.exists():
            saved = json.loads(previous.read_text())
            if saved["exit"] == 0 and saved["argv"] == argv and saved["envelopes"][-1].get("ok") and saved["envelopes"][-1]["result"]["value"].get("outcome") not in ["cancelled", "indeterminate"]:
                receipts.append({"path": previous.name, "sha256": digest(previous.read_bytes())})
                return saved["envelopes"][-1]["result"]["value"]
        for extension in ["json", "stdout", "stderr", "pty"]:
            old = evidence / (label + "." + extension)
            if old.exists():
                assert args.resume, "Existing attempt requires explicit --resume"
                old.rename(evidence / (label + ".attempt-" + str(time.time_ns()) + "." + extension))
        before = snap()
        started = time.monotonic()
        if token is None:
            try:
                process = subprocess.run([*executable, *argv], cwd=root, env=env, capture_output=True, timeout=840)
                stdout, stderr, code = process.stdout, process.stderr, process.returncode
            except subprocess.TimeoutExpired as error:
                # subprocess.run has killed and reaped this exact child. Retain
                # the failed attempt; neither cleanup nor phase completion follows.
                stdout, stderr, code = error.stdout or b"", error.stderr or b"", 124
            raw = stdout + stderr
            (evidence / (label + ".stdout")).write_bytes(stdout)
            (evidence / (label + ".stderr")).write_bytes(stderr)
        else:
            master, slave = pty.openpty()
            attributes = termios.tcgetattr(slave)
            attributes[3] &= ~termios.ECHO
            termios.tcsetattr(slave, termios.TCSANOW, attributes)
            process = subprocess.Popen([*executable, *argv], cwd=root, env=env, stdin=slave, stdout=slave,
                                       stderr=slave, start_new_session=True)
            os.close(slave)
            raw, delivered = b"", set()
            deadline = time.monotonic() + 300
            try:
                while time.monotonic() < deadline:
                    readable, _, _ = select.select([master], [], [], .05)
                    if readable:
                        try:
                            data = os.read(master, 1024 * 1024)
                        except OSError as error:
                            if error.errno != 5:
                                raise
                            break
                        if not data:
                            break
                        raw += data
                        values = envelopes(raw)
                        if values and values[-1].get("ok") and values[-1]["result"]["value"].get("kind", "").endswith("-review") and b"Type " in raw:
                            assert snap() == before, "Review preview mutated the fixture before confirmation"
                            value = values[-1]["result"]["value"]
                            confirmation = token(value)
                            if confirmation not in delivered:
                                os.write(master, confirmation.encode() + b"\n")
                                delivered.add(confirmation)
                    elif process.poll() is not None:
                        break
                code = process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
                os.close(master)
                (evidence / (label + ".pty")).write_bytes(raw)
        values = envelopes(raw)
        record = {"runtime": runtime, "label": label, "argv": argv, "exit": code, "elapsed_seconds": round(time.monotonic() - started, 3),
                  "before": before, "after": snap(), "envelopes": values}
        save(label + ".json", record)
        receipts.append({"path": label + ".json", "sha256": digest((evidence / (label + ".json")).read_bytes())})
        print(json.dumps({"step": label, "exit": code, "seconds": record["elapsed_seconds"]}), flush=True)
        assert code == 0 and values and values[-1].get("ok") and values[-1]["result"]["value"].get("outcome") not in ["cancelled", "indeterminate"], (label, code, raw[-3000:])
        return values[-1]["result"]["value"]

    # Fixture-only setup: a distinct local bare publication and missing generated
    # policy model the reviewed P1 create workflow. Preserve exact originals.
    setup = evidence / "setup.json"
    package_sha = digest((package / manifest["bin"]["devai"]).read_bytes())
    if setup.exists():
        assert args.resume, "Use --resume for the exact recorded fixture and package"
        saved = json.loads(setup.read_text())
        assert saved["fixture"] == fixture and saved["package_bin_sha256"] == package_sha and saved["runtime"] == runtime
        baseline = saved["baseline"]
    else:
        baseline = snap()
        origin = root.parent / "origin.git"
        subprocess.run(["/usr/bin/git", "clone", "--local", "--no-hardlinks", "--bare", str(root), str(origin)], check=True, capture_output=True)
        if "origin" in git("remote").decode().splitlines():
            git("remote", "set-url", "origin", str(origin))
        else:
            git("remote", "add", "origin", str(origin))
        old_policy = root / ".devai/config/authority-policy.json"
        old_bytes = old_policy.read_bytes()
        (evidence / "original-authority-policy.json").write_bytes(old_bytes)
        old_policy.unlink()
        save("setup.json", {"runtime": runtime, "fixture": fixture, "baseline": baseline, "origin": str(origin), "package_bin_sha256": package_sha,
                            "fixture_generated_policy_reset_sha256": digest(old_bytes), "live_detran_effects": False})
    invoke("constitution-bind", ["init", "bind", "--constitution", "--target", str(root), "--as-role", "architect", "--write", "--format", "json"])
    invoke("policy-create", ["init", "bind", "--review-authority-policy", "--after-constitution", "--target", str(root), "--as-role", "architect", "--write", "--format", "json"],
           lambda value: f"CREATE {value['plan_sha256']} {value['artifact']['sha256']}")
    invoke("host-provision", ["init", "bind", "--reconciliation-host", "--target", str(root), "--as-role", "architect", "--write", "--format", "json"], lambda value: value["confirmation"])
    stage_receipt = evidence / "fixture-upgrade-stage.json"
    if not stage_receipt.exists():
        upgraded_paths = [".devai/config/authority-policy.json", ".devai/config/project.json", ".devai/pin/constitution.md"]
        before_stage = git("ls-files", "--stage", "-z")
        git("add", "--", *upgraded_paths)
        after_stage = git("ls-files", "--stage", "-z")
        def entries(raw):
            return {item.split(b"\t", 1)[1]: item for item in raw.split(b"\0") if item}
        first, last = entries(before_stage), entries(after_stage)
        changed = sorted(key.decode() for key in first.keys() | last.keys() if first.get(key) != last.get(key))
        assert set(changed) <= set(upgraded_paths)
        (evidence / "fixture-index-before-upgrade-stage.bin").write_bytes(before_stage)
        (evidence / "fixture-index-after-upgrade-stage.bin").write_bytes(after_stage)
        save(stage_receipt.name, {"kind": "explicit-disposable-fixture-upgrade-stage", "paths": upgraded_paths, "changed_paths": changed,
                                  "before_sha256": digest(before_stage), "after_sha256": digest(after_stage), "native_phase_effect": False})
    plan_path = ".devai/reconciliation-public-plan.json"
    # The client saves its reviewed input outside the staged source population.
    exclude = root / ".git/info/exclude"
    exclusion = "/" + plan_path + "\n"
    if exclusion not in exclude.read_text():
        with exclude.open("a") as handle:
            handle.write("\n" + exclusion)
    plan = invoke("plan", ["evidence", "reconcile", "plan", "--repo-root", str(root), "--selected-parent", fixture["selected_parent"], "--published-ref", "refs/heads/main", "--as-role", "architect", "--format", "json"])
    plan_bytes = canonical(plan)
    if (root / plan_path).exists():
        assert args.resume and (root / plan_path).read_bytes() == plan_bytes
    else:
        with (root / plan_path).open("xb") as handle:
            handle.write(plan_bytes)
    os.chmod(root / plan_path, 0o600)
    plan_sha = digest(plan_bytes)
    base = ["--repo-root", str(root), "--plan", plan_path, "--plan-sha256", plan_sha]
    approved = invoke("owner-approve", ["evidence", "reconcile", "approve", *base, "--as-role", "owner", "--write", "--format", "json"], lambda value: value["confirmation"])
    approval = approved["approval_id"]
    current_grant = approved["approval_sha256"]
    machine = [*base, "--approval", approval, "--as-role", "inspector", "--write", "--format", "json"]
    invoke("materialize", ["evidence", "reconcile", "materialize", *machine])
    invoke("materialize-retry", ["evidence", "reconcile", "materialize", *machine])
    for obligation in plan["effect_plan"]["recovery"]["obligations"]:
        divergent = obligation["mode"] == "divergent"
        recovery = ["evidence", "record", "--recover-divergent-anchor" if divergent else "--recover-newest-line", "--repo-root", str(root),
                    "--proof-path", obligation["proof_path"], "--proof-sequence", str(obligation["proof_sequence"]), "--as-role", "inspector", "--write", "--format", "json"]
        if divergent:
            recovery += ["--source-chain", obligation["source_chain_path"], "--source-chain-sha256", obligation["source_chain_sha256"],
                         "--expected-head", json.loads((root / "record/proofs/chain.json").read_text())["head"]]
        invoke("recover-" + str(obligation["proof_sequence"]), recovery)
    renewed = invoke("owner-renew-before-index", ["evidence", "reconcile", "approve", *base, "--approval", approval,
                     "--renew", "--expected-grant-sha256", current_grant, "--as-role", "owner", "--write", "--format", "json"], lambda value: value["confirmation"])
    current_grant = renewed["record_sha256"]
    invoke("stage-proof", ["evidence", "reconcile", "stage-proof", *machine])
    invoke("stage-proof-retry", ["evidence", "reconcile", "stage-proof", *machine])
    invoke("owner-renew-before-inventory", ["evidence", "reconcile", "approve", *base, "--approval", approval,
           "--renew", "--expected-grant-sha256", current_grant, "--as-role", "owner", "--write", "--format", "json"], lambda value: value["confirmation"])
    inventory = invoke("inventory", ["sense", "bootstrap-inventory", *base, "--approval", approval, "--as-role", "architect", "--write", "--format", "json"])
    invoke("inventory-retry", ["sense", "bootstrap-inventory", *base, "--approval", approval, "--as-role", "architect", "--write", "--format", "json"])
    after = snap()
    assert after["record/proofs/work/generic/R-0025.jsonl"] == baseline["record/proofs/work/generic/R-0025.jsonl"]
    assert after["head"] == baseline["head"] and after["merge_head"] == baseline["merge_head"]
    assert len(inventory["outputs"]) == 7
    save("result.json", {"standing": "INSTALLED_PUBLIC_DISPOSABLE_WORKFLOW_COMPLETE", "package": str(package), "fixture": str(root),
                         "plan_sha256": plan_sha, "approval_id": approval, "source_manifest_sha256": plan["source_manifest_sha256"],
                         "receipts": receipts, "inventory": inventory, "before": baseline, "after": after, "live_detran_effects": False})


if __name__ == "__main__":
    main()
